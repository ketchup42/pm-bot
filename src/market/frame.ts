import { safeToNum } from "../utils.js";
import { Coin } from "./coins.js";

export interface EventFrameConfig {
    durationMs: number;
    durationSec: number;
}

/** Canonical registry of event frames supported by the application. */
export const FRAME_CONFIGS = {
    '5m': { durationMs: 300_000, durationSec: 300 },
    '15m': { durationMs: 900_000, durationSec: 900 },
} as const satisfies Record<string, EventFrameConfig>;

export type EventFrame = keyof typeof FRAME_CONFIGS;

export const SUPPORTED_FRAMES: readonly EventFrame[] = Object.freeze(
    Object.keys(FRAME_CONFIGS) as EventFrame[],
);

export const FRAME_5M_MS = FRAME_CONFIGS['5m'].durationMs;
export const FRAME_15M_MS = FRAME_CONFIGS['15m'].durationMs;
export const FRAME_5M_SEC = FRAME_CONFIGS['5m'].durationSec;
export const FRAME_15M_SEC = FRAME_CONFIGS['15m'].durationSec;

/**
 * Returns the list of all supported event frame types.
 * @returns A read‑only array of available {@link EventFrame} values.
 */
export function getSupportedFrames(): readonly EventFrame[] {
    return SUPPORTED_FRAMES;
}

export function isEventFrame(value: string): value is EventFrame {
    return Object.prototype.hasOwnProperty.call(FRAME_CONFIGS, value);
}

/**
 * Waits until the exact start of the next time interval (based on current time)
 * @param frame - Interval type (default: 300_000 ms = 5 minutes)
 */
export async function waitFrameStart(frame: EventFrame = '5m'): Promise<void> {
    await waitFrameStartMs(getFrameDurationMs(frame));
}

/**
 * Waits until the exact start of the next time interval (based on current time)
 * @param intervalMs - Interval length in milliseconds (e.g., 300_000 for 5 minutes)
 */
export async function waitFrameStartMs(intervalMs: number): Promise<void> {
    const nowMs = Date.now();
    const remainder = nowMs % intervalMs;
    const waitMs = (remainder === 0) ? 0 : intervalMs - remainder;
    return new Promise(resolve => setTimeout(resolve, waitMs));
}

/** Waits for a frame boundary while allowing the caller to cancel the wait. */
export async function waitFrameStartMsUntil(intervalMs: number, shouldStop: () => boolean): Promise<void> {
    const nowMs = Date.now();
    const remainder = nowMs % intervalMs;
    const targetTimeMs = nowMs + (remainder === 0 ? 0 : intervalMs - remainder);
    while (!shouldStop()) {
        const remainingMs = targetTimeMs - Date.now();
        if (remainingMs <= 0) return;
        await new Promise(resolve => setTimeout(resolve, Math.min(remainingMs, 1_000)));
    }
}

/**
 * Generates the deterministic slug for any coin's market.
 * @param coin - The coin identifier (e.g., 'btc', 'doge', 'eth', 'sol')
 * @returns Market slug like "doge-updown-5m-1742227200"
 */
export function getCoinSlug(coin: Coin, frame: EventFrame = '5m'): string {
    return `${coin}-updown-${frame}-${getCurrentFrameStart(frame)}`;
}

export function getFrameCloseTimebySlug(slug: string, frame: EventFrame = '5m'): number {
    const start = safeToNum(slug.split('-').pop() || '0', 10);
    return start + getFrameDuration(frame);
}

/**
 * Calculates the value of UTC timestamp for events
 * @returns UTC interval start value in seconds
 */
export function getCurrentFrameStart(frame: EventFrame = '5m'): number {
    const now = Math.floor(Date.now() / 1000);
    const duration = getFrameDuration(frame);
    return now - (now % duration);
}

/**
 * Returns the duration of the given frame type in seconds.
 * @param frame - The frame type ('5m' or '15m')
 * @returns Duration in seconds (300 for '5m', 900 for '15m')
 */
export function getFrameDuration(frame: EventFrame): number {
    return FRAME_CONFIGS[frame].durationSec;
}

/**
 * Returns the duration of the given frame type in ms.
 * @param frame - The frame type ('5m' or '15m')
 * @returns Duration in ms (300_000 for '5m', 900_000 for '15m')
 */
export function getFrameDurationMs(frame: EventFrame): number {
    return FRAME_CONFIGS[frame].durationMs;
}

/**
 * Generates the deterministic slug for any coin's 5-minute market.
 * @param coin - The coin identifier (e.g., 'btc', 'doge', 'eth', 'sol')
 * @returns Market slug like "doge-updown-5m-1742227200"
 */
export function getCoin5mSlug(coin: Coin): string {
    return getCoinSlug(coin, '5m');
}

export function get5mFrameCloseTimebySlug(slug: string): number {
    return getFrameCloseTimebySlug(slug, '5m');
}

/**
 * Calculates the value of UTC timestamp for 5m events
 * @returns UTC 5m interval start value
 */
export function getCurrent5mFrameStart(): number {
  return getCurrentFrameStart('5m');
}

/**
 * Generates the deterministic slug for any coin's 15‑minute market.
 * @param coin - The coin identifier (e.g., 'btc', 'doge', 'eth', 'sol')
 * @returns Market slug like "doge-updown-15m-1742227200"
 */
export function getCoin15mSlug(coin: Coin): string {
    return getCoinSlug(coin, '15m');
}

/**
 * Returns the closing timestamp of a 15‑minute market frame.
 * @param slug - The market slug (e.g., "doge-updown-15m-1742227200")
 * @returns The UTC timestamp when the frame closes (start + 900 seconds)
 */
export function get15mFrameCloseTimebySlug(slug: string): number {
    return getFrameCloseTimebySlug(slug, '15m');
}

/**
 * Calculates the current UTC start timestamp of the 15‑minute interval.
 * @returns The start of the current 15‑minute frame in seconds since epoch.
 */
export function getCurrent15mFrameStart(): number {
    return getCurrentFrameStart('15m');
}
