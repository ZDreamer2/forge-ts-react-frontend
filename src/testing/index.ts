import { afterEach, beforeEach } from "vitest";
import { registerTestSuiteLifecycle } from "./internal/lifecycle-owner.js";
import type { TestSuiteLifecycle, TestSuiteLifecycleOptions } from "./internal/types.js";

export type {
	BrowserIsolationOptions,
	DeferredOutcome,
	OwnedDeferred,
	ScopedHttpScenario,
	TestSuiteLifecycle,
	TestSuiteLifecycleOptions,
} from "./internal/types.js";

/**
 * Declares one lifecycle owner for a sequential test suite (never `it.concurrent`). Call at module scope.
 * Teardown is registered before preparation, so partial preparation still releases owned work and restores
 * browser state. A `runCleanup` wrapper must invoke and await the callback it receives.
 */
export function createTestSuiteLifecycle(options: TestSuiteLifecycleOptions = {}): TestSuiteLifecycle {
	return registerTestSuiteLifecycle(options, { afterEach, beforeEach });
}

export {
	type ControlledResponse,
	type ControlledResponseState,
	createHttpScenario,
	type FinishHttpScenario,
	type HttpScenario,
} from "./http.js";
