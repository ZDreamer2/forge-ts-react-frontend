import { createHttpScenario } from "../http.js";
import { OwnedDeferreds } from "./owned-deferred.js";
import { OwnedQueryClients } from "./owned-query-clients.js";
const OWNED_SETTLEMENT_TIMEOUT_MS = 1_000;
export function registerTestSuiteLifecycle(options, hooks) {
    let state;
    const lifecycle = {
        createQueryClient(config) {
            const current = requireActiveState(state);
            if (current.finished)
                throw new Error("Cannot create a QueryClient after the test lifecycle finished");
            return current.queryClients.create(config);
        },
        createHttpScenario(...handlers) {
            const current = requireActiveState(state);
            if (current.finished)
                throw new Error("Cannot start HTTP after the test lifecycle finished");
            if (current.network)
                throw new Error("The test lifecycle already owns an HTTP scenario");
            current.network = createHttpScenario(...handlers);
            return current.network;
        },
        defer(options) {
            const current = requireActiveState(state);
            if (current.finished)
                throw new Error("Cannot defer work after the test lifecycle finished");
            return current.deferreds.defer(options);
        },
        async finish() {
            const current = state;
            if (!current || current.finished)
                return;
            current.finished = true;
            const errors = [];
            let settlementDeadline;
            const startOwnedSettlement = () => {
                current.deferreds.applyUnfinished();
                settlementDeadline = Date.now() + OWNED_SETTLEMENT_TIMEOUT_MS;
            };
            const remainingSettlementTime = () => Math.max(0, (settlementDeadline ?? Date.now()) - Date.now());
            const beforeCancel = [
                ...(options.beforeCancel ?? []),
                () => current.queryClients.cancelQueries(),
                startOwnedSettlement,
            ];
            const afterCancel = [
                () => current.deferreds.drain(remainingSettlementTime()),
                () => current.queryClients.drainMutations(remainingSettlementTime()),
                ...(options.afterCancel ?? []),
                () => current.queryClients.clear(),
            ];
            try {
                let cleanupOperation;
                const dispose = async () => {
                    if (current.network)
                        await current.network.finish({ beforeCancel, afterCancel });
                    else {
                        const cleanupErrors = [];
                        await runCallbacks(beforeCancel, cleanupErrors);
                        await runCallbacks(afterCancel, cleanupErrors);
                        throwCollected(cleanupErrors, "Test suite lifecycle cleanup failed");
                    }
                };
                // The caller may throw before invoking cleanup or invoke it without awaiting. Keep one observed
                // operation so either misuse still disposes everything and cannot create an unhandled rejection.
                const cleanup = () => {
                    if (!cleanupOperation) {
                        cleanupOperation = dispose();
                        void cleanupOperation.catch(() => undefined);
                    }
                    return cleanupOperation;
                };
                try {
                    if (options.runCleanup)
                        await options.runCleanup(cleanup);
                }
                catch (error) {
                    errors.push(error);
                }
                try {
                    await cleanup();
                }
                catch (error) {
                    if (!errors.includes(error))
                        errors.push(error);
                }
            }
            finally {
                if (current.browser)
                    restoreBrowser(current.browser, errors);
            }
            throwCollected(errors, "Test suite lifecycle cleanup failed");
        },
    };
    hooks.afterEach(() => lifecycle.finish());
    hooks.beforeEach(async () => {
        state = {
            ...(options.browser ? { browser: captureBrowser(options.browser) } : {}),
            deferreds: new OwnedDeferreds(),
            queryClients: new OwnedQueryClients(),
            finished: false,
        };
        await options.prepare?.();
    });
    return lifecycle;
}
function requireActiveState(state) {
    if (!state)
        throw new Error("Test lifecycle is only available while a test is running");
    return state;
}
async function runCallbacks(callbacks, errors) {
    for (const callback of callbacks ?? []) {
        try {
            await callback();
        }
        catch (error) {
            errors.push(error);
        }
    }
}
function captureBrowser(options) {
    const descriptors = [
        [globalThis, "fetch", Object.getOwnPropertyDescriptor(globalThis, "fetch")],
        [globalThis, "scrollTo", Object.getOwnPropertyDescriptor(globalThis, "scrollTo")],
        [navigator, "clipboard", Object.getOwnPropertyDescriptor(navigator, "clipboard")],
    ];
    return {
        url: window.location.href,
        historyState: window.history.state,
        descriptors,
        attributes: (options.documentAttributes ?? []).map((name) => [name, document.documentElement.getAttribute(name)]),
        storages: captureStorages(),
    };
}
/**
 * Web storage outlives a rendered tree, so state an island persists — a draft typed and never sent — would
 * otherwise reach the next test of the file. An environment without a storage, or one whose getter throws,
 * has nothing to leak, so it is skipped rather than failing the capture.
 */
function captureStorages() {
    const storages = [];
    for (const name of ["localStorage", "sessionStorage"]) {
        let storage;
        try {
            storage = globalThis[name];
        }
        catch {
            continue;
        }
        if (storage === undefined)
            continue;
        const entries = [];
        for (let index = 0; index < storage.length; index++) {
            const key = storage.key(index);
            if (key !== null)
                entries.push([key, storage.getItem(key) ?? ""]);
        }
        storages.push([storage, entries]);
    }
    return storages;
}
function restoreBrowser(snapshot, errors) {
    for (const [target, key, descriptor] of snapshot.descriptors) {
        try {
            if (descriptor)
                Object.defineProperty(target, key, descriptor);
            else
                Reflect.deleteProperty(target, key);
        }
        catch (error) {
            errors.push(error);
        }
    }
    try {
        window.history.replaceState(snapshot.historyState, "", snapshot.url);
    }
    catch (error) {
        errors.push(error);
    }
    for (const [name, value] of snapshot.attributes) {
        try {
            if (value === null)
                document.documentElement.removeAttribute(name);
            else
                document.documentElement.setAttribute(name, value);
        }
        catch (error) {
            errors.push(error);
        }
    }
    for (const [storage, entries] of snapshot.storages) {
        try {
            storage.clear();
            for (const [key, value] of entries)
                storage.setItem(key, value);
        }
        catch (error) {
            errors.push(error);
        }
    }
}
function throwCollected(errors, message) {
    if (errors.length === 1)
        throw errors[0];
    if (errors.length > 1)
        throw new AggregateError(errors, `${message}:\n${errors.map((error) => String(error)).join("\n")}`);
}
