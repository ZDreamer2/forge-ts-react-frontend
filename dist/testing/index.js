import { afterEach, beforeEach } from "vitest";
import { registerTestSuiteLifecycle } from "./internal/lifecycle-owner.js";
/**
 * Declares one lifecycle owner for a sequential test suite (never `it.concurrent`). Call at module scope.
 * Teardown is registered before preparation, so partial preparation still releases owned work and restores
 * browser state. A `runCleanup` wrapper must invoke and await the callback it receives.
 */
export function createTestSuiteLifecycle(options = {}) {
    return registerTestSuiteLifecycle(options, { afterEach, beforeEach });
}
export { createHttpScenario, } from "./http.js";
