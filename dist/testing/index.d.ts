import type { TestSuiteLifecycle, TestSuiteLifecycleOptions } from "./internal/types.js";
export type { BrowserIsolationOptions, DeferredOutcome, OwnedDeferred, ScopedHttpScenario, TestSuiteLifecycle, TestSuiteLifecycleOptions, } from "./internal/types.js";
/**
 * Declares one lifecycle owner for a sequential test suite (never `it.concurrent`). Call at module scope.
 * Teardown is registered before preparation, so partial preparation still releases owned work and restores
 * browser state. A `runCleanup` wrapper must invoke and await the callback it receives.
 */
export declare function createTestSuiteLifecycle(options?: TestSuiteLifecycleOptions): TestSuiteLifecycle;
export { type ControlledResponse, type ControlledResponseState, createHttpScenario, type FinishHttpScenario, type HttpScenario, } from "./http.js";
