import { logger } from "../../../log.js";
import { EventRaw, fetchEventBySlug } from "../../../rest/scan.js";
import { error_str, isValid, safeToNum } from "../../../utils.js";
import { WSSubscriptionManager } from "../manager/WSSubscriptionManager.js";
import { BookEvent } from "../manager/types/PolymarketWebSocket.js";
import { EventOrderBooksWatcher, MarketTokenData, OrderBookLevel } from "./EventOrderBooksWatcher.js";

/**
 * Manages real‑time order book data for a Polymarket event (Up/Down tokens).
 * Uses WebSocket subscriptions to receive snapshots and incremental updates.
 * Must be initialised with `init()` before calling any other methods.
 */
export class CoinEventOrderBooksWatcher implements EventOrderBooksWatcher {
    private _slug_gvn: string;
    private _eventData: EventRaw | undefined = undefined;
    private _upMarket: MarketTokenData | undefined = undefined;
    private _downMarket: MarketTokenData | undefined = undefined;
    private _manager!: WSSubscriptionManager;
    private _isUpBooked = false;
    private _isDownBooked = false;
    private _isInitialized = false;

    constructor(slug: string) {
        this._slug_gvn = slug;
    }

    /**
     * Fetches event metadata, initialises WebSocket manager, and subscribes to Up/Down token books.
     * @throws If the slug is invalid, event data is malformed, or subscription fails.
     */
    public async init(): Promise<void> {
        if (!this._slug_gvn) throw new Error(`OrderBook manager error: no slug error`);

        this._eventData = await fetchEventBySlug(this._slug_gvn);
        if (this._eventData.markets.length !== 1)
            throw new Error(`OrderBook manager error: wrong number of event markets: ${this._eventData.markets.length}`);

        const market = this._eventData.markets[0]!;
        const outcomes = market.outcomes;
        const tokenIds = market.clobTokenIds;

        if (outcomes.length < 2 || tokenIds.length < 2) {
            throw new Error(`OrderBook manager error: expected 2 outcomes/tokenIds, got outcomes=${outcomes.length}, tokenIds=${tokenIds.length}`);
        }

        this._upMarket = {
            outcome: outcomes[0]!.toLocaleLowerCase(),
            tokenId: tokenIds[0]!,
            marketId: market.id,
            eventId: this._eventData.id,
        };

        this._downMarket = {
            outcome: outcomes[1]!.toLocaleLowerCase(),
            tokenId: tokenIds[1]!,
            marketId: market.id,
            eventId: this._eventData.id,
        };

        const options = {
            reconnectAndCleanupIntervalMs: 750,
            pendingFlushIntervalMs: 50,
        };
        this._manager = new WSSubscriptionManager({
            onBook: async (events: BookEvent[]) => {
                for (const { asset_id } of events) {
                    if (!this._isUpBooked && this._upMarket?.tokenId === asset_id) this._isUpBooked = true;
                    if (!this._isDownBooked && this._downMarket?.tokenId === asset_id) this._isDownBooked = true;
                    if (this._isUpBooked && this._isDownBooked) break;
                }
            },
            onError: async (error) => {
                logger.error(`OrderBook manager error: ${error_str(error)}`);
                try {
                    this._manager.clearState();
                } catch (err) {
                    logger.error(`Error while clearing manager state: ${error_str(err)}`);
                }
                this._isUpBooked = false;
                this._isDownBooked = false;
            }
        }, options);

        await this._manager.addSubscriptions([this._upMarket.tokenId, this._downMarket.tokenId]);
        this._isInitialized = true;
    }

    private ensureInitialized(): void {
        if (!this._isInitialized) throw new Error('Call init() first');
    }

    /** @returns Sorted bid levels for Up token (descending price). */
    public getBidsUp(): OrderBookLevel[] {
        this.ensureInitialized();
        const entry = this._manager.getBookEntry(this._upMarket!.tokenId);
        return entry?.bids ?? [];
    }

    /** @returns Sorted ask levels for Up token (ascending price). */
    public getAsksUp(): OrderBookLevel[] {
        this.ensureInitialized();
        const entry = this._manager.getBookEntry(this._upMarket!.tokenId);
        return entry?.asks ?? [];
    }

    /** @returns Sorted bid levels for Down token (descending price). */
    public getBidsDown(): OrderBookLevel[] {
        this.ensureInitialized();
        const entry = this._manager.getBookEntry(this._downMarket!.tokenId);
        return entry?.bids ?? [];
    }

    /** @returns Sorted ask levels for Down token (ascending price). */
    public getAsksDown(): OrderBookLevel[] {
        this.ensureInitialized();
        const entry = this._manager.getBookEntry(this._downMarket!.tokenId);
        return entry?.asks ?? [];
    }

    /**
     * Best bid (highest price) for the specified token.
     * @param token - 'up' or 'down'
     * @returns Price as number, or undefined if no bids exist.
     */
    public getBestBid(token: 'up' | 'down'): number | undefined {
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
    public getBestAsk(token: 'up' | 'down'): number | undefined {
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
        const now = new Date();
        const endTime = new Date(this._eventData.endDate);
        return anyMarket.active && !anyMarket.closed && now < endTime;
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

    /** Cleans up WebSocket resources and resets initialisation state. */
    public dispose(): void {
        if (this._manager) {
            this._manager.clearState();
            this._manager = undefined!;
        }
        this._isInitialized = false;
    }
}