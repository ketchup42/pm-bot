import { MarketOrderBooksWatcher } from "../../../market/orderbook/watcher/MarketOrderBooksWatcher.js";

/**
 * Watches market data for a specific coin and frame, collecting snapshots for both up and down sides.
 * @template EventDataType - The type of market data collected (e.g., `CoinFrameEventMarketData`).
 */
export interface EventWatcher<EventDataType> {

  /** Returns a unique identifier for this watcher. */
  getEventId(): string;

  /** Returns the underlying order book watcher instance. */
  getEventMarketOrderBooksWatcher(): MarketOrderBooksWatcher[];

  /** Returns the collected data for the 'up' side (read‑only). */
  getWatcherHistoryUp(): Readonly<EventDataType>[];

  /** Returns the collected data for the 'down' side (read‑only). */
  getWatcherHistoryDown(): Readonly<EventDataType>[];

  /** Whether the watcher is currently active (still collecting data). */
  isActive(): boolean;

  /** Whether the watcher is able to watching for updates. */
  isWatching(): boolean;

  /**
   * Whether the watcher has finished its time frame and data collection.
   * May be inactive but not finished if data collection is incomplete.
   */
  isFinished(): boolean;

  /** Releases all resources held by the watcher. */
  dispose(): void;
}