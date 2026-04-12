import { PriceWatcher } from "./PriceWatcher";

/**
 * Waits for the start of the next fixed‑time interval (e.g., every 300 seconds) and captures the starting price.
 *
 * @description
 * This function calculates the time remaining until the next boundary of the specified interval (in seconds),
 * waits until that exact moment, and then resolves with the current price from the WebSocket feed.
 *
 * This is useful for trading strategies that depend on price changes over regular time windows
 * (e.g., Polymarket 5‑minute "Up/Down" markets).
 *
 * @param priceWatcher - An instance of `IPriceWatcher` that can provide the current price.
 * @param intervalSeconds - Interval length in seconds (default: 300 for 5 minutes).
 * @returns Promise<number> - Resolves with the numeric starting price at the interval boundary.
 *
 * @example
 * // Wait for the next 5‑minute boundary (default)
 * const startPrice = await waitForStartPrice(priceWatcher);
 *
 * @example
 * // Wait for the next 1‑hour boundary (3600 seconds)
 * const hourlyStart = await waitForStartPrice(priceWatcher, 3600);
 */
export async function waitForStartPrice(
    priceWatcher: PriceWatcher,
    intervalSeconds: number = 300
): Promise<number> {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const secondsUntilNext = intervalSeconds - (nowSeconds % intervalSeconds);
    // If we are exactly on a boundary (remainder 0), wait a full interval
    const waitSeconds = secondsUntilNext === 0 ? intervalSeconds : secondsUntilNext;

    return new Promise((resolve) => {
        setTimeout(() => {
            resolve(priceWatcher.getCurrentPrice());
        }, waitSeconds * 1000);
    });
}