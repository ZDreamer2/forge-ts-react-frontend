import assert from "node:assert/strict";
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const packageName = "@zdreamer/forge-ts-react-frontend";

// Called by the single packed-package acceptance entry, after proving preset-only consumption.
export async function verifyTestingConsumer({ t, consumer, put, run, tool }) {
	run("npm", [
		"install",
		"--ignore-scripts",
		"--no-audit",
		"--no-fund",
		"--save-dev",
		"--save-exact",
		`--before=${new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()}`,
		"vitest@4.1.11",
		"msw@2.15.0",
		"@tanstack/query-core@5.102.8",
		"@tanstack/react-query@5.102.8",
		"react-dom@19.2.7",
		"@types/react-dom@19.2.3",
		"@testing-library/react@16.3.3",
		"jsdom@30.0.1",
	]);
	put(
		"vitest.config.ts",
		`import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["testing/**/*.test.{ts,tsx}"], globals: false, maxWorkers: 2, fileParallelism: true } });`,
	);
	put(
		"testing.tsconfig.json",
		JSON.stringify({
			compilerOptions: {
				target: "ES2023",
				module: "NodeNext",
				strict: true,
				exactOptionalPropertyTypes: true,
				noUncheckedIndexedAccess: true,
				noEmit: true,
				skipLibCheck: true,
				jsx: "react-jsx",
				types: ["node"],
			},
			include: ["testing/**/*.ts", "testing/**/*.tsx"],
		}),
	);
	put(
		"testing/types.ts",
		`import { createHttpScenario, type HttpScenario, type ControlledResponse, type ControlledResponseState, type FinishHttpScenario } from "${packageName}/testing/http";
import { createTestSuiteLifecycle, type BrowserIsolationOptions, type DeferredOutcome, type OwnedDeferred, type ScopedHttpScenario, type TestSuiteLifecycle, type TestSuiteLifecycleOptions } from "${packageName}/testing";
const options: TestSuiteLifecycleOptions = { browser: { documentAttributes: ["data-test"] } satisfies BrowserIsolationOptions };
const suite: TestSuiteLifecycle = createTestSuiteLifecycle(options);
const outcome: DeferredOutcome<number> = {type:"resolve", value:1};
const deferred: OwnedDeferred<number> = suite.defer({label:"types", unfinished:outcome});
const scoped: ScopedHttpScenario = suite.createHttpScenario();
const standalone: HttpScenario = createHttpScenario();
const response: ControlledResponse = standalone.deferResponse();
const state: ControlledResponseState = response.state;
const finish: FinishHttpScenario = {beforeCancel:[async () => {}]};
// @ts-expect-error lifecycle-owned HTTP cannot be finished independently
scoped.finish();
// @ts-expect-error a labelled fallback is required
suite.defer({label:"missing fallback"});
void [deferred, state, finish];`,
	);

	await t.test("HTTP-only built export runs without a Vitest runner", () => {
		put(
			"http-only.mjs",
			`import assert from "node:assert/strict";
import { createHttpScenario } from "${packageName}/testing/http";
import { http, HttpResponse } from "msw";
const original = Object.getOwnPropertyDescriptor(globalThis,"fetch");
const owner = createHttpScenario(http.get("http://consumer.test/value", () => HttpResponse.text("base")));
owner.use(http.get("http://consumer.test/value", () => HttpResponse.text("override")));
assert.equal(await (await fetch("http://consumer.test/value")).text(), "override");
const response = owner.deferResponse();
owner.use(http.get("http://consumer.test/abort", ({request}) => response.handle(request)));
const controller = new AbortController();
const pending = fetch("http://consumer.test/abort", {signal:controller.signal});
const observed = assert.rejects(pending);
while (!response.request) await new Promise(resolve => setTimeout(resolve,1));
controller.abort();
await observed;
assert.equal(response.state,"cancelled");
await owner.finish();
assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis,"fetch"), original);
const fresh = createHttpScenario();
await fresh.finish();`,
		);
		run(process.execPath, ["http-only.mjs"]);
	});

	put(
		"testing/react.test.tsx",
		`// @vitest-environment jsdom
import { createTestSuiteLifecycle } from "${packageName}/testing";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react/pure.js";
import { http } from "msw";
import { expect, it } from "vitest";
const initialFetch = globalThis.fetch;
const suite = createTestSuiteLifecycle({browser:{documentAttributes:["data-consumer"]}, beforeCancel:[cleanup], runCleanup:finish => act(finish)});
function Result() {
 const query = useQuery({queryKey:["acknowledged"], queryFn:async () => (await fetch("http://consumer.test/result")).text()});
 return <p>{query.data ?? "waiting"}</p>;
}
it("acknowledges a controlled result through consumer-owned React Query providers", async () => {
 const client = suite.createQueryClient({defaultOptions:{queries:{retry:false}}});
 const network = suite.createHttpScenario();
 const response = network.deferResponse();
 network.use(http.get("http://consumer.test/result", ({request}) => response.handle(request)));
 document.documentElement.setAttribute("data-consumer","changed");
 localStorage.setItem("consumer","changed");
 render(<QueryClientProvider client={client}><Result /></QueryClientProvider>);
 await waitFor(() => expect(response.request).toBeDefined());
 expect(screen.getByText("waiting")).toBeDefined();
 await act(async () => response.release(new Response("acknowledged result")));
 expect(await screen.findByText("acknowledged result")).toBeDefined();
 expect(client.getQueryData(["acknowledged"])).toBe("acknowledged result");
});
it("starts a fresh test after owned resource disposal and browser restoration", async () => {
 expect(globalThis.fetch).toBe(initialFetch);
 expect(document.documentElement.hasAttribute("data-consumer")).toBe(false);
 expect(localStorage.getItem("consumer")).toBeNull();
 expect(document.body.textContent).toBe("");
 expect(suite.createQueryClient().getQueryCache().getAll()).toHaveLength(0);
 const network = suite.createHttpScenario(http.get("http://consumer.test/fresh", () => new Response("fresh")));
 expect(await (await fetch("http://consumer.test/fresh")).text()).toBe("fresh");
 void network;
});`,
	);

	for (const name of ["one", "two"]) {
		const other = name === "one" ? "two" : "one";
		put(
			`testing/parallel-${name}.test.ts`,
			`import { createTestSuiteLifecycle } from "${packageName}/testing";
import { existsSync, writeFileSync } from "node:fs";
import { http } from "msw";
import { expect, it } from "vitest";
const suite = createTestSuiteLifecycle();
it("overlaps an isolated HTTP owner in another file worker", async () => {
 suite.createHttpScenario(http.get("http://parallel.test/", () => new Response("${name}")));
 const start = Date.now();
 writeFileSync("${name}.started", String(start));
 const deadline = Date.now()+10000;
 while (!existsSync("${other}.started") && Date.now()<deadline) await new Promise(resolve => setTimeout(resolve,10));
 expect(existsSync("${other}.started")).toBe(true);
 expect(await (await fetch("http://parallel.test/")).text()).toBe("${name}");
 await new Promise(resolve => setTimeout(resolve,50));
 writeFileSync("${name}.interval.json", JSON.stringify({start,end:Date.now()}));
});
it("has no handlers from the previous test", async () => {
 suite.createHttpScenario(http.get("http://parallel.test/", () => new Response("fresh ${name}")));
 expect(await (await fetch("http://parallel.test/")).text()).toBe("fresh ${name}");
});`,
		);
	}
	await t.test("built public lifecycle supports React and observed isolated file parallelism", () => {
		tool("tsc", ["-p", "testing.tsconfig.json"]);
		tool("vitest", ["run", "testing/react.test.tsx"]);
		tool("vitest", ["run", "testing/parallel-one.test.ts", "testing/parallel-two.test.ts"]);
		const one = JSON.parse(readFileSync(join(consumer, "one.interval.json"), "utf8"));
		const two = JSON.parse(readFileSync(join(consumer, "two.interval.json"), "utf8"));
		assert.ok(Math.max(one.start, two.start) < Math.min(one.end, two.end), "HTTP owners must actually overlap");
	});

	await verifyHookFailures({ t, consumer, put, tool });
	await verifyIsolationControls({ t, consumer, put, run });
}

async function verifyHookFailures({ t, consumer, put, tool }) {
	const modes = {
		preparation: {
			setup: `prepare(){ if (++prepares === 1) { suite.createHttpScenario(); throw new Error("packed preparation sentinel"); } }`,
			body: "",
			message: /packed preparation sentinel/,
		},
		cleanup: {
			setup: `runCleanup:async finish => { if (prepares === 1) throw new Error("packed cleanup wrapper sentinel"); await finish(); }, prepare(){++prepares;}`,
			body: "suite.createHttpScenario();",
			message: /packed cleanup wrapper sentinel/,
		},
		traffic: {
			setup: "prepare(){++prepares;}",
			body: 'suite.createHttpScenario(); await expect(fetch("http://unexpected.test/asset.json")).rejects.toThrow();',
			message: /Unexpected request: GET http:\/\/unexpected.test\/asset.json/,
		},
		deferred: {
			setup: "prepare(){++prepares;}",
			body: 'suite.defer({label:"packed unresolved operation",unfinished:{type:"resolve",value:1}}).resolve(new Promise<number>(() => {}));',
			message: /still owns unsettled deferred operation\(s\):[\s\S]*packed unresolved operation/,
		},
		mutation: {
			setup: "prepare(){++prepares;}",
			body: 'const client = suite.createQueryClient(); void client.getMutationCache().build(client,{mutationKey:["packed unresolved mutation"],mutationFn:() => new Promise(() => {})}).execute(undefined);',
			message: /mutations did not settle:[\s\S]*packed unresolved mutation/,
		},
	};
	for (const [mode, { setup, body, message }] of Object.entries(modes)) {
		await t.test(`real hooks diagnose ${mode} failure and recover on the following test`, () => {
			put(
				`testing/failure-${mode}.test.ts`,
				`import { createTestSuiteLifecycle } from "${packageName}/testing";
import { http } from "msw";
import { expect, it } from "vitest";
const initialFetch = globalThis.fetch;
let prepares = 0;
const suite = createTestSuiteLifecycle({${setup}});
it("intended ${mode} failure", async () => {${body}});
it("recovers after ${mode}", async () => {
 expect(globalThis.fetch).toBe(initialFetch);
 const client = suite.createQueryClient();
 expect(client.getQueryCache().getAll()).toHaveLength(0);
 suite.createHttpScenario(http.get("http://recovered.test/", () => new Response("recovered")));
 expect(await (await fetch("http://recovered.test/")).text()).toBe("recovered");
});`,
			);
			const reportPath = join(consumer, `failure-${mode}.json`);
			tool("tsc", ["-p", "testing.tsconfig.json"]);
			tool(
				"vitest",
				["run", `testing/failure-${mode}.test.ts`, "--reporter=json", `--outputFile=${reportPath}`],
				false,
			);
			const report = JSON.parse(readFileSync(reportPath, "utf8"));
			const results = report.testResults.flatMap((file) => file.assertionResults);
			assert.deepEqual(
				results.map(({ title, status }) => ({ title, status })),
				[
					{ title: `intended ${mode} failure`, status: "failed" },
					{ title: `recovers after ${mode}`, status: "passed" },
				],
			);
			assert.match(results[0].failureMessages.join("\n"), message);
			rmSync(join(consumer, `testing/failure-${mode}.test.ts`));
		});
	}
}

async function verifyIsolationControls({ t, consumer, put, run }) {
	await t.test("bounded candidate-artifact controls distinguish actual escape from changed bytes", () => {
		const installed = join(consumer, "node_modules", packageName);
		const candidate = join(consumer, "control-candidate");
		cpSync(installed, candidate, { recursive: true, dereference: true });
		const target = join(candidate, "dist/testing/http.js");
		const original = readFileSync(target, "utf8");
		// Both the loopback observer and the discriminating regression import this exact staged artifact.
		put(
			"isolation-control.mjs",
			`import assert from "node:assert/strict";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
const {createHttpScenario} = await import(pathToFileURL(process.argv[2]).href);
let received = 0;
const receiver = createServer((_request,response) => {received++; response.end("escaped to receiver");});
await new Promise(resolve => receiver.listen(0,"127.0.0.1",resolve));
const observations = [];
try {
 for (const path of ["/ordinary", "/asset.json"]) {
  const before = received;
  const owner = createHttpScenario();
  let outcome = "rejected";
  try { await fetch(\`http://127.0.0.1:\${receiver.address().port}\${path}\`); outcome="fulfilled"; } catch {}
  try {await owner.finish();} catch {}
  observations.push({path,outcome,received:received-before});
 }
 console.log(JSON.stringify(observations));
 if (process.argv[3] === "regression") {
  assert.deepEqual(observations.map(({outcome,received}) => ({outcome,received})), [{outcome:"rejected",received:0},{outcome:"rejected",received:0}], "unmatched ordinary and JSON requests must not escape");
 }
} finally {await new Promise(resolve => receiver.close(resolve));}`,
		);
		function observe(regression = false, succeeds = true) {
			const { stdout, output } = run(
				process.execPath,
				["isolation-control.mjs", resolve(target), ...(regression ? ["regression"] : [])],
				consumer,
				succeeds,
			);
			if (!succeeds) assert.match(output, /unmatched ordinary and JSON requests must not escape/);
			return JSON.parse(stdout.trim());
		}
		const isolated = [
			{ path: "/ordinary", outcome: "rejected", received: 0 },
			{ path: "/asset.json", outcome: "rejected", received: 0 },
		];
		try {
			assert.deepEqual(observe(true), isolated);
			writeFileSync(target, `${original}\n// Behavior-neutral control.\n`);
			assert.deepEqual(observe(true), isolated);
			// Remove the final fail-closed handler, and allow unhandled traffic to reach the loopback receiver.
			const fallback = /http\.all\("\*", \(\{ request \}\) => \{[\s\S]*?return HttpResponse\.error\(\);\s*\}\),?/;
			assert.equal(original.match(new RegExp(fallback.source, "g"))?.length, 1, "candidate fallback identity");
			const listening = /onUnhandledRequest: "error"/;
			assert.equal(original.match(new RegExp(listening.source, "g"))?.length, 1, "candidate listen identity");
			writeFileSync(target, original.replace(fallback, "").replace(listening, 'onUnhandledRequest: "bypass"'));
			assert.deepEqual(observe(), [
				{ path: "/ordinary", outcome: "fulfilled", received: 1 },
				{ path: "/asset.json", outcome: "fulfilled", received: 1 },
			]);
			observe(true, false);
		} finally {
			writeFileSync(target, original);
		}
		assert.deepEqual(observe(true), isolated);
		assert.equal(
			readFileSync(join(installed, "dist/testing/http.js"), "utf8"),
			original,
			"installed artifact stays untouched",
		);
	});
}
