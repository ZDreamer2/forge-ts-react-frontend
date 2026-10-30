/**
 * The kinds of unit a directory can be. `package` is the fourth level `ai/bc-plugins/dev/forge/codebases/ts-react-frontend/packages.md`
 * adds: a shared package "keeps on-plan.md's unit shapes" without being an island,
 * so it holds components and libs but no address space and no PHP payload mirrors.
 */
export type Level = "app" | "component" | "lib" | "package";
export type Severity = "error" | "recommendation";
export interface Finding {
    rule: string;
    severity: Severity;
    path: string;
    message: string;
}
export type SourceKind = "production" | "test" | "test-support";
export type StructureScope = {
    /** Scope root relative to `root`. */
    root: string;
    level: "app";
    /** Required mount filename for this app. */
    entry: string;
    /** Exact additional filenames allowed loose at the app root. */
    allowedRootFiles?: readonly string[];
} | {
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
    dependencies: readonly {
        module: string;
    }[];
}
/** Compare host-discovered files against the collection actually fed to a checker/test runner. */
export declare function compareFileCoverage(kind: "source" | "test", discovered: readonly string[], collected: readonly string[]): Finding[];
/** Verify that a host-normalized graph retained every source and import found by scanImports(). */
export declare function compareImportGraph(scanned: ReadonlyMap<string, readonly string[]>, modules: readonly NormalizedGraphModule[]): Finding[];
/**
 * Bind the checker to installation-owned roots without taking over their discovery or command execution.
 * Filesystem walking and path semantics remain shared so empty trees, assets-only directories, groups,
 * and source files are interpreted exactly as in the extracted island checker.
 */
export declare function createStructureChecker(options: StructureCheckerOptions): {
    checkStructure(): Finding[];
    scanImports(): Map<string, string[]>;
    classifySource(path: string): SourceKind;
};
