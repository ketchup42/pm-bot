import { EventRaw, MarketRaw, fetchEventBySlug } from "../../../rest/scan.js";
import { WSSubscriptionManagerHandlers } from "../manager/WSSubscriptionManager.js";
import { LiveMarketOrderBooksWatcher } from "./LiveMarketOrderBooksWatcher.js";

/**
 * Manages real‑time order book data for a Polymarket event (Up/Down tokens).
 * Uses WebSocket subscriptions to receive snapshots and incremental updates.
 */
export class CoinMarketOrderBooksWatcher extends LiveMarketOrderBooksWatcher {

    private constructor(eventData: EventRaw, marketData: MarketRaw, handlers?: WSSubscriptionManagerHandlers) {
       super(eventData, marketData, handlers);
    }

    /**
     * Creates a new real‑time order book watcher for data.
     * @param coin - The real‑time order book watcher.
     * @param handlers - Event handlers for it.
     * @returns A promise that resolves to the initialized watcher.
     */
    public static async create(slug: string, handlers?: WSSubscriptionManagerHandlers): Promise<CoinMarketOrderBooksWatcher>
    {
        if (!slug) throw new Error(`[CoinMarketOrderBooksWatcher] Error: no slug error!`);

        const eventData = await fetchEventBySlug(slug);
        if (!eventData)
            throw new Error(`[CoinMarketOrderBooksWatcher]  Error: no event data fetched by slug: ${slug}`);

        if (eventData.markets.length !== 1)
            throw new Error(`[CoinMarketOrderBooksWatcher] Error: wrong number of event markets: ${eventData.markets.length}`);

        const marketData = eventData.markets[0]!;
        const watcher = new CoinMarketOrderBooksWatcher(eventData, marketData, handlers);
        await watcher.init();
        return watcher;
    }
}