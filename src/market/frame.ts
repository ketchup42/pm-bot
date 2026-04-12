import { safeToNum } from "../utils.js";
import { Coin } from "./coins.js";

/**
 * Generates the deterministic slug for any coin's 5-minute market.
 * @param coin - The coin identifier (e.g., 'btc', 'doge', 'eth', 'sol')
 * @returns Market slug like "doge-updown-5m-1742227200"
 */
export function getCoin5mSlug(coin: Coin): string {
    const nowInSeconds = Math.floor(Date.now() / 1000);
    const windowStartTimestamp = nowInSeconds - (nowInSeconds % 300);
    return `${coin}-updown-5m-${windowStartTimestamp}`;
}

// Optional: Add validation or a function to get the window's close time
export function get5mFrameCloseTimebySlug(slug: string): number {
    const timestamp = safeToNum(slug.split('-').pop() || '0', 10);
    return timestamp + 300; // Window closes 5 minutes later
}

/**
 * Calculates the value of UTC timestamp for 5m events
 * @returns UTC 5m interval start value
 */
export function getCurrent5mIntervalStart(): number {
  const now = Math.floor(Date.now() / 1000); // seconds UTC
  return now - (now % 300); // 300 seconds = 5 m
}

/**
 * Generates the deterministic slug for any coin's 15‑minute market.
 * @param coin - The coin identifier (e.g., 'btc', 'doge', 'eth', 'sol')
 * @returns Market slug like "doge-updown-15m-1742227200"
 */
export function getCoin15mSlug(coin: Coin): string {
    const nowInSeconds = Math.floor(Date.now() / 1000);
    const windowStartTimestamp = nowInSeconds - (nowInSeconds % 900);
    return `${coin}-updown-15m-${windowStartTimestamp}`;
}

/**
 * Returns the closing timestamp of a 15‑minute market window.
 * @param slug - The market slug (e.g., "doge-updown-15m-1742227200")
 * @returns The UTC timestamp when the window closes (start + 900 seconds)
 */
export function get15mFrameCloseTimebySlug(slug: string): number {
    const timestamp = safeToNum(slug.split('-').pop() || '0', 10);
    return timestamp + 900;
}

/**
 * Calculates the current UTC start timestamp of the 15‑minute interval.
 * @returns The start of the current 15‑minute window in seconds since epoch.
 */
export function getCurrent15mIntervalStart(): number {
    const now = Math.floor(Date.now() / 1000);
    return now - (now % 900);
}