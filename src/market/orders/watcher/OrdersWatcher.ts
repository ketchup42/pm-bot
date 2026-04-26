
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

    isLive(orderId: string): boolean;

    hasCanceled(orderId: string): boolean;

    /**
     * Returs is orders under watcher status control or in the history. 
     * @param orderId
     */
    isUnderWatching(orderId: string): boolean;

    isActive(): boolean;
    isWatching(): boolean;
    
    /**
     * API provides trade events stream subscribe only by condition id. 
     */
    getConditionId(): string;

    /**
     * Gracefully closes the WebSocket connection and cleans up resources.
     */
    disconnect(): void;
}