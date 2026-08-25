import { OrderWallet } from "./OrderWallet.js";

/**
 * Virtual wallet abstraction for one strategy.
 *
 * Each strategy operates on its own "virtual balance", even though
 * all strategies share the same exchange account.
 * The wallet:
 * - enforces tick size, minimum order size, and minimum USD amount,
 * - places maker orders through the CLOB API,
 * - monitors execution of those orders via an {@link OrdersWatcher},
 * - automatically updates the virtual balance and order statuses
 *   when the watcher reports fills, cancellations, etc.
 */
export interface MultiOrderWallet extends OrderWallet {

      /**
     * Free virtual balance (available for new buy orders).
     */
    getAvailableBalance(): number;

    /**
     * Free token quantity (available for new sell orders).
     */
    getAvailableTokens(): number;
}