import { PriceWatcherRTDC, RTDS_PRICE_NODATA, RtdsSymbolPriceData } from './PriceWatcherRTDC.js';
import { Coin } from '../crypto.js';

/**
 * Mapping from Coin enum to the symbol string expected by Polymarket RTDS.
 */
const coinToSymbol: Record<Coin, string> = {
    btc: 'btcusdt',
    doge: 'dogeusdt',
    eth: 'ethusdt',
    sol: 'solusdt',
    xrp: 'xrpusdt',
};

/**
 * Factory that creates and manages PriceWatcherRTDC instances per coin.
 * Uses a singleton pattern per coin – calling `getPriceWatcher` with the same coin
 * returns the same instance (unless `forceNew` is true).
 */
export class CoinPriceWatcherFactory {
    private static _instances: Map<Coin, PriceWatcherRTDC> = new Map();

    /**
     * Returns a PriceWatcherRTDC instance for the given coin.
     * Reuses an existing instance if one already exists for this coin.
     *
     * @param coin - The coin type (e.g., 'btc', 'eth').
     * @returns The price watcher instance.
     */
    static getPriceWatcher(coin: Coin): PriceWatcherRTDC {
        const existing = this._instances.get(coin);
        if (existing) {
            return existing;
        }
        const symbol = coinToSymbol[coin];
        const watcher = new PriceWatcherRTDC(symbol);
        this._instances.set(coin, watcher);
        return watcher;
    }

    /**
     * Creates a **new** price watcher instance without reusing any existing one.
     * Useful when you need multiple independent connections to the same coin.
     *
     * @param coin - The coin type.
     * @returns A fresh price watcher instance.
     */
    static createNew(coin: Coin): PriceWatcherRTDC {
        const symbol = coinToSymbol[coin];
        return new PriceWatcherRTDC(symbol);
    }

    /**
     * Disconnects and removes the cached instance for a specific coin.
     * @param coin - The coin type.
     */
    static async destroy(coin: Coin): Promise<void> {
        const watcher = this._instances.get(coin);
        if (watcher) {
            watcher.disconnect();
            this._instances.delete(coin);
        }
    }

    /**
     * Disconnects and clears all cached instances.
     */
    static async destroyAll(): Promise<void> {
        for (const [coin, watcher] of this._instances) {
            watcher.disconnect();
        }
        this._instances.clear();
    }
}

// -----------------------------------PriceWatcherFactory---------------------------------------
// Alternative: Simple function‑based factory (if you don't need caching)
// --------------------------------------------------------------------------

/**
 * Simple factory function – creates a new PriceWatcherRTDC for the given coin.
 * Does NOT cache instances.
 *
 * @param coin - The coin type.
 * @returns A new price watcher instance.
 */
export function createPriceWatcher(coin: Coin): PriceWatcherRTDC {
    const symbol = coinToSymbol[coin];
    return new PriceWatcherRTDC(symbol);
}