import { ClobApiKeyCreds } from "@polymarket/real-time-data-client";
import { OrderStatus, OrdersWatcher } from "./OrdersWatcher.js";
import { error_str, safeToNum } from "../../../utils.js";
import { ClobClient } from "@polymarket/clob-client";
import { logger } from "../../../log.js";
import { ClobOrderEvent, ClobUserClient } from "polymarket-websocket-client";

/**
 * Raw status fields from data stream:
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

    private _isConnected: boolean = false;

    /**
     * Callback triggered for every incoming WebSocket message.
     */
    private readonly _onOrder = (event: ClobOrderEvent): void => {
        // Process only order update messages
        if (event.event_type !== "order") return;
        const payload = event as OrderStatusRTDS;

        if (!payload || payload.market.toLowerCase() !== this._conditionId) return;

        let map_id: string = payload.id;

        // It works for any type of order event types.
        // https://docs.polymarket.com/market-data/websocket/user-channel
        let has_size_matched: boolean = safeToNum(payload.original_size) <= safeToNum(payload.size_matched);

        const is_live = payload.type === "PLACEMENT" || payload.type === "UPDATE";
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
            has_size_matched,
            is_live,
            has_canceled: is_canceled,
        };

        this._watchingOrders.set(map_id, status);
    };


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
            this._userClient.subscribe([this._conditionId]);
            this.syncOpenOrders(this._client).catch((error) => {
                logger.error(`[LiveOrdersWatcherRTDS] Failed to sync open orders: ${error_str(error)}`);
            });
            this._isConnected = true;
        });

        this._userClient.on('disconnected', ({ code, reason }) => {
            this._isConnected = false;
            this._watchingOrders.clear();
        });
        
        this._userClient.on('error', (error) => {
            this._isConnected = false;
            this._watchingOrders.clear();
        });
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

    private async syncOpenOrders(client: ClobClient): Promise<void> {
        try {
            const openOrders = await client.getOpenOrders({ market: this._conditionId });
            for (const rawOrder of openOrders) {

                // const is_status_matched = rawOrder.status === "MATCHED";
                const is_status_matched = true;
                const is_live = rawOrder.status === "LIVE";
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
                    has_size_matched: is_status_matched && safeToNum(rawOrder.size_matched) >= safeToNum(rawOrder.original_size),
                    is_live: is_live,
                    has_canceled: is_canceled
                };
                this._watchingOrders.set(status.id, status);
            }
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
        return this._isConnected;
    }
    
    public isWatching(): boolean {
        return this._watchingOrders.size !== 0;
    }
    
    getConditionId(): string {
        return this._conditionId;
    }

    /**
     * Gracefully closes the WebSocket connection and cleans up resources.
     */
    public disconnect(): void {
        if (this._userClient) {
            this._userClient.disconnect();

            // Additional clear steps to full safe
            this._isConnected = false;
            this._watchingOrders.clear();
        }
    }
}