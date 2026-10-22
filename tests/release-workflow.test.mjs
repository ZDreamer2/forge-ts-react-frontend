import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const workflow = readFileSync(join(root, ".github/workflows/publish.yml"), "utf8");
const block = workflow.match(/node --input-type=module <<'JS'\n([\s\S]*?)\n {10}JS/);
assert.ok(block, "Release guard must remain executable without dependencies");
const guard = block[1]?.replace(/^ {10}/gm, "");
assert.ok(guard);

const cases = [
	{ name: "push skips an existing version", event: "push", versions: { "1.2.3": {} }, run: false, publish: false },
	{ name: "push publishes a new version", event: "push", versions: {}, run: true, publish: true },
	{ name: "missing package push only dry-runs", event: "push", status: 404, run: true, publish: false },
	{ name: "missing package manual dry-run", event: "workflow_dispatch", status: 404, run: true, publish: false },
	{ name: "missing package cannot publish via OIDC", event: "workflow_dispatch", status: 404, requested: true, fails: true },
	{ name: "registry 403 fails closed", event: "push", status: 403, fails: true },
	{ name: "registry 429 fails closed", event: "push", status: 429, fails: true },
	{ name: "registry 500 fails closed", event: "push", status: 500, fails: true },
	{ name: "registry timeout fails closed", event: "push", networkError: true, fails: true },
	{ name: "malformed registry fails closed", event: "push", fails: true },
	{ name: "wrong registry package fails closed", event: "push", wrongName: true, versions: {}, fails: true },
	{ name: "manual dry-run of a new version", event: "workflow_dispatch", versions: {}, run: true, publish: false },
	{
		name: "manual existing-version verification",
		event: "workflow_dispatch",
		versions: { "1.2.3": {} },
		run: true,
		publish: false,
	},
	{ name: "manual registry failure stops verification", event: "workflow_dispatch", networkError: true, fails: true },
	{
		name: "manual republishing is rejected",
		event: "workflow_dispatch",
		versions: { "1.2.3": {} },
		requested: true,
		fails: true,
	},
	{
		name: "manual publish needs explicit opt-in",
		event: "workflow_dispatch",
		requested: true,
		versions: {},
		run: true,
		publish: true,
	},
	{ name: "manual version mismatch fails", event: "workflow_dispatch", version: "9.9.9", fails: true },
	{ name: "unexpected event fails", event: "pull_request", fails: true },
];

for (const scenario of cases) {
	test(scenario.name, () => {
		const directory = mkdtempSync(join(tmpdir(), "release-guard-"));
		try {
			writeFileSync(join(directory, "package.json"), JSON.stringify({ name: manifest.name, version: "1.2.3" }));
			const output = join(directory, "output");
			writeFileSync(output, "");
			const registry = { name: scenario.wrongName ? "wrong-package" : manifest.name, versions: scenario.versions };
			const fetch = scenario.networkError
				? "globalThis.fetch = async () => { throw new Error('Registry unavailable'); };"
				: `globalThis.fetch = async () => ({ status: ${scenario.status ?? 200}, json: async () => (${JSON.stringify(registry)}) });`;
			const result = spawnSync(process.execPath, ["--input-type=module", "-e", `${fetch}\n${guard}`], {
				cwd: directory,
				env: {
					GITHUB_EVENT_NAME: scenario.event,
					EXPECTED_VERSION: scenario.version ?? "1.2.3",
					PUBLISH_REQUESTED: String(scenario.requested ?? false),
					GITHUB_OUTPUT: output,
				},
				encoding: "utf8",
			});
			if (scenario.fails) {
				assert.notEqual(result.status, 0);
				assert.equal(readFileSync(output, "utf8"), "");
			} else {
				assert.equal(result.status, 0, result.stderr);
				assert.equal(
					readFileSync(output, "utf8"),
					`version=1.2.3\nrun=${scenario.run}\npublish=${scenario.publish}\nunpublished=${!Object.hasOwn(scenario.versions ?? {}, "1.2.3")}\n`,
				);
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
}

test("workflow wires automatic releases through verification and preserves manual dry-runs", () => {
	assert.ok(workflow.includes("push:\n    branches: [main]"));
	assert.ok(workflow.includes('test "$GITHUB_REF" = refs/heads/main'));
	const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
	assert.ok(ci.includes("push:\n    branches: [main]"));
	assert.match(workflow, /if: \$\{\{ needs\.guard\.outputs\.run == 'true' \}\}/);
	assert.match(workflow, /expected-version: \$\{\{ needs\.guard\.outputs\.version \}\}/);
	assert.ok(workflow.includes("needs: [guard, verify]"));
	assert.match(workflow, /if: \$\{\{ needs\.guard\.outputs\.publish == 'true' \}\}/);
	assert.match(workflow, /if: \$\{\{ needs\.guard\.outputs\.unpublished == 'true' \}\}/);
	assert.ok(workflow.includes("default: false"));
	assert.ok(workflow.includes("--provenance"));
});
