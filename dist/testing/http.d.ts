import { type RequestHandler } from "msw";
export type ControlledResponseState = "pending" | "released" | "cancelled";
export interface ControlledResponse {
    readonly request: Request | undefined;
    readonly state: ControlledResponseState;
    handle(request: Request): Promise<Response>;
    release(response: Response): void;
    cancel(): void;
}
export interface FinishHttpScenario {
    /** Runs first, for consumer unmount and cancellation of work it owns. Each callback is attempted. */
    beforeCancel?: Array<() => void | Promise<void>>;
    /** Runs after controlled responses are cancelled, for bounded consumer continuation settling and disposal. */
    afterCancel?: Array<() => void | Promise<void>>;
}
export interface HttpScenario {
    deferResponse(): ControlledResponse;
    use(...handlers: RequestHandler[]): void;
    /** Waits only for application-facing fetch promises, not response-body or framework continuations. */
    drain(timeoutMs?: number): Promise<void>;
    /** Always cancels gates, drains fetches, checks diagnostics, closes interception and restores fetch exactly. */
    finish(cleanup?: FinishHttpScenario, timeoutMs?: number): Promise<void>;
}
/**
 * Starts isolated, opt-in interception. Use one owner in a sequential scenario (never `it.concurrent`) and
 * always call `finish` from teardown or `finally`. Endpoint handlers and payloads stay with the consumer.
 */
export declare function createHttpScenario(...handlers: RequestHandler[]): HttpScenario;
