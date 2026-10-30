import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { compareFileCoverage, compareImportGraph, createStructureChecker } from "../dist/structure.js";

const scopes = [
	{ root: "ui/src/App/Islands/Demo", level: "app", entry: "main.tsx", allowedRootFiles: ["tsconfig.json"] },
	{ root: "packages/ui", level: "package" },
	{ root: "packages/testing", level: "package" },
];
const options = {
	scopes,
	additionalFileCategories: ["Types"],
	testSupportPackages: [{ root: "packages/testing", specifier: "@example/testing" }],
	routeTree: "routeTree.gen.ts",
};

function workspace() {
	const root = mkdtempSync(join(tmpdir(), "forge-structure-"));
	const files = new Map([
		["ui/src/App/Islands/Demo/main.tsx", ""],
		["ui/src/App/Islands/Demo/App.tsx", 'import "./Routes/routeTree.gen";'],
		["ui/src/App/Islands/Demo/tsconfig.json", "{}"],
		["ui/src/App/Islands/Demo/Routes/routeTree.gen.ts", 'import { Route } from "./index";'],
		["ui/src/App/Islands/Demo/Routes/index.tsx", "export const Route = {};"],
		["ui/src/App/Islands/Demo/Components/Shell/Shell.tsx", 'import "../../Lib/Shared/Shared";'],
		["ui/src/App/Islands/Demo/Components/Shell/Tests/Shell.test.tsx", 'import "../Shell";'],
		["ui/src/App/Islands/Demo/Lib/Shared/Shared.ts", "export const shared = true;"],
		["ui/src/App/Islands/Demo/Lib/Testing/Testing.ts", "export const setup = true;"],
		["ui/src/App/Islands/Demo/Types/Payload.ts", "export interface Payload { value: string }"],
		["packages/ui/Components/Button/Button.tsx", "export const Button = () => null;"],
		["packages/testing/Testing.ts", "export function scenario() {}"],
	]);
	for (const [path, content] of files) {
		const absolute = join(root, path);
		mkdirSync(dirname(absolute), { recursive: true });
		writeFileSync(absolute, content);
	}
	return {
		root,
		files,
		checker: createStructureChecker({ root, ...options }),
		close: () => rmSync(root, { recursive: true, force: true }),
	};
}

function withWorkspace(callback) {
	const fixture = workspace();
	try {
		return callback(fixture);
	} finally {
		fixture.close();
	}
}

function rules(findings) {
	return findings.map(({ rule }) => rule);
}

test("faithfully checks an explicit app/package topology", () => {
	withWorkspace(({ checker }) => {
		const findings = checker.checkStructure();
		assert.ok(!findings.some(({ severity }) => severity === "error"), JSON.stringify(findings, null, 2));
	});
});

test("factory scopes are explicit and empty, missing, duplicate scopes fail visibly", () => {
	withWorkspace(({ root }) => {
		assert.throws(() => createStructureChecker({ root, scopes: [] }).checkStructure(), /no structure scopes/);
		const missing = createStructureChecker({ root, scopes: [{ root: "missing", level: "package" }] });
		assert.ok(rules(missing.checkStructure()).includes("scope-coverage"));
		const duplicate = createStructureChecker({ root, scopes: [scopes[1], scopes[1]] });
		assert.ok(rules(duplicate.checkStructure()).includes("scope-coverage"));
	});
});

test("source scan preserves all in-scope files and real static import specifiers", () => {
	withWorkspace(({ checker }) => {
		const imports = checker.scanImports();
		assert.equal(imports.size, 11);
		assert.deepEqual(imports.get("ui/src/App/Islands/Demo/App.tsx"), ["./Routes/routeTree.gen"]);
		assert.deepEqual(imports.get("ui/src/App/Islands/Demo/Components/Shell/Shell.tsx"), ["../../Lib/Shared/Shared"]);
	});
});

test("source and test collection checks catch empty, missing, duplicate and extra coverage", () => {
	assert.ok(compareFileCoverage("source", [], []).some((finding) => finding.message.includes("no source")));
	const result = compareFileCoverage("test", ["a.test.ts", "a.test.ts", "b.test.ts"], ["a.test.ts", "extra.test.ts"]);
	assert.ok(result.some((finding) => finding.message.includes("2 times")));
	assert.ok(result.some((finding) => finding.message.includes("absent from collection")));
	assert.ok(result.some((finding) => finding.message.includes("outside discovered scopes")));
});

test("normalized graph comparison catches missing modules and omitted imports", () => {
	withWorkspace(({ checker }) => {
		const scanned = checker.scanImports();
		const modules = [...scanned].map(([source, specifiers]) => ({
			source,
			dependencies: specifiers.map((module) => ({ module })),
		}));
		assert.deepEqual(compareImportGraph(scanned, modules), []);
		const degraded = modules.slice(1).map((module) => ({ ...module, dependencies: [] }));
		const findings = compareImportGraph(scanned, degraded);
		assert.ok(findings.some((finding) => finding.message.includes("not represented")));
		assert.ok(findings.some((finding) => finding.message.includes("differs")));
	});
});

test("source classification grants Tests/ only at legal category positions", () => {
	withWorkspace(({ checker, root }) => {
		assert.equal(checker.classifySource("ui/src/App/Islands/Demo/Components/Shell/Tests/Shell.test.tsx"), "test");
		assert.equal(
			checker.classifySource("ui/src/App/Islands/Demo/Components/Shell/Internal/Tests/helper.ts"),
			"production",
		);
		assert.equal(checker.classifySource("ui/src/App/Islands/Demo/Lib/Testing/Testing.ts"), "test-support");
		assert.equal(checker.classifySource("packages/testing/Testing.ts"), "test-support");
		assert.equal(checker.classifySource("ui/src/App/Islands/Demo/Lib/NotTesting/NotTesting.ts"), "production");
		const invalidSupport = createStructureChecker({
			root,
			scopes,
			testSupportPackages: [{ root: "arbitrary/path", specifier: "@fake/testing" }],
		});
		assert.ok(rules(invalidSupport.checkStructure()).includes("scope-coverage"));
	});
});

test("original tree rules retain route-tree deleted-reference and ignored-ancestor behavior", () => {
	withWorkspace(({ root, files }) => {
		const routeTree = join(root, "ui/src/App/Islands/Demo/Routes/routeTree.gen.ts");
		writeFileSync(routeTree, 'import { Route } from "./deleted"; import { Ignored } from "./-ignored/file";');
		const ignored = join(root, "ui/src/App/Islands/Demo/Routes/-ignored/file.tsx");
		mkdirSync(dirname(ignored), { recursive: true });
		writeFileSync(ignored, "export {}; ");
		const current = createStructureChecker({ root, ...options }).checkStructure();
		assert.ok(current.some((finding) => finding.rule === "route-tree-current" && finding.message.includes("deleted")));
		assert.ok(!current.some((finding) => finding.path.endsWith("-ignored/file.tsx")));
		assert.equal(files.has("ui/src/App/Islands/Demo/Routes/index.tsx"), true);
	});
});

test("bare imports between host packages are left to the host graph/package rules", () => {
	withWorkspace(({ root }) => {
		writeFileSync(join(root, "ui/src/App/Islands/Demo/App.tsx"), 'import "@example/ui";');
		writeFileSync(join(root, "packages/ui/Components/Button/Button.tsx"), 'import "@example/testing-library";');
		const findings = createStructureChecker({ root, ...options }).checkStructure();
		assert.ok(!findings.some((finding) => finding.rule === "import-visibility"));
		assert.ok(
			!findings.some((finding) => finding.rule === "test-only-import" && finding.message.includes("@example/ui")),
		);
	});
});

test("Routes-to-Routes relative imports remain foreign-territory-exempt", () => {
	withWorkspace(({ root }) => {
		const route = join(root, "ui/src/App/Islands/Demo/Routes/index.tsx");
		writeFileSync(route, 'import "./other";');
		writeFileSync(join(dirname(route), "other.tsx"), "export {}; ");
		const findings = createStructureChecker({ root, ...options }).checkStructure();
		assert.ok(
			!findings.some((finding) => finding.rule === "import-visibility" && finding.path.endsWith("Routes/index.tsx")),
		);
	});
});

test("asset-only directories remain visible to tree checks and empty recommendations", () => {
	withWorkspace(({ root }) => {
		const asset = join(root, "ui/src/App/Islands/Demo/Components/EmptyGroup/logo.svg");
		mkdirSync(dirname(asset), { recursive: true });
		writeFileSync(asset, "<svg/>");
		const findings = createStructureChecker({ root, ...options }).checkStructure();
		assert.ok(findings.some((finding) => finding.rule === "group-contents" && finding.path.endsWith("logo.svg")));
		const emptyCategory = join(root, "ui/src/App/Islands/Demo/Lib/Empty/Internal");
		mkdirSync(emptyCategory, { recursive: true });
		const afterEmpty = createStructureChecker({ root, ...options }).checkStructure();
		assert.ok(afterEmpty.some((finding) => finding.rule === "empty-category" && finding.path.endsWith("Internal")));
	});
});

test("ownership drift remains recommendation-only for a sole nested consumer", () => {
	withWorkspace(({ checker }) => {
		const findings = checker.checkStructure();
		const drift = findings.find((finding) => finding.rule === "ownership-drift");
		assert.ok(drift);
		assert.equal(drift.severity, "recommendation");
		assert.equal(drift.path, "ui/src/App/Islands/Demo/Lib/Shared/Shared.ts");
	});
});

test("additional root file categories are opt-in and their imports remain host-owned", () => {
	withWorkspace(({ root }) => {
		const typesFile = join(root, "ui/src/App/Islands/Demo/Types/Payload.ts");
		writeFileSync(typesFile, 'import "../Lib/Shared/Shared";');
		const noTypes = createStructureChecker({ root, scopes, routeTree: options.routeTree }).checkStructure();
		assert.ok(noTypes.some((finding) => finding.rule === "unknown-category"));
		const checker = createStructureChecker({ root, ...options });
		assert.ok(
			!checker
				.checkStructure()
				.some((finding) => finding.rule === "import-visibility" && finding.path.endsWith("Types/Payload.ts")),
		);
		const secret = join(root, "ui/src/App/Islands/Demo/Components/Shell/Internal/Secret.ts");
		mkdirSync(dirname(secret), { recursive: true });
		writeFileSync(secret, "export const secret = 1;");
		writeFileSync(typesFile, 'import "../Components/Shell/Internal/Secret";');
		assert.ok(
			checker
				.checkStructure()
				.some((finding) => finding.rule === "import-visibility" && finding.path.endsWith("Types/Payload.ts")),
		);
	});
});

test("rejects noncanonical and repository-root scope aliases before any scan", () => {
	withWorkspace(({ root }) => {
		for (const path of [".", "../outside", "/absolute", "ui/./src", "ui//src", "ui/../src"])
			assert.throws(
				() => createStructureChecker({ root, scopes: [{ root: path, level: "package" }] }),
				/canonical non-root/,
			);
	});
});

test("scanner independently retains named, star, type-only and dynamic imports", () => {
	withWorkspace(({ root, checker }) => {
		writeFileSync(
			join(root, "ui/src/App/Islands/Demo/App.tsx"),
			`
// import "comment-not-code";
import { thing } from "named";
import type { Type } from "types";
export { other } from "reexport";
export * from "star";
const load = () => import("dynamic");
import "side-effect";
`,
		);
		assert.deepEqual(checker.scanImports().get("ui/src/App/Islands/Demo/App.tsx"), [
			"named",
			"types",
			"reexport",
			"star",
			"dynamic",
			"side-effect",
		]);
	});
});

test("private and own-entry imports are rejected while owned Internal imports stay legal", () => {
	withWorkspace(({ root, checker }) => {
		const put = (path, text) => {
			const file = join(root, "ui/src/App/Islands/Demo", path);
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, text);
		};
		put("Components/Shell/Internal/Secret.ts", 'import "../Shell"; export const secret = 1;');
		put("Components/Shell/Shell.tsx", 'import "./Internal/Secret";');
		put("App.tsx", 'import "./Components/Shell/Internal/Secret";');
		const findings = checker.checkStructure().filter((f) => f.rule === "import-visibility");
		assert.equal(findings.length, 2, JSON.stringify(findings));
		assert.ok(findings.some((f) => f.path.endsWith("App.tsx") && f.message.includes("Internal/ private")));
		assert.ok(findings.some((f) => f.path.endsWith("Internal/Secret.ts") && f.message.includes("public interface")));
	});
});

test("ownership markers stay live only for a sole deeper production consumer", () => {
	withWorkspace(({ root, checker }) => {
		const shared = join(root, "ui/src/App/Islands/Demo/Lib/Shared/Shared.ts");
		writeFileSync(shared, "// @shared-by-decision\nexport const shared = true;");
		assert.ok(!checker.checkStructure().some((f) => f.rule === "ownership-drift" && f.path.endsWith("Shared.ts")));
		writeFileSync(join(root, "ui/src/App/Islands/Demo/Components/Shell/Shell.tsx"), "export {};");
		writeFileSync(
			join(root, "ui/src/App/Islands/Demo/Components/Shell/Tests/Shell.test.tsx"),
			'import "../../../Lib/Shared/Shared";',
		);
		writeFileSync(join(root, "ui/src/App/Islands/Demo/Lib/Testing/Testing.ts"), 'import "../Shared/Shared";');
		const finding = checker.checkStructure().find((f) => f.rule === "ownership-drift" && f.path.endsWith("Shared.ts"));
		assert.equal(finding?.severity, "recommendation");
		assert.match(finding.message, /marker is dead text/);
	});
});

test("fixed shared test-only import boundary recognizes host test-support package identity", () => {
	withWorkspace(({ root }) => {
		const app = join(root, "ui/src/App/Islands/Demo/App.tsx");
		writeFileSync(app, 'import "@example/testing"; import "vitest";');
		const findings = createStructureChecker({ root, ...options }).checkStructure();
		assert.ok(findings.filter((finding) => finding.rule === "test-only-import").length >= 2);
	});
});
