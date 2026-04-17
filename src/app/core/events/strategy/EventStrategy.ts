import { ClobClient } from "@polymarket/clob-client";
import { EventWatcher } from "../EventWatcher.js";

/**
 * Strategy for evaluating and acting on event watchers.
 * @template EventDataType – Type of data produced by each watcher.
 */
export interface EventStrategy<EventDataType> {

    /**
     * Checks if the strategy conditions are met.
     * @param watchers – Read-only list of event watchers.
     * @returns True if execution should proceed.
     */
    check(watchers: readonly EventWatcher<EventDataType>[]): Promise<boolean>;

    /**
     * Executes the strategy (e.g., places orders on Polymarket). Execute is async because of order requests.
     * @param client – Polymarket CLOB client.
     * @param watchers – Read-only list of event watchers.
     * @returns True if execution succeeded.
     */
    execute(client: ClobClient, watchers: readonly EventWatcher<EventDataType>[]): Promise<boolean>;

    /**
     * Executes cancel operations for strategy, Dispose strategy state and rolls back all operations.
     * @param client Polymarket CLOB client.
     * @param watchers Read-only list of event watchers.
     */
    cancel(client: ClobClient, watchers: readonly EventWatcher<EventDataType>[]): Promise<boolean>;
}