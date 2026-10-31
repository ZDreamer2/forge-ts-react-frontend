// @vitest-environment jsdom

import type { QueryClient } from "@tanstack/query-core";
import { http } from "msw";
import { expect, it, vi } from "vitest";
import { registerTestSuiteLifecycle } from "../../src/testing/internal/lifecycle-owner.js";

it("registers and clears a QueryClient when later preparation fails", async () => {
	let prepare!: () => void | Promise<void>;
	let finish!: () => void | Promise<void>;
	let client!: QueryClient;
	const suite = registerTestSuiteLifecycle(
		{
			prepare() {
				client = suite.createQueryClient({ defaultOptions: { queries: { retry: false } } });
				client.setQueryData(["prepared"], "cached");
				throw new Error("later preparation failed");
			},
		},
		{
			afterEach(callback) {
				finish = callback;
			},
			beforeEach(callback) {
				prepare = callback;
			},
		},
	);

	await expect(prepare()).rejects.toThrow("later preparation failed");
	await finish();
	expect(client.getQueryCache().getAll()).toHaveLength(0);
	expect(() => suite.createQueryClient()).toThrow("Cannot create a QueryClient after the test lifecycle finished");
});

it("cleans and restores browser state when preparation fails before HTTP starts", async () => {
	const originalUrl = window.location.href;
	const originalState = window.history.state;
	const originalScrollTo = Object.getOwnPropertyDescriptor(globalThis, "scrollTo");
	let prepare!: () => void | Promise<void>;
	let finish!: () => void | Promise<void>;
	let cleaned = false;
	let partiallyPreparedWork: Promise<string> | undefined;
	const partiallyPrepared = document.createElement("div");
	partiallyPrepared.textContent = "partially prepared";
	const suite = registerTestSuiteLifecycle(
		{
			browser: { documentAttributes: ["data-lifecycle-probe"] },
			prepare() {
				const work = suite.defer({
					label: "partially prepared work",
					unfinished: { type: "resolve", value: "released" },
				});
				partiallyPreparedWork = work.promise;
				window.history.pushState({ changed: true }, "", "/preparation-failed");
				document.documentElement.setAttribute("data-lifecycle-probe", "changed");
				Object.defineProperty(globalThis, "scrollTo", { configurable: true, value: () => {} });
				document.body.append(partiallyPrepared);
				throw new Error("preparation failed");
			},
			beforeCancel: [
				() => {
					partiallyPrepared.remove();
					cleaned = true;
				},
			],
		},
		{
			afterEach(callback) {
				finish = callback;
			},
			beforeEach(callback) {
				prepare = callback;
			},
		},
	);

	try {
		await expect(prepare()).rejects.toThrow("preparation failed");
		await finish();
		await expect(partiallyPreparedWork).resolves.toBe("released");
		expect(cleaned).toBe(true);
		expect(document.body.textContent).not.toContain("partially prepared");
		expect(window.location.href).toBe(originalUrl);
		expect(window.history.state).toEqual(originalState);
		expect(document.documentElement.hasAttribute("data-lifecycle-probe")).toBe(false);
		expect(Object.getOwnPropertyDescriptor(globalThis, "scrollTo")).toEqual(originalScrollTo);
	} finally {
		partiallyPrepared.remove();
		await suite.finish().catch(() => undefined);
	}
});

it("attempts specialized phases, HTTP diagnostics and browser restoration once on early finish", async () => {
	const originalUrl = window.location.href;
	const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
	let prepare!: () => void | Promise<void>;
	let automaticFinish!: () => void | Promise<void>;
	const calls: string[] = [];
	const suite = registerTestSuiteLifecycle(
		{
			browser: {},
			beforeCancel: [
				() => {
					calls.push("before-throws");
					throw new Error("consumer cleanup failed");
				},
				() => {
					calls.push("before-after-throw");
				},
			],
			afterCancel: [
				() => {
					calls.push("after");
				},
			],
		},
		{
			afterEach(callback) {
				automaticFinish = callback;
			},
			beforeEach(callback) {
				prepare = callback;
			},
		},
	);

	try {
		await prepare();
		const network = suite.createHttpScenario();
		const pending = network.deferResponse();
		network.use(http.post("https://gateway.test/pending", ({ request }) => pending.handle(request)));
		window.history.pushState({ changed: true }, "", "/early-finish");
		const writing = fetch("https://gateway.test/pending", { method: "POST" }).catch((error: unknown) => error);
		await vi.waitFor(() => expect(pending.request).toBeDefined());
		await fetch("https://gateway.test/missing").catch(() => undefined);
		await expect(suite.finish()).rejects.toThrow(
			/consumer cleanup failed[\s\S]*Unexpected request: GET https:\/\/gateway\.test\/missing/,
		);
		expect(calls).toEqual(["before-throws", "before-after-throw", "after"]);
		expect(pending.state).toBe("cancelled");
		await expect(writing).resolves.toBeInstanceOf(TypeError);
		expect(window.location.href).toBe(originalUrl);
		await expect(suite.finish()).resolves.toBeUndefined();
		await expect(automaticFinish()).resolves.toBeUndefined();
		expect(calls).toHaveLength(3);
		expect(() => network.use()).toThrow("Cannot add handlers after the HTTP scenario finished");
	} finally {
		await suite.finish().catch(() => undefined);
		consoleError.mockRestore();
	}
});

it("starts the owned HTTP scenario with base handlers that later handlers override", async () => {
	let prepare!: () => void | Promise<void>;
	let finish!: () => void | Promise<void>;
	const suite = registerTestSuiteLifecycle(
		{},
		{
			afterEach(callback) {
				finish = callback;
			},
			beforeEach(callback) {
				prepare = callback;
			},
		},
	);

	try {
		await prepare();
		const network = suite.createHttpScenario(
			http.get("https://gateway.test/owner", () => Response.json({ owner: "base" })),
			http.get("https://gateway.test/kept", () => Response.json({ owner: "base" })),
		);
		network.use(http.get("https://gateway.test/owner", () => Response.json({ owner: "override" })));
		expect(await (await fetch("https://gateway.test/owner")).json()).toEqual({ owner: "override" });
		expect(await (await fetch("https://gateway.test/kept")).json()).toEqual({ owner: "base" });
		await expect(finish()).resolves.toBeUndefined();
	} finally {
		await suite.finish().catch(() => undefined);
	}
});

it("continues restoring browser state when one restoration operation throws", async () => {
	const originalUrl = window.location.href;
	const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
	const defineProperty = Object.defineProperty;
	let prepare!: () => void | Promise<void>;
	let finish!: () => void | Promise<void>;
	Object.defineProperty(navigator, "clipboard", { configurable: true, value: { baseline: true } });
	const suite = registerTestSuiteLifecycle(
		{
			browser: { documentAttributes: ["data-lifecycle-probe"] },
			beforeCancel: [
				() => {
					throw new Error("cleanup also failed");
				},
			],
		},
		{
			afterEach(callback) {
				finish = callback;
			},
			beforeEach(callback) {
				prepare = callback;
			},
		},
	);
	try {
		await prepare();
		window.history.pushState({ changed: true }, "", "/restore-failure");
		document.documentElement.setAttribute("data-lifecycle-probe", "changed");
		Object.defineProperty(navigator, "clipboard", { configurable: true, value: { changed: true } });
		Object.defineProperty = ((target: object, key: PropertyKey, descriptor: PropertyDescriptor) => {
			if (target === navigator && key === "clipboard") throw new Error("clipboard restore failed");
			return defineProperty(target, key, descriptor);
		}) as typeof Object.defineProperty;

		await expect(finish()).rejects.toThrow(/cleanup also failed[\s\S]*clipboard restore failed/);
		expect(window.location.href).toBe(originalUrl);
		expect(document.documentElement.hasAttribute("data-lifecycle-probe")).toBe(false);
	} finally {
		Object.defineProperty = defineProperty;
		await suite.finish().catch(() => undefined);
		if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
		else Reflect.deleteProperty(navigator, "clipboard");
	}
});

it("restores web storage to its captured contents, with or without a failed cleanup", async () => {
	let prepare!: () => void | Promise<void>;
	let finish!: () => void | Promise<void>;
	let failCleanup = false;
	localStorage.setItem("lifecycle-probe:baseline", "before");
	sessionStorage.setItem("lifecycle-probe:baseline", "before");
	const suite = registerTestSuiteLifecycle(
		{
			browser: {},
			beforeCancel: [
				() => {
					if (failCleanup) throw new Error("cleanup failed");
				},
			],
		},
		{
			afterEach(callback) {
				finish = callback;
			},
			beforeEach(callback) {
				prepare = callback;
			},
		},
	);
	try {
		for (const failing of [false, true]) {
			failCleanup = failing;
			await prepare();
			localStorage.setItem("lifecycle-probe:written", "during");
			localStorage.setItem("lifecycle-probe:baseline", "changed");
			sessionStorage.removeItem("lifecycle-probe:baseline");
			sessionStorage.setItem("lifecycle-probe:written", "during");

			if (failing) await expect(finish()).rejects.toThrow("cleanup failed");
			else await finish();

			expect(localStorage.getItem("lifecycle-probe:written")).toBeNull();
			expect(localStorage.getItem("lifecycle-probe:baseline")).toBe("before");
			expect(sessionStorage.getItem("lifecycle-probe:written")).toBeNull();
			expect(sessionStorage.getItem("lifecycle-probe:baseline")).toBe("before");
		}
	} finally {
		await suite.finish().catch(() => undefined);
		localStorage.removeItem("lifecycle-probe:baseline");
		sessionStorage.removeItem("lifecycle-probe:baseline");
	}
});

it("owns deferred resolve and reject outcomes from preparation through cleanup", async () => {
	let prepare!: () => void | Promise<void>;
	let finish!: () => void | Promise<void>;
	let fallbackResolved!: Promise<string>;
	let fallbackRejected!: Promise<unknown>;
	let explicitResolved!: Promise<string>;
	let explicitRejected!: Promise<unknown>;
	const suite = registerTestSuiteLifecycle(
		{
			prepare() {
				const resolved = suite.defer({
					label: "fallback success",
					unfinished: { type: "resolve", value: "fallback" },
				});
				fallbackResolved = resolved.promise;
				const rejected = suite.defer<string>({
					label: "fallback failure",
					unfinished: { type: "reject", reason: new Error("cancelled fallback") },
				});
				fallbackRejected = rejected.promise;
				const firstResolve = suite.defer<string>({
					label: "explicit success",
					unfinished: { type: "reject", reason: new Error("must not replace success") },
				});
				firstResolve.resolve("first");
				firstResolve.reject(new Error("second"));
				firstResolve.resolve("third");
				explicitResolved = firstResolve.promise;
				const firstReject = suite.defer<string>({
					label: "explicit failure",
					unfinished: { type: "resolve", value: "must not replace failure" },
				});
				firstReject.reject(new Error("first rejection"));
				firstReject.resolve("second");
				explicitRejected = firstReject.promise;
			},
		},
		{
			afterEach(callback) {
				finish = callback;
			},
			beforeEach(callback) {
				prepare = callback;
			},
		},
	);

	expect(() => suite.defer({ label: "outside test", unfinished: { type: "resolve", value: undefined } })).toThrow(
		"Test lifecycle is only available while a test is running",
	);
	await prepare();
	await finish();
	await expect(fallbackResolved).resolves.toBe("fallback");
	await expect(fallbackRejected).rejects.toThrow("cancelled fallback");
	await expect(explicitResolved).resolves.toBe("first");
	await expect(explicitRejected).rejects.toThrow("first rejection");
	expect(() => suite.defer({ label: "finished test", unfinished: { type: "resolve", value: undefined } })).toThrow(
		"Cannot defer work after the test lifecycle finished",
	);
	await expect(suite.finish()).resolves.toBeUndefined();
});

it("attempts deferred and HTTP cleanup phases in order after caller cleanup fails", async () => {
	const originalFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
	let prepare!: () => void | Promise<void>;
	let finish!: () => void | Promise<void>;
	const calls: string[] = [];
	let response: { readonly state: string } | undefined;
	const suite = registerTestSuiteLifecycle(
		{
			browser: {},
			beforeCancel: [
				() => {
					calls.push("before-throws");
					throw new Error("scenario cleanup failed");
				},
				() => {
					calls.push("before-continues");
				},
			],
			afterCancel: [
				() => {
					calls.push(`after:${response?.state}`);
				},
			],
		},
		{
			afterEach(callback) {
				finish = callback;
			},
			beforeEach(callback) {
				prepare = callback;
			},
		},
	);

	try {
		await prepare();
		const deferred = suite.defer({
			label: "ordered deferred",
			unfinished: { type: "resolve", value: "fallback" },
		});
		void deferred.promise.then(() => calls.push("deferred-settled"));
		const client = suite.createQueryClient();
		client.setQueryData(["disposed"], "cached");
		void client
			.fetchQuery({
				queryKey: ["cancel-before-outcome"],
				queryFn: ({ signal }) =>
					new Promise<string>((resolve) => {
						signal.addEventListener("abort", () => calls.push("query-cancelled"), { once: true });
						void deferred.promise.then(resolve);
					}),
			})
			.catch(() => undefined);
		const network = suite.createHttpScenario();
		response = network.deferResponse();
		await expect(finish()).rejects.toThrow("scenario cleanup failed");
		expect(calls).toEqual([
			"before-throws",
			"before-continues",
			"query-cancelled",
			"deferred-settled",
			"after:cancelled",
		]);
		expect(client.getQueryCache().getAll()).toHaveLength(0);
		expect(Object.getOwnPropertyDescriptor(globalThis, "fetch")).toEqual(originalFetch);
	} finally {
		await suite.finish().catch(() => undefined);
	}
});

it("waits for asynchronous mutation settlement before caller cleanup and disposal", async () => {
	let prepare!: () => void | Promise<void>;
	let finish!: () => void | Promise<void>;
	const calls: string[] = [];
	let client!: QueryClient;
	const suite = registerTestSuiteLifecycle(
		{
			afterCancel: [() => void calls.push(`after:${client.isMutating()}:${client.getMutationCache().getAll().length}`)],
		},
		{
			afterEach(callback) {
				finish = callback;
			},
			beforeEach(callback) {
				prepare = callback;
			},
		},
	);

	await prepare();
	client = suite.createQueryClient();
	const result = suite.defer({ label: "mutation result", unfinished: { type: "resolve", value: "saved" } });
	const mutation = client.getMutationCache().build(client, {
		mutationKey: ["save", 42],
		mutationFn: () => result.promise,
		onSettled: async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
			calls.push("settled");
		},
	});
	void mutation.execute(undefined);

	await finish();
	expect(calls).toEqual(["settled", "after:0:1"]);
	expect(client.getMutationCache().getAll()).toHaveLength(0);
});

it.each([false, true])(
	"bounds all unresolved deferred work, continues cleanup, restores state and starts fresh (HTTP: %s)",
	async (withHttp) => {
		const originalUrl = window.location.href;
		const originalFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
		let prepare!: () => void | Promise<void>;
		let finish!: () => void | Promise<void>;
		let failAfterCleanup = true;
		const afterCalls: string[] = [];
		const suite = registerTestSuiteLifecycle(
			{
				browser: {},
				afterCancel: [
					() => {
						afterCalls.push("first");
						if (failAfterCleanup) {
							failAfterCleanup = false;
							throw new Error("after cleanup failed");
						}
					},
					() => {
						afterCalls.push("second");
					},
				],
			},
			{
				afterEach(callback) {
					finish = callback;
				},
				beforeEach(callback) {
					prepare = callback;
				},
			},
		);

		await prepare();
		window.history.pushState({}, "", "/unresolved-deferred");
		const response = withHttp ? suite.createHttpScenario().deferResponse() : undefined;
		const first = suite.defer<string>({
			label: "assimilated first",
			unfinished: { type: "resolve", value: "unused" },
		});
		const second = suite.defer<string>({
			label: "assimilated second",
			unfinished: { type: "resolve", value: "unused" },
		});
		first.resolve(new Promise(() => {}));
		second.resolve(new Promise(() => {}));
		const firstClient = suite.createQueryClient();
		const secondClient = suite.createQueryClient();
		for (const [client, key] of [
			[firstClient, ["first mutation"]],
			[secondClient, ["second mutation"]],
		] as const) {
			client.setQueryData(["must clear"], "cached");
			const mutation = client.getMutationCache().build(client, {
				mutationKey: key,
				mutationFn: () => new Promise(() => {}),
			});
			void mutation.execute(undefined);
		}
		vi.useFakeTimers();
		let cleanupError: unknown;
		try {
			let completed = false;
			const finishing = Promise.resolve(finish()).then(
				() => {
					completed = true;
				},
				(error: unknown) => {
					completed = true;
					cleanupError = error;
				},
			);
			await vi.advanceTimersByTimeAsync(999);
			expect(completed).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			await finishing;
		} finally {
			vi.useRealTimers();
		}
		expect(String(cleanupError)).toMatch(
			/assimilated first[\s\S]*assimilated second[\s\S]*first mutation[\s\S]*second mutation[\s\S]*after cleanup failed/,
		);
		expect(afterCalls).toEqual(["first", "second"]);
		expect(firstClient.getQueryCache().getAll()).toHaveLength(0);
		expect(secondClient.getQueryCache().getAll()).toHaveLength(0);
		expect(window.location.href).toBe(originalUrl);
		expect(response?.state).toBe(withHttp ? "cancelled" : undefined);
		expect(Object.getOwnPropertyDescriptor(globalThis, "fetch")).toEqual(originalFetch);

		await prepare();
		const fresh = suite.defer({ label: "fresh", unfinished: { type: "resolve", value: "fresh fallback" } });
		await expect(finish()).resolves.toBeUndefined();
		await expect(fresh.promise).resolves.toBe("fresh fallback");
		expect(afterCalls).toEqual(["first", "second", "first", "second"]);
	},
);

it.each(["throws before cleanup", "omits cleanup", "does not await cleanup", "invokes twice"] as const)(
	"disposes owned work once and starts fresh when the cleanup wrapper %s",
	async (wrapperBehavior) => {
		const originalFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
		const originalUrl = window.location.href;
		let prepare!: () => void | Promise<void>;
		let cleanupCalls = 0;
		let failWrapper = true;
		const suite = registerTestSuiteLifecycle(
			{
				browser: {},
				beforeCancel: [
					async () => {
						await new Promise((resolve) => setTimeout(resolve, 0));
						cleanupCalls++;
					},
				],
				async runCleanup(cleanup) {
					if (failWrapper) {
						if (wrapperBehavior === "throws before cleanup") throw new Error("wrapper failed before cleanup");
						if (wrapperBehavior === "omits cleanup") return;
						if (wrapperBehavior === "does not await cleanup") {
							void cleanup();
							return;
						}
						await Promise.all([cleanup(), cleanup()]);
						return;
					}
					await cleanup();
				},
			},
			{
				beforeEach(callback) {
					prepare = callback;
				},
				afterEach() {},
			},
		);
		try {
			await prepare();
			const deferred = suite.defer({ label: "wrapper fallback", unfinished: { type: "resolve", value: "settled" } });
			const client = suite.createQueryClient();
			client.setQueryData(["wrapper cached"], "clear me");
			const response = suite.createHttpScenario().deferResponse();
			window.history.pushState({}, "", "/wrapper-failed");
			if (wrapperBehavior === "throws before cleanup")
				await expect(suite.finish()).rejects.toThrow("wrapper failed before cleanup");
			else await suite.finish();
			expect(cleanupCalls).toBe(1);
			await expect(deferred.promise).resolves.toBe("settled");
			expect(client.getQueryCache().getAll()).toHaveLength(0);
			expect(response.state).toBe("cancelled");
			expect(window.location.href).toBe(originalUrl);
			expect(Object.getOwnPropertyDescriptor(globalThis, "fetch")).toEqual(originalFetch);
			await suite.finish();
			expect(cleanupCalls).toBe(1);

			failWrapper = false;
			await prepare();
			const fresh = suite.createHttpScenario();
			const freshResponse = fresh.deferResponse();
			await suite.finish();
			expect(freshResponse.state).toBe("cancelled");
			expect(cleanupCalls).toBe(2);
		} finally {
			await suite.finish().catch(() => undefined);
		}
	},
);

it("collects independent wrapper and cleanup failures without repeating disposal", async () => {
	let prepare!: () => void | Promise<void>;
	let cleanupCalls = 0;
	const cleanupError = new Error("owned cleanup failed");
	const wrapperError = new Error("wrapper also failed");
	const suite = registerTestSuiteLifecycle(
		{
			beforeCancel: [
				async () => {
					cleanupCalls++;
					await new Promise((resolve) => setTimeout(resolve, 0));
					throw cleanupError;
				},
			],
			async runCleanup(cleanup) {
				void cleanup();
				throw wrapperError;
			},
		},
		{
			beforeEach(callback) {
				prepare = callback;
			},
			afterEach() {},
		},
	);
	await prepare();
	const client = suite.createQueryClient();
	client.setQueryData(["must clear"], "cached");
	const failure = await suite.finish().catch((error: unknown) => error);
	expect(failure).toBeInstanceOf(AggregateError);
	expect((failure as AggregateError).errors).toEqual([wrapperError, cleanupError]);
	expect(cleanupCalls).toBe(1);
	expect(client.getQueryCache().getAll()).toHaveLength(0);
	await suite.finish();
	expect(cleanupCalls).toBe(1);
});

it("preserves a cleanup rejection through an awaiting wrapper without counting it twice", async () => {
	let prepare!: () => void | Promise<void>;
	const cleanupError = new Error("single cleanup failure");
	const suite = registerTestSuiteLifecycle(
		{
			beforeCancel: [
				() => {
					throw cleanupError;
				},
			],
			runCleanup: (cleanup) => cleanup(),
		},
		{
			beforeEach(callback) {
				prepare = callback;
			},
			afterEach() {},
		},
	);
	await prepare();
	await expect(suite.finish()).rejects.toBe(cleanupError);
});
