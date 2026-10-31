export class OwnedDeferreds {
    #deferreds = new Set();
    defer(options) {
        let complete = false;
        let settled = false;
        let resolvePromise;
        let rejectPromise;
        const promise = new Promise((resolve, reject) => {
            resolvePromise = resolve;
            rejectPromise = reject;
        });
        // Observe rejection immediately. Consumers still receive the original promise and its rejection.
        const settledPromise = promise.then(() => {
            settled = true;
        }, () => {
            settled = true;
        });
        const resolve = (value) => {
            if (complete)
                return;
            complete = true;
            resolvePromise(value);
        };
        const reject = (reason) => {
            if (complete)
                return;
            complete = true;
            rejectPromise(reason);
        };
        const tracked = {
            label: options.label,
            applyUnfinished: () => {
                if (options.unfinished.type === "resolve")
                    resolve(options.unfinished.value);
                else
                    reject(options.unfinished.reason);
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
        for (const deferred of this.#deferreds)
            deferred.applyUnfinished();
    }
    async drain(timeoutMs = 1_000) {
        const pending = [...this.#deferreds].filter((deferred) => !deferred.isSettled());
        if (pending.length === 0)
            return;
        let timeout;
        await Promise.race([
            Promise.all(pending.map((deferred) => deferred.settled)),
            new Promise((resolve) => {
                timeout = setTimeout(resolve, timeoutMs);
            }),
        ]);
        if (timeout)
            clearTimeout(timeout);
        const unresolved = pending.filter((deferred) => !deferred.isSettled());
        if (unresolved.length > 0)
            throw new Error(`Test lifecycle still owns unsettled deferred operation(s):\n${unresolved.map(({ label }) => `- ${label}`).join("\n")}`);
    }
}
