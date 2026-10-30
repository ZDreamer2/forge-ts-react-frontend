import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const publicFiles = [
	"LICENSE",
	"README.md",
	"dist/structure.d.ts",
	"dist/structure.js",
	"package.json",
	"presets/biome-preset.json",
	"presets/tsconfig.json",
	"src/structure.ts",
];

test("packed presets and structural enforcement work in an independent consumer", { timeout: 240_000 }, async (t) => {
	const directory = mkdtempSync(join(tmpdir(), "forge-frontend-package-"));
	const consumer = join(directory, "consumer");
	const env = { ...process.env };
	// The consumer must not borrow developer credentials, npm settings or parent tools.
	for (const key of Object.keys(env)) {
		if (/token|password|auth/i.test(key) || /^npm_config_/i.test(key)) delete env[key];
	}
	Object.assign(env, {
		HOME: join(directory, "home"),
		NPM_CONFIG_USERCONFIG: join(directory, "empty.npmrc"),
		NPM_CONFIG_REGISTRY: "https://registry.npmjs.org/",
	});

	function put(path, content) {
		mkdirSync(dirname(join(consumer, path)), { recursive: true });
		writeFileSync(join(consumer, path), content);
	}

	function run(command, args, cwd = consumer, succeeds = true) {
		const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 120_000 });
		assert.ifError(result.error);
		assert.equal(result.signal, null, `${command} terminated unexpectedly`);
		const output = `${result.stdout}\n${result.stderr}`;
		if (succeeds) assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${output}`);
		else assert.notEqual(result.status, 0, `Expected rejection: ${command} ${args.join(" ")}`);
		return { stdout: result.stdout, output };
	}

	function tool(name, args, succeeds = true) {
		return run(join(consumer, "node_modules/.bin", name), args, consumer, succeeds);
	}

	try {
		mkdirSync(env.HOME);
		mkdirSync(consumer);
		writeFileSync(env.NPM_CONFIG_USERCONFIG, "");
		const [packed] = JSON.parse(
			run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", directory], root).stdout,
		);
		assert.equal(packed.name, "@zdreamer/forge-ts-react-frontend");
		assert.equal(packed.version, manifest.version);
		assert.deepEqual(packed.files.map((file) => file.path).sort(), publicFiles);
		const tarball = join(directory, packed.filename);
		assert.equal(packed.integrity, `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`);
		put("package.json", JSON.stringify({ private: true, type: "module" }));
		run("npm", [
			"install",
			"--ignore-scripts",
			"--no-audit",
			"--no-fund",
			"--save-dev",
			"--save-exact",
			// Keep the same third-party age floor as the development installation.
			`--before=${new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()}`,
			tarball,
			"react@19.2.7",
			"@types/react@19.2.17",
			"@types/node@24.13.3",
		]);
		const installed = JSON.parse(
			readFileSync(join(consumer, "node_modules/@zdreamer/forge-ts-react-frontend/package.json"), "utf8"),
		);
		assert.equal(installed.version, packed.version);
		assert.equal(installed.license, "MIT");
		assert.equal(installed.repository.url, "git+https://github.com/ZDreamer2/forge-ts-react-frontend.git");
		assert.deepEqual(installed.exports, {
			"./biome": "./presets/biome-preset.json",
			"./tsconfig": "./presets/tsconfig.json",
			"./structure": { types: "./dist/structure.d.ts", default: "./dist/structure.js" },
		});
		assert.deepEqual(installed.peerDependencies, { "@biomejs/biome": "2.5.4", typescript: "7.0.2" });
		assert.equal(installed.dependencies, undefined);
		assert.equal(installed.scripts.prepublishOnly, undefined);
		assert.equal(tool("tsc", ["--version"]).stdout.trim(), "Version 7.0.2");
		assert.equal(tool("biome", ["--version"]).stdout.trim(), "Version: 2.5.4");

		put(
			"biome.json",
			JSON.stringify({
				extends: ["@zdreamer/forge-ts-react-frontend/biome"],
				files: { includes: ["browser/**"] },
			}),
		);
		put(
			"tsconfig.json",
			JSON.stringify({
				extends: "@zdreamer/forge-ts-react-frontend/tsconfig",
				include: ["browser"],
			}),
		);
		put(
			"browser/Greeting.tsx",
			`export function Greeting({ name }: { name: string }) {
	return <button type="button">Hello {name}</button>;
}
export async function loadTitle(url: URL): Promise<string> {
	const response = await fetch(url);
	return response.text();
}
export const root: HTMLElement | null = document.getElementById("root");
`,
		);
		// Invalid files outside the declared consumer roots must not be collected from preset-relative paths.
		put("excluded/Bad.ts", "export const wrong: number = 'outside coverage';\n");

		await t.test("consumer-owned coverage and browser JSX work without Node/test globals", () => {
			tool("biome", ["check", "--write", "."]);
			tool("biome", ["check", "."]);
			tool("tsc", ["--noEmit"]);
			const effective = JSON.parse(tool("tsc", ["--showConfig"]).stdout);
			assert.deepEqual(effective.include, ["browser"]);
			assert.deepEqual(effective.compilerOptions.types, []);
			assert.equal(effective.compilerOptions.moduleResolution, "bundler");
			assert.equal(effective.compilerOptions.jsx, "react-jsx");
			assert.equal(effective.compilerOptions.target, "es2023");
			assert.deepEqual(effective.compilerOptions.lib, ["es2023", "dom", "dom.iterable"]);
			for (const option of [
				"strict",
				"exactOptionalPropertyTypes",
				"noUncheckedIndexedAccess",
				"noFallthroughCasesInSwitch",
				"isolatedModules",
				"verbatimModuleSyntax",
				"erasableSyntaxOnly",
				"skipLibCheck",
				"noEmit",
				"allowImportingTsExtensions",
			])
				assert.equal(effective.compilerOptions[option], true, option);
			const formatted = readFileSync(join(consumer, "browser/Greeting.tsx"), "utf8");
			assert.match(formatted, /\n\treturn <button/);
		});

		await t.test("shared recommended lint rejects a deliberate defect", () => {
			put("browser/Bad.ts", "export const loose = (value: number) => value == 1;\n");
			const lint = JSON.parse(tool("biome", ["lint", "--reporter=json", "."], false).stdout);
			assert.ok(lint.diagnostics.some((diagnostic) => diagnostic.category === "lint/suspicious/noDoubleEquals"));
			rmSync(join(consumer, "browser/Bad.ts"));
		});

		await t.test("strict optional/indexed checks and erasable syntax reject invalid source", () => {
			put(
				"browser/Bad.ts",
				`export const wrong: number = "not a number";
export const optional: { name?: string } = { name: undefined };
const values: string[] = [];
export const first: string = values[0];
export enum Status { Ready }
`,
			);
			const { output } = tool("tsc", ["--noEmit"], false);
			assert.match(output, /TS2322/);
			assert.match(output, /exactOptionalPropertyTypes/);
			assert.match(output, /string \| undefined/);
			assert.match(output, /erasableSyntaxOnly/);
			rmSync(join(consumer, "browser/Bad.ts"));
		});

		await t.test("installed structural engine enforces standalone topology and coverage", () => {
			put("application/main.tsx", "export {};\n");
			put("application/App.tsx", 'export { Widget } from "./Components/Widget/Widget";\n');
			put("application/Components/Widget/Widget.tsx", "export const Widget = 1;\n");
			put("application/Components/Widget/Internal/value.ts", "export const value = 1;\n");
			put("application/Components/Widget/Tests/Widget.test.ts", 'import "vitest";\n');
			put(
				"verify-structure.mjs",
				`
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { createStructureChecker, compareFileCoverage, compareImportGraph } from "@zdreamer/forge-ts-react-frontend/structure";
const checker = createStructureChecker({ root: process.cwd(), scopes: [{ root: "application", level: "app", entry: "main.tsx" }], testOnlyImports: ["@host/testing"] });
assert.deepEqual(checker.checkStructure(), []);
const scanned = checker.scanImports();
assert.equal(scanned.size, 5);
const graph = [...scanned].map(([source, imports]) => ({source, dependencies: [...new Set(imports)].map(module => ({module}))}));
assert.deepEqual(compareImportGraph(scanned, graph), []);
assert.ok(compareImportGraph(scanned, graph.slice(1)).length);
assert.ok(compareFileCoverage("test", ["one.test.ts"], []).length);
assert.ok(compareFileCoverage("source", [], []).length);
writeFileSync("application/App.tsx", 'import "@host/testing"; import "./Components/Widget/Internal/value";');
const rules = checker.checkStructure().map(f => f.rule);
assert.ok(rules.includes("test-only-import"));
assert.ok(rules.includes("import-visibility"));
mkdirSync("application/Components/Widget/Internal/Tests");
writeFileSync("application/Components/Widget/Internal/Tests/Wrong.test.ts", 'import "vitest";');
assert.equal(checker.classifySource("application/Components/Widget/Internal/Tests/Wrong.test.ts"), "production");
assert.ok(checker.checkStructure().some(f => f.rule === "test-placement"));
assert.throws(() => createStructureChecker({root:process.cwd(), scopes:[]}).checkStructure(), /no structure scopes/);
`,
			);
			run(process.execPath, ["verify-structure.mjs"]);
			put(
				"tooling.ts",
				`import { createStructureChecker, type StructureCheckerOptions } from "@zdreamer/forge-ts-react-frontend/structure";
const options: StructureCheckerOptions = { root: ".", scopes: [{ root: "application", level: "app", entry: "main.tsx" }] };
const findings = createStructureChecker(options).checkStructure();
const severity: "error" | "recommendation" | undefined = findings[0]?.severity;
// @ts-expect-error shared policy has no arbitrary rule-disable option
createStructureChecker({ ...options, disableRules: ["test-only-import"] });
// @ts-expect-error app entry identity is required
createStructureChecker({ root: ".", scopes: [{ root: "application", level: "app" }] });
void severity;
`,
			);
			put(
				"tooling.tsconfig.json",
				JSON.stringify({
					compilerOptions: { target: "ES2023", module: "NodeNext", strict: true, noEmit: true, types: ["node"] },
					include: ["tooling.ts"],
				}),
			);
			tool("tsc", ["-p", "tooling.tsconfig.json"]);
		});

		await t.test("ambient Node types require an explicit consumer binding", () => {
			put("browser/Bad.ts", "export const runtime = process.version;\n");
			assert.match(tool("tsc", ["--noEmit"], false).output, /Cannot find name 'process'/);
			put(
				"tsconfig.json",
				JSON.stringify({
					extends: "@zdreamer/forge-ts-react-frontend/tsconfig",
					include: ["browser"],
					compilerOptions: { types: ["node"] },
				}),
			);
			tool("tsc", ["--noEmit"]);
			rmSync(join(consumer, "browser/Bad.ts"));
		});
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
