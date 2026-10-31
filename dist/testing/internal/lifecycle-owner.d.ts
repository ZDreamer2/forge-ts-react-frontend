import type { CleanupCallback, TestSuiteLifecycle, TestSuiteLifecycleOptions } from "./types.js";
export interface LifecycleHooks {
    afterEach(callback: CleanupCallback): void;
    beforeEach(callback: CleanupCallback): void;
}
export declare function registerTestSuiteLifecycle(options: TestSuiteLifecycleOptions, hooks: LifecycleHooks): TestSuiteLifecycle;
