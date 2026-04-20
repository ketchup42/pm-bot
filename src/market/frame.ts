import { safeToNum } from "../utils.js";
import { Coin } from "./coins.js";

/* 
 * Set of supported frame types
 */
export type EventFrame = '5m' | '15m';

export const FRAME_5M_MS = 300_000;
export const FRAME_15M_MS = 900_000;

export const FRAME_5M_SEC = 300;
export const FRAME_15M_SEC = 900;

/**
 * Waits until the exact start of the next time interval (based on current time)
 * 
 * @param frame - Interval type (default: 300_000 ms = 5 minutes)
 */
export async function waitFrameStart(frame: EventFrame = '5m'): Promise<void> {
    const intervalMs = frame === '5m'? FRAME_5M_MS: FRAME_15M_MS;
    await waitFrameStartMs(intervalMs);
}

/**
 * Waits until the exact start of the next time interval (based on current time)
 * 
 * @param intervalMs - Interval length in milliseconds (e.g., 300_000 for 5 minutes)
 */
export async function waitFrameStartMs(intervalMs: number): Promise<void> {
    const nowMs = Date.now();
    const remainder = nowMs % intervalMs;
    const waitMs = (remainder === 0) ? 0 : intervalMs - remainder;

    return new Promise(resolve => setTimeout(resolve, waitMs));
}

/**
 * Generates the deterministic slug for any coin's market.
 * @param coin - The coin identifier (e.g., 'btc', 'doge', 'eth', 'sol')
 * @returns Market slug like "doge-updown-5m-1742227200"
 */
export function getCoinSlug(coin: Coin, frame: EventFrame = '5m'): string {
    return (frame === '5m')? getCoin5mSlug(coin): getCoin15mSlug(coin);
}

// Optional: Add validation or a function to get the window's close time
export function getFrameCloseTimebySlug(slug: string, frame: EventFrame = '5m'): number {
    return (frame === '5m')? get5mFrameCloseTimebySlug(slug): get15mFrameCloseTimebySlug(slug);
}

/**
 * Calculates the value of UTC timestamp for events
 * @returns UTC interval start value
 */
export function getCurrentFrameStart(frame: EventFrame = '5m'): number {
    return (frame === '5m')? getCurrent5mFrameStart(): getCurrent15mFrameStart();
}

/**
 * Returns the duration of the given frame type in seconds.
 * @param frame - The frame type ('5m' or '15m')
 * @returns Duration in seconds (300 for '5m', 900 for '15m')
 */
export function getFrameDuration(frame: EventFrame): number {
    return frame === '5m' ? FRAME_5M_SEC : FRAME_15M_SEC;
}

/**
 * Returns the duration of the given frame type in ms.
 * @param frame - The frame type ('5m' or '15m')
 * @returns Duration in ms (300_000 for '5m', 900_000 for '15m')
 */
export function getFrameDurationMs(frame: EventFrame): number {
    return frame === '5m' ? FRAME_5M_MS : FRAME_15M_MS;
}

/**
 * Generates the deterministic slug for any coin's 5-minute market.
 * @param coin - The coin identifier (e.g., 'btc', 'doge', 'eth', 'sol')
 * @returns Market slug like "doge-updown-5m-1742227200"
 */
export function getCoin5mSlug(coin: Coin): string {
    const nowInSeconds = Math.floor(Date.now() / 1000);
    const windowStartTimestamp = nowInSeconds - (nowInSeconds % FRAME_5M_SEC);
    return `${coin}-updown-5m-${windowStartTimestamp}`;
}

// Optional: Add validation or a function to get the window's close time
export function get5mFrameCloseTimebySlug(slug: string): number {
    const timestamp = safeToNum(slug.split('-').pop() || '0', 10);
    return timestamp + FRAME_5M_SEC; // Window closes 5 minutes later
}

/**
 * Calculates the value of UTC timestamp for 5m events
 * @returns UTC 5m interval start value
 */
export function getCurrent5mFrameStart(): number {
  const now = Math.floor(Date.now() / 1000); // seconds UTC
  return now - (now % FRAME_5M_SEC); // 300 seconds = 5 m
}

/**
 * Generates the deterministic slug for any coin's 15‑minute market.
 * @param coin - The coin identifier (e.g., 'btc', 'doge', 'eth', 'sol')
 * @returns Market slug like "doge-updown-15m-1742227200"
 */
export function getCoin15mSlug(coin: Coin): string {
    const nowInSeconds = Math.floor(Date.now() / 1000);
    const windowStartTimestamp = nowInSeconds - (nowInSeconds % FRAME_15M_SEC);
    return `${coin}-updown-15m-${windowStartTimestamp}`;
}

/**
 * Returns the closing timestamp of a 15‑minute market window.
 * @param slug - The market slug (e.g., "doge-updown-15m-1742227200")
 * @returns The UTC timestamp when the window closes (start + 900 seconds)
 */
export function get15mFrameCloseTimebySlug(slug: string): number {
    const timestamp = safeToNum(slug.split('-').pop() || '0', 10);
    return timestamp + FRAME_15M_SEC;
}

/**
 * Calculates the current UTC start timestamp of the 15‑minute interval.
 * @returns The start of the current 15‑minute window in seconds since epoch.
 */
export function getCurrent15mFrameStart(): number {
    const now = Math.floor(Date.now() / 1000);
    return now - (now % FRAME_15M_SEC);
}