import { expect, it } from "vitest";
import { registerTestSuiteLifecycle } from "../../src/testing/internal/lifecycle-owner.js";

let prepare!: () => void | Promise<void>;
let finish!: () => void | Promise<void>;
const suite = registerTestSuiteLifecycle(
	{},
	{
		afterEach(callback) {
			finish = callback;
		},
		beforeEach(callback) {
			prepare = callback;
		},
	},
);

async function runScenario(scenario: () => Promise<void>) {
	await prepare();
	try {
		await scenario();
	} finally {
		await finish();
	}
}

it("observes deferred rejection while scenario failure still reaches the harness", async () => {
	const scenarioFailure = new Error("scenario failed as expected");
	let failedScenarioFallback!: Promise<string>;

	await expect(
		runScenario(async () => {
			const fallback = suite.defer<string>({
				label: "rejected during failed scenario cleanup",
				unfinished: { type: "reject", reason: new Error("observed cleanup rejection") },
			});
			failedScenarioFallback = fallback.promise;
			const explicit = suite.defer<string>({
				label: "immediately rejected during failed scenario",
				unfinished: { type: "resolve", value: "unused fallback" },
			});
			explicit.reject(new Error("observed immediate rejection"));
			await new Promise((resolve) => setTimeout(resolve, 0));
			throw scenarioFailure;
		}),
	).rejects.toBe(scenarioFailure);
	await expect(failedScenarioFallback).rejects.toThrow("observed cleanup rejection");
});

it("starts the following scenario with fresh owned work", async () => {
	await prepare();
	const deferred = suite.defer({
		label: "fresh operation",
		unfinished: { type: "resolve", value: "fresh fallback" },
	});
	await finish();
	await expect(deferred.promise).resolves.toBe("fresh fallback");
});
