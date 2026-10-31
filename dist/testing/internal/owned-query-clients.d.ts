import { QueryClient, type QueryClientConfig } from "@tanstack/query-core";
export declare class OwnedQueryClients {
    #private;
    create(config?: QueryClientConfig): QueryClient;
    cancelQueries(): Promise<void>;
    drainMutations(timeoutMs?: number): Promise<void>;
    clear(): void;
}
