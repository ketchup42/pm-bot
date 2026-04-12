import { CoinEventOrderBooksWatcher } from './CoinEventOrderBooksWatcher.js';

/**
 * Factory that creates and manages CoinEventOrderBooksWatcher instances.
 * Uses a singleton pattern per slug and prevents duplicate initialisation.
 */
export class CoinEventOrderBooksWatcherFactory {
    private static _instances: Map<string, CoinEventOrderBooksWatcher> = new Map();
    private static _pending: Map<string, Promise<CoinEventOrderBooksWatcher>> = new Map();

    private static getKey(slug: string): string {
        return slug;
    }

    /**
     * Returns an order book watcher for the given slug.
     * Reuses an existing instance if one already exists for this slug.
     * If an initialisation is already in progress, returns the same promise.
     * Note: The returned instance is already initialised.
     *
     * @param slug - Market slug (e.g., 'btc-updown-5m-1742227200').
     * @returns Promise resolving to an initialised order book watcher.
     */
    static async getWatcher(slug: string): Promise<CoinEventOrderBooksWatcher> {
        const key = this.getKey(slug);
        // Already initialised?
        const existing = this._instances.get(key);
        if (existing) {
            return existing;
        }
        // Initialisation already in progress?
        const pending = this._pending.get(key);
        if (pending) {
            return pending;
        }
        // Start new initialisation
        const promise = (async () => {
            try {
                const watcher = new CoinEventOrderBooksWatcher(slug);
                await watcher.init();
                this._instances.set(key, watcher);
                return watcher;
            } finally {
                this._pending.delete(key);
            }
        })();
        this._pending.set(key, promise);
        return promise;
    }

    /**
     * Creates a **new** order book watcher instance without reusing any existing one.
     * Does not cache the instance and always initialises a fresh watcher.
     *
     * @param slug - Market slug.
     * @returns Promise resolving to a new initialised order book watcher.
     */
    static async createNew(slug: string): Promise<CoinEventOrderBooksWatcher> {
        const watcher = new CoinEventOrderBooksWatcher(slug);
        await watcher.init();
        return watcher;
    }

    /**
     * Disconnects and removes the cached instance for a specific slug.
     * If a pending initialisation exists for the slug, it will not be interrupted,
     * but the resulting instance will not be cached.
     *
     * @param slug - Market slug.
     */
    static destroy(slug: string): void {
        const key = this.getKey(slug);
        const watcher = this._instances.get(key);
        if (watcher) {
            watcher.dispose();
            this._instances.delete(key);
        }
        // Optionally, also cancel pending initialisation? We'll just let it finish
        // and then not cache it (the finally block will delete pending but not store).
        const pending = this._pending.get(key);
        if (pending) {
            pending.then(watcher => {
                // If it was still pending, we discard the instance because destroy was called
                watcher.dispose();
            }).catch(() => {});
            this._pending.delete(key);
        }
    }

    /**
     * Disconnects and clears all cached instances.
     * Also clears any pending initialisations.
     */
    static destroyAll(): void {
        for (const watcher of this._instances.values()) {
            watcher.dispose();
        }
        this._instances.clear();
        // Cancel pending promises (they will resolve and be discarded)
        for (const [key, pending] of this._pending) {
            pending.then(watcher => watcher.dispose()).catch(() => {});
            this._pending.delete(key);
        }
    }
}

/**
 * Simple factory function – creates a new order book watcher for the given slug.
 * Does NOT cache instances.
 *
 * @param slug - Market slug.
 * @returns Promise resolving to a new initialised order book watcher.
 */
export async function createCoinOrderBookWatcher(slug: string): Promise<CoinEventOrderBooksWatcher> {
    const watcher = new CoinEventOrderBooksWatcher(slug);
    await watcher.init();
    return watcher;
}