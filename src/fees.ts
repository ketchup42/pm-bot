import { ClobClient } from "@polymarket/clob-client";

/**
 * Fetches the current taker fee rate in basis points for a specific token.
 * @param tokenId - The token's unique identifier.
 * @param client - An initialized Polymarket ClobClient instance.
 * @returns The fee rate in basis points (e.g., 30 for 0.30%).
 */
export async function getTakerFeeBps(tokenId: string, client: ClobClient): Promise<number> {
    // It returns the current fee in basis points for a given token.
    const feeResponse = await client.getFeeRateBps(tokenId);
    return feeResponse;
}

/**
 * Calculates the taker fee for a Polymarket order.
 * @param sharesCount - Number of shares being traded.
 * @param price - The price per share (e.g., 0.65 for 65 cents).
 * @param feeRateBps - Fee rate in basis points.
 * @returns The fee amount in USDC.
 */
export function calculateTakerFee(sharesCount: number, price: number, feeRateBps: number): number {
    // The official documentation states the formula is:
    // fee = C × p × feeRate × (p × (1 - p))^exponent
    // Where feeRate is the taker fee rate.
    const feeRateDecimal = feeRateBps / 10000; // Convert basis points (e.g., 30 -> 0.0030)
    // Using an exponent of 1 for now, as it's the most common.
    const exponent = 1;
    const fee = sharesCount * price * feeRateDecimal * Math.pow(price * (1 - price), exponent);
    return fee;
}

