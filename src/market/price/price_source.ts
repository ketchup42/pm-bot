export interface PriceSourceConfig {
    /** Maximum observation age before collected history marks a price data gap. */
    maxAgeMs: number;
    /** Maximum wait for a frame price requested by live code. */
    framePriceReadTimeoutMs: number;
    /** Maximum wait for a source update used to capture a history frame boundary price. */
    framePriceCaptureTimeoutMs: number;
    /** Maximum silence before a watcher reconnects an apparently open stream. */
    staleReconnectMs: number;
    /** Delay before the first retry after a failed source connection. */
    reconnectInitialDelayMs: number;
    /** Maximum delay between repeated failed source connection attempts. */
    reconnectMaxDelayMs: number;
}

export const PS_BINANCE = 'binance' as const;
export const PS_CHAINLINK = 'chainlink' as const;
export const PS_CHAINLINK_TWAP_30 = 'chainlink-twap-30' as const;
export const PS_CHAINLINK_TWAP_60 = 'chainlink-twap-60' as const;

const DEFAULT_PRICE_SOURCE_CONFIG = {
    maxAgeMs: 5_000,
    framePriceReadTimeoutMs: 5_000,
    framePriceCaptureTimeoutMs: 20_000,
    staleReconnectMs: 10_000,
    reconnectInitialDelayMs: 1_000,
    reconnectMaxDelayMs: 30_000,
} as const satisfies PriceSourceConfig;

/** Canonical registry of price sources and their collection characteristics. */
export const PRICE_SOURCE_CONFIGS = {
    [PS_BINANCE]: { ...DEFAULT_PRICE_SOURCE_CONFIG },
    [PS_CHAINLINK]: { ...DEFAULT_PRICE_SOURCE_CONFIG },
    [PS_CHAINLINK_TWAP_30]: { ...DEFAULT_PRICE_SOURCE_CONFIG },
    [PS_CHAINLINK_TWAP_60]: { ...DEFAULT_PRICE_SOURCE_CONFIG },
} as const satisfies Record<string, PriceSourceConfig>;

export type PriceSource = keyof typeof PRICE_SOURCE_CONFIGS;

export const SUPPORTED_PRICE_SOURCES: readonly PriceSource[] = Object.freeze(
    Object.keys(PRICE_SOURCE_CONFIGS) as PriceSource[],
);

export function getSupportedPriceSources(): readonly PriceSource[] {
    return SUPPORTED_PRICE_SOURCES;
}

export function getPriceSourceConfig(source: PriceSource): Readonly<PriceSourceConfig> {
    return PRICE_SOURCE_CONFIGS[source];
}

export function getPriceSourceReconnectDelayMs(source: PriceSource, failedAttempt: number): number {
    const config = getPriceSourceConfig(source);
    const exponent = Math.max(0, failedAttempt - 1);
    return Math.min(config.reconnectInitialDelayMs * 2 ** exponent, config.reconnectMaxDelayMs);
}

export function isPriceSource(value: string): value is PriceSource {
    return Object.prototype.hasOwnProperty.call(PRICE_SOURCE_CONFIGS, value);
}

export function isTwapPriceSource(source: PriceSource): boolean {
    return source === PS_CHAINLINK_TWAP_30 || source === PS_CHAINLINK_TWAP_60;
}

export function getPriceSourceSymbol(coin: Coin, source: PriceSource): string {
    return source === PS_BINANCE ? `${coin}usdt` : `${coin}/usd`;
}
import { Coin } from '../coins.js';
