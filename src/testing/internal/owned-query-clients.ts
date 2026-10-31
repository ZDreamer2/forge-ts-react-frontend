import { QueryClient, type QueryClientConfig } from "@tanstack/query-core";

const SETTLEMENT_TIMEOUT_MS = 1_000;

export class OwnedQueryClients {
	readonly #clients = new Set<QueryClient>();

	create(config?: QueryClientConfig) {
		const client = new QueryClient(config);
		this.#clients.add(client);
		return client;
	}

	async cancelQueries() {
		const errors: unknown[] = [];
		for (const client of this.#clients) {
			try {
				await client.cancelQueries();
			} catch (error) {
				errors.push(error);
			}
		}
		throwCollected(errors, "Owned QueryClient cancellation failed");
	}

	async drainMutations(timeoutMs = SETTLEMENT_TIMEOUT_MS) {
		const deadline = Date.now() + timeoutMs;
		while (this.#pendingMutations().length > 0 && Date.now() < deadline)
			await new Promise((resolve) => setTimeout(resolve, 0));
		const pending = this.#pendingMutations();
		if (pending.length > 0) throw new Error(`Owned QueryClient mutations did not settle: ${pending.join(", ")}`);
	}

	clear() {
		const errors: unknown[] = [];
		for (const client of this.#clients) {
			try {
				client.clear();
			} catch (error) {
				errors.push(error);
			}
		}
		throwCollected(errors, "Owned QueryClient disposal failed");
	}

	#pendingMutations() {
		return [...this.#clients].flatMap((client, clientIndex) =>
			client
				.getMutationCache()
				.getAll()
				.filter((mutation) => mutation.state.status === "pending")
				.map((mutation) => `client ${clientIndex + 1} mutation ${formatKey(mutation.options.mutationKey)}`),
		);
	}
}

function formatKey(key: readonly unknown[] | undefined) {
	if (!key) return "<unkeyed>";
	try {
		return JSON.stringify(key);
	} catch {
		return "<unserializable key>";
	}
}

function throwCollected(errors: unknown[], message: string) {
	if (errors.length === 1) throw errors[0];
	if (errors.length > 1) throw new AggregateError(errors, `${message}:\n${errors.map(String).join("\n")}`);
}
