import { DEFAULT_ORDER_AMOUNT_FRACTION } from "../../rest/orders.js";

export const ORDER_WALLET_FRACTION = DEFAULT_ORDER_AMOUNT_FRACTION;

/** Data of the current limit order */
export interface OrderValue {
    price: number;
    quantity: number;
}

export interface OrderWalletState {
    id: string,       // Order id
    value: OrderValue // Placed price and quantity, check it after operation

    fast_full_trade: boolean; // true if order had place-time filled,
    // so "value" has average price and filled quantity
}

export interface OrderWalletParams {
    token_id: string,
    balance: number
    tick_size: number,
    min_order_size: number,
    min_buy_order_value: number
}

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
export interface OrderWallet {

    /** The token ID (asset_id) this wallet trades. */
    getTokenId(): string;

    /**
     * Places a maker BUY order after validating price, quantity, and balance.
     *
     * @param price   - Desired price per token (will be rounded to tick size).
     * @param quantity - Desired token quantity (will be adjusted to min order size
     *                   and capped by available balance, with a minimum order value
     *                   of 1 USD).
     * @returns The resulting order ID and the actual values used.
     */
    buy(price: number, quantity: number): Promise<OrderWalletState | undefined>;

    /**
     * Places a maker SELL order after validating price, quantity, and token balance.
     *
     * @param price   - Desired price per token (will be rounded to tick size).
     * @param quantity - Desired token quantity (will be adjusted to min order size
     *                   and capped by available tokens).
     * @returns The resulting order ID and the actual values used.
     */
    sell(price: number, quantity: number): Promise<OrderWalletState | undefined>;

    /**
     * Whether the given order is fully filled (size_matched >= original_size).
     *
     * Delegates to the internal {@link OrdersWatcher}.
     */
    isFullFilled(orderId: string): boolean;

    /**
     * Whether the given order is partial filled (size_matched > 0).
     *
     * Delegates to the internal {@link OrdersWatcher}.
     */
    isPartialFilled(orderId: string): boolean;

    /**
     * Whether the given order is still live (PLACEMENT or UPDATE).
     *
     * Delegates to the internal {@link OrdersWatcher}.
     */
    isLive(orderId: string): boolean;

    /**
     * Whether the given order has been cancelled.
     *
     * Delegates to the internal {@link OrdersWatcher}.
     */
    hasCanceled(orderId: string): boolean;

    /**
     * Current virtual USD balance available for new orders.
     *
     * Updated automatically when fills are detected.
     */
    getBalance(): number;

    /**
     * Total change in virtual balance since the wallet was created.
     *
     * Positive when the strategy is in profit.
     */
    getBalanceChange(): number;

    /**
     * Current number of tokens held (virtual position).
     */
    getTokensQuantity(): number;

    /**
     * Number of currently active buy orders.
     */
    getBuyOrdersCount(): number;

    /**
     * Number of currently active sell orders.
     */
    getSellOrdersCount(): number;

    getTick(): number;
    getMinOrderSize(): number;
    getMinBuyOrderValue(): number;

    /**
     * Cancels a single order by its exchange ID.
     *
     * @param orderId - The order to cancel.
     * @return False if the API call fails.
     */
    cancel_order(orderId: string): Promise<boolean>;

    /**
     * Cancels a all orders.
     *
     * @param orderId - The order to cancel.
     * @return False if the API call fails.
     */
    cancel_all(): Promise<boolean>;

    /**
     * Releases all resources held by this wallet (e.g. order update handlers).
     * After disposal the wallet instance should not be used.
     * @param sellAll If you want to sell add tokens before dispose
     */
    dispose(sellAll: boolean): void;
}