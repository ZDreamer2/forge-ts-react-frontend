import type { DeferredOutcome, OwnedDeferred } from "./types.js";
export declare class OwnedDeferreds {
    #private;
    defer<T>(options: {
        label: string;
        unfinished: DeferredOutcome<T>;
    }): OwnedDeferred<T>;
    applyUnfinished(): void;
    drain(timeoutMs?: number): Promise<void>;
}
