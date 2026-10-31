// @vitest-environment jsdom

import { createServer } from "node:http";
import { HttpResponse, http } from "msw";
import { expect, it, vi } from "vitest";
import { createHttpScenario } from "../../src/testing/http.js";

it("intercepts relative and absolute requests while preserving their body and headers", async () => {
	const scenario = createHttpScenario();
	scenario.use(
		http.post(new URL("/api/probe", location.href).href, async ({ request }) => {
			expect(request.headers.get("X-Auth-Guard")).toBe("manager");
			return HttpResponse.json(await request.json());
		}),
		http.get("https://gateway.test/probe", () => HttpResponse.json({ gateway: true })),
	);
	try {
		const response = await fetch("/api/probe", {
			method: "POST",
			headers: { "X-Auth-Guard": "manager", "Content-Type": "application/json" },
			body: JSON.stringify({ title: "probe" }),
		});
		expect(await response.json()).toEqual({ title: "probe" });
		expect(await (await fetch("https://gateway.test/probe")).json()).toEqual({ gateway: true });
	} finally {
		await scenario.finish();
	}
});

it.each(["/unmatched", "/unmatched.json"])(
	"rejects an unmatched %s request without reaching the real network",
	async (path) => {
		const receivedRequests: string[] = [];
		const networkBoundary = createServer((request, response) => {
			receivedRequests.push(request.url ?? "");
			response.end("escaped");
		});
		await new Promise<void>((resolve, reject) => {
			networkBoundary.once("error", reject);
			networkBoundary.listen(0, "127.0.0.1", resolve);
		});
		const originalFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
		let consoleError: ReturnType<typeof vi.spyOn> | undefined;
		let scenario: ReturnType<typeof createHttpScenario> | undefined;
		try {
			const address = networkBoundary.address();
			if (!address || typeof address === "string") throw new Error("Loopback server has no TCP address");
			const url = `http://127.0.0.1:${address.port}${path}`;
			consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
			scenario = createHttpScenario();
			await expect(fetch(url)).rejects.toThrow();
			expect(receivedRequests).toEqual([]);
			await expect(scenario.finish()).rejects.toThrow(`Unexpected request: GET ${url}`);
			expect(Object.getOwnPropertyDescriptor(globalThis, "fetch")).toEqual(originalFetch);
		} finally {
			await scenario?.finish().catch(() => undefined);
			consoleError?.mockRestore();
			await new Promise<void>((resolve, reject) => {
				networkBoundary.close((error) => (error ? reject(error) : resolve()));
			});
		}
	},
);

it("cancels and drains owned work and restores fetch even when cleanup and diagnostics both fail", async () => {
	const originalFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
	const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
	const scenario = createHttpScenario();
	try {
		const pending = scenario.deferResponse();
		scenario.use(
			http.post("https://gateway.test/pending", ({ request }) => pending.handle(request)),
			http.get("https://gateway.test/broken", () => {
				throw new Error("bad fixture");
			}),
		);
		let applicationFetchSettled = false;
		const writing = fetch("https://gateway.test/pending", { method: "POST" })
			.catch((error: unknown) => error)
			.finally(() => {
				applicationFetchSettled = true;
			});
		await vi.waitFor(() => expect(pending.request).toBeDefined());
		await fetch("https://gateway.test/missing?caught=yes").catch(() => undefined);
		expect((await fetch("https://gateway.test/broken")).status).toBe(500);
		await expect(
			scenario.finish({ beforeCancel: [() => Promise.reject(new Error("consumer cleanup failed"))] }),
		).rejects.toThrow(
			/consumer cleanup failed[\s\S]*Unexpected request: GET https:\/\/gateway\.test\/missing\?caught=yes[\s\S]*Handler failed: GET https:\/\/gateway\.test\/broken: Error: bad fixture/,
		);
		await expect(writing).resolves.toBeInstanceOf(TypeError);
		expect(applicationFetchSettled).toBe(true);
		expect(pending.state).toBe("cancelled");
		expect(Object.getOwnPropertyDescriptor(globalThis, "fetch")).toEqual(originalFetch);
	} finally {
		await scenario.finish().catch(() => undefined);
		consoleError.mockRestore();
	}
});

it("does not retain handlers or diagnostics between scenarios", async () => {
	const fixture = { owner: "initial" };
	const first = createHttpScenario(http.get("https://gateway.test/once", () => HttpResponse.json(fixture)));
	try {
		expect(await (await fetch("https://gateway.test/once")).json()).toEqual({ owner: "initial" });
		first.use(http.get("https://gateway.test/once", () => HttpResponse.json({ owner: "override" })));
		expect(await (await fetch("https://gateway.test/once")).json()).toEqual({ owner: "override" });
		fixture.owner = "changed";
	} finally {
		await first.finish();
	}

	const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
	const second = createHttpScenario();
	try {
		await fetch("https://gateway.test/once").catch(() => undefined);
		await expect(second.finish()).rejects.toThrow("Unexpected request: GET https://gateway.test/once");
	} finally {
		await second.finish().catch(() => undefined);
		consoleError.mockRestore();
	}

	const freshFixture = () => ({ owner: "fresh" });
	const third = createHttpScenario(http.get("https://gateway.test/once", () => HttpResponse.json(freshFixture())));
	try {
		const received = (await (await fetch("https://gateway.test/once")).json()) as { owner: string };
		received.owner = "changed by consumer";
		expect(await (await fetch("https://gateway.test/once")).json()).toEqual({ owner: "fresh" });
	} finally {
		await third.finish();
	}
});

it("reports a bounded drain while a controlled GET is pending and drains it after abort", async () => {
	const scenario = createHttpScenario();
	const response = scenario.deferResponse();
	const abort = new AbortController();
	scenario.use(http.get("https://gateway.test/pending", ({ request }) => response.handle(request)));
	const reading = fetch("https://gateway.test/pending", { signal: abort.signal }).catch((error: unknown) => error);
	try {
		await vi.waitFor(() => expect(response.request).toBeDefined());
		await expect(scenario.drain(5)).rejects.toThrow("HTTP scenario still owns 1 active fetch(es)");
		abort.abort();
		await scenario.drain();
		await expect(reading).resolves.toMatchObject({ name: "AbortError" });
		expect(response.state).toBe("cancelled");
	} finally {
		abort.abort();
		await scenario.finish();
	}
});

it("rolls back interception and releases ownership when installing observed fetch fails", async () => {
	const originalFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
	const defineProperty = Object.defineProperty;
	let rejectedWrapper = false;
	const replacement = vi.spyOn(Object, "defineProperty").mockImplementation((target, key, descriptor) => {
		if (target === globalThis && key === "fetch" && !rejectedWrapper) {
			rejectedWrapper = true;
			return defineProperty(target, key, { ...descriptor, writable: false });
		}
		return defineProperty(target, key, descriptor);
	});
	try {
		expect(() => createHttpScenario()).toThrow(/fetch/);
		expect(rejectedWrapper).toBe(true);
		expect(Object.getOwnPropertyDescriptor(globalThis, "fetch")).toEqual(originalFetch);
	} finally {
		replacement.mockRestore();
	}
	await expectFreshOwner();
});

it("closes interception and restores the descriptor when resetting fetch during teardown throws", async () => {
	const originalFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
	const scenario = createHttpScenario();
	const observedFetch = globalThis.fetch;
	Object.defineProperty(globalThis, "fetch", {
		configurable: true,
		get: () => observedFetch,
		set: () => {
			throw new Error("fetch reset failed");
		},
	});
	try {
		await expect(scenario.finish()).rejects.toThrow("fetch reset failed");
		expect(Object.getOwnPropertyDescriptor(globalThis, "fetch")).toEqual(originalFetch);
	} finally {
		await scenario.finish().catch(() => undefined);
		if (originalFetch) Object.defineProperty(globalThis, "fetch", originalFetch);
		else Reflect.deleteProperty(globalThis, "fetch");
	}
	await expectFreshOwner();
});

it("rejects overlapping owners before touching interception and permits a fresh owner after finish", async () => {
	const first = createHttpScenario(http.get("https://gateway.test/owner", () => HttpResponse.text("first")));
	const fetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
	try {
		expect(() => createHttpScenario()).toThrow(/already owns interception[\s\S]*no it.concurrent/);
		expect(Object.getOwnPropertyDescriptor(globalThis, "fetch")).toEqual(fetchDescriptor);
		expect(await (await fetch("https://gateway.test/owner")).text()).toBe("first");
	} finally {
		await first.finish();
	}
	await expectFreshOwner();
});

it("keeps controlled completion and duplicate request diagnostics", async () => {
	const scenario = createHttpScenario();
	try {
		const response = scenario.deferResponse();
		const request = new Request("https://gateway.test/duplicate");
		const handling = response.handle(request);
		await expect(response.handle(request)).rejects.toThrow(
			"Duplicate controlled request: GET https://gateway.test/duplicate",
		);
		const released = Response.json({ acknowledged: true });
		response.release(released);
		await expect(handling).resolves.toBe(released);
		expect(() => response.release(Response.json({}))).toThrow("Cannot release released response");
		response.cancel();
		expect(response.state).toBe("released");

		const aborted = scenario.deferResponse();
		const abort = new AbortController();
		abort.abort();
		const cancelled = await aborted.handle(new Request("https://gateway.test/aborted", { signal: abort.signal }));
		expect(cancelled.type).toBe("error");
		expect(aborted.state).toBe("cancelled");
		expect(() => aborted.release(Response.json({}))).toThrow("Cannot release cancelled response");
	} finally {
		await scenario.finish();
	}
});

async function expectFreshOwner() {
	const fresh = createHttpScenario(http.get("https://gateway.test/fresh", () => HttpResponse.text("fresh")));
	try {
		expect(await (await fetch("https://gateway.test/fresh")).text()).toBe("fresh");
	} finally {
		await fresh.finish();
	}
}
