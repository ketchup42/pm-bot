import { ClobClient, OpenOrder } from "@polymarket/clob-client-v2";
import { ClobApiKeyCreds } from "@polymarket/real-time-data-client";
import { OrderStatus, OrderUpdateHandler, OrdersWatcher } from "./OrdersWatcher.js";
import { delay, error_str, safeToNum } from "../../../utils.js";
import { logger } from "../../../log.js";
import { ClobOrderEvent, ClobUserClient } from "polymarket-websocket-client";

const RTDS_MAX_RECONNECT_ATTEMPTS = 20;
const MAX_SYNC_OPEN_ORDERS_ATTEMPTS = 5;
const WATCHER_RECONNECT_DELAY = 1000;

/**
 * Raw status fields from data stream
 */
export interface OrderStatusRTDS {
  asset_id: string;     // Order's ERC1155 token ID of conditional token

  created_at?: string;
  event_type: string;   // order
  expiration?: string;

  id: string;           // Order id
  market: string;       // Condition ID
  order_type?: string;  
  original_size: string;
  outcome: string;
  price: string;
  side: string;         // Side of the trade: BUY or SELL 
  size_matched: string;

  status?: string;      // LIVE, MATCHED, CANCELED (REST only, mb not WebSocket)
  timestamp: string;
  type: string          // PLACEMENT, UPDATE, CANCELLATION
}

/**
 * Watches our own maker orders on a single market.
 * Uses a WebSocket user client and keeps an in‑memory map of order statuses.
 */
export class LiveOrdersWatcherRTDS implements OrdersWatcher {
    private _client: ClobClient;
    private _userClient: ClobUserClient;

    private _conditionId: string;
    private _watchingOrders = new Map<string, OrderStatus>();
    private _handlers = new Map<string, OrderUpdateHandler>();

    private _isConnected: boolean = false;
    private _isDisposed: boolean = false;
    private _shouldReconnect: boolean = true;
    private _isSyncing: boolean = false;

    /**
     * Callback triggered for every incoming WebSocket message.
     */
    private readonly _onOrder = (event: ClobOrderEvent): void => {
        if (this._isDisposed) return;

        // Process only order update messages
        if (event.event_type !== "order") return;
        const payload = event as OrderStatusRTDS;

        if (!payload || payload.market.toLowerCase() !== this._conditionId) return;

        let map_id: string = payload.id;

        // It works for any type of order event types.
        // https://docs.polymarket.com/market-data/websocket/user-channel
        const has_size_matched: boolean = safeToNum(payload.original_size) <= safeToNum(payload.size_matched);
        const has_size_matched_partial = !has_size_matched && (safeToNum(payload.size_matched) > 0);

        const is_live = (payload.type === "PLACEMENT" || payload.type === "UPDATE") && !has_size_matched;
        const is_canceled = payload.type === "CANCELLATION";

        const status: OrderStatus = {
            id: payload.id,
            token_id: payload.asset_id,
            timestamp: payload.timestamp,
            market: payload.market,
            original_size: payload.original_size,
            size_matched: payload.size_matched,
            price: payload.price,
            side: payload.side,
            raw_data: payload,
            has_size_matched: has_size_matched,
            has_size_matched_partial: has_size_matched_partial,
            is_live: is_live,
            has_canceled: is_canceled
        };

        this._watchingOrders.set(map_id, status);

        const handler = this._handlers.get(map_id);
        handler?.(status);
    };

    private async _reconnect(): Promise<void> {
        logger.debug(`[LiveOrdersWatcherRTDS] _reconnect called, shouldReconnect=${this._shouldReconnect}, isDisposed=${this._isDisposed}, isConnected=${this._isConnected}`);
        if (!this._shouldReconnect || this._isDisposed) return;
        let attempt = 0;
        while (this._shouldReconnect && !this._isConnected && attempt < RTDS_MAX_RECONNECT_ATTEMPTS) {
            attempt++;
            logger.warn(`[LiveOrdersWatcherRTDS] Reconnecting (${attempt}/${RTDS_MAX_RECONNECT_ATTEMPTS})...`);
            await delay(WATCHER_RECONNECT_DELAY);
            if (this._isDisposed) return;
            try {
                await this._userClient.connect();
                logger.info(`[LiveOrdersWatcherRTDS] Reconnect succeeded (attempt ${attempt})`);
                break;
            } catch (error) {
                logger.error(`[LiveOrdersWatcherRTDS] Reconnect attempt ${attempt} failed: ${error_str(error)}`);
            }
        }
    }

    private async _syncOpenOrdersWithRetry(retries: number, delayMs: number): Promise<void> {
        if (this._isDisposed) return;
        if (this._isSyncing) {
            logger.debug(`[LiveOrdersWatcherRTDS] Watcher syncOpenOrders already in progress, skipping...`);
            return;
        }
        this._isSyncing = true;
        try {
            for (let attempt = 1; attempt <= retries; attempt++) {
                if (this._isDisposed) return;
                try {
                    await this.syncOpenOrders();
                    return;
                } catch (error) {
                    logger.warn(`[LiveOrdersWatcherRTDS] Watcher syncOpenOrders attempt ${attempt}/${retries} failed: ${error_str(error)}`);
                    if (attempt === retries) {
                        logger.error(`[LiveOrdersWatcherRTDS] Giving up syncOpenOrders after ${retries} attempts`);
                        return;
                    }
                    await delay(delayMs * attempt);
                    if (this._isDisposed) return;
                }
            }
        } finally {
            this._isSyncing = false;
        }
    }

    private constructor(conditionId: string, client: ClobClient, api?: ClobApiKeyCreds) {
        this._conditionId = conditionId.toLowerCase();
        this._client = client;

        const apiKeysCreds = api ?? client.creds;
        if (!apiKeysCreds) throw new Error("[LiveOrdersWatcherRTDS] API Key creds required!");

        this._userClient = new ClobUserClient({
            apiKey: apiKeysCreds.key,
            secret: apiKeysCreds.secret,
            passphrase: apiKeysCreds.passphrase
        });

        this._userClient.onOrder(this._onOrder);

        this._userClient.on('connected', () => {
            if (this._isDisposed) return;
            this._userClient.subscribe([this._conditionId]);
            logger.info(`[LiveOrdersWatcherRTDS] Connected to user channel for condition ${this._conditionId}`);
            this._syncOpenOrdersWithRetry(MAX_SYNC_OPEN_ORDERS_ATTEMPTS, WATCHER_RECONNECT_DELAY);
            this._isConnected = true;
        });

        this._userClient.on('disconnected', ({ code, reason }) => {
            this._isConnected = false;
            logger.warn(`[LiveOrdersWatcherRTDS] Disconnected: ${reason} (${code})`);
            if (this._shouldReconnect) this._reconnect();
        });

        this._userClient.on('error', (error) => {
            this._isConnected = false;
            logger.error(`[LiveOrdersWatcherRTDS] Error: ${error_str(error)}`);
            if (this._shouldReconnect) this._reconnect();
        });
    }

    public setUpdateHandler(orderId: string, handler: OrderUpdateHandler): void {
        if (this._isDisposed) return;
        this._handlers.set(orderId, handler);
        if (this._watchingOrders.has(orderId)) {
            const handler = this._handlers.get(orderId)!;
            handler(this._watchingOrders.get(orderId)!);
        }
    }

    public resetUpdateHandler(orderId: string): void {
        if (this._isDisposed) return;
        this._handlers.delete(orderId);
    }

    public resetAllUpdateHandlers(): void {
        if (this._isDisposed) return;
        this._handlers.clear();
    }

    private async init(): Promise<void> {
        await this._userClient.connect();
    }

    /** Factory method that creates and connects the watcher. */
    public static async create(conditionId: string, client: ClobClient, api?: ClobApiKeyCreds): Promise<LiveOrdersWatcherRTDS> {
        const watcher = new LiveOrdersWatcherRTDS(conditionId, client, api);
        await watcher.init();
        return watcher
    }

    private async _checkMissingOrders(openOrders: OpenOrder[]): Promise<void> {
        const currentOrderIds = new Set(openOrders.map(o => o.id));
        for (const [id, status] of this._watchingOrders.entries()) {
            if (this._isDisposed) return;

            if (currentOrderIds.has(id) || status.has_size_matched || status.has_canceled) continue;

            try {
                const orderDetails = await this._client.getOrder(id);
                if (this._isDisposed) return;

                const matched = safeToNum(orderDetails.size_matched);
                const original = safeToNum(orderDetails.original_size);

                // const is_status_matched = orderDetails.status === "MATCHED";
                const is_status_matched = true;
                const has_size_matched = is_status_matched && matched >= original;

                if (orderDetails.status === "CANCELED") {
                    const updatedStatus: OrderStatus = {
                        ...status,
                        has_canceled: true,
                        is_live: false,
                        raw_data: orderDetails,
                    };

                    if (this._isDisposed) return;
                    this._watchingOrders.set(id, updatedStatus);
                    const handler = this._handlers.get(id);
                    handler?.(updatedStatus);
                    logger.debug(`[LiveOrdersWatcherRTDS] Order ${id} marked as canceled via missing order check`);
                    continue;
                }

                if (status.size_matched && safeToNum(status.size_matched) > matched) {
                    logger.debug(`[LiveOrdersWatcherRTDS] Skip missing order check for ${id}: existing matched ${status.size_matched} > REST matched ${matched}`);
                    continue;
                }

                if (has_size_matched) {
                    const updatedStatus: OrderStatus = {
                        ...status,
                        is_live: false,
                        has_size_matched: true,
                        has_size_matched_partial: false,
                        size_matched: orderDetails.size_matched,
                        raw_data: orderDetails,
                    };

                    if (this._isDisposed) return;
                    this._watchingOrders.set(id, updatedStatus);
                    const handler = this._handlers.get(id);
                    handler?.(updatedStatus);
                    logger.debug(`[LiveOrdersWatcherRTDS] Order ${id} marked as fully matched via missing order check`);

                } else if (matched > 0 && matched > safeToNum(status.size_matched)) {
                    const updatedStatus: OrderStatus = {
                        ...status,
                        size_matched: orderDetails.size_matched,
                        has_size_matched_partial: true,
                        raw_data: orderDetails,
                    };

                    if (this._isDisposed) return;
                    this._watchingOrders.set(id, updatedStatus);
                    const handler = this._handlers.get(id);
                    handler?.(updatedStatus);
                    logger.debug(`[LiveOrdersWatcherRTDS] Order ${id} marked as partially matched via missing order check`);
                }
            } catch (error) {
                logger.warn(`[LiveOrdersWatcherRTDS] Could not fetch details for missing order ${id}: ${error_str(error)}`);
            }
        }
    }

    private async syncOpenOrders(): Promise<void> {
        if (this._isDisposed) return;
        try {
            const openOrders = await this._client.getOpenOrders({ market: this._conditionId });
            if (this._isDisposed) return;

            for (const rawOrder of openOrders) {

                // const is_status_matched = rawOrder.status === "MATCHED";
                const is_status_matched = true;

                const matched = safeToNum(rawOrder.size_matched);
                const original = safeToNum(rawOrder.original_size);
                const has_size_matched = is_status_matched && matched >= original;
                const has_size_matched_partial = !has_size_matched && matched > 0;

                let is_live = rawOrder.status === "LIVE";
                if (has_size_matched) is_live = false;

                const is_canceled = rawOrder.status === "CANCELED";

                const status: OrderStatus = {
                    id: rawOrder.id,
                    token_id: rawOrder.asset_id,
                    timestamp: rawOrder.created_at.toString(),
                    market: rawOrder.market,
                    original_size: rawOrder.original_size,
                    size_matched: rawOrder.size_matched,
                    price: rawOrder.price,
                    side: rawOrder.side,

                    raw_data: rawOrder,
                    has_size_matched: has_size_matched,
                    has_size_matched_partial: has_size_matched_partial,
                    is_live: is_live,
                    has_canceled: is_canceled
                };

                const existing = this._watchingOrders.get(rawOrder.id);
                const shouldUpdate = !existing ||
                    safeToNum(rawOrder.size_matched) > safeToNum(existing.size_matched) ||
                    (!existing.has_size_matched && has_size_matched);

                if (shouldUpdate) {
                    this._watchingOrders.set(rawOrder.id, status);
                    const handler = this._handlers.get(rawOrder.id);
                    handler?.(status);
                }
            }

            await this._checkMissingOrders(openOrders);
        } catch (error) {
           throw new Error(`[LiveOrdersWatcherRTDS] Failed to sync open orders: ${error_str(error)}`);
        }
    }

    public status(orderId: string): OrderStatus | undefined {
        return this._watchingOrders.get(orderId)
    }

    public isFullMatched(orderId: string): boolean {
        return this._watchingOrders.get(orderId)?.has_size_matched ?? false;
    }

    public isPartialMatched(orderId: string): boolean {
        return this._watchingOrders.get(orderId)?.has_size_matched_partial ?? false;
    }

    public isLive(orderId: string): boolean {
        return this._watchingOrders.get(orderId)?.is_live ?? false;
    }

    public hasCanceled(orderId: string): boolean {
        return this._watchingOrders.get(orderId)?.has_canceled ?? false;
    }

    public isUnderWatching(orderId: string): boolean {
        return this._watchingOrders.has(orderId);
    }
    
    public isActive(): boolean {
        return !this._isDisposed && this._isConnected;
    }
    
    public isWatching(): boolean {
        return this._watchingOrders.size !== 0;
    }
    
    public getConditionId(): string {
        return this._conditionId;
    }
    
    public async warmUp(tick: number): Promise<this> {
        while(!this.isActive()) {
            if (this._isDisposed) return this;
            await delay(tick);
        }
        return this;
    }
    
    /**
     * Gracefully closes the WebSocket connection and cleans up resources.
     */
    public disconnect(): void {
        this._shouldReconnect = false;
        this._isDisposed = true;
        if (this._userClient) {
            this._userClient.disconnect();

            // Additional clear steps to full safe
            this._isConnected = false;
            this._watchingOrders.clear();
            this._handlers.clear();
        }
    }
}