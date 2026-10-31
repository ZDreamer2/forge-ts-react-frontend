import type { DeferredOutcome, OwnedDeferred } from "./types.js";

interface TrackedDeferred {
	readonly label: string;
	readonly applyUnfinished: () => void;
	readonly settled: Promise<void>;
	readonly isSettled: () => boolean;
}

export class OwnedDeferreds {
	readonly #deferreds = new Set<TrackedDeferred>();

	defer<T>(options: { label: string; unfinished: DeferredOutcome<T> }): OwnedDeferred<T> {
		let complete = false;
		let settled = false;
		let resolvePromise!: (value: T | PromiseLike<T>) => void;
		let rejectPromise!: (reason: unknown) => void;
		const promise = new Promise<T>((resolve, reject) => {
			resolvePromise = resolve;
			rejectPromise = reject;
		});
		// Observe rejection immediately. Consumers still receive the original promise and its rejection.
		const settledPromise = promise.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		const resolve = (value: T | PromiseLike<T>) => {
			if (complete) return;
			complete = true;
			resolvePromise(value);
		};
		const reject = (reason: unknown) => {
			if (complete) return;
			complete = true;
			rejectPromise(reason);
		};
		const tracked: TrackedDeferred = {
			label: options.label,
			applyUnfinished: () => {
				if (options.unfinished.type === "resolve") resolve(options.unfinished.value);
				else reject(options.unfinished.reason);
			},
			settled: settledPromise,
			isSettled: () => settled,
		};
		this.#deferreds.add(tracked);
		return {
			promise,
			resolve,
			reject,
		};
	}

	applyUnfinished() {
		for (const deferred of this.#deferreds) deferred.applyUnfinished();
	}

	async drain(timeoutMs = 1_000) {
		const pending = [...this.#deferreds].filter((deferred) => !deferred.isSettled());
		if (pending.length === 0) return;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([
			Promise.all(pending.map((deferred) => deferred.settled)),
			new Promise<void>((resolve) => {
				timeout = setTimeout(resolve, timeoutMs);
			}),
		]);
		if (timeout) clearTimeout(timeout);
		const unresolved = pending.filter((deferred) => !deferred.isSettled());
		if (unresolved.length > 0)
			throw new Error(
				`Test lifecycle still owns unsettled deferred operation(s):\n${unresolved.map(({ label }) => `- ${label}`).join("\n")}`,
			);
	}
}
