import { ClobClient } from "@polymarket/clob-client-v2";
import { safeFloat } from "../utils.js";

export const BASIS_POINTS_PER_UNIT = 10_000;
/** Polymarket rounds each taker fee charged at match time to five decimal places. */
export const TAKER_FEE_DECIMAL_PLACES = 5;
export const MINIMUM_TAKER_FEE = 0.00001;

/** Converts the CLOB fee metadata unit (basis points) into a decimal rate. */
export function feeRateBpsToDecimal(feeRateBps: number): number {
    return feeRateBps / BASIS_POINTS_PER_UNIT;
}

/**
 * [DEPRECATED V1]
 * 
 * Fetches the current taker fee rate in basis points for a specific token.
 * @param client - An initialized Polymarket ClobClient instance.
 * @param tokenId - The token's unique identifier.
 * @returns The fee rate in basis points (e.g., 30 for 0.30%).
 */
export async function getTakerFeeBpsV1(client_v1: ClobClient, tokenId: string): Promise<number> {
    // It returns the current fee in basis points for a given token.
    const feeResponse = await client_v1.getFeeRateBps(tokenId);
    return feeResponse;
}

/**
 * Calculates the taker fee for a trade on Polymarket.
 *
 * @param shares - Number of shares being traded
 * @param price - Price per share (in USD, typically between 0.01 and 0.99)
 * @param feeRateDecimal - Taker fee rate as a decimal (e.g., 0.072 for Crypto markets)
 * @returns The fee amount in USD
 *
 * @see https://docs.polymarket.com/trading/fees
 */
export function calculateTakerFee(shares: number, price: number, feeRateDecimal: number): number {
    // Formula: fee = C × feeRate × p × (1 - p)
    // where C = shares, feeRate = taker fee rate (decimal), p = price
    const fee = shares * feeRateDecimal * price * (1 - price);
    
    const roundedFee = safeFloat(fee, TAKER_FEE_DECIMAL_PLACES);
    return roundedFee < MINIMUM_TAKER_FEE ? 0 : roundedFee;
}

/** Calculates the maximum taker fee reserve for a prospective buy limit order. */
export function calculateBuyTakerFeeReserve(
    feesEnabled: boolean,
    takerBaseFeeBps: number,
    price: number,
    quantity: number,
): number {
    if (!feesEnabled) return 0;
    return calculateTakerFee(quantity, price, feeRateBpsToDecimal(takerBaseFeeBps));
}
