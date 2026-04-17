import { PriceWatcher } from "./PriceWatcher.js";

/**
 * Waits until the start of the current or next time interval, then returns the current price.
 * 
 * - If called **exactly** on a boundary (remainder === 0), resolves immediately.
 * - Otherwise, waits until the next boundary.
 * 
 * @param priceWatcher - Price watcher instance
 * @param intervalMs - Interval length in milliseconds (default: 300_000 ms = 5 minutes)
 * @returns Promise resolving to the current price (or undefined if not available)
 */
export async function waitForStartPrice(priceWatcher: PriceWatcher, intervalMs: number = 300_000): Promise<number | undefined> {
    const nowMs = Date.now();
    const remainder = nowMs % intervalMs;
    const waitMs = (remainder === 0) ? 0 : intervalMs - remainder;
    
    // If you want to wait until the next frame starts perfectly, uncomment:
    //
    // let waitMs: number;
    // if (remainder === 0) {
    //    // Exactly on a boundary – wait a full interval
    //    waitMs = intervalMs;
    // } else {
    //    // Wait until the next boundary
    //    waitMs = intervalMs - remainder;
    // }

    return new Promise((resolve) => {
        setTimeout(() => {
            resolve(priceWatcher.getCurrentPrice());
        }, waitMs);
    });
}