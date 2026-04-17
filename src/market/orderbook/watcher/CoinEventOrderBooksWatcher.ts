import { logger } from "../../../log.js";
import { MarketSide } from "../../side.js";
import { EventRaw, fetchEventBySlug } from "../../../rest/scan.js";
import { error_str, isValid, isoToMs, safeToNum } from "../../../utils.js";
import { WSSubscriptionManager, WSSubscriptionManagerHandlers } from "../manager/WSSubscriptionManager.js";
import { EventOrderBooksWatcher, MarketTokenData, OrderBookLevel } from "./EventOrderBooksWatcher.js";

/**
 * Manages real‑time order book data for a Polymarket event (Up/Down tokens).
 * Uses WebSocket subscriptions to receive snapshots and incremental updates.
 * Must be initialised with `init()` before calling any other methods.
 */
export class CoinEventOrderBooksWatcher implements EventOrderBooksWatcher {
    private _slug: string;
    private _eventData: EventRaw | undefined = undefined;
    private _upMarket: MarketTokenData | undefined = undefined;
    private _downMarket: MarketTokenData | undefined = undefined;

    private _timestampUp: number | undefined = undefined;
    private _timestampDown: number | undefined = undefined;

    private _manager!: WSSubscriptionManager;
    private _handlers: WSSubscriptionManagerHandlers | undefined;

    private _isUpBooked = false;
    private _isDownBooked = false;
    private _isInitialized = false;

    private constructor(slug: string, handlers?: WSSubscriptionManagerHandlers) {
        this._slug = slug;
        this._handlers = handlers;
    }

    /**
     * Fetches event metadata, initialises WebSocket manager, and subscribes to Up/Down token books.
     * @throws If the slug is invalid, event data is malformed, or subscription fails.
     */
    private async init(): Promise<void> {
        if (this._isInitialized) {
            this.dispose();
        }

        if (!this._slug) throw new Error(`OrderBook manager error: no slug error`);

        this._eventData = await fetchEventBySlug(this._slug);
        if (!this._eventData)
            throw new Error(`OrderBook manager error: no event data fetched by slug: ${this._slug}`);

        if (this._eventData.markets.length !== 1)
            throw new Error(`OrderBook manager error: wrong number of event markets: ${this._eventData.markets.length}`);

        const market = this._eventData.markets[0]!;
        const outcomes = market.outcomes;
        const tokenIds = market.clobTokenIds;

        if (outcomes.length < 2 || tokenIds.length < 2) {
            throw new Error(`OrderBook manager error: expected 2 outcomes/tokenIds, got outcomes=${outcomes.length}, tokenIds=${tokenIds.length}`);
        }

        /**
         * Polymarket’s API does not guarantee that the first outcome is always "up" and the second "down".
         */
        const eventId = this._eventData.id;
        const marketId = market.id;
        let upMarket: MarketTokenData | undefined = undefined;
        let downMarket: MarketTokenData | undefined = undefined;

        for (let i = 0; i < outcomes.length; i++) {
            const rawOutcome = outcomes[i];
            const tokenId = tokenIds[i];
            if (!rawOutcome || !tokenId) continue;
            const outcome = rawOutcome.toLowerCase();

            if (outcome === 'up') {
                upMarket = { outcome, tokenId, marketId, eventId };
                if (downMarket) break;
            } else if (outcome === 'down') {
                downMarket = { outcome, tokenId, marketId, eventId };
                if (upMarket) break;
            }
        }

        if (!upMarket || !downMarket) {
            throw new Error(`OrderBook manager error: up/down outcomes not found for slug ${this._slug}`);
        }
        this._upMarket = upMarket;
        this._downMarket = downMarket;

        
        const options = {
            reconnectAndCleanupIntervalMs: 750,
            pendingFlushIntervalMs: 50,
        };


        this._manager = new WSSubscriptionManager({
            onBook: async (events) => {
                try {
                    for (const { asset_id, timestamp } of events) {
                        if (this._upMarket?.tokenId === asset_id) this._timestampUp = safeToNum(timestamp);
                        if (this._downMarket?.tokenId === asset_id) this._timestampDown = safeToNum(timestamp);

                        if (!this._isUpBooked && this._upMarket?.tokenId === asset_id) this._isUpBooked = true;
                        if (!this._isDownBooked && this._downMarket?.tokenId === asset_id) this._isDownBooked = true;
                    }
                } catch (err) {
                    logger.error(`OrderBook manager error: ${error_str(err)}`);
                }
                // Calls users code handler for onBook event
                await this.callHandler('onBook', events);
            },

            onPriceChange: async (events) => {
                try {
                    for (const { timestamp, price_changes } of events) {
                        for (const {asset_id } of price_changes){
                            if (this._upMarket?.tokenId === asset_id) this._timestampUp = safeToNum(timestamp);
                            if (this._downMarket?.tokenId === asset_id) this._timestampDown = safeToNum(timestamp);
                        }
                    }
                } catch (err) {
                    logger.error(`OrderBook manager error: ${error_str(err)}`);
                }
                await this.callHandler('onPriceChange', events);
            },
            onLastTradePrice:  async (events) => {
                try {
                    for (const { asset_id, timestamp } of events) {
                        if (this._upMarket?.tokenId === asset_id) this._timestampUp = safeToNum(timestamp);
                        if (this._downMarket?.tokenId === asset_id) this._timestampDown = safeToNum(timestamp);
                    }
                } catch (err) {
                    logger.error(`OrderBook manager error: ${error_str(err)}`);
                }
                await this.callHandler('onLastTradePrice', events);
            },

            onError: async (error) => {
                logger.error(`OrderBook manager error: ${error_str(error)}`);
                                
                await this.callHandler('onError', error);
                try {
                    if (this._manager) this._manager.clearState();
                } catch (err) {
                    logger.error(`Error while clearing manager state: ${error_str(err)}`);
                }
                this._isUpBooked = false;
                this._isDownBooked = false;
            },

            onTickSizeChange: async (events) => {
                //...
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

        await this._manager.addSubscriptions([this._upMarket.tokenId, this._downMarket.tokenId]);
        this._isInitialized = true;
    }

    /**
     * Creates a new real‑time order book watcher for data.
     * @param coin - The real‑time order book watcher.
     * @param handlers - Event handlers for it.
     * @returns A promise that resolves to the initialized watcher.
     */
    public static async create(slug: string, handlers?: WSSubscriptionManagerHandlers): Promise<CoinEventOrderBooksWatcher> {
        const instance = new CoinEventOrderBooksWatcher(slug, handlers);
        await instance.init();
        return instance;
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
            logger.error(`User handler ${name} error: ${error_str(err)}`);
        }
    }

    private ensureInitialized(): void {
        if (!this._isInitialized) throw new Error('CoinEventOrderBookWatcher Error: call init() first!');
    }

    /** @returns Sorted bid levels for Up token (descending price). */
    public getBidsUp(): OrderBookLevel[] {
        this.ensureInitialized();
        const entry = this._manager.getBookEntry(this._upMarket!.tokenId);
        return entry?.bids.slice() ?? [];
    }

    /** @returns Sorted ask levels for Up token (ascending price). */
    public getAsksUp(): OrderBookLevel[] {
        this.ensureInitialized();
        const entry = this._manager.getBookEntry(this._upMarket!.tokenId);
        return entry?.asks.slice() ?? [];
    }

    /** @returns Sorted bid levels for Down token (descending price). */
    public getBidsDown(): OrderBookLevel[] {
        this.ensureInitialized();
        const entry = this._manager.getBookEntry(this._downMarket!.tokenId);
        return entry?.bids.slice() ?? [];
    }

    /** @returns Sorted ask levels for Down token (ascending price). */
    public getAsksDown(): OrderBookLevel[] {
        this.ensureInitialized();
        const entry = this._manager.getBookEntry(this._downMarket!.tokenId);
        return entry?.asks.slice() ?? [];
    }

    /**
     * Best bid (highest price) for the specified token.
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
     * Best ask (lowest price) for the specified token.
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
        if (!this._eventData) return false;
        if (!this._upMarket) return false;
        if (!this._downMarket) return false;

        const anyMarket = this._eventData.markets[0];
        if (!anyMarket) return false;
        ///////////////////////////////////////////////////////////////////////
        const now = Date.now();
        const endTime = isoToMs(this._eventData.endDate);
        return anyMarket.active && !anyMarket.closed && now < endTime;
        ///////////////////////////////////////////////////////////////////////
    }

    /**
     * Returns true if both order books have received their initial snapshots and the WebSocket is open.
     */
    public isWatching(): boolean {
        this.ensureInitialized();
        if (!this._isUpBooked || !this._isDownBooked) return false;
        const stats = this._manager.getStatistics();
        return stats.openWebSockets > 0;
    }

    /**
     * Returns true if event time over
     */
    public isFinished(): boolean {
        if (!this._eventData) return true;
        const now = Date.now();
        const endTime = isoToMs(this._eventData.endDate);
        return now >= endTime;
    }

    /** @returns The unique event ID from the REST data. */
    public getEventId(): string {
        this.ensureInitialized();
        return this._eventData!.id;
    }

    /** @returns The latest price (midpoint) for the Up token. */
    public getUpPrice(): number | undefined {
        this.ensureInitialized();
        const entry = this._manager.getBookEntry(this._upMarket!.tokenId);
        const price = entry?.price;
        return isValid(price) ? safeToNum(price) : undefined;
    }

    /** @returns The latest price (midpoint) for the Down token. */
    public getDownPrice(): number | undefined {
        this.ensureInitialized();
        const entry = this._manager.getBookEntry(this._downMarket!.tokenId);
        const price = entry?.price;
        return isValid(price) ? safeToNum(price) : undefined;
    }
    
    /** @returns Midpoint price for the Up token. */
    public getUpMidpoint(): number | undefined {
        this.ensureInitialized();
        const entry = this._manager.getBookEntry(this._upMarket!.tokenId);
        const midpoint = entry?.midpoint;
        return isValid(midpoint) ? safeToNum(midpoint) : undefined;
    }

    /** @returns Midpoint price for the Down token. */
    public getDownMidpoint(): number | undefined {
        this.ensureInitialized();
        const entry = this._manager.getBookEntry(this._downMarket!.tokenId);
        const midpoint = entry?.midpoint;
        return isValid(midpoint) ? safeToNum(midpoint) : undefined;
    }

    /** @returns Spread for the Up token. */
    public getUpSpread(): number | undefined {
        this.ensureInitialized();
        const entry = this._manager.getBookEntry(this._upMarket!.tokenId);
        const spread = entry?.spread;
        return isValid(spread) ? safeToNum(spread) : undefined;
    }

    /** @returns Spread for the Down token. */
    public getDownSpread(): number | undefined {
        this.ensureInitialized();
        const entry = this._manager.getBookEntry(this._downMarket!.tokenId);
        const spread = entry?.spread;
        return isValid(spread) ? safeToNum(spread) : undefined;
    }

    /** @returns A shallow copy of the Up token metadata. */
    public getUpMarketData(): MarketTokenData {
        this.ensureInitialized();
        return {
            outcome: this._upMarket!.outcome,
            tokenId: this._upMarket!.tokenId,
            marketId: this._upMarket!.marketId,
            eventId: this._upMarket!.eventId,
        };
    }

    /** @returns A shallow copy of the Down token metadata. */
    public getDownMarketData(): MarketTokenData {
        this.ensureInitialized();
        return {
            outcome: this._downMarket!.outcome,
            tokenId: this._downMarket!.tokenId,
            marketId: this._downMarket!.marketId,
            eventId: this._downMarket!.eventId,
        };
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
        this.ensureInitialized();
        const entry = this._manager.getBookEntry(this._upMarket!.tokenId);
        return (entry?.bids?.length ?? 0) > 0;
    }

    public hasAsksUp(): boolean {
        this.ensureInitialized();
        const entry = this._manager.getBookEntry(this._upMarket!.tokenId);
        return (entry?.asks?.length ?? 0) > 0;
    }

    public hasBidsDown(): boolean {
        this.ensureInitialized();
        const entry = this._manager.getBookEntry(this._downMarket!.tokenId);
        return (entry?.bids?.length ?? 0) > 0;
    }

    public hasAsksDown(): boolean {
        this.ensureInitialized();
        const entry = this._manager.getBookEntry(this._downMarket!.tokenId);
        return (entry?.asks?.length ?? 0) > 0;
    }

    /** Cleans up WebSocket resources and resets all internal state for possible re-initialization. */
    public dispose(): void {
        if (this._manager) {
            this._manager.clearState();
            this._manager = undefined!;
        }

        //this._eventData = undefined;
        //this._upMarket = undefined;
        //this._downMarket = undefined;
        
        this._timestampUp = undefined;
        this._timestampDown = undefined;

        this._isUpBooked = false;
        this._isDownBooked = false;
        this._isInitialized = false;
    }
}