/** Canonical list of binary market sides. */
export const MARKET_SIDES = ['up', 'down'] as const;

export type MarketSide = typeof MARKET_SIDES[number];

export function isMarketSide(value: string): value is MarketSide {
    return (MARKET_SIDES as readonly string[]).includes(value);
}