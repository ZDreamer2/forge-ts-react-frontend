import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * The island structure rules that are not import edges, plus the one that is an edge no regex pair can
 * carry (#29349). Run by the `treecheck` script and so by `check`. The split with
 * `dependency-cruiser.jsonc` falls on one line: a rule that is an edge between two path regexes lives in
 * that config, and everything else lives here — the paragraphs below record why each side is what it is.
 *
 * **Why a script exists at all**, against the precedent of `ai/ai-gateway/docs/structure-checks.md`
 * ("no check script exists anywhere and none is coming"): most of `ai/bc-plugins/dev/forge/codebases/ts-react-frontend/on-plan.md` is about
 * the *shape of the tree* — a closed category set with per-level rights, a root file named after its
 * folder, which categories hold folders and which hold files — and none of that is an import edge for
 * dependency-cruiser to look at. The gateway's rule set happened to be edges end to end; this one is not.
 *
 * **Why the unit-surface rule landed here too**, although it is an edge. Legality depends on a *prefix
 * relationship between the two paths* — a unit's private files are visible exactly to that unit's
 * subtree, at any depth — and dependency-cruiser's `$1` substitution flows `from` → `to` as a literal,
 * which can test "target starts with the importer's directory" but never "target's holder is one of the
 * importer's ancestors". There is also a hard blocker specific to this tree: a substituted path is
 * spliced into a regex verbatim, and TanStack's route-file grammar puts a `$` in it
 * (`Routes/session.$sessionId.tsx`), where `$` reads as an end-of-input anchor and the pattern then
 * matches nothing — a rule that silently stops excusing legal imports. So no rule in the cruiser config
 * uses `$1` over a path that may name a route file, and the visibility rule is computed here instead.
 *
 * **What this file does NOT check is `Routes/`' contents.** `ai/bc-plugins/dev/forge/codebases/ts-react-frontend/on-plan.md` § Navigation
 * declares that directory foreign territory: TanStack's file-based conventions hold inside it verbatim
 * and its own generator is their validator. What is checked is the directory's *position* (the app root
 * only, through the level table below), the outbound imports of the files in it (they are app-level
 * files like any other), and that the committed route tree still names every route file — the one way
 * that territory can rot silently, since a stale tree typechecks, lints and tests exactly as a current
 * one does.
 *
 * **What deliberately stayed prose** — `ai/bc-plugins/dev/forge/codebases/ts-react-frontend/on-plan.md` rules no checker carries, so do not
 * "complete" the rule set with them; a red run was never the whole review. A unit's cohesion and choice
 * of public exports are judgements about responsibilities, which no path pair states.
 * Ownership-means-authorship places by who authors a portal or provider, and the checkable trace of
 * authorship is the very position the rule produces — a checker reading position would only agree with
 * itself. The entry staying mount-only and the fast-refresh export rule are about a module's exports,
 * review's job with the build's own failure modes (full page reloads, a double-mounted root) as backstop.
 * Promotion is the one that stopped being wholly prose: the checks report illegal imports; whether to
 * share the dependency or keep responsibilities separately owned stays a design decision. For code
 * chosen for reuse, promotion supplies legal placement, and `ownership-drift` names the downward move a sole deeper
 * consumer asks for — but that one reports at recommendation tier and never as an error, because the
 * *moment* of either move stays a design decision and a unit mid-construction passes through
 * sole-consumer states a red run would fight.
 *
 * **What the import scan sees.** Specifiers are read with a regex rather than an AST: island imports are
 * static `from "…"` (imports and re-exports) / `import "…"` / `import("…")` forms, and only the relative ones are judged — a bare
 * specifier is node_modules or a workspace package, which is `island-self-contained`'s and
 * `package-boundaries.ts`'s business alongside the cruiser config. `import.meta.glob(…)` is deliberately not matched:
 * a compile-time glob is invisible to dependency-cruiser too, and a check that saw it would have to
 * invent a legality for a pattern rather than a path. The scan is not trusted on its word:
 * `structure-rules.test.ts` compares it against dependency-cruiser's graph of the real tree, file for
 * file, so a regex that quietly stops matching turns the run red rather than green-and-empty.
 *
 * Plain TypeScript run under node (`node library/tools/island-structure/tree-shape.ts`): the engines
 * field pins node ≥ 24, which strips types natively, so the check adds no runner dependency. Everything
 * here must therefore stay erasable syntax — no enums, no parameter properties — which the root
 * tsconfig's `erasableSyntaxOnly` enforces.
 */

/** The closed category set of `ai/bc-plugins/dev/forge/codebases/ts-react-frontend/on-plan.md`, drawn from the trees of § App, § Component and § Lib. */
/** Categories whose ownership and shape are shared; host payload categories are explicit additions. */
const CATEGORIES = ["Components", "Routes", "Lib", "Internal", "Tests", "Docs"] as const;

type Category = string;

/**
 * The kinds of unit a directory can be. `package` is the fourth level `ai/bc-plugins/dev/forge/codebases/ts-react-frontend/packages.md`
 * adds: a shared package "keeps on-plan.md's unit shapes" without being an island,
 * so it holds components and libs but no address space and no PHP payload mirrors.
 */
export type Level = "app" | "component" | "lib" | "package";

/**
 * § App, § Component, § Lib and `ai/bc-plugins/dev/forge/codebases/ts-react-frontend/packages.md` read as a table: which categories each level
 * may hold. Where the trees could be read against each other — § Component's shape recurses with no
 * bound on where a `Components/` appears, while libs hold only private implementation, tests and docs.
 * Internal directories organize files without adding units or category boundaries.
 */
const LEVEL_CATEGORIES: Record<Level, readonly Category[]> = {
	app: ["Components", "Routes", "Lib", "Tests", "Docs"],
	component: ["Components", "Lib", "Internal", "Tests", "Docs"],
	lib: ["Internal", "Tests", "Docs"],
	package: ["Components", "Lib", "Tests", "Docs"],
};

/** The categories named in rules of their own, rather than only through the table above. */
const COMPONENTS_CATEGORY = "Components";
const LIB_CATEGORY = "Lib";
const INTERNAL_CATEGORY = "Internal";
const ROUTES_CATEGORY = "Routes";
const TESTS_CATEGORY = "Tests";
const DOCS_CATEGORY = "Docs";

/**
 * The route tree TanStack's generator writes and this repository commits. Named here as well as in
 * `vite.config.ts` because the two programs never meet: that one configures the generator, this one
 * checks the file it left behind.
 */
const DEFAULT_ROUTE_TREE = "routeTree.gen.ts";

/** TanStack's own "not a route" marker: a `Routes/` file or folder whose name starts with it is ignored. */
const IGNORED_ROUTE_PREFIX = "-";

/**
 * The island's own TypeScript program (§ App). Allowed at the island root and named here only
 * for that; whether an island *has* one is `typecheck.ts`'s error, since that is the runner it decides.
 */
/** The categories that hold unit folders, and the level each of their children is. */
const UNIT_CATEGORIES: Record<string, Level> = {
	Components: "component",
	Lib: "lib",
};

/**
 * The assigned groups of § Group and the sigil they alone carry. `@Pages/` holds individual page units,
 * `@Features/` capability units and `@Layout/` persistent chrome, all in the app root's
 * `Components/`; the prefix is for the reader, sorting them above the island's own organization, and it
 * is checked as a name rather than read as a meaning — under every other rule they are ordinary groups.
 *
 * Nothing else in an island starts with `@`, units included, which is what makes the sigil worth
 * anything in a listing: `assigned-groups` is the rule that keeps it true.
 */
const ASSIGNED_GROUP_PREFIX = "@";
const ASSIGNED_GROUPS = ["@Pages", "@Features", "@Layout"] as const;

/**
 * A unit's root file is named after its folder; the extension is the unit's kind (§ Component, § Lib).
 * It is also what tells a unit from a group (§ Group): the file wins detection, so a folder holding it is
 * a unit whatever else it holds, and a folder in a unit-holding category without it is a group.
 */
const ROOT_FILE_EXTENSIONS: Record<string, string> = {
	component: ".tsx",
	lib: ".ts",
};

const TESTING_UNIT = "Testing";
const TEST_RUNTIME_PACKAGES = ["vitest", "@testing-library/", "msw"] as const;

const SOURCE_EXTENSIONS = [".ts", ".tsx"];

/** The same two extensions, for stripping: an import specifier names a module, never a file. */
const SOURCE_EXTENSION_PATTERN = /\.tsx?$/;

/** What `vitest.config.ts` collects by, extension aside: a `Tests/` file whose name ends in it. */
const TEST_FILE_SUFFIX = ".test";

/** How the generated route tree names a route file — the only import shape it writes. */
const GENERATED_IMPORT_PATTERN = /\bfrom\s*["']\.\/([^"']+)["']/g;

/**
 * pnpm gives a workspace package its own `node_modules/` inside the package directory, so a link farm
 * sits under `src/` looking exactly like a category that is not one. Nothing below it is island code.
 */
const IGNORED_DIRECTORY = "node_modules";

/**
 * Static import specifiers. Three shapes, all static: `from "…"`, a side-effect `import "…"` and a
 * dynamic `import("…")`. `import.meta.glob("…")` does not match — `\bimport\s*\(` needs the parenthesis
 * next — so a compile-time glob stays out of this graph exactly as it is out of the cruiser's.
 *
 * Matched against the file with its comments removed, which is not optional here: every file in this
 * codebase carries a long docblock and those docblocks quote paths and import forms constantly — one
 * sentence naming a forbidden import would otherwise become that import, a hard error on a file whose
 * code imports nothing.
 */
const IMPORT_PATTERN = /\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']/g;

/**
 * The suppression marker of § Sharing and promotion: the comment a unit's root file carries to state that
 * a wide placement with one consumer is deliberate. Its shape is the one this tree already gives file-level
 * tags — `// @ts-nocheck`, `// @vitest-environment jsdom` — a tag opening a comment line, in a line comment
 * or a docblock alike.
 *
 * Anchored on the comment opener rather than searched for as a word, which is what keeps prose from
 * marking a file: the docblocks here quote rules and tokens constantly, and a bare word would mark a
 * component for discussing marking. Read off the raw text and not through the specifier scan below, which
 * strips comments — the marker *is* a comment, so the read that must see it is the one keeping them.
 */
const OWNERSHIP_MARKER = "@shared-by-decision";
const OWNERSHIP_MARKER_PATTERN = new RegExp(String.raw`^[ \t]*(?://+|/\*+|\*)[ \t]*${OWNERSHIP_MARKER}\b`, "m");

export type Severity = "error" | "recommendation";

export interface Finding {
	rule: string;
	severity: Severity;
	path: string;
	message: string;
}

export type SourceKind = "production" | "test" | "test-support";

export type StructureScope =
	| {
			/** Scope root relative to `root`. */
			root: string;
			level: "app";
			/** Required mount filename for this app. */
			entry: string;
			/** Exact additional filenames allowed loose at the app root. */
			allowedRootFiles?: readonly string[];
	  }
	| {
			root: string;
			level: "package";
	  };

export interface TestSupportPackage {
	root: string;
	specifier: string;
}

export interface StructureCheckerOptions {
	root: string;
	scopes: readonly StructureScope[];
	additionalFileCategories?: readonly string[];
	testSupportPackages?: readonly TestSupportPackage[];
	/** Installed or otherwise external support imports; does not grant local source privileges. */
	testOnlyImports?: readonly string[];
	routeTree?: string;
}

export interface NormalizedGraphModule {
	source: string;
	dependencies: readonly { module: string }[];
}

/** Compare host-discovered files against the collection actually fed to a checker/test runner. */
export function compareFileCoverage(
	kind: "source" | "test",
	discovered: readonly string[],
	collected: readonly string[],
): Finding[] {
	const rule = `${kind}-coverage`;
	const findings: Finding[] = [];
	for (const [path, count] of countPaths(discovered.map(normalizeRelative))) {
		if (count > 1)
			findings.push({ rule, severity: "error", path, message: `discovery lists this file ${count} times` });
	}
	for (const [path, count] of countPaths(collected.map(normalizeRelative))) {
		if (count > 1)
			findings.push({ rule, severity: "error", path, message: `collection includes this file ${count} times` });
	}
	const expected = new Set(discovered.map(normalizeRelative));
	const actual = new Set(collected.map(normalizeRelative));
	if (expected.size === 0)
		findings.push({ rule, severity: "error", path: ".", message: `discovery found no ${kind} files` });
	for (const path of expected) {
		if (!actual.has(path))
			findings.push({ rule, severity: "error", path, message: "discovered file is absent from collection" });
	}
	for (const path of actual) {
		if (!expected.has(path))
			findings.push({ rule, severity: "error", path, message: "collected file is outside discovered scopes" });
	}
	return findings;
}

/** Verify that a host-normalized graph retained every source and import found by scanImports(). */
export function compareImportGraph(
	scanned: ReadonlyMap<string, readonly string[]>,
	modules: readonly NormalizedGraphModule[],
): Finding[] {
	const findings: Finding[] = [];
	if (scanned.size === 0) {
		findings.push({ rule: "graph-fidelity", severity: "error", path: ".", message: "source scan found no modules" });
		return findings;
	}
	const bySource = new Map<string, NormalizedGraphModule>();
	for (const module of modules) {
		const source = normalizeRelative(module.source);
		if (bySource.has(source))
			findings.push({
				rule: "graph-fidelity",
				severity: "error",
				path: source,
				message: "graph contains duplicate source module",
			});
		bySource.set(source, module);
	}
	for (const [sourcePath, specifiers] of scanned) {
		const source = normalizeRelative(sourcePath);
		const module = bySource.get(source);
		const expected = [...new Set(specifiers)].toSorted();
		const actual = module?.dependencies.map(({ module: specifier }) => specifier).toSorted();
		if (JSON.stringify(actual) !== JSON.stringify(expected)) {
			findings.push({
				rule: "graph-fidelity",
				severity: "error",
				path: source,
				message: module
					? `normalized graph differs: expected ${JSON.stringify(expected)}; got ${JSON.stringify(actual)}`
					: "source was not represented in graph",
			});
		}
	}
	return findings;
}

interface Scope {
	root: string;
	level: Level;
	entry?: string;
	allowedRootFiles?: readonly string[];
}

/** Test privileges come from legal Tests/ positions and the fixed Testing-lib/package identities. */
function classifySource(
	repoRoot: string,
	scopes: readonly Scope[],
	supportPackages: readonly TestSupportPackage[],
	source: string,
): SourceKind {
	const scope = scopeContaining(scopes, source);
	if (scope === undefined) return "production";
	if (isTestFile(repoRoot, scope, source)) return "test";
	if (
		supportPackages.some((pkg) => pkg.root === scope.root) ||
		testingUnitContaining(repoRoot, scope, source) !== undefined
	)
		return "test-support";
	return "production";
}

function scopeContaining(scopes: readonly Scope[], source: string): Scope | undefined {
	return scopes.find((scope) => source === scope.root || source.startsWith(`${scope.root}/`));
}

function testingUnitContaining(repoRoot: string, scope: Scope, source: string): string | undefined {
	let directory = dirname(source);
	while (directory.startsWith(`${scope.root}/`)) {
		if (
			basename(directory) === TESTING_UNIT &&
			unitLevelAt(repoRoot, scope.root, directory) === "lib" &&
			holdsRootFile(repoRoot, directory, "lib")
		) {
			return directory;
		}
		directory = dirname(directory);
	}
	return undefined;
}

/**
 * Bind the checker to installation-owned roots without taking over their discovery or command execution.
 * Filesystem walking and path semantics remain shared so empty trees, assets-only directories, groups,
 * and source files are interpreted exactly as in the extracted island checker.
 */
export function createStructureChecker(options: StructureCheckerOptions): {
	checkStructure(): Finding[];
	scanImports(): Map<string, string[]>;
	classifySource(path: string): SourceKind;
} {
	const repoRoot = resolve(options.root);
	const scopes: Scope[] = options.scopes.map((scope) => ({
		...scope,
		root: normalizeRelative(scope.root),
		...(scope.level === "app" ? { entry: scope.entry } : {}),
	}));
	const additionalCategories = [...(options.additionalFileCategories ?? [])];
	const categories = [...CATEGORIES, ...additionalCategories];
	const supportPackages = (options.testSupportPackages ?? []).map((pkg) => ({
		root: normalizeRelative(pkg.root),
		specifier: pkg.specifier,
	}));
	const routeTree = options.routeTree ?? DEFAULT_ROUTE_TREE;
	// Prefix-based ownership uses canonical source-directory roots, not repository-root aliases.
	// Validate before any public operation can walk files or grant source privileges.
	for (const scope of scopes) {
		if (
			!scope.root ||
			isAbsolute(scope.root) ||
			scope.root.split("/").some((part) => !part || part === "." || part === "..")
		)
			throw new Error(`scope root must be a canonical non-root repository-relative directory: ${scope.root || "."}`);
		if (scope.level === "app") {
			for (const name of [scope.entry ?? "", ...(scope.allowedRootFiles ?? [])])
				if (!name || name.includes("/") || name.includes("\\") || name === "." || name === "..")
					throw new Error(`app root file must be a filename: ${name}`);
		}
	}
	for (const name of [...additionalCategories, routeTree])
		if (!name || name.includes("/") || name.includes("\\") || name === "." || name === "..")
			throw new Error(`category and route-tree bindings must be single names: ${name}`);

	function scanImports(): Map<string, string[]> {
		const scanned = new Map<string, string[]>();
		for (const scope of scopes) {
			for (const file of sourceFilesUnder(join(repoRoot, scope.root), isSourceFile)) {
				scanned.set(relative(repoRoot, file).split(sep).join("/"), readSpecifiers(file));
			}
		}
		return scanned;
	}

	function checkStructure(): Finding[] {
		if (scopes.length === 0) throw new Error(`no structure scopes supplied for ${repoRoot}`);
		const findings: Finding[] = [];
		for (const [path, count] of countPaths(scopes.map((scope) => scope.root))) {
			if (count > 1)
				findings.push({ rule: "scope-coverage", severity: "error", path, message: `scope appears ${count} times` });
		}
		for (const [index, scope] of scopes.entries()) {
			if (!scope.root || isAbsolute(scope.root) || scope.root.split("/").includes("..")) {
				findings.push({
					rule: "scope-coverage",
					severity: "error",
					path: scope.root || ".",
					message: "scope root must be a nonempty repository-relative path",
				});
				continue;
			}
			if (scopes.some((other, otherIndex) => otherIndex !== index && scope.root.startsWith(`${other.root}/`))) {
				findings.push({
					rule: "scope-coverage",
					severity: "error",
					path: scope.root,
					message: "scope overlaps another configured scope",
				});
			}
		}
		for (const support of supportPackages) {
			if (!scopes.some((scope) => scope.root === support.root && scope.level === "package") || !support.specifier) {
				findings.push({
					rule: "scope-coverage",
					severity: "error",
					path: support.root,
					message: "test-support package must identify a configured package scope and import specifier",
				});
			}
		}
		for (const category of additionalCategories) {
			if (CATEGORIES.includes(category as (typeof CATEGORIES)[number])) {
				findings.push({
					rule: "scope-coverage",
					severity: "error",
					path: category,
					message: "additional file categories must not replace or duplicate fixed shared categories",
				});
			}
		}
		for (const scope of scopes) {
			if (!scope.root || isAbsolute(scope.root) || scope.root.split("/").includes("..")) continue;
			if (!existsSync(join(repoRoot, scope.root))) {
				findings.push({
					rule: "scope-coverage",
					severity: "error",
					path: scope.root,
					message: "configured scope does not exist",
				});
				continue;
			}
			if (sourceFilesUnder(join(repoRoot, scope.root), isSourceFile).length === 0) {
				findings.push({
					rule: "scope-coverage",
					severity: "error",
					path: scope.root,
					message: "configured scope has no TypeScript source files",
				});
			}
			if (scope.level === "app") {
				checkIslandRootFiles(repoRoot, scope, findings);
				checkRouteTreeCurrency(repoRoot, scope.root, routeTree, findings);
			}
			checkAssignedGroups(repoRoot, scope, findings);
			checkUnit(repoRoot, scope.root, scope.level, findings, categories);
			checkImportsInScope(repoRoot, scope.root, findings, additionalCategories);
			checkTestOnlyImports(repoRoot, scope, scopes, supportPackages, options.testOnlyImports ?? [], findings);
			checkTestPlacement(repoRoot, scope, findings);
			checkOwnershipDrift(repoRoot, scope, scopes, supportPackages, additionalCategories, findings);
		}
		return findings;
	}

	return {
		checkStructure,
		scanImports,
		classifySource: (path) => classifySource(repoRoot, scopes, supportPackages, normalizeRelative(path)),
	};
}

function checkTestOnlyImports(
	repoRoot: string,
	scope: Scope,
	scopes: readonly Scope[],
	supportPackages: readonly TestSupportPackage[],
	testOnlyImports: readonly string[],
	findings: Finding[],
): void {
	for (const file of sourceFilesUnder(join(repoRoot, scope.root), isSourceFile)) {
		const source = relative(repoRoot, file).split(sep).join("/");
		if (classifySource(repoRoot, scopes, supportPackages, source) !== "production") continue;

		for (const specifier of readSpecifiers(file)) {
			const runtime = TEST_RUNTIME_PACKAGES.some((name) =>
				name.endsWith("/") ? specifier.startsWith(name) : specifier === name || specifier.startsWith(`${name}/`),
			);
			const testingPackage = [...supportPackages.map((pkg) => pkg.specifier), ...testOnlyImports].some(
				(name) => specifier === name || specifier.startsWith(`${name}/`),
			);
			const target = specifier.startsWith(".") ? resolveSpecifier(source, specifier) : "";
			const testingLibrary = target !== "" && testingUnitContaining(repoRoot, scope, target) !== undefined;
			if (!runtime && !testingPackage && !testingLibrary) continue;

			findings.push({
				rule: "test-only-import",
				severity: "error",
				path: source,
				message: `${specifier} is test-only; import it only from a legal Tests/ category or recognized Testing library`,
			});
		}
	}
}

/**
 * § App: the island root's loose files are the entry, which the build contract names after the
 * directory, `App.tsx`, and `tsconfig.json`. A fourth loose file is a lib that skipped `Lib/`, and a
 * missing entry aborts every build (`vite.config.ts` throws on it), so the check reports the shape rather
 * than waiting for the build to say it differently.
 *
 * The three are exactly three, although § Styling grants a component a co-located CSS module and § App
 * calls `App.tsx` the shell's component: the shell has no styling role to lose — the chrome
 * that stays at every address is a root `Components/` unit — so `App.module.css` here is the same error
 * as a stray `README.md` or `.gitignore`, and the island's documentation goes in `Docs/`.
 *
 * **`tsconfig.json` is allowed here, not required**, although an island without one is a hard error of
 * `typecheck.ts`. Presence is that runner's business because it is the one that would otherwise typecheck
 * nothing; requiring it here would only mean every fixture tree in this directory carrying a stub config
 * to prove some other rule.
 */
function checkIslandRootFiles(repoRoot: string, scope: Scope, findings: Finding[]): void {
	const islandRoot = scope.root;
	const required = [scope.entry ?? `${basename(islandRoot)}.tsx`, "App.tsx"];
	const allowed = [...required, ...(scope.allowedRootFiles ?? [])];
	const actual = filesIn(join(repoRoot, islandRoot));

	for (const name of actual.filter((file) => !allowed.includes(file))) {
		findings.push({
			rule: "island-root-files",
			severity: "error",
			path: `${islandRoot}/${name}`,
			message: `the island root holds only ${allowed.join(", ")}; ${name} belongs in a category folder`,
		});
	}

	for (const name of required.filter((file) => !actual.includes(file))) {
		findings.push({
			rule: "island-root-files",
			severity: "error",
			path: `${islandRoot}/${name}`,
			message: `missing: the island root requires ${required.join(" and ")}`,
		});
	}
}

/** A unit's subfolders are categories, and which categories it may hold is its level's business. */
function checkUnit(
	repoRoot: string,
	unitPath: string,
	level: Level,
	findings: Finding[],
	categories: readonly string[],
): void {
	if (level === "component") {
		checkComponentRootFile(repoRoot, unitPath, findings);
	} else if (level === "lib") {
		checkLibRootFile(repoRoot, unitPath, findings);
	}

	for (const name of directoriesIn(join(repoRoot, unitPath))) {
		const path = `${unitPath}/${name}`;

		if (!isCategory(name, categories)) {
			findings.push({
				rule: "unknown-category",
				severity: "error",
				path,
				message: `not a category: a unit's subfolders come from ${categories.join(", ")}`,
			});

			continue;
		}

		const allowedAtLevel =
			level === "app"
				? [
						...LEVEL_CATEGORIES.app,
						...categories.filter((category) => !CATEGORIES.includes(category as (typeof CATEGORIES)[number])),
					]
				: LEVEL_CATEGORIES[level];
		if (!allowedAtLevel.includes(name)) {
			findings.push({
				rule: "category-level",
				severity: "error",
				path,
				message: `a ${level} level holds ${LEVEL_CATEGORIES[level].join(", ")} — not ${name}`,
			});

			continue;
		}

		checkCategory(repoRoot, path, name, findings, categories);
	}
}

/**
 * § Component's tree read as a loose-file rule, the counterpart of `island-root-files` one level down: a
 * component's loose source modules are its matching .tsx and optional Api.ts. Extracted non-component implementations
 * belong in Internal/ or an owned lib; child components belong in Components/.
 *
 * **Only source modules are judged.** § Styling puts `{Component}.module.css` right there beside the
 * root file, and a component's other non-source files are its own; the rule is about units that went
 * missing, not about a component's whole listing.
 *
 * The two neighbouring levels have their own answer and are deliberately not this rule's: the app root's
 * three loose files are `island-root-files`', and a lib's matching entry is its only loose source module,
 * enforced by `lib-root-file` below.
 */
function checkComponentRootFile(repoRoot: string, componentPath: string, findings: Finding[]): void {
	const rootFile = rootFileOf(componentPath, "component");
	const apiFile = `${basename(componentPath)}Api.ts`;
	const loose = filesIn(join(repoRoot, componentPath)).filter(
		(name) => isSourceFile(name) && name !== rootFile && name !== apiFile,
	);

	for (const name of loose) {
		findings.push({
			rule: "component-root-file",
			severity: "error",
			path: `${componentPath}/${name}`,
			message: `a component holds ${rootFile} and optional ${apiFile} loose and no other source module; ${name} belongs at ${unitDestination(name)}`,
		});
	}
}

/**
 * § Lib's loose-file rule: the file matching the folder is the whole public entry, while extracted
 * implementation stays visibly private under `Internal/` and tests stay under `Tests/`.
 *
 * As with `component-root-file`, this judges source modules only. Data files and other non-code assets
 * remain the lib's own, and `Internal/` may organize private source to any depth.
 */
function checkLibRootFile(repoRoot: string, libPath: string, findings: Finding[]): void {
	const rootFile = rootFileOf(libPath, "lib");
	const loose = filesIn(join(repoRoot, libPath)).filter((name) => isSourceFile(name) && name !== rootFile);

	for (const name of loose) {
		const destination = withoutExtension(name).endsWith(TEST_FILE_SUFFIX)
			? `${TESTS_CATEGORY}/${name}`
			: `${INTERNAL_CATEGORY}/${name}`;

		findings.push({
			rule: "lib-root-file",
			severity: "error",
			path: `${libPath}/${name}`,
			message: `a lib holds only ${rootFile} loose as source; ${name} belongs at ${destination}`,
		});
	}
}

/** Suggest a legal extraction path without requiring every non-component helper to become a lib. */
function unitDestination(name: string): string {
	const unit = withoutExtension(name);

	if (unit.endsWith(TEST_FILE_SUFFIX)) {
		return `${TESTS_CATEGORY}/${name}`;
	}

	if (unit.includes(".")) {
		return `${INTERNAL_CATEGORY}/${name}`;
	}

	const level: Level = name === rootFileOf(unit, "component") ? "component" : "lib";
	const category = level === "component" ? COMPONENTS_CATEGORY : INTERNAL_CATEGORY;

	return level === "lib" ? `${category}/${name}` : `${category}/${unit}/${rootFileOf(unit, level)}`;
}

/**
 * The trees of § App, § Component and § Lib read across their category rows: `Components/` and `Lib/`
 * hold unit folders — components and libs, always folders — while `Types/` and `Tests/` hold files.
 * Routes, Internal and Docs have their own contents and are not traversed as unit categories.
 */
function checkCategory(
	repoRoot: string,
	categoryPath: string,
	category: Category,
	findings: Finding[],
	categories: readonly string[],
): void {
	const level = UNIT_CATEGORIES[category];

	reportEmptyDirectory(repoRoot, categoryPath, "category", findings);

	// Routes uses upstream grammar; Internal organizes private files freely, and § Docs gives
	// documentation the same freedom — a subject that outgrows one page becomes a folder of pages, and
	// nothing downstream reads a doc's position. Import and source scans still traverse all three, but
	// their directories introduce neither units nor further categories.
	if (category === ROUTES_CATEGORY || category === INTERNAL_CATEGORY || category === DOCS_CATEGORY) {
		return;
	}

	if (level === undefined) {
		reportWrongKind(categoryPath, category, "folder", directoriesIn(join(repoRoot, categoryPath)), findings);

		return;
	}

	reportWrongKind(categoryPath, category, "file", filesIn(join(repoRoot, categoryPath)), findings);
	checkUnitFolders(repoRoot, categoryPath, level, findings, categories);
}

/**
 * § Group: a unit-holding category MAY organize its units into group folders, nested to any depth. A
 * group's children are checked exactly as if they sat in the category directly, which is the whole of
 * "transparent": the group grants no rights and imposes none.
 *
 * - **`group-contents`** — a group holds unit folders or further groups and carries no file of its own:
 *   it adds a path segment, not a unit. A loose file in a group is a unit that skipped its folder — or,
 *   the case the message names out loud, a unit whose root file was lost to a rename, which now reads as
 *   a group and is reported through this rule rather than as the missing file it is — the accepted cost
 *   of detecting groups by content instead of by name.
 * - **`group-name`** — a group takes a name of its own, never a category's. Position already tells the
 *   two apart, so this rule is for the reader: a `Lib` inside `Components/` costs a double take. It is
 *   also where the lost-root-file cascade surfaces when the folder kept its categories — they read as
 *   groups named after categories.
 */
function checkGroup(
	repoRoot: string,
	groupPath: string,
	level: Level,
	findings: Finding[],
	categories: readonly string[],
): void {
	const name = basename(groupPath);

	reportEmptyDirectory(repoRoot, groupPath, "group", findings);

	if (isCategory(name, categories)) {
		findings.push({
			rule: "group-name",
			severity: "error",
			path: groupPath,
			message: `${name}/ is a category name, and this folder is a group: a group takes a name of its own`,
		});
	}

	for (const file of filesIn(join(repoRoot, groupPath))) {
		findings.push({
			rule: "group-contents",
			severity: "error",
			path: `${groupPath}/${file}`,
			message: describeGroupContents(groupPath, level, categories),
		});
	}

	checkUnitFolders(repoRoot, groupPath, level, findings, categories);
}

/**
 * The rule, plus the root file that would make this folder a unit instead — the closest content
 * detection gets to the diagnosis the retired `unit-root-file` gave.
 *
 * That second half is named only where creating the file is the fix. On a category name or on the sigil
 * it is the wrong advice twice over: `group-name` and `assigned-groups` reject exactly the unit it would
 * produce, and such a folder is almost always the cascade of a rename one level up rather than a unit of
 * its own.
 */
function describeGroupContents(groupPath: string, level: Level, categories: readonly string[]): string {
	const name = basename(groupPath);
	const rule = `${name}/ holds unit folders and no file of its own: a group adds a path segment, not a unit`;

	if (isCategory(name, categories) || name.startsWith(ASSIGNED_GROUP_PREFIX)) {
		return rule;
	}

	return `${rule} — this folder would be a unit if it held ${rootFileOf(groupPath, level)}`;
}

/**
 * The walk a unit-holding directory shares with any group inside it, and the one place group-or-unit is
 * decided: the root file wins (§ Group), so a folder holding it is walked as a unit whatever else it
 * holds, and every other folder is a group.
 */
function checkUnitFolders(
	repoRoot: string,
	holderPath: string,
	level: Level,
	findings: Finding[],
	categories: readonly string[],
): void {
	for (const name of directoriesIn(join(repoRoot, holderPath))) {
		const path = `${holderPath}/${name}`;

		if (holdsRootFile(repoRoot, path, level)) {
			checkUnit(repoRoot, path, level, findings, categories);

			continue;
		}

		checkGroup(repoRoot, path, level, findings, categories);
	}
}

/** § Component and § Lib: a unit carries the file its folder names, and § Group makes that file detection. */
function holdsRootFile(repoRoot: string, path: string, level: Level): boolean {
	return filesIn(join(repoRoot, path)).includes(rootFileOf(path, level));
}

function rootFileOf(path: string, level: Level): string {
	return `${basename(path)}${ROOT_FILE_EXTENSIONS[level]}`;
}

function reportWrongKind(
	categoryPath: string,
	category: Category,
	kind: string,
	offenders: string[],
	findings: Finding[],
): void {
	const holds = kind === "folder" ? "files" : "unit folders";

	for (const name of offenders) {
		findings.push({
			rule: "category-contents",
			severity: "error",
			path: `${categoryPath}/${name}`,
			message: `${category}/ holds ${holds}, and this is a ${kind}`,
		});
	}
}

/**
 * § Group's sigil sentence: `@Pages/`, `@Features/` and `@Layout/` are the only folders in an island that start with
 * `@` — units included — they stand in the app root's `Components/`, and they are groups like any other
 * folder there rather than units wearing a prefix.
 *
 * A walk of its own rather than a branch of the unit walk, because the rule is about the whole tree: a
 * `@`-named folder inside `Types/`, or anywhere in a shared package, is exactly as wrong as one in a
 * nested `Components/`, and the unit walk never descends into the first of those.
 *
 * `Routes/` is the one place the walk stops, on the header's foreign-territory promise: TanStack's
 * grammar turns a route file's name into a URL segment, so a `Routes/@handle.tsx` is an address rather
 * than a folder wearing the island's sigil, and it is upstream's generator that judges it.
 */
function checkAssignedGroups(repoRoot: string, scope: Scope, findings: Finding[]): void {
	const home = scope.level === "app" ? `${scope.root}/${COMPONENTS_CATEGORY}` : "";

	for (const path of directoriesUnder(repoRoot, scope.root)) {
		if (!basename(path).startsWith(ASSIGNED_GROUP_PREFIX) || isInsideRoutes(scope.root, path)) {
			continue;
		}

		const problem = describeAssignedGroupProblem(repoRoot, path, home);

		if (problem !== null) {
			findings.push({ rule: "assigned-groups", severity: "error", path, message: problem });
		}
	}
}

/** The three ways a `@` name goes wrong: not an assigned name, not at home, or not a group. */
function describeAssignedGroupProblem(repoRoot: string, path: string, home: string): string | null {
	const name = basename(path);

	if (!(ASSIGNED_GROUPS as readonly string[]).includes(name)) {
		return `${ASSIGNED_GROUP_PREFIX} marks an assigned group: only ${ASSIGNED_GROUPS.join(", ")} carry it, units included`;
	}

	if (dirname(path) !== home) {
		return `${name}/ stands in the app root's ${COMPONENTS_CATEGORY}/ and nowhere else`;
	}

	if (holdsRootFile(repoRoot, path, "component")) {
		return `${name}/ is a group: it holds unit folders, never a root file of its own`;
	}

	return null;
}

/**
 * The one recommendation tier this checker seeds, and a real rule rather than a placeholder: § Ownership
 * has a category folder appear with its first member, so a category holding no file anywhere below it is
 * leftover noise from a move — worth reporting, never worth failing a run over.
 *
 * A group is read the same way and reported under the same rule name, the group being transparent: an
 * empty one is the same leftover-from-a-move shape, and it has no other tier to be reported in.
 */
function reportEmptyDirectory(repoRoot: string, path: string, subject: string, findings: Finding[]): void {
	if (sourceFilesUnder(join(repoRoot, path), () => true).length > 0) {
		return;
	}

	findings.push({
		rule: "empty-category",
		severity: "recommendation",
		path,
		message: `holds no files: a ${subject} appears with its first file, so this one is left over`,
	});
}

/**
 * `ai/bc-plugins/dev/forge/codebases/ts-react-frontend/navigation.md` § The generated tree's policy, guarded: the route tree is generated but *committed*, so it can be
 * stale — a route file authored without a dev-server or build run is a destination that exists on disk
 * and in no program. Nothing else in `check` would notice, because a stale tree typechecks, lints and
 * tests exactly as a current one does, and the address it forgot answers with the island's own 404.
 *
 * A text scan for the import specifier the generator writes, in the style of the specifier scan below:
 * `./{path below Routes/, without the extension}`, whatever else the generated file wraps around it.
 *
 * **Both directions are checked here**, and the second one is not redundant: a tree naming a route file
 * that has been deleted is an unresolvable import that no other step of `check` reports. `typecheck` is
 * silenced by the generated file's own `// @ts-nocheck`, `lint` by `biome.json`'s exclusion of it, and
 * the cruiser config carries no unresolvable-module rule — leaving only a root test that renders `App`,
 * which not every island has. Measured while reviewing this chunk; the familiar silent-pass shape, seen
 * from the other end.
 *
 * Files TanStack itself ignores are ignored: a `Routes/` name starting with `-` is upstream's marker for
 * "not a route", and this checker does not get to disagree with the grammar it declared foreign.
 */
function checkRouteTreeCurrency(repoRoot: string, islandRoot: string, routeTree: string, findings: Finding[]): void {
	const routesDirectory = join(repoRoot, islandRoot, ROUTES_CATEGORY);

	if (!existsSync(routesDirectory)) {
		return;
	}

	const treePath = join(routesDirectory, routeTree);
	const treeRelativePath = `${islandRoot}/${ROUTES_CATEGORY}/${routeTree}`;

	if (!existsSync(treePath)) {
		findings.push({
			rule: "route-tree-current",
			severity: "error",
			path: treeRelativePath,
			message: "missing: the generated route tree is committed, and a dev server or build run writes it",
		});

		return;
	}

	const tree = readFileSync(treePath, "utf8");

	for (const file of sourceFilesUnder(routesDirectory, isSourceFile)) {
		const below = relative(routesDirectory, file).split(sep).join("/");

		if (file === treePath || isIgnoredRouteFile(below) || namesRouteFile(tree, below)) {
			continue;
		}

		findings.push({
			rule: "route-tree-current",
			severity: "error",
			path: `${islandRoot}/${ROUTES_CATEGORY}/${below}`,
			message: `not in ${routeTree}: run the dev server or a build to regenerate the committed tree`,
		});
	}

	reportVanishedRouteFiles(routesDirectory, tree, treeRelativePath, findings);
}

/** The other direction: a route file the committed tree still imports and the tree no longer holds. */
function reportVanishedRouteFiles(
	routesDirectory: string,
	tree: string,
	treeRelativePath: string,
	findings: Finding[],
): void {
	for (const specifier of routeSpecifiersIn(tree)) {
		const target = join(routesDirectory, specifier);

		if (SOURCE_EXTENSIONS.some((extension) => existsSync(`${target}${extension}`))) {
			continue;
		}

		findings.push({
			rule: "route-tree-current",
			severity: "error",
			path: treeRelativePath,
			message: `imports "./${specifier}", which is not a route file: regenerate the committed tree`,
		});
	}
}

/** The relative specifiers the generated tree imports its route files by, without their leading `./`. */
function routeSpecifiersIn(tree: string): string[] {
	return [...tree.matchAll(GENERATED_IMPORT_PATTERN)].map((match) => match[1] ?? "");
}

/** TanStack skips a route file whose name — or whose folder's — starts with the ignore prefix. */
function isIgnoredRouteFile(pathBelowRoutes: string): boolean {
	return pathBelowRoutes.split("/").some((segment) => segment.startsWith(IGNORED_ROUTE_PREFIX));
}

function namesRouteFile(tree: string, pathBelowRoutes: string): boolean {
	const specifier = `./${withoutExtension(pathBelowRoutes)}`;

	return tree.includes(`"${specifier}"`) || tree.includes(`'${specifier}'`);
}

/** Every relative import in the scope, judged against the visibility rules of § Imports. */
function checkImportsInScope(
	repoRoot: string,
	scopeRoot: string,
	findings: Finding[],
	categories: readonly string[],
): void {
	for (const file of sourceFilesUnder(join(repoRoot, scopeRoot), isSourceFile)) {
		const source = relative(repoRoot, file).split(sep).join("/");

		for (const specifier of readSpecifiers(file)) {
			const problem = describeVisibilityProblem(repoRoot, scopeRoot, source, specifier, categories);

			if (problem !== null) {
				findings.push({ rule: "import-visibility", severity: "error", path: source, message: problem });
			}
		}
	}
}

/**
 * The § Imports visibility rules, decided from the two paths and the tree they name: everything but the
 * group segments is read off the strings, and those are read off the folders they point at. The importer
 * and the target share a deepest common directory — the `../` count names it — and everything legal is
 * one short step below it:
 * a file the common directory itself holds (the importer is inside that unit's subtree), a component
 * entered through either public interface or a lib entered through its root file, or an island-wide `Types/` file.
 * Internal targets are checked by their owning unit before descent: arbitrary private directory depth
 * is legal throughout that owner's subtree, and inaccessible outside it.
 *
 * An edge whose *target* is inside `Routes/` is not judged here at all. That boundary is a rule of its
 * own — nothing outside `Routes/` imports from it save `App.tsx` taking the generated tree — and it is
 * an edge between two paths with no prefix relationship in it, so it lives in the cruiser config where
 * such rules belong. Judging it here as well would have this file inventing a unit grammar for a
 * directory § Navigation declares foreign, and would misread every nested route file as one.
 *
 * **A group is skipped on both sides**, which is the whole of what § Group means by adding a path
 * segment and nothing else: a group segment inside the descent (`../Components/@Pages/New/New` from a
 * route file) drops out of it, and a common directory that is a group (two units in one group reading
 * each other's root files) is lifted to the category holding it — through a whole chain of groups, since
 * groups nest. The two together make the specifier judge exactly as an ungrouped one does, so a group
 * grants no import right and takes none away.
 *
 * **Which segments those are is read off the tree**, not off the path: § Group detects a group by the
 * root file it does not hold, so this judgement consults directories where it once matched a prefix. A
 * segment that names no directory at all is left standing — a specifier reaching through a folder that
 * is not there is broken, and stripping the segment would judge it as if it resolved.
 */
function describeVisibilityProblem(
	repoRoot: string,
	scopeRoot: string,
	source: string,
	specifier: string,
	additionalCategories: readonly string[],
): string | null {
	if (!specifier.startsWith(".")) {
		return null;
	}

	if (isInsideRoutes(scopeRoot, resolveSpecifier(source, specifier))) {
		return null;
	}

	const target = resolveSpecifier(source, specifier);
	const targetUnit = dirname(target);
	const targetLevel = unitLevelAt(repoRoot, scopeRoot, targetUnit);
	if (
		source.startsWith(`${targetUnit}/`) &&
		!isTestFile(repoRoot, { root: scopeRoot, level: "app" }, source) &&
		(targetLevel === "component" || targetLevel === "lib") &&
		holdsRootFile(repoRoot, targetUnit, targetLevel) &&
		entersThroughPublicInterface([basename(targetUnit), basename(target)], targetLevel)
	) {
		return `${specifier} imports its own or an enclosing ${targetLevel}'s public interface; import the implementation directly`;
	}

	const internalOwner = categoryOwner(repoRoot, scopeRoot, target, INTERNAL_CATEGORY);
	if (internalOwner !== undefined) {
		return source.startsWith(`${internalOwner}/`)
			? null
			: `${specifier} reaches into Internal/ private to ${internalOwner}`;
	}

	const parts = specifier.split("/");
	const ups = parts.filter((part) => part === "..").length;
	const from = ascend(dirname(source), ups);
	const steps = parts.filter((part) => part !== ".." && part !== ".");
	const descent = withoutGroups(repoRoot, scopeRoot, from, steps);
	const common = liftGroups(repoRoot, scopeRoot, from);

	if (descent.length === 0) {
		return null;
	}

	return judgeDescent({ scopeRoot, common, descent, specifier, additionalCategories });
}

/** The descent with its group segments dropped; the last one names a file, so it is never a group. */
function withoutGroups(repoRoot: string, scopeRoot: string, from: string, descent: string[]): string[] {
	const kept: string[] = [];
	let directory = from;

	for (const [index, part] of descent.entries()) {
		directory = `${directory}/${part}`;

		if (index === descent.length - 1 || !isGroupDirectory(repoRoot, scopeRoot, directory)) {
			kept.push(part);
		}
	}

	return kept;
}

/** A group read as the category holding it — groups nest, so the chain lifts to its first non-group holder. */
function liftGroups(repoRoot: string, scopeRoot: string, directory: string): string {
	return isGroupDirectory(repoRoot, scopeRoot, directory)
		? liftGroups(repoRoot, scopeRoot, dirname(directory))
		: directory;
}

/** § Group off the tree: a directory standing where a unit may stand and holding no root file is a group. */
function isGroupDirectory(repoRoot: string, scopeRoot: string, path: string): boolean {
	const level = unitLevelAt(repoRoot, scopeRoot, path);

	return level !== undefined && existsSync(join(repoRoot, path)) && !holdsRootFile(repoRoot, path, level);
}

/**
 * The level a unit standing at this position would be, or undefined when no unit may stand there at all:
 * a unit position is a child of a `Components/` or `Lib/`, or a child of a group inside one.
 *
 * The holder is read by position rather than by name, which matters exactly where `group-name` is
 * violated: a group named `Lib` inside `Components/` would otherwise hand its units a lib's `.ts` root
 * file and turn every component below it into a group.
 */
function unitLevelAt(repoRoot: string, scopeRoot: string, path: string): Level | undefined {
	if (!path.startsWith(`${scopeRoot}/`)) {
		return undefined;
	}

	const holder = dirname(path);

	if (isCategoryPosition(repoRoot, scopeRoot, holder)) {
		return UNIT_CATEGORIES[basename(holder)];
	}

	const holderLevel = unitLevelAt(repoRoot, scopeRoot, holder);

	// The holder passes its level down only when it is a group: a unit's children are categories.
	return holderLevel !== undefined && !holdsRootFile(repoRoot, holder, holderLevel) ? holderLevel : undefined;
}

/** A category stands in a unit or at a scope root, never in a category or a group (the trees of § App and § Component). */
function isCategoryPosition(repoRoot: string, scopeRoot: string, path: string): boolean {
	const holder = dirname(path);

	if (holder === scopeRoot) {
		return true;
	}

	const holderLevel = unitLevelAt(repoRoot, scopeRoot, holder);

	return holderLevel !== undefined && holdsRootFile(repoRoot, holder, holderLevel);
}

interface Descent {
	scopeRoot: string;
	additionalCategories: readonly string[];
	/** The deepest directory the importer and the target share. */
	common: string;
	/** The target's path below that directory. */
	descent: string[];
	specifier: string;
}

function judgeDescent(step: Descent): string | null {
	const { common, descent, specifier } = step;
	const head = descent[0] ?? "";

	// A file the common directory holds: the importer is inside that unit, so its loose files are its own.
	if (descent.length === 1) {
		return null;
	}

	if (isCategory(head) || step.additionalCategories.includes(head)) {
		return judgeCategoryDescent(step);
	}

	// Reaching up into a category folder and back down into a sibling unit — the surface rule again, seen
	// from one level lower: only the unit's public interfaces are visible.
	if (UNIT_CATEGORIES[basename(common)] !== undefined) {
		return judgeSiblingDescent(step);
	}

	return `${specifier} reaches past a unit's public interface into files private to its own subtree`;
}

function judgeCategoryDescent(step: Descent): string | null {
	const { scopeRoot, common, descent, specifier } = step;
	const head = descent[0] ?? "";

	if (step.additionalCategories.includes(head)) {
		return descent.length === 2 && common === scopeRoot
			? null
			: `${specifier} does not name a file directly under the configured ${head}/ category`;
	}

	if (head === TESTS_CATEGORY || head === DOCS_CATEGORY) {
		return `${specifier} reaches into ${head}/, which is imported only from inside it`;
	}

	return descent.length === 3 && entersThroughPublicInterface(descent, UNIT_CATEGORIES[head])
		? null
		: `${specifier} enters a unit other than through its public interface`;
}

function judgeSiblingDescent(step: Descent): string | null {
	const { common, descent, specifier } = step;

	return descent.length === 2 && entersThroughPublicInterface(descent, UNIT_CATEGORIES[basename(common)])
		? null
		: `${specifier} enters a unit other than through its public interface`;
}

/**
 * § Sharing and promotion read downward (#29411): a unit whose public interfaces exactly one *other* unit imports,
 * that unit sitting strictly below the unit's holder, may be filed wider than its responsibility requires.
 * Cohesion decides whether it belongs under that consumer. The finding names the move and the fork it presents: demote it, or say the wide
 * placement is meant with the marker above.
 *
 * **Recommendation tier, never error.** § Sharing and promotion leaves the *moment* of a move a judgement,
 * and a unit mid-construction flickers through sole-consumer states; forcing move-or-mark on every one of
 * them would fight ordinary work rather than catch rot.
 *
 * A walk of its own per scope, like `checkAssignedGroups` and for the same kind of reason: this is a rule
 * about the whole scope's import graph rather than about one folder's contents, so the scope's edges are
 * read once and every unit judged against the result.
 *
 * **The readings the #29411 prototype settled by measuring them**, each carried by a clause below:
 *
 * 1. *A unit's own subtree is never its own consumer.* An importer inside the unit is the unit reading
 *    itself, and an importer in a unit nested under it would have the rule propose moving a component
 *    under its own child.
 * 2. *A `Tests/` importer is not a consumer.* A test names what it exercises, which is not a statement
 *    about where production code belongs — and § Imports' `Tests/` clause constrains imports *into*
 *    `Tests/`, not out of it, so such an edge is legal and still says nothing about placement.
 * 3. *Holders are read through groups* (§ Group): a unit in `@Layout/` is held by the island root, the
 *    shelf adding a path segment and nothing else.
 * 4. *A sole consumer outside the holder's subtree raises nothing here* — that edge is already an
 *    `import-visibility` error, and reporting it again under a second name would state one violation
 *    twice. The marker is silent there too: a placement this rule declines to judge is not one it may
 *    call a marker dead over.
 * 5. *A unit nothing imports raises nothing.* Whether a unit is dead is a different question.
 *
 * **The marker's other half.** A marked unit that no longer meets the condition — several consumers, a
 * sole consumer that is its holder, no consumer at all — is told to remove the marker: the placement it
 * defends is justified by position alone, so it is dead text, and dead suppressions are exactly the noise
 * a suppression mechanism otherwise accumulates.
 *
 * **Per scope by construction.** A cross-scope edge is a bare `@islands/{name}` specifier, which no
 * relative path relationship judges, so a package unit consumed by exactly one island unit is invisible
 * here — the same boundary § Sharing and promotion draws between promotion and packaging.
 */
function checkOwnershipDrift(
	repoRoot: string,
	scope: Scope,
	scopes: readonly Scope[],
	supportPackages: readonly TestSupportPackage[],
	additionalCategories: readonly string[],
	findings: Finding[],
): void {
	const units = unitsOf(repoRoot, scope);
	const importers = importersOf(repoRoot, scope, units, additionalCategories);
	const byPath = new Map(units.map((unit) => [unit.path, unit]));

	for (const unit of units) {
		const message = describeOwnershipDrift(
			repoRoot,
			scope,
			byPath,
			unit,
			importers.get(unit.path) ?? [],
			scopes,
			supportPackages,
		);

		if (message !== null) {
			findings.push({ rule: "ownership-drift", severity: "recommendation", path: unit.rootFile, message });
		}
	}
}

/** One unit of a scope, with everything the rule asks of it read off its position. */
interface Unit {
	/** The unit folder, repo-relative. */
	path: string;
	level: Level;
	/** The root file — what an importer must name, and what a finding points at. */
	rootFile: string;
	/** The unit or scope root whose category holds it, through any chain of groups. */
	holder: string;
}

/** One import landing on a unit's public interface, carrying the unit the importing file belongs to. */
interface Edge {
	file: string;
	owner: string;
	legal: boolean;
}

/** Every unit of the scope, in walk order, each carrying the holder its position gives it. */
function unitsOf(repoRoot: string, scope: Scope): Unit[] {
	const units: Unit[] = [];

	for (const path of directoriesUnder(repoRoot, scope.root)) {
		const level = unitLevelAt(repoRoot, scope.root, path);

		if (level === undefined || !holdsRootFile(repoRoot, path, level)) {
			continue;
		}

		// Reading 3: the category holding the unit, with any chain of group segments lifted away; whatever
		// holds that category is the holder — a unit, or the scope root itself.
		const holder = dirname(liftGroups(repoRoot, scope.root, dirname(path)));

		units.push({ path, level, rootFile: `${path}/${rootFileOf(path, level)}`, holder });
	}

	return units;
}

/**
 * Every edge landing on either component interface or a lib root, keyed by the owning unit.
 *
 * The scope's files are read once here rather than through `scanImports`, which would rescan every scope
 * for each scope it is asked about.
 */
function importersOf(
	repoRoot: string,
	scope: Scope,
	units: Unit[],
	additionalCategories: readonly string[],
): Map<string, Edge[]> {
	const byRootModule = new Map<string, string>();
	for (const unit of units) {
		byRootModule.set(withoutExtension(unit.rootFile), unit.path);
		const api = `${unit.path}/${basename(unit.path)}Api.ts`;
		if (unit.level === "component" && existsSync(join(repoRoot, api))) {
			byRootModule.set(withoutExtension(api), unit.path);
		}
	}
	const importers = new Map<string, Edge[]>(units.map((unit) => [unit.path, []]));

	for (const file of sourceFilesUnder(join(repoRoot, scope.root), isSourceFile)) {
		const source = relative(repoRoot, file).split(sep).join("/");
		const owner = owningUnit(repoRoot, scope, source);

		for (const specifier of readSpecifiers(file).filter((candidate) => candidate.startsWith("."))) {
			const entered = byRootModule.get(withoutExtension(resolveSpecifier(source, specifier)));

			if (entered !== undefined) {
				importers.get(entered)?.push({
					file: source,
					owner,
					legal: describeVisibilityProblem(repoRoot, scope.root, source, specifier, additionalCategories) === null,
				});
			}
		}
	}

	return importers;
}

/**
 * The unit a file belongs to: the nearest ancestor that is a unit, else the scope root. The entry,
 * `App.tsx`, a route file and the island's own root `Tests/` all resolve to the app — which is what makes
 * "a unit a route file renders is correctly root" fall out of position instead of needing an exception:
 * the sole consumer of such a unit *is* its holder, and the condition below rules it out on its own.
 */
function owningUnit(repoRoot: string, scope: Scope, file: string): string {
	let directory = dirname(file);

	while (directory.startsWith(`${scope.root}/`)) {
		const level = unitLevelAt(repoRoot, scope.root, directory);

		if (level !== undefined && holdsRootFile(repoRoot, directory, level)) {
			return directory;
		}

		directory = dirname(directory);
	}

	return scope.root;
}

/** The distinct units consuming this one — readings 1 and 2 applied to the edges entering it. */
function consumersOf(
	repoRoot: string,
	unit: Unit,
	edges: Edge[],
	scopes: readonly Scope[],
	supportPackages: readonly TestSupportPackage[],
): string[] {
	const testingTarget = basename(unit.path) === TESTING_UNIT && unit.level === "lib";
	return [
		...new Set(
			edges
				.filter((edge) => {
					if (!isForeign(unit, edge)) return false;
					const kind = classifySource(repoRoot, scopes, supportPackages, edge.file);
					return testingTarget ? edge.legal && kind !== "production" : kind === "production";
				})
				.map((edge) => edge.owner),
		),
	].sort();
}

/**
 * Reading 1, and the whole of it: `owningUnit` walks up from the file, so a file anywhere inside the unit
 * resolves to the unit itself or to a unit nested under it.
 */
function isForeign(unit: Unit, edge: Edge): boolean {
	return edge.owner !== unit.path && !edge.owner.startsWith(`${unit.path}/`);
}

/** Find a real category boundary; names inside private or foreign contents carry no category rights. */
function categoryOwner(repoRoot: string, scopeRoot: string, file: string, category: Category): string | undefined {
	if (!file.startsWith(`${scopeRoot}/`)) {
		return undefined;
	}

	let directory = scopeRoot;
	for (const segment of relativeTo(scopeRoot, file).split("/").slice(0, -1)) {
		const path = `${directory}/${segment}`;
		if (isCategory(segment) && isCategoryPosition(repoRoot, scopeRoot, path)) {
			if (segment === category) {
				return directory;
			}
			if (UNIT_CATEGORIES[segment] === undefined) {
				return undefined;
			}
		}
		directory = path;
	}
	return undefined;
}

function isTestFile(repoRoot: string, scope: Scope, file: string): boolean {
	return categoryOwner(repoRoot, scope.root, file, TESTS_CATEGORY) !== undefined;
}

/** A misplaced test can typecheck and lint while being silently omitted by Vitest. */
function checkTestPlacement(repoRoot: string, scope: Scope, findings: Finding[]): void {
	for (const file of sourceFilesUnder(join(repoRoot, scope.root), isSourceFile)) {
		const path = relative(repoRoot, file).split(sep).join("/");
		if (withoutExtension(path).endsWith(TEST_FILE_SUFFIX) && !isTestFile(repoRoot, scope, path)) {
			findings.push({
				rule: "test-placement",
				severity: "error",
				path,
				message: "test files belong in their owning unit's Tests/ category; this location is outside the test contract",
			});
		}
	}
}

/** The rule itself: the demotion finding, the stale-marker finding, or silence. */
function describeOwnershipDrift(
	repoRoot: string,
	scope: Scope,
	units: Map<string, Unit>,
	unit: Unit,
	edges: Edge[],
	scopes: readonly Scope[],
	supportPackages: readonly TestSupportPackage[],
): string | null {
	const consumers = consumersOf(repoRoot, unit, edges, scopes, supportPackages);
	const sole = consumers.length === 1 ? (consumers[0] ?? "") : "";
	const demotable = sole !== "" && sole !== unit.holder && sole.startsWith(`${unit.holder}/`);

	// Reading 4, before either half of the rule: this edge belongs to `import-visibility`.
	if (sole !== "" && sole !== unit.holder && !demotable) {
		return null;
	}

	if (carriesOwnershipMarker(repoRoot, unit)) {
		return demotable ? null : describeStaleMarker(scope, unit, edges, consumers);
	}

	const destination = demotable ? ownershipDestination(units.get(sole), unit) : null;

	if (destination === null) {
		return null;
	}

	return `${basename(unit.path)} is imported by ${describeUnit(scope, sole)} alone, which sits below ${describeUnit(scope, unit.holder)} holding it — either it is internal to that consumer and belongs at ${relativeTo(scope.root, destination)}, or it is shared with one consumer today and ${OWNERSHIP_MARKER} in its root file says so`;
}

/**
 * Where § Sharing and promotion files a unit under its sole consumer: "a lib lives in its narrowest
 * owner's `Lib/`", and a component a second component needs sits in the nearest common ancestor's
 * `Components/` — read downward, the narrowest owner is the sole consumer, and the destination is a unit
 * folder in that consumer's category either way. A lib is always a folder (§ Lib), so a demoted lib lands
 * at `{Consumer}/Lib/{Lib}/{Lib}.ts` and never as a file beside its owner — and that is the string the
 * finding carries, where a component's carries the folder: the same unit named from either end, with the
 * lib's root file spelled out because it is what the importer must then name.
 *
 * The one position with no destination the grammar allows: a sole consumer that is itself a lib, since a
 * lib level holds neither `Components/` nor `Lib/` (`LEVEL_CATEGORIES`, § Lib). Naming that folder would
 * be advising a move `category-level` rejects, so the rule stays silent there.
 */
function ownershipDestination(consumer: Unit | undefined, unit: Unit): string | null {
	if (consumer === undefined || consumer.level === "lib") {
		return null;
	}

	return unit.level === "lib"
		? `${consumer.path}/${LIB_CATEGORY}/${basename(unit.path)}/${rootFileOf(unit.path, "lib")}`
		: `${consumer.path}/${COMPONENTS_CATEGORY}/${basename(unit.path)}/`;
}

/** The marker's other half: what a marked unit is told when the condition it suppresses is not met. */
function describeStaleMarker(scope: Scope, unit: Unit, edges: Edge[], consumers: string[]): string {
	return `${OWNERSHIP_MARKER} defends a wide placement against a sole deeper consumer, and there is none: ${describeMarkerMismatch(scope, unit, edges, consumers)} — the marker is dead text, so remove it`;
}

/**
 * Why the condition failed, in the tree's own terms. The no-consumer branch says which of the two shapes
 * it is: a reader told "nothing imports it" who then greps up an importing test file would be reading a
 * message the tree contradicts, and the reading that dropped it is the one clause worth naming there.
 */
function describeMarkerMismatch(scope: Scope, unit: Unit, edges: Edge[], consumers: string[]): string {
	if (consumers.length === 0) {
		return edges.some((edge) => isForeign(unit, edge))
			? "only test files outside its own subtree import its public interfaces"
			: "no unit outside its own subtree imports its public interfaces";
	}

	if (consumers.length > 1) {
		return `${consumers.length} units import it`;
	}

	return `its sole consumer is ${describeUnit(scope, unit.holder)}, which holds it`;
}

function carriesOwnershipMarker(repoRoot: string, unit: Unit): boolean {
	return OWNERSHIP_MARKER_PATTERN.test(readFileSync(join(repoRoot, unit.rootFile), "utf8"));
}

/** A unit named for the reader: the scope root is a place rather than a path, and reads as one. */
function describeUnit(scope: Scope, path: string): string {
	return path === scope.root
		? `the ${scope.level === "package" ? "package" : "island"} root`
		: relativeTo(scope.root, path);
}

function relativeTo(scopeRoot: string, path: string): string {
	return path.startsWith(`${scopeRoot}/`) ? path.slice(scopeRoot.length + 1) : path;
}

/** A specifier names a module, never a file, so a path is compared to one with its extension dropped. */
function withoutExtension(path: string): string {
	return path.replace(SOURCE_EXTENSION_PATTERN, "");
}

/** The target's repo-relative path, so a rule can ask where it landed rather than how it was written. */
function resolveSpecifier(source: string, specifier: string): string {
	return join(dirname(source), specifier).split(sep).join("/");
}

/**
 * Anchored on the scope root rather than matching any segment named `Routes`, which is the same shape
 * the two cruiser rules use. A `Routes/` somewhere it may not be — `Lib/Routes/`, a component's own — is
 * already a `category-level` error, and exempting imports into it as well would hide a second violation
 * behind the first instead of reporting both.
 */
function isInsideRoutes(scopeRoot: string, path: string): boolean {
	return path.startsWith(`${scopeRoot}/${ROUTES_CATEGORY}/`);
}

/** A matching root or component API basename, with an optional source extension. */
function entersThroughPublicInterface(descent: string[], level: Level | undefined): boolean {
	const unit = descent.at(-2) ?? "";
	const file = descent.at(-1) ?? "";

	return (
		file === unit ||
		(level !== undefined && file === rootFileOf(unit, level)) ||
		(level === "component" && (file === `${unit}Api` || file === `${unit}Api.ts`))
	);
}

function ascend(directory: string, levels: number): string {
	let current = directory;

	for (let step = 0; step < levels; step++) {
		current = dirname(current);
	}

	return current;
}

function readSpecifiers(file: string): string[] {
	const source = withoutComments(readFileSync(file, "utf8"));

	return [...source.matchAll(IMPORT_PATTERN)].map((match) => match[1] ?? match[2] ?? match[3] ?? "");
}

/**
 * The source with `//` and block comments removed and everything else, quotes included, left alone.
 *
 * A character walk rather than a regex, because the two hazards are each other's mirror: a regex over
 * comments eats the `//` inside a string literal, and a regex over strings eats the quote inside a
 * comment. Tracking which of the two we are in is the whole job, and it is the smallest thing that makes
 * the scan read code rather than text. What survives is a specifier quoted inside a *string* literal —
 * far more exotic than one quoted in prose, and accepted as residual: the fidelity comparison in
 * `structure-rules.test.ts` is what would catch it turning systematic.
 */
function withoutComments(source: string): string {
	let code = "";
	let index = 0;
	let quote = "";

	while (index < source.length) {
		const pair = source.slice(index, index + 2);

		if (quote === "" && (pair === "//" || pair === "/*")) {
			index = skipComment(source, index, pair === "//");

			continue;
		}

		const character = source[index] ?? "";

		quote = nextQuoteState(quote, character, source[index - 1] ?? "");
		code += character;
		index += 1;
	}

	return code;
}

/** The index just past a comment that starts at `index`; an unterminated block comment runs to the end. */
function skipComment(source: string, index: number, lineComment: boolean): number {
	const end = lineComment ? source.indexOf("\n", index) : source.indexOf("*/", index + 2);

	if (end === -1) {
		return source.length;
	}

	return lineComment ? end : end + 2;
}

/** Which string literal the walk is inside, if any — `"`, `'`, `` ` `` or "" for code. */
function nextQuoteState(quote: string, character: string, previous: string): string {
	if (previous === "\\") {
		return quote;
	}

	if (quote === "") {
		return ['"', "'", "`"].includes(character) ? character : "";
	}

	return character === quote ? "" : quote;
}

function isCategory(name: string, categories: readonly string[] = CATEGORIES): boolean {
	return categories.includes(name);
}

function isSourceFile(name: string): boolean {
	return SOURCE_EXTENSIONS.some((extension) => name.endsWith(extension));
}

/** Island roots are discovered the way `vite.config.ts` discovers them: a directory below an `Islands/`. */
function directoriesIn(directory: string): string[] {
	return entriesOf(directory)
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort();
}

/** Every directory below a scope root, repo-relative — what a rule about the whole tree walks. */
function directoriesUnder(repoRoot: string, scopeRoot: string): string[] {
	const found: string[] = [];

	const walk = (relativePath: string): void => {
		for (const name of directoriesIn(join(repoRoot, relativePath))) {
			found.push(`${relativePath}/${name}`);
			walk(`${relativePath}/${name}`);
		}
	};

	walk(scopeRoot);

	return found;
}

function filesIn(directory: string): string[] {
	return entriesOf(directory)
		.filter((entry) => entry.isFile())
		.map((entry) => entry.name)
		.sort();
}

function entriesOf(directory: string) {
	const entries = existsSync(directory) ? readdirSync(directory, { withFileTypes: true }) : [];

	return entries.filter((entry) => entry.name !== IGNORED_DIRECTORY);
}

function sourceFilesUnder(directory: string, accept: (name: string) => boolean): string[] {
	const found: string[] = [];

	for (const entry of entriesOf(directory)) {
		const path = join(directory, entry.name);

		if (entry.isDirectory()) {
			found.push(...sourceFilesUnder(path, accept));
		} else if (accept(entry.name)) {
			found.push(path);
		}
	}

	return found;
}

function normalizeRelative(path: string): string {
	return path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
}

function countPaths(paths: readonly string[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const path of paths) counts.set(path, (counts.get(path) ?? 0) + 1);
	return counts;
}
