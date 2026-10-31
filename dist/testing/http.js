import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
let activeOwner = false;
/**
 * Starts isolated, opt-in interception. Use one owner in a sequential scenario (never `it.concurrent`) and
 * always call `finish` from teardown or `finally`. Endpoint handlers and payloads stay with the consumer.
 */
export function createHttpScenario(...handlers) {
    if (activeOwner)
        throw new Error("An HTTP scenario already owns interception in this environment; finish it before starting another (no it.concurrent)");
    activeOwner = true;
    const originalFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
    const failures = [];
    const activeFetches = new Set();
    const responses = new Set();
    let server;
    let interceptedFetch;
    let finished = false;
    try {
        // MSW's built-in unhandled-request strategy permits common asset paths, so isolation needs a final handler.
        server = setupServer(...handlers, http.all("*", ({ request }) => {
            failures.push(`Unexpected request: ${request.method} ${request.url}`);
            return HttpResponse.error();
        }));
        server.events.on("unhandledException", ({ request, error }) => {
            failures.push(`Handler failed: ${request.method} ${request.url}: ${String(error)}`);
        });
        server.listen({ onUnhandledRequest: "error" });
        interceptedFetch = globalThis.fetch;
        const fetchRequest = interceptedFetch;
        globalThis.fetch = function observedFetch(input, init) {
            const result = fetchRequest(input, init);
            let observed;
            const settled = () => void activeFetches.delete(observed);
            observed = result.then(settled, settled);
            activeFetches.add(observed);
            return result;
        };
    }
    catch (error) {
        const errors = [error];
        restoreInterception(errors);
        throwCollected(errors, "HTTP scenario startup failed");
        throw error;
    }
    // Each restoration is independent: a hostile fetch descriptor must not leave MSW interception installed.
    function restoreInterception(errors) {
        for (const restore of [
            () => {
                if (interceptedFetch)
                    globalThis.fetch = interceptedFetch;
            },
            () => server?.close(),
            () => restoreDescriptor("fetch", originalFetch),
        ]) {
            try {
                restore();
            }
            catch (error) {
                errors.push(error);
            }
        }
        activeOwner = false;
    }
    const cancelPending = () => {
        for (const response of responses)
            response.cancel();
    };
    return {
        deferResponse() {
            if (finished)
                throw new Error("Cannot create a response after the HTTP scenario finished");
            const response = controlledResponse();
            responses.add(response);
            return response;
        },
        use(...nextHandlers) {
            if (finished)
                throw new Error("Cannot add handlers after the HTTP scenario finished");
            server?.use(...nextHandlers);
        },
        drain(timeoutMs = 1_000) {
            return drain(activeFetches, timeoutMs);
        },
        async finish(cleanup = {}, timeoutMs = 1_000) {
            if (finished)
                return;
            finished = true;
            const errors = [];
            try {
                await runCleanup(cleanup.beforeCancel, errors);
                cancelPending();
                await runCleanup(cleanup.afterCancel, errors);
                try {
                    await drain(activeFetches, timeoutMs);
                }
                catch (error) {
                    errors.push(error);
                }
                if (failures.length > 0)
                    errors.push(new Error(`HTTP scenario setup failures:\n${failures.join("\n")}`));
            }
            finally {
                restoreInterception(errors);
            }
            throwCollected(errors, "HTTP scenario teardown failed");
        },
    };
}
async function runCleanup(callbacks, errors) {
    for (const callback of callbacks ?? []) {
        try {
            await callback();
        }
        catch (error) {
            errors.push(error);
        }
    }
}
function controlledResponse() {
    let state = "pending";
    let request;
    let resolve;
    const response = new Promise((done) => {
        resolve = done;
    });
    function cancel() {
        if (state !== "pending")
            return;
        state = "cancelled";
        resolve(HttpResponse.error());
    }
    return {
        get request() {
            return request;
        },
        get state() {
            return state;
        },
        async handle(received) {
            if (request)
                throw new Error(`Duplicate controlled request: ${received.method} ${received.url}`);
            request = received;
            received.signal.addEventListener("abort", cancel, { once: true });
            if (received.signal.aborted)
                cancel();
            try {
                return await response;
            }
            finally {
                received.signal.removeEventListener("abort", cancel);
            }
        },
        release(value) {
            if (state !== "pending")
                throw new Error(`Cannot release ${state} response`);
            state = "released";
            resolve(value);
        },
        cancel,
    };
}
async function drain(activeFetches, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (activeFetches.size > 0 && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 0));
    if (activeFetches.size > 0)
        throw new Error(`HTTP scenario still owns ${activeFetches.size} active fetch(es)`);
}
function restoreDescriptor(key, descriptor) {
    if (descriptor)
        Object.defineProperty(globalThis, key, descriptor);
    else
        Reflect.deleteProperty(globalThis, key);
}
function throwCollected(errors, message) {
    if (errors.length === 1)
        throw errors[0];
    if (errors.length > 1)
        throw new AggregateError(errors, `${message}:\n${errors.map((error) => String(error)).join("\n")}`);
}
