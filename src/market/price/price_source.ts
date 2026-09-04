export interface PriceSourceConfig {
    /** Maximum observation age before collected history marks a price data gap. */
    maxAgeMs: number;
    /** Maximum wait for a frame price requested by live code. */
    framePriceReadTimeoutMs: number;
    /** Maximum wait for a source update used to capture a history frame boundary price. */
    framePriceCaptureTimeoutMs: number;
    /** Maximum silence before a watcher reconnects an apparently open stream. */
    staleReconnectMs: number;
}

export const PS_BINANCE = 'binance' as const;
export const PS_CHAINLINK = 'chainlink' as const;
export const PS_CHAINLINK_TWAP_30 = 'chainlink-twap-30' as const;
export const PS_CHAINLINK_TWAP_60 = 'chainlink-twap-60' as const;

const DEFAULT_PRICE_SOURCE_CONFIG = {
    maxAgeMs: 5_000,
    framePriceReadTimeoutMs: 5_000,
    framePriceCaptureTimeoutMs: 20_000,
    staleReconnectMs: 25_000,
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

export function isPriceSource(value: string): value is PriceSource {
    return Object.prototype.hasOwnProperty.call(PRICE_SOURCE_CONFIGS, value);
}
