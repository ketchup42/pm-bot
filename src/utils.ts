import fs from 'fs/promises';
import path from 'path';

/**
 * Delay (sleep)
 * @param ms - milliseconds
 * @returns Promise that resolves after specified time
 */
export const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retry an async function with exponential backoff
 * @param fn - async function to retry
 * @param maxAttempts - maximum number of attempts (default 3)
 * @param baseDelayMs - base delay between attempts in ms (default 100)
 * @returns result of fn
 * @throws last error after all attempts fail
 */
export async function retry<T>(
  fn: () => Promise<T>,
  maxAttempts: number = 3,
  baseDelayMs: number = 100
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === maxAttempts) break;
      const waitTime = baseDelayMs * Math.pow(2, attempt - 1);
      await delay(waitTime);
    }
  }
  throw lastError;
}

/**
 * Format number with fixed decimal places
 * @param value - number
 * @param decimals - number of decimal places (default 2)
 * @returns formatted string
 */
export const formatNumber = (value: number, decimals: number = 2): string =>
  value.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });

/**
 * Convert Polymarket price (probability) to percentage
 * @param price - price in range [0, 1]
 * @returns percentage string (e.g., "65.00%")
 */
export const priceToPercent = (price: number): string =>
  `${(price * 100).toFixed(2)}%`;

/**
 * Round number to specified decimal places (avoid floating point issues)
 * @param value - number or undefined
 * @param decimals - decimal places (default 6)
 * @returns rounded number
 */
export const roundTo = (value: number | undefined, decimals: number = 6): number | undefined => {
  if (!value) return undefined;
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
};

/**
 * Validate Ethereum address (simple check: starts with 0x and length 42)
 * @param address - potential address
 * @returns true if address is valid
 */
export const isValidEthereumAddress = (address: string): boolean =>
  /^0x[a-fA-F0-9]{40}$/.test(address);

/**
 * Safely converts a value to number with fallback.
 * @param value - string, number, or undefined
 * @param fallback - default 0
 * @returns number or fallback if conversion fails
 */
export function safeToNum(value: unknown, fallback: number = 0): number {
    if (value === undefined || value === null) return fallback;
    if (typeof value === 'number') return isNaN(value) || !isFinite(value) ? fallback : value;
    if (typeof value === 'string' && value.trim() === '') return fallback;
    if (typeof value === 'object') return fallback;
    if (typeof value === 'symbol') return fallback;
    const converted = Number(value); // Stricter than parseFloat
    return isNaN(converted) ? fallback : converted;
}

export function safeFloat(value: number, digits: number): number {
    return safeToNum(value.toFixed(digits));
}

/**
 * Checks if a value is valid (not null, not undefined, and not NaN if a number).
 * Works with any type: numbers, strings, objects, arrays, etc.
 *
 * @param value - The value to check.
 * @returns `true` if the value is valid, otherwise `false`.
 */
export function isValid(value: unknown): boolean {
    if (value === null || value === undefined) return false;
    if (typeof value === 'number') return !isNaN(value) && isFinite(value);
    return true;
}

/**
 * Get current timestamp in ISO format (UTC)
 * @returns string like "2025-04-04T12:34:56.789Z"
 */
export const getISOTimestamp = (): string => new Date().toISOString();

/**
 * Converts an ISO 8601 timestamp string to milliseconds since Unix epoch.
 * @param isoString - ISO timestamp (e.g., "2025-04-05T12:34:56.789Z")
 * @returns Milliseconds since 1970-01-01T00:00:00.000Z
 * @throws Error if the input string is invalid.
 */
export function isoToMs(isoString: string): number {
    const ms = Date.parse(isoString);
    if (isNaN(ms)) {
        throw new Error(`Invalid ISO timestamp: ${isoString}`);
    }
    return ms;
}

/**
 * Converts an ISO 8601 timestamp string to seconds since Unix epoch (floored).
 * @param isoString - ISO timestamp
 * @returns Seconds since 1970-01-01T00:00:00.000Z (integer)
 */
export function isoToSeconds(isoString: string): number {
    return Math.floor(isoToMs(isoString) / 1000);
}

/**
 * Converts an unknown error value to a string for safe logging.
 * Handles Error objects, strings, numbers, and other types.
 */
export function error_str(error: unknown): string {
    if (error instanceof Error) {
        // Include stack trace if available, otherwise just message
        return error.stack || error.message;
    }
    if (typeof error === 'string') {
        return error;
    }
    try {
        return JSON.stringify(error);
    } catch {
        return String(error);
    }
}

/**
 * Writes a string to a file, creating parent directories if they don't exist.
 * @param filePath - Path to the destination file.
 * @param content - String content to write.
 * @param options - Optional write options (encoding, flag, mode).
 * @throws If directory creation or file writing fails.
 */
export async function fileWrite(
    filePath: string,
    content: string,
    options?: { encoding?: BufferEncoding; flag?: string; mode?: number }
): Promise<void> {
    try {
        const dir = path.dirname(filePath);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(filePath, content, options);
    } catch (error) {
        throw new Error(`Failed to write to ${filePath}: ${error}`);
    }
}

export type UnsubscribeHook = () => void;
/**
 * Registers an async callback to be executed on SIGINT or SIGTERM signals.
 * 
 * @param callback - Async function to run when a shutdown signal is received.
 */
export function killSignalsHook(callback: () => Promise<void>): UnsubscribeHook {
    const handler = async () => {
        await callback();
    };

    process.on('SIGINT', handler);
    process.on('SIGTERM', handler); 

    return () => {
        process.off('SIGINT', handler);
        process.off('SIGTERM', handler);
    };
}