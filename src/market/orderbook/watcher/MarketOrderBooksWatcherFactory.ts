import { logger } from '../../../log.js';
import { error_str } from '../../../utils.js';
import { WSSubscriptionManagerHandlers } from '../manager/WSSubscriptionManager.js';
import { CoinMarketOrderBooksWatcher } from './CoinMarketOrderBooksWatcher.js';
import { MarketOrderBooksWatcher } from './MarketOrderBooksWatcher.js';

export class MarketOrderBooksWatcherFactory {
    private static _instances: Map<string, MarketOrderBooksWatcher> = new Map();

    private static _pending: Map<string, Promise<MarketOrderBooksWatcher>> = new Map();
    private static _cancelled: Map<string, boolean> = new Map();

    private static getCoinKey(slug: string): string {
        return `coin-${slug}`;
    }

    /**
     * Returns an order book watcher for the given slug.
     * Reuses an existing instance if one already exists.
     * If an initialisation is already in progress, returns the same promise.
     * If destroy() was called for this slug before the promise resolved,
     * the resulting watcher will be disposed and not cached.
     */
    static async getCoinMarketWatcher(slug: string, handlers?: WSSubscriptionManagerHandlers): Promise<MarketOrderBooksWatcher> {
        const key = this.getCoinKey(slug);
        
        // Already initialised and not destroyed?
        const existing = this._instances.get(key);
        if (existing) return existing;
        
        // Initialisation already in progress?
        const pending = this._pending.get(key);
        if (pending) return pending;

        // Start new initialisation
        const promise = (async () => {
            try {
                const watcher = await CoinMarketOrderBooksWatcher.create(slug, handlers);
                
                // If destroy() was called for this key while we were creating, do not cache
                if (this._cancelled.get(key)) {
                    watcher.dispose();          // dispose the fresh watcher
                    throw new Error(`Watcher creation cancelled for ${slug}`);
                } else {
                    this._instances.set(key, watcher); // cache normally
                    return watcher;
                }
            } finally {
                this._pending.delete(key);
                this._cancelled.delete(key);   // clean up cancellation flag
            }
        })();
        
        this._pending.set(key, promise);
        return promise;
    }

    /**
     * Creates a **new** order book watcher instance without reusing any existing one.
     * Does not cache the instance and always initialises a fresh watcher.
     */
    static async createNewCoinMarketWatcher(slug: string, handlers?: WSSubscriptionManagerHandlers): Promise<MarketOrderBooksWatcher> {
        return await CoinMarketOrderBooksWatcher.create(slug, handlers);
    }

    /**
     * Disconnects and removes the cached instance for a specific slug.
     * Also cancels any pending initialisation so that it will not be cached.
     */
    static destroy(slug: string): void {
        const key = this.getCoinKey(slug);
        
        // Mark as cancelled – this prevents a pending promise from caching
        this._cancelled.set(key, true);
        
        // Remove and dispose cached instance if present
        const watcher = this._instances.get(key);
        if (watcher) {
            try {
                watcher.dispose();
            } catch (error) {
                logger.error(`Error disposing watcher for ${key}: ${error_str(error)}`);
            }
            this._instances.delete(key);
        }
        
        // If a promise is pending, we still let it finish (it will check _cancelled)
        // but we remove it from the pending map so that subsequent calls start fresh.
        const pending = this._pending.get(key);
        if (pending) {
            this._pending.delete(key);
            // Optionally, we could wait for it, but it will dispose itself when it sees _cancelled
        }
    }

    /**
     * Disconnects and clears all cached instances and pending initialisations.
     */
    static destroyAll(): void {
        for (const [key, watcher] of this._instances.entries()) {
            try {
                watcher.dispose();
            } catch (error) {
                logger.error(`Error disposing watcher for ${key}: ${error_str(error)}`);
            }
        }
        this._instances.clear();
        
        // Cancel all pending promises
        for (const key of this._pending.keys()) {
            this._cancelled.set(key, true);
        }
        this._pending.clear();
        
        // Clean cancellation flags (optional, they will be removed when promises finish)
        // But to avoid memory leak, clear them after a short delay or when promises resolve.
        // For simplicity, we keep them – they will be deleted in the promise finally.
    }
}

/**
 * Simple factory function – creates a new order book watcher for the given slug.
 * Does NOT cache instances.
 */
export async function createCoinMarketOrderBookWatcher(slug: string, handlers?: WSSubscriptionManagerHandlers): Promise<MarketOrderBooksWatcher> {
    return await CoinMarketOrderBooksWatcher.create(slug, handlers);
}