import { ClobClient } from "@polymarket/clob-client-v2";

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
    
    // Round to 5 decimal places as per Polymarket's fee precision
    const roundedFee = Math.round(fee * 1e5) / 1e5;
    
    // Minimum fee is 0.00001 USD; anything smaller rounds to zero
    return roundedFee < 0.00001 ? 0 : roundedFee;
}