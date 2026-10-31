import type { QueryClient, QueryClientConfig } from "@tanstack/query-core";
import type { RequestHandler } from "msw";
import type { HttpScenario } from "../http.js";

export type CleanupCallback = () => void | Promise<void>;
export interface BrowserIsolationOptions {
	documentAttributes?: string[];
}
export interface TestSuiteLifecycleOptions {
	prepare?: CleanupCallback;
	beforeCancel?: CleanupCallback[];
	afterCancel?: CleanupCallback[];
	runCleanup?: (cleanup: () => Promise<void>) => Promise<void>;
	browser?: BrowserIsolationOptions;
}
export type DeferredOutcome<T> = { type: "resolve"; value: T } | { type: "reject"; reason: unknown };
export interface OwnedDeferred<T> {
	readonly promise: Promise<T>;
	resolve(value: T | PromiseLike<T>): void;
	reject(reason: unknown): void;
}
export type ScopedHttpScenario = Omit<HttpScenario, "finish">;
export interface TestSuiteLifecycle {
	createQueryClient(config?: QueryClientConfig): QueryClient;
	createHttpScenario(...handlers: RequestHandler[]): ScopedHttpScenario;
	defer<T>(options: { label: string; unfinished: DeferredOutcome<T> }): OwnedDeferred<T>;
	finish(): Promise<void>;
}
