    import { CoinPriceWatcherRTDS } from './CoinPriceWatcherRTDS.js';
    import { Coin } from '../coins.js';
    import { PriceSource } from './CoinPriceWatcherRTDS.js';

    /**
     * Factory that creates and manages CoinPriceWatcherRTDS instances.
     * Uses a singleton pattern per (coin, source) combination.
     */
    export class CoinPriceWatcherFactory {

        private static _instances: Map<string, CoinPriceWatcherRTDS> = new Map();

        private static getKey(coin: Coin, source: PriceSource): string {
            return `${coin}|${source}`;
        }

        /**
         * Returns a price watcher instance for the given coin and source.
         * Reuses an existing instance if one already exists for this (coin, source) pair.
         *
         * @param coin - The coin type (e.g., 'btc', 'eth').
         * @param source - The price source: 'binance' or 'chainlink' (default 'binance').
         * @returns The price watcher instance.
         */
        static getWatcher(coin: Coin, source: PriceSource = 'binance'): CoinPriceWatcherRTDS {
            const key = this.getKey(coin, source);
            const existing = this._instances.get(key);
            if (existing) {
                return existing;
            }
            const watcher = new CoinPriceWatcherRTDS(coin, source);
            this._instances.set(key, watcher);
            return watcher;
        }

        /**
         * Creates a **new** price watcher instance without reusing any existing one.
         * Useful when you need multiple independent connections to the same (coin, source).
         *
         * @param coin - The coin type.
         * @param source - The price source (default 'binance').
         * @returns A fresh price watcher instance.
         */
        static createNew(coin: Coin, source: PriceSource = 'binance'): CoinPriceWatcherRTDS {
            return new CoinPriceWatcherRTDS(coin, source);
        }

        /**
         * Disconnects and removes the cached instance for a specific (coin, source).
         * @param coin - The coin type.
         * @param source - The price source (default 'binance').
         */
        static destroy(coin: Coin, source: PriceSource = 'binance'): void {
            const key = this.getKey(coin, source);
            const watcher = this._instances.get(key);
            if (watcher) {
                watcher.disconnect();
                this._instances.delete(key);
            }
        }

        /**
         * Disconnects and clears all cached instances.
         */
        static destroyAll(): void {
            for (const watcher of this._instances.values()) {
                watcher.disconnect();
            }
            this._instances.clear();
        }
    }

    /**
     * Simple factory function – creates a new price watcher for the given coin and source.
     * Does NOT cache instances.
     *
     * @param coin - The coin type.
     * @param source - The price source (default 'binance').
     * @returns A new price watcher instance.
     */
    export function createCoinPriceWatcher(coin: Coin, source: PriceSource = 'binance'): CoinPriceWatcherRTDS {
        return new CoinPriceWatcherRTDS(coin, source);
    }