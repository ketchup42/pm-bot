import { Side } from "@polymarket/clob-client-v2";
import { safeFloat } from "../utils.js";
import { DEFAULT_ORDER_AMOUNT_FRACTION } from "./orders.js";

export const getDecimalsFromTick = (tick: number) => {
    const s = tick.toString();
    const dot = s.indexOf('.');
    return dot === -1 ? 0 : s.length - dot - 1;
};

export const getDecimalsFromTickString = (tick: string) => {
    const s = tick.toString();
    const dot = s.indexOf('.');
    return dot === -1 ? 0 : s.length - dot - 1;
};

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
    return safeFloat(rounded, getDecimalsFromTick(tickSize));
}

/**
 * Returns a valid order quantity.
 * - Formats the result to DEFAULT_ORDER_AMOUNT_FRACTION.
 * - Returns 0 if the quantity is below minOrderSize.
 *
 * @param quantity     - desired quantity
 * @param minOrderSize - the minimum allowed order size
 * @param _tickSize    - (unused, kept for backward compatibility)
 * @param _side        - (unused, kept for backward compatibility)
 */
export function valid_quantity_safe(
    quantity: number,
    minOrderSize: number,
    _tickSize: number,
    _side: Side
): number {
    if (minOrderSize <= 0) return 0;
    const formatted = safeFloat(quantity, DEFAULT_ORDER_AMOUNT_FRACTION);
    return formatted >= minOrderSize ? formatted : 0;
}

/**
 * Returns a guaranteed minimum order quantity (at least minOrderSize).
 * - Formats the result to DEFAULT_ORDER_AMOUNT_FRACTION.
 * - If the quantity is below minOrderSize, returns minOrderSize.
 *
 * @param quantity     - desired quantity
 * @param minOrderSize - the minimum allowed order size
 * @param _tickSize    - (unused, kept for backward compatibility)
 * @param _side        - (unused, kept for backward compatibility)
 */
export function valid_quantity_unsafe(
    quantity: number,
    minOrderSize: number,
    _tickSize: number,
    _side: Side
): number {
    if (minOrderSize <= 0) return 0;
    const formatted = safeFloat(quantity, DEFAULT_ORDER_AMOUNT_FRACTION);
    return formatted >= minOrderSize ? formatted : minOrderSize;
}