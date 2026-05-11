export type Coin = 'btc' | 'doge' | 'eth' | 'sol' | 'xrp' | 'bnb' | 'hype';

export const DEFAULT_COIN_PRICE_TICK_SIZE = 0.01;

/**
 * Returns the number of decimal places to use when rounding prices for a given coin.
 * Defaults to 6 if the coin is not explicitly defined.
 *
 * @param coin - The coin type (e.g., 'btc', 'doge', 'eth', 'xrp', 'sol').
 * @returns Number of decimal places.
 */
export function coin_precis(coin: Coin): number {
    const records: Record<Coin, number> = {
        btc: 2,
        doge: 6,
        eth: 2,
        xrp: 4,
        sol: 2,
        bnb: 4,
        hype: 4,
        // Add other coins as needed
    };
    return records[coin] ?? 6;
}