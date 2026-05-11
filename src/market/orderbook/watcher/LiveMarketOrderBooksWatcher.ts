import { logger } from "../../../log.js";
import { MarketSide } from "../../side.js";
import { EventRaw, MarketRaw } from "../../../rest/scan.js";
import { error_str, isValid, isoToMs, safeFloat, safeToNum } from "../../../utils.js";
import { WSSubscriptionManager, WSSubscriptionManagerHandlers } from "../manager/WSSubscriptionManager.js";
import { MarketOrderBooksWatcher, OrderBookLevel, EventMarketData, TokenMarketData, LiquidityInfo } from "./MarketOrderBooksWatcher.js";
import { DEFAULT_ORDER_AMOUNT_FRACTION } from "../../../rest/orders.js";

const ORDER_BOOKS_WATCHER_RECONNECT_AND_CLEANUP = 500;
const PENDING_FLUSH_INTERVAL_MS = 50;
 
/**
 * Manages real‑time order book data for a Polymarket event (Up/Down tokens).
 * Uses WebSocket subscriptions to receive snapshots and incremental updates.
 */
export class LiveMarketOrderBooksWatcher implements MarketOrderBooksWatcher {
    private _eventDataRaw: EventRaw;
    private _marketDataRaw: MarketRaw;

    private _marketData: EventMarketData | undefined = undefined;

    private _timestampUp: number | undefined = undefined;
    private _timestampDown: number | undefined = undefined;

    private _manager!: WSSubscriptionManager;
    private _handlers: WSSubscriptionManagerHandlers | undefined;

    private _isUpBooked = false;
    private _isDownBooked = false;
    private _isInitialized = false;

    protected constructor(eventData: EventRaw, marketData: MarketRaw, handlers?: WSSubscriptionManagerHandlers) {
        this._eventDataRaw = eventData;

        let noMarket: boolean = true;
        this._eventDataRaw.markets.forEach((market) => { if (market.id === marketData.id) noMarket = false; });
        if (noMarket) throw new Error(`[LiveMarketOrderBooksWatcher] Error: no such market for given event: id: ${eventData.id} slug: ${eventData.slug}`);

        this._marketDataRaw = marketData;
        this._handlers = handlers;
    }

    /**
     * Fetches event metadata, initialises WebSocket manager, and subscribes to Up/Down token books.
     * @throws If the slug is invalid, event data is malformed, or subscription fails.
     */
    protected async init(): Promise<void> {
        if (this._isInitialized) {
            this.disconnect();
        }

        const market = this._marketDataRaw;
        const outcomes = market.outcomes;
        const tokenIds = market.clobTokenIds;

        if (outcomes.length < 2 || tokenIds.length < 2) {
            throw new Error(`[LiveMarketOrderBooksWatcher] Error: expected 2 outcomes/tokenIds, got outcomes=${outcomes.length}, tokenIds=${tokenIds.length}`);
        }

        if (!market.enableOrderBook) 
            throw new Error(`[LiveMarketOrderBooksWatcher] Error: order book not enabled!`);

        /**
         * Polymarket’s API does not guarantee that the first outcome is always "up" and the second "down".
         */
        const eventId = this._eventDataRaw.id;
        const marketId = market.id;
        const conditionId = market.conditionId;
        const tick_size = market.orderPriceMinTickSize;
        const min_order_size = market.orderMinSize;

        const fees_enabled = market.feesEnabled;
        const maker_base_fee = market.makerBaseFee;
        const taker_base_fee = market.takerBaseFee;
        const rewards_max_spread = market.rewardsMaxSpread;
        const rewards_min_size = market.rewardsMinSize;

        let upData: TokenMarketData | undefined = undefined;
        let downData: TokenMarketData | undefined = undefined;

        for (let i = 0; i < outcomes.length; i++) {
            const rawOutcome = outcomes[i];
            const tokenId = tokenIds[i];
            if (!rawOutcome || !tokenId) continue;
            const outcome = rawOutcome.toLowerCase();

            if (outcome === 'up') {
                upData = { outcome, tokenId };
                if (downData) break;
            } else if (outcome === 'down') {
                downData = { outcome, tokenId };
                if (upData) break;
            }
        }

        if (!upData || !downData) {
            throw new Error(`[LiveMarketOrderBooksWatcher] Error: up/down outcomes not found for market: ${this._marketDataRaw.id}`);
        }

        let marketData: EventMarketData | undefined = {
            eventId: eventId,
            marketId: marketId,
            conditionId: conditionId,
            tick_size: tick_size,
            min_order_size: min_order_size,

            fees_enabled: fees_enabled,
            maker_base_fee: maker_base_fee,
            taker_base_fee: taker_base_fee,
            rewards_max_spread: rewards_max_spread,
            rewards_min_size: rewards_min_size,

            up: upData,
            down: downData
        };
        this._marketData = marketData;

        const options = {
            reconnectAndCleanupIntervalMs: ORDER_BOOKS_WATCHER_RECONNECT_AND_CLEANUP,
            pendingFlushIntervalMs: PENDING_FLUSH_INTERVAL_MS,
        };

        this._manager = new WSSubscriptionManager({
            onBook: async (events) => {
                try {
                    for (const { asset_id, timestamp } of events) {
                        if (this._marketData?.up?.tokenId === asset_id) this._timestampUp = safeToNum(timestamp);
                        if (this._marketData?.down?.tokenId === asset_id) this._timestampDown = safeToNum(timestamp);

                        if (!this._isUpBooked && this._marketData?.up?.tokenId === asset_id) this._isUpBooked = true;
                        if (!this._isDownBooked && this._marketData?.down.tokenId === asset_id) this._isDownBooked = true;
                    }
                } catch (err) {
                    logger.error(`[LiveMarketOrderBooksWatcher] Error: ${error_str(err)}`);
                }
                // Calls users code handler for onBook event
                await this.callHandler('onBook', events);
            },

            onPriceChange: async (events) => {
                try {
                    for (const { timestamp, price_changes } of events) {
                        for (const {asset_id } of price_changes) {
                            if (this._marketData?.up?.tokenId === asset_id) this._timestampUp = safeToNum(timestamp);
                            if (this._marketData?.down?.tokenId === asset_id) this._timestampDown = safeToNum(timestamp);
                        }
                    }
                } catch (err) {
                    logger.error(`[LiveMarketOrderBooksWatcher] Error: ${error_str(err)}`);
                }
                await this.callHandler('onPriceChange', events);
            },

            onLastTradePrice:  async (events) => {
                try {
                    for (const { asset_id, timestamp } of events) {
                        if (this._marketData?.up.tokenId === asset_id) this._timestampUp = safeToNum(timestamp);
                        if (this._marketData?.down?.tokenId === asset_id) this._timestampDown = safeToNum(timestamp);
                    }
                } catch (err) {
                    logger.error(`[LiveMarketOrderBooksWatcher] Error: ${error_str(err)}`);
                }
                await this.callHandler('onLastTradePrice', events);
            },

            onError: async (error) => {
                logger.error(`[LiveMarketOrderBooksWatcher] Error: ${error_str(error)}`);

                await this.callHandler('onError', error);
                try {
                    if (this._manager) this._manager.clearState();
                } catch (err) {
                    logger.error(`[LiveMarketOrderBooksWatcher] Error while clearing manager state: ${error_str(err)}`);
                }
                this._isUpBooked = false;
                this._isDownBooked = false;
            },

            onTickSizeChange: async (events) => {
                events.forEach((event) => {

                    const newTickSize = safeToNum(event.new_tick_size);
                    if (newTickSize <= 0) return;
                    if (this._marketData && event.market === this._marketData.conditionId) {
                        this._marketData.tick_size = newTickSize;
                    }
               });
                await this.callHandler('onTickSizeChange', events);
            },

            onPolymarketPriceUpdate: async (events) => {
                await this.callHandler('onPolymarketPriceUpdate', events);
            },
            
            // Connection lifecycle events
            onWSClose: async (managerId: string, code: number, reason: string) => {
                await this.callHandler('onWSClose', managerId, code, reason);
            },

            onWSOpen: async (managerId: string, pendingAssetIds: string[]) => {
                await this.callHandler('onWSOpen', managerId, pendingAssetIds);
            }

        }, options);

        await this._manager.addSubscriptions([this._marketData.up.tokenId, this._marketData.down.tokenId]);
        this._isInitialized = true;
    }


    /**
     * Helper functions for user handlers calling
     * @param name The name of event handler like onBook
     * @param args Set of params for handler
     * @returns 
     */
    private async callHandler(name: keyof WSSubscriptionManagerHandlers, ...args: any[]): Promise<void> {
        const handler = this._handlers?.[name];
        if (!handler) return;
        try {
            await (handler as any)(...args);
        } catch (err) {
            logger.error(`[LiveMarketOrderBooksWatcher] User handler ${name} error: ${error_str(err)}`);
        }
    }

    /** @returns Sorted bid levels for Up token (descending price). */
    public getBidsUp(): OrderBookLevel[] {
        const entry = this._manager.getBookEntry(this._marketData!.up.tokenId);
        return entry?.bids.slice() ?? [];
    }

    /** @returns Sorted ask levels for Up token (ascending price). */
    public getAsksUp(): OrderBookLevel[] {
        const entry = this._manager.getBookEntry(this._marketData!.up.tokenId);
        return entry?.asks.slice() ?? [];
    }

    /** @returns Sorted bid levels for Down token (descending price). */
    public getBidsDown(): OrderBookLevel[] {
        const entry = this._manager.getBookEntry(this._marketData!.down.tokenId);
        return entry?.bids.slice() ?? [];
    }

    /** @returns Sorted ask levels for Down token (ascending price). */
    public getAsksDown(): OrderBookLevel[] {
        const entry = this._manager.getBookEntry(this._marketData!.down.tokenId);
        return entry?.asks.slice() ?? [];
    }

    /**
     * Best bid for the specified token.
     * @param token - 'up' or 'down'
     * @returns Price as number, or undefined if no bids exist.
     */
    public getBestBid(token: MarketSide): number | undefined {
        const bids = token === 'up' ? this.getBidsUp() : this.getBidsDown();
        if (bids.length === 0) return undefined;
        const bestBid = safeToNum(bids[bids.length - 1]!.price, -1);
        return (bestBid === -1) ? undefined : bestBid;
    }

    /**
     * Best ask for the specified token.
     * @param token - 'up' or 'down'
     * @returns Price as number, or undefined if no asks exist.
     */
    public getBestAsk(token: MarketSide): number | undefined {
        const asks = token === 'up' ? this.getAsksUp() : this.getAsksDown();
        if (asks.length === 0) return undefined;
        const bestAsk = safeToNum(asks[asks.length - 1]!.price, -1);
        return (bestAsk === -1) ? undefined : bestAsk;
    }

    /**
     * Determines whether the event is still tradable (active, not closed, and before end date).
     */
    public isActive(): boolean {
        if (!this._eventDataRaw) return false;
        if (!this._marketDataRaw) return false;
        if (!this._marketData) return false;
        if (!this._marketData!.up) return false;
        if (!this._marketData!.down) return false;

        ///////////////////////////////////////////////////////////////////////
        const anyMarket = this._marketDataRaw;
        if (!anyMarket) return false;
        const now = Date.now();
        const endTime = isoToMs(this._eventDataRaw.endDate);
        return anyMarket.active && !anyMarket.closed && now < endTime;
        ///////////////////////////////////////////////////////////////////////
    }

    /**
     * Returns true if both order books have received their initial snapshots and the WebSocket is open.
     */
    public isWatching(): boolean {
        if (!this._isUpBooked || !this._isDownBooked) return false;
        const stats = this._manager.getStatistics();
        return stats.openWebSockets > 0;
    }

    /**
     * Returns true if event time over
     */
    public isFinished(): boolean {
        if (!this._eventDataRaw) return true;
        const now = Date.now();
        const endTime = isoToMs(this._eventDataRaw.endDate);
        return now >= endTime;
    }

    /** @returns The unique event ID from the REST data. */
    public getEventId(): string {
        return this._eventDataRaw!.id;
    }

    /** @returns The unique market ID from the REST data. */
    public getMarketId(): string {
        return this._marketData!.marketId;
    }

    /** @returns The latest price (midpoint) for the Up token. */
    public getUpPrice(): number | undefined {
        const entry = this._manager.getBookEntry(this._marketData!.up.tokenId);
        const price = entry?.price;
        return isValid(price) ? safeToNum(price) : undefined;
    }

    /** @returns The latest price (midpoint) for the Down token. */
    public getDownPrice(): number | undefined {
        const entry = this._manager.getBookEntry(this._marketData!.down.tokenId);
        const price = entry?.price;
        return isValid(price) ? safeToNum(price) : undefined;
    }
    
    /** @returns Midpoint price for the Up token. */
    public getUpMidpoint(): number | undefined {
        const entry = this._manager.getBookEntry(this._marketData!.up.tokenId);
        const midpoint = entry?.midpoint;
        return isValid(midpoint) ? safeToNum(midpoint) : undefined;
    }

    /** @returns Midpoint price for the Down token. */
    public getDownMidpoint(): number | undefined {
        const entry = this._manager.getBookEntry(this._marketData!.down.tokenId);
        const midpoint = entry?.midpoint;
        return isValid(midpoint) ? safeToNum(midpoint) : undefined;
    }

    /** @returns Spread for the Up token. */
    public getUpSpread(): number | undefined {
        const entry = this._manager.getBookEntry(this._marketData!.up.tokenId);
        const spread = entry?.spread;
        return isValid(spread) ? safeToNum(spread) : undefined;
    }

    /** @returns Spread for the Down token. */
    public getDownSpread(): number | undefined {
        const entry = this._manager.getBookEntry(this._marketData!.down.tokenId);
        const spread = entry?.spread;
        return isValid(spread) ? safeToNum(spread) : undefined;
    }

    public getMarketData(): EventMarketData {
        return {
            eventId: this._marketData!.eventId,
            marketId: this._marketData!.marketId,
            conditionId: this._marketData!.conditionId,
            tick_size: this._marketData!.tick_size,
            min_order_size: this._marketData!.min_order_size,

            fees_enabled: this._marketData!.fees_enabled,
            maker_base_fee: this._marketData!.maker_base_fee,
            taker_base_fee: this._marketData!.taker_base_fee,
            rewards_max_spread: this._marketData!.rewards_max_spread,
            rewards_min_size: this._marketData!.rewards_min_size,

            up: this._marketData!.up,
            down: this._marketData!.down
        };
    }

    /** @returns A shallow copy of the Up token metadata. */
    public getUpMarketData(): TokenMarketData {
        return {
            outcome: this._marketData!.up.outcome,
            tokenId: this._marketData!.up.tokenId
        };
    }

    /** @returns A shallow copy of the Down token metadata. */
    public getDownMarketData(): TokenMarketData {
        return {
            outcome: this._marketData!.down.outcome,
            tokenId: this._marketData!.down.tokenId
        };
    }

    /**
     * Helper: aggregates total size, total cost, and average price from a list of book levels.
     */
    private computeLiquidity(levels: OrderBookLevel[]): LiquidityInfo {
        let totalSize = 0;
        let totalCost = 0;
        for (const level of levels) {
            const size = safeToNum(level.size);
            const price = safeToNum(level.price);
            // For complete safety, use this:
            // totalSize = safeFloat(totalSize + size, DEFAULT_ORDER_AMOUNT_FRACTION);
            // totalCost = safeFloat(totalCost + price * size, DEFAULT_ORDER_AMOUNT_FRACTION);
            totalSize += size;
            totalCost += price * size;
        }
        const averagePrice = totalSize > 0 ? totalCost / totalSize : 0;
        return {
            total_size: safeFloat(totalSize, DEFAULT_ORDER_AMOUNT_FRACTION),
            total_cost: safeFloat(totalCost, DEFAULT_ORDER_AMOUNT_FRACTION),
            average_price: safeFloat(averagePrice, DEFAULT_ORDER_AMOUNT_FRACTION),
        };
    }

    public getUpBidLiquidity(): LiquidityInfo {
        return this.computeLiquidity(this.getBidsUp());
    }

    public getUpAskLiquidity(): LiquidityInfo {
        return this.computeLiquidity(this.getAsksUp());
    }

    public getDownBidLiquidity(): LiquidityInfo {
        return this.computeLiquidity(this.getBidsDown());
    }

    public getDownAskLiquidity(): LiquidityInfo {
        return this.computeLiquidity(this.getAsksDown());
    }

    /** @returns Whether the Up token’s initial snapshot has been received. */
    public isUpBooked(): boolean {
        return this._isUpBooked;
    }

    /** @returns Whether the Down token’s initial snapshot has been received. */
    public isDownBooked(): boolean {
        return this._isDownBooked;
    }

    public getTimeStamp(token: MarketSide): number | undefined {
        return (token === 'up')? this._timestampUp : this._timestampDown;
    }

    public hasBidsUp(): boolean {
        const entry = this._manager.getBookEntry(this._marketData!.up.tokenId);
        return (entry?.bids?.length ?? 0) > 0;
    }

    public hasAsksUp(): boolean {
        const entry = this._manager.getBookEntry(this._marketData!.up.tokenId);
        return (entry?.asks?.length ?? 0) > 0;
    }

    public hasBidsDown(): boolean {
        const entry = this._manager.getBookEntry(this._marketData!.down.tokenId);
        return (entry?.bids?.length ?? 0) > 0;
    }

    public hasAsksDown(): boolean {
        const entry = this._manager.getBookEntry(this._marketData!.down.tokenId);
        return (entry?.asks?.length ?? 0) > 0;
    }

    /** Cleans up WebSocket resources and resets all internal state for possible re-initialization. */
    public disconnect(): void {
        if (this._manager) {
            this._manager.clearState();
            this._manager = undefined!;
        }
        this._timestampUp = undefined;
        this._timestampDown = undefined;

        this._isUpBooked = false;
        this._isDownBooked = false;
        this._isInitialized = false;
    }
}