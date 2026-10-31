import { HttpResponse, http, type RequestHandler } from "msw";
import { setupServer } from "msw/node";

export type ControlledResponseState = "pending" | "released" | "cancelled";

export interface ControlledResponse {
	readonly request: Request | undefined;
	readonly state: ControlledResponseState;
	handle(request: Request): Promise<Response>;
	release(response: Response): void;
	cancel(): void;
}

export interface FinishHttpScenario {
	/** Runs first, for consumer unmount and cancellation of work it owns. Each callback is attempted. */
	beforeCancel?: Array<() => void | Promise<void>>;
	/** Runs after controlled responses are cancelled, for bounded consumer continuation settling and disposal. */
	afterCancel?: Array<() => void | Promise<void>>;
}

export interface HttpScenario {
	deferResponse(): ControlledResponse;
	use(...handlers: RequestHandler[]): void;
	/** Waits only for application-facing fetch promises, not response-body or framework continuations. */
	drain(timeoutMs?: number): Promise<void>;
	/** Always cancels gates, drains fetches, checks diagnostics, closes interception and restores fetch exactly. */
	finish(cleanup?: FinishHttpScenario, timeoutMs?: number): Promise<void>;
}

let activeOwner = false;

/**
 * Starts isolated, opt-in interception. Use one owner in a sequential scenario (never `it.concurrent`) and
 * always call `finish` from teardown or `finally`. Endpoint handlers and payloads stay with the consumer.
 */
export function createHttpScenario(...handlers: RequestHandler[]): HttpScenario {
	if (activeOwner)
		throw new Error(
			"An HTTP scenario already owns interception in this environment; finish it before starting another (no it.concurrent)",
		);
	activeOwner = true;
	const originalFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
	const failures: string[] = [];
	const activeFetches = new Set<Promise<void>>();
	const responses = new Set<ControlledResponse>();
	let server: ReturnType<typeof setupServer> | undefined;
	let interceptedFetch: typeof fetch | undefined;
	let finished = false;
	try {
		// MSW's built-in unhandled-request strategy permits common asset paths, so isolation needs a final handler.
		server = setupServer(
			...handlers,
			http.all("*", ({ request }) => {
				failures.push(`Unexpected request: ${request.method} ${request.url}`);
				return HttpResponse.error();
			}),
		);

		server.events.on("unhandledException", ({ request, error }) => {
			failures.push(`Handler failed: ${request.method} ${request.url}: ${String(error)}`);
		});
		server.listen({ onUnhandledRequest: "error" });

		interceptedFetch = globalThis.fetch;
		const fetchRequest = interceptedFetch;
		globalThis.fetch = function observedFetch(input, init) {
			const result = fetchRequest(input, init);
			let observed: Promise<void>;
			const settled = () => void activeFetches.delete(observed);
			observed = result.then(settled, settled);
			activeFetches.add(observed);
			return result;
		};
	} catch (error) {
		const errors: unknown[] = [error];
		restoreInterception(errors);
		throwCollected(errors, "HTTP scenario startup failed");
		throw error;
	}

	// Each restoration is independent: a hostile fetch descriptor must not leave MSW interception installed.
	function restoreInterception(errors: unknown[]) {
		for (const restore of [
			() => {
				if (interceptedFetch) globalThis.fetch = interceptedFetch;
			},
			() => server?.close(),
			() => restoreDescriptor("fetch", originalFetch),
		]) {
			try {
				restore();
			} catch (error) {
				errors.push(error);
			}
		}
		activeOwner = false;
	}

	const cancelPending = () => {
		for (const response of responses) response.cancel();
	};

	return {
		deferResponse() {
			if (finished) throw new Error("Cannot create a response after the HTTP scenario finished");
			const response = controlledResponse();
			responses.add(response);
			return response;
		},
		use(...nextHandlers) {
			if (finished) throw new Error("Cannot add handlers after the HTTP scenario finished");
			server?.use(...nextHandlers);
		},
		drain(timeoutMs = 1_000) {
			return drain(activeFetches, timeoutMs);
		},
		async finish(cleanup = {}, timeoutMs = 1_000) {
			if (finished) return;
			finished = true;
			const errors: unknown[] = [];
			try {
				await runCleanup(cleanup.beforeCancel, errors);
				cancelPending();
				await runCleanup(cleanup.afterCancel, errors);
				try {
					await drain(activeFetches, timeoutMs);
				} catch (error) {
					errors.push(error);
				}
				if (failures.length > 0) errors.push(new Error(`HTTP scenario setup failures:\n${failures.join("\n")}`));
			} finally {
				restoreInterception(errors);
			}
			throwCollected(errors, "HTTP scenario teardown failed");
		},
	};
}

async function runCleanup(callbacks: FinishHttpScenario["beforeCancel"], errors: unknown[]) {
	for (const callback of callbacks ?? []) {
		try {
			await callback();
		} catch (error) {
			errors.push(error);
		}
	}
}

function controlledResponse(): ControlledResponse {
	let state: ControlledResponseState = "pending";
	let request: Request | undefined;
	let resolve!: (response: Response) => void;
	const response = new Promise<Response>((done) => {
		resolve = done;
	});
	function cancel() {
		if (state !== "pending") return;
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
			if (request) throw new Error(`Duplicate controlled request: ${received.method} ${received.url}`);
			request = received;
			received.signal.addEventListener("abort", cancel, { once: true });
			if (received.signal.aborted) cancel();
			try {
				return await response;
			} finally {
				received.signal.removeEventListener("abort", cancel);
			}
		},
		release(value) {
			if (state !== "pending") throw new Error(`Cannot release ${state} response`);
			state = "released";
			resolve(value);
		},
		cancel,
	};
}

async function drain(activeFetches: Set<Promise<void>>, timeoutMs: number) {
	const deadline = Date.now() + timeoutMs;
	while (activeFetches.size > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 0));
	if (activeFetches.size > 0) throw new Error(`HTTP scenario still owns ${activeFetches.size} active fetch(es)`);
}

function restoreDescriptor(key: "fetch", descriptor: PropertyDescriptor | undefined) {
	if (descriptor) Object.defineProperty(globalThis, key, descriptor);
	else Reflect.deleteProperty(globalThis, key);
}

function throwCollected(errors: unknown[], message: string) {
	if (errors.length === 1) throw errors[0];
	if (errors.length > 1)
		throw new AggregateError(errors, `${message}:\n${errors.map((error) => String(error)).join("\n")}`);
}
