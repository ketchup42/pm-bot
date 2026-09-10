import { Coin } from '../../../../../market/coins.js';
import { EventFrame } from '../../../../../market/frame.js';
import { PriceSource, PS_CHAINLINK_TWAP_60 } from '../../../../../market/price/price_source.js';

export const DOGE_BASELINE_STRATEGY = 'doge-baseline' as const;
export const DOGE_BASELINE_MODEL_DIRECTORY = DOGE_BASELINE_STRATEGY;
export const DOGE_BASELINE_MODEL_FILE = 'model.json';
export const DOGE_BASELINE_REFRESH_LOCK_FILE = 'refresh.lock';
export const DOGE_BASELINE_MODEL_VERSION = 1 as const;
export const DOGE_BASELINE_DEFAULT_DEBUG = true;
export const DOGE_BASELINE_COIN: Coin = 'doge';
export const DOGE_BASELINE_FRAME: EventFrame = '5m';
export const DOGE_BASELINE_SOURCE: PriceSource = PS_CHAINLINK_TWAP_60;
export const DOGE_BASELINE_L2 = 1;
export const DOGE_BASELINE_MINIMUM_EDGE = 0.02;
export const DOGE_BASELINE_INITIAL_BALANCE = 100;
export const DOGE_BASELINE_MAX_ORDER_VALUE = 10;
export const DOGE_BASELINE_EMERGENCY_EXIT_WINDOW_MS = 30_000;
export const DOGE_BASELINE_EMERGENCY_EXIT_DEVIATION_FACTOR = 0.0001;
export const DOGE_BASELINE_EMERGENCY_EXIT_CONFIRMATION_MS = 5_000;
export const DOGE_BASELINE_CROSSING_DEVIATION_FACTOR = 0.005;
export const DOGE_BASELINE_MAX_CROSSINGS = 0;

export const DOGE_BASELINE_MODES = Object.freeze([
    { name: 'early-60', offsetMs: 60_000, lookbacksMs: Object.freeze([15_000, 30_000, 60_000]) },
    { name: 'late-120', offsetMs: 120_000, lookbacksMs: Object.freeze([75_000, 90_000, 120_000]) },
] as const);

export type DogeBaselineModeName = typeof DOGE_BASELINE_MODES[number]['name'];
