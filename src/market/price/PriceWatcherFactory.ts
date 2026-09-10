import { CoinPriceWatcherRTDS } from './CoinPriceWatcherRTDS.js';
import { CoinPriceWatcherTWAP } from './CoinPriceWatcherTWAP.js';
import { isTwapPriceSource, PriceSource } from './price_source.js';
import { Coin, getSupportedCoins } from '../coins.js';
import { logger } from '../../log.js';
import { error_str } from '../../utils.js';
import { CoinPriceWatcher } from './CoinPriceWatcher.js';
import { SharedCoinPriceFeed } from './SharedCoinPriceFeed.js';
import { SharedCoinPriceWatcher } from './SharedCoinPriceWatcher.js';

/**
 * Factory that creates and manages PriceWatchers instances.
 * Uses a singleton pattern per (coin, source) combination, for CoinPriceWatchers.
 * Add more for other types of watchers.
 */
export class PriceWatcherFactory {

    private static _instances: Map<string, CoinPriceWatcher> = new Map();

    private static getCoinKey(coin: Coin, source: PriceSource): string {
        return `${coin}|${source}`;
    }

    /**
     * Returns a price watcher instance for the given coin and source.
     * Reuses an existing instance if one already exists for this (coin, source) pair.
     *
     * @param coin - The coin type (e.g., 'btc', 'eth').
     * @param source - The price source, for example PS_BINANCE or PS_CHAINLINK.
     * @returns The price watcher instance.
     *
     * TODO NOTE: This method is not safe for concurrent async calls.
     * For parallel initialization, use external synchronization.
     * 
     */
    static getCoinWatcher(coin: Coin, source: PriceSource): CoinPriceWatcher {
        const key = this.getCoinKey(coin, source);
        const existing = this._instances.get(key);
        if (existing) {
            return existing;
        }
        const watcher = isTwapPriceSource(source)
            ? new CoinPriceWatcherTWAP(coin, source)
            : new CoinPriceWatcherRTDS(coin, source);
        this._instances.set(key, watcher);
        return watcher;
    }

    /**
     * Creates per-coin views backed by one shared connection for the selected source.
     * The returned map is intentionally independent from singleton live watchers.
     */
    static createSharedCoinWatchers(source: PriceSource): ReadonlyMap<Coin, CoinPriceWatcher> {
        const feed = new SharedCoinPriceFeed(source, getSupportedCoins());
        return new Map(getSupportedCoins().map(coin => [coin, new SharedCoinPriceWatcher(coin, feed)]));
    }

    // ========== Asynchronous version with locking (commented out) ==========
    // private static _pending: Map<string, Promise<PriceWatcher>> = new Map();
    //
    // static async getCoinWatcherAsync(coin: Coin, source: PriceSource = PS_BINANCE): Promise<PriceWatcher> {
    //     const key = this.getCoinKey(coin, source);
    //     const pending = this._pending.get(key);
    //     if (pending) return pending;
    //
    //     const creationPromise = (async () => {
    //         const existing = this._instances.get(key);
    //         if (existing) return existing;
    //         const watcher = new CoinPriceWatcherRTDS(coin, source);
    //         this._instances.set(key, watcher);
    //         return watcher;
    //     })();
    //
    //     this._pending.set(key, creationPromise);
    //     try {
    //         return await creationPromise;
    //     } finally {
    //         this._pending.delete(key);
    //     }
    // }

    /**
     * Creates a **new** price watcher instance without reusing any existing one.
     * Useful when you need multiple independent connections to the same (coin, source).
     *
     * @param coin - The coin type.
     * @param source - The price source.
     * @returns A fresh price watcher instance.
     */
    static createNewCoinWatcher(coin: Coin, source: PriceSource): CoinPriceWatcher {
        return isTwapPriceSource(source)
            ? new CoinPriceWatcherTWAP(coin, source)
            : new CoinPriceWatcherRTDS(coin, source);
    }

   /**
     * Disconnects and removes the cached instance for a specific (coin, source).
     * @param coin - The coin type.
     * @param source - The price source.
     */
    static destroyCoinWatcher(coin: Coin, source: PriceSource): void {
        const key = this.getCoinKey(coin, source);
        const watcher = this._instances.get(key);
        if (watcher) {
            try {
                watcher.disconnect();
            } catch (error) {
                logger.error(`Error disconnecting watcher for ${key}: ${error_str(error)}`);
            }
            this._instances.delete(key);
        }
    }

    /**
     * Disconnects and clears all cached instances.
     */
    static destroyAll(): void {
        for (const [key, watcher] of this._instances.entries()) {
            try {
                watcher.disconnect();
            } catch (error) {
                logger.error(`Error disconnecting watcher for ${key}: ${error_str(error)}`);
            }
        }
        this._instances.clear();
    }
}

/**
 * Simple factory function – creates a new price watcher for the given coin and source.
 * Does NOT cache instances.
 *
 * @param coin - The coin type.
 * @param source - The price source.
 * @returns A new price watcher instance.
 */
export function createCoinPriceWatcher(coin: Coin, source: PriceSource): CoinPriceWatcher {
    return isTwapPriceSource(source)
        ? new CoinPriceWatcherTWAP(coin, source)
        : new CoinPriceWatcherRTDS(coin, source);
}
