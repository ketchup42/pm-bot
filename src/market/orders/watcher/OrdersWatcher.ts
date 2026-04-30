
/**
 * Orders status update messages structure, uses to store orders status
 */
export interface OrderStatus {
    id: string;
    token_id: string;
    timestamp: string;
    market: string; // Condition id
    original_size: string;
    size_matched: string;

    price: string;
    side: string; // BUY or SELL

    /**
     * Raw order data, sync or updates
     */
    raw_data: any;

    /**
     * User space fields:
     */
    has_size_matched: boolean; // original_size === size_matched
    is_live: boolean;
    has_canceled: boolean;
}

/**
 * Type of option update handler for order watchers
 */
export type OrderUpdateHandler = (status: OrderStatus) => void;

/**
 * Defines the public contract for a market orders watcher. Accumulates orders users's orders by conditional id.
 */
export interface OrdersWatcher {

    /**
     * Returns current order status by order id or undefined if threr is no such order.
     * @param orderId 
     */
    status(orderId: string): OrderStatus | undefined;

    /**
     * Function check is order if full filed and completed.
     * @param orderId 
     */
    isFullMatched(orderId: string): boolean;

    /**
     * Function check is order in live state in order book.
     * @param orderId 
     */
    isLive(orderId: string): boolean;

    /**
     * Function check is order in canceled state.
     * @param orderId 
     */
    hasCanceled(orderId: string): boolean;

    /**
     * Returs is orders under watcher status control or in the history. 
     * @param orderId
     */
    isUnderWatching(orderId: string): boolean;

    isActive(): boolean;
    isWatching(): boolean;

    setUpdateHandler(orderId: string, handler: OrderUpdateHandler): void;
    resetUpdateHandler(orderId: string): void;
    resetAllUpdateHandlers(): void;

    /**
     * API provides trade events stream subscribe only by condition id. 
     */
    getConditionId(): string;

    /**
     * This function guarantees that the watcher will establish the first connection 
     * and has sync orders after a delay.
     * @param tick Force delay during warming up.
     * @returns Returns itself to chain-call.
     */
    warmUp(tick: number): Promise<this>;

    /**
     * Gracefully closes the WebSocket connection and cleans up resources.
     */
    disconnect(): void;
}