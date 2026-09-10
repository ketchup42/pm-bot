export interface CoinConfig {
    /** Decimal places used when normalising the external price feed. */
    precision: number;
}

/**
 * Canonical registry of coins supported by the application.
 * Add or remove coins here; the Coin type, runtime validation, collector CLI and
 * all consumers of getSupportedCoins() update automatically.
 */
export const COIN_CONFIGS = {
    btc: { precision: 2 },
    doge: { precision: 6 },
    eth: { precision: 2 },
    sol: { precision: 2 },
    xrp: { precision: 4 },
    bnb: { precision: 4 },
} as const satisfies Record<string, CoinConfig>;

export type Coin = keyof typeof COIN_CONFIGS;

export const SUPPORTED_COINS: readonly Coin[] = Object.freeze(
    Object.keys(COIN_CONFIGS) as Coin[],
);

export function getSupportedCoins(): readonly Coin[] {
    return SUPPORTED_COINS;
}

export function isCoin(value: string): value is Coin {
    return Object.prototype.hasOwnProperty.call(COIN_CONFIGS, value);
}

export const DEFAULT_COIN_PRICE_TICK_SIZE = 0.01;

/**
 * Returns the number of decimal places to use when rounding prices for a given coin.
 * Defaults to 6 if the coin is not explicitly defined.
 *
 * @param coin - The coin type (e.g., 'btc', 'doge', 'eth', 'xrp', 'sol').
 * @returns Number of decimal places.
 */
export function coin_precis(coin: Coin): number {
    return COIN_CONFIGS[coin].precision;
}
