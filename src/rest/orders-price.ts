import { Side } from "@polymarket/clob-client-v2";

/**
 * Rounds the price according to the tick size and allowed range.
 * @param price - The original price
 * @param tickSize - The price increment (tick size)
 * @param side - The side of the order (BUY or SELL)
 * @returns The adjusted price
 */
export function tick_price(price: number, tickSize: number, side: Side): number {
    if (tickSize <= 0) return price;
    let rounded = side === Side.BUY
        ? Math.floor(price / tickSize) * tickSize   // for buy orders – round down
        : Math.ceil(price / tickSize) * tickSize;   // for sell orders – round up
    // Clamp to the allowed range [tickSize, 1 - tickSize]
    rounded = Math.max(rounded, tickSize);
    rounded = Math.min(rounded, 1 - tickSize);
    return rounded;
}

/**
 * Returns a valid order quantity:
 * - Rounds to the nearest tickSize multiple.
 *   BUY: rounds down (conservative cost).
 *   SELL: rounds up (ensures intended amount can be fully sold).
 * - Returns 0 if the final quantity is below minOrderSize.
 */
export function valid_quantity_safe(
    quantity: number,
    minOrderSize: number,
    tickSize: number,
    side: Side
): number {
    if (tickSize <= 0 || minOrderSize <= 0) return 0;
    const rounded =
        side === Side.BUY
            ? Math.floor(quantity / tickSize) * tickSize
            : Math.ceil(quantity / tickSize) * tickSize;
    return rounded >= minOrderSize ? rounded : 0;
}

/**
 * Returns a guaranteed minimum order quantity (at least minOrderSize).
 * - For BUY: rounds DOWN to keep cost under control, then if below minOrderSize returns minOrderSize.
 * - For SELL: rounds UP to avoid leaving dust, then if below minOrderSize returns minOrderSize.
 */
export function valid_quantity_unsafe(
    quantity: number,
    minOrderSize: number,
    tickSize: number,
    side: Side
): number {
    if (tickSize <= 0 || minOrderSize <= 0) return 0;
    const rounded =
        side === Side.BUY
            ? Math.floor(quantity / tickSize) * tickSize
            : Math.ceil(quantity / tickSize) * tickSize;
    return rounded >= minOrderSize ? rounded : minOrderSize;
}