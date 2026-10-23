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
const publicFiles = ["LICENSE", "README.md", "package.json", "presets/biome-preset.json", "presets/tsconfig.json"];

test("packed presets work in an independent React/browser consumer", { timeout: 240_000 }, async (t) => {
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
