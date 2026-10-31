import { MutationCache, QueryCache } from "@tanstack/query-core";
import { expect, it, vi } from "vitest";
import { OwnedQueryClients } from "../../src/testing/internal/owned-query-clients.js";

it("preserves configuration and cancels real queries before controlled outcomes", async () => {
	const owner = new OwnedQueryClients();
	const defaultOptions = { queries: { retry: 7 } } as const;
	const queryCache = new QueryCache();
	const mutationCache = new MutationCache();
	const client = owner.create({ defaultOptions, queryCache, mutationCache });
	const events: string[] = [];
	let release!: () => void;
	const outcome = new Promise<void>((resolve) => {
		release = resolve;
	});
	const query = client
		.fetchQuery({
			queryKey: ["owned", 42],
			queryFn: ({ signal }) =>
				new Promise<string>((resolve) => {
					signal.addEventListener("abort", () => events.push("query aborted"), { once: true });
					void outcome.then(() => {
						events.push("outcome released");
						resolve("late result");
					});
				}),
		})
		.catch((error: unknown) => error);

	try {
		expect(client.getDefaultOptions()).toEqual(defaultOptions);
		expect(client.getQueryCache()).toBe(queryCache);
		expect(client.getMutationCache()).toBe(mutationCache);
		await owner.cancelQueries();
		release();
		await outcome;
		await query;
		expect(events).toEqual(["query aborted", "outcome released"]);
	} finally {
		release();
		await query;
		owner.clear();
	}
	expect(client.getQueryCache().getAll()).toHaveLength(0);
});

it("waits through asynchronous mutation settlement callbacks", async () => {
	const owner = new OwnedQueryClients();
	const client = owner.create();
	let releaseMutation!: () => void;
	let releaseSettled!: () => void;
	const mutationResult = new Promise<void>((resolve) => {
		releaseMutation = resolve;
	});
	const settled = new Promise<void>((resolve) => {
		releaseSettled = resolve;
	});
	const mutation = client.getMutationCache().build(client, {
		mutationKey: ["save", 17],
		mutationFn: () => mutationResult,
		onSettled: () => settled,
	});
	const execution = mutation.execute(undefined);

	try {
		releaseMutation();
		await mutationResult;
		let drained = false;
		const draining = owner.drainMutations().then(() => {
			drained = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(drained).toBe(false);
		releaseSettled();
		await execution;
		await draining;
		expect(mutation.state.status).toBe("success");
	} finally {
		releaseMutation();
		releaseSettled();
		await execution.catch(() => undefined);
		owner.clear();
	}
});

it("bounds all clients with useful mutation diagnostics", async () => {
	const owner = new OwnedQueryClients();
	const first = owner.create();
	const second = owner.create();
	for (const [client, key] of [
		[first, ["first", 1]],
		[second, ["second", 2]],
	] as const) {
		const mutation = client.getMutationCache().build(client, {
			mutationKey: key,
			mutationFn: () => new Promise(() => {}),
		});
		void mutation.execute(undefined);
	}

	try {
		await expect(owner.drainMutations(10)).rejects.toThrow(
			/Owned QueryClient mutations did not settle: client 1 mutation \["first",1\], client 2 mutation \["second",2\]/,
		);
	} finally {
		owner.clear();
	}
});

it("attempts to clear every client after another client fails", () => {
	const owner = new OwnedQueryClients();
	const failing = owner.create();
	const cleared = owner.create();
	cleared.setQueryData(["cached"], "value");
	vi.spyOn(failing, "clear").mockImplementation(() => {
		throw new Error("first clear failed");
	});

	expect(() => owner.clear()).toThrow("first clear failed");
	expect(cleared.getQueryCache().getAll()).toHaveLength(0);
});
