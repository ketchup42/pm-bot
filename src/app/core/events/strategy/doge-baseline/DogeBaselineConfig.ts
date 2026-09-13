import type { Coin } from '../../../../../market/coins.js';
import type { EventFrame } from '../../../../../market/frame.js';
import { PS_CHAINLINK_TWAP_60, type PriceSource } from '../../../../../market/price/price_source.js';

export const DOGE_BASELINE_STRATEGY = 'doge-baseline' as const;
export const DOGE_BASELINE_MODEL_DIRECTORY = DOGE_BASELINE_STRATEGY;
export const DOGE_BASELINE_MODEL_FILE = 'model.json';
export const DOGE_BASELINE_CONFIG_FILE = 'config.json';
export const DOGE_BASELINE_CANDIDATE_MODEL_FILE = 'candidate.json';
export const DOGE_BASELINE_LATEST_EVALUATION_FILE = 'latest-evaluation.json';
export type DogeBaselineArtifactFile =
    | typeof DOGE_BASELINE_MODEL_FILE
    | typeof DOGE_BASELINE_CONFIG_FILE
    | typeof DOGE_BASELINE_CANDIDATE_MODEL_FILE
    | typeof DOGE_BASELINE_LATEST_EVALUATION_FILE;
export const DOGE_BASELINE_REFRESH_LOCK_FILE = 'refresh.lock';
export const DOGE_BASELINE_MODEL_VERSION = 1 as const;
export const DOGE_BASELINE_COIN = 'doge' satisfies Coin;
export const DOGE_BASELINE_FRAME = '5m' satisfies EventFrame;
export const DOGE_BASELINE_SOURCE = PS_CHAINLINK_TWAP_60 satisfies PriceSource;
export const DOGE_BASELINE_L2 = 1;
export const DOGE_BASELINE_DEFAULT_MINIMUM_EDGE = 0.04;
export const DOGE_BASELINE_DEFAULT_BALANCE = 100;
export const DOGE_BASELINE_DEFAULT_TRADE_VALUE = 10;
export const DOGE_BASELINE_CANDIDATE_MINIMUM_TRADE_COUNT = 5;
export const DOGE_BASELINE_CANDIDATE_MAXIMUM_TRADE_COUNT = 20;
export const DOGE_BASELINE_CANDIDATE_MINIMUM_TRADE_RATIO = 0.1;
export const DOGE_BASELINE_CANDIDATE_MAXIMUM_PNL_UNDERPERFORMANCE_RATIO = 0.2;
export const DOGE_BASELINE_CANDIDATE_MINIMUM_ACCURACY = 0.55;
export const DOGE_BASELINE_CANDIDATE_MAXIMUM_BRIER_SCORE = 0.25;
export const DOGE_BASELINE_DEFAULT_REPLAY_FRAME_COUNT = 100;
/** Keeps configuration research within a bounded heap while retaining sub-second execution detail. */
export const DOGE_BASELINE_CONFIG_RESEARCH_SNAPSHOT_INTERVAL_MS = 250;
export const DOGE_BASELINE_EMERGENCY_EXIT_WINDOW_MS = 60_000;
export const DOGE_BASELINE_EMERGENCY_EXIT_DEVIATION_FACTOR = 0.0005;
export const DOGE_BASELINE_EMERGENCY_EXIT_CONFIRMATION_MS = 5_000;
export const DOGE_BASELINE_EMERGENCY_EXIT_RETRY_MS = 1_000;
export const DOGE_BASELINE_EMERGENCY_EXIT_WINDOWS_MS = Object.freeze([60_000, 90_000, 120_000]);
export const DOGE_BASELINE_EMERGENCY_EXIT_DEVIATION_FACTORS = Object.freeze([0.0001, 0.0002, 0.0003, 0.0005]);
export const DOGE_BASELINE_MINIMUM_EDGE_VALUES = Object.freeze([0.02, 0.04, 0.06, 0.08, 0.10]);
export const DOGE_BASELINE_CONFIG_FINALIST_COUNT = 3;
export const DOGE_BASELINE_CROSSING_DEVIATION_FACTOR = 0.0005;
export const DOGE_BASELINE_MAX_CROSSINGS = 0;

export const DOGE_BASELINE_MODES = Object.freeze([
    { name: 'early-60', offsetMs: 60_000, lookbacksMs: Object.freeze([15_000, 30_000, 60_000]) },
    { name: 'late-120', offsetMs: 120_000, lookbacksMs: Object.freeze([75_000, 90_000, 120_000]) },
] as const);

export type DogeBaselineModeName = typeof DOGE_BASELINE_MODES[number]['name'];

export function isDogeBaselineModeName(value: string): value is DogeBaselineModeName {
    return DOGE_BASELINE_MODES.some(mode => mode.name === value);
}

export interface DogeBaselineEntryModeSettings {
    enabled: boolean;
    minimumEdge: number;
}

export interface DogeBaselineEntrySettings {
    modes: Record<DogeBaselineModeName, DogeBaselineEntryModeSettings>;
}

export function createDogeBaselineEntrySettings(
    enabledModes: readonly DogeBaselineModeName[] = DOGE_BASELINE_MODES.map(mode => mode.name),
    minimumEdges: Partial<Record<DogeBaselineModeName, number>> = {},
): DogeBaselineEntrySettings {
    return {
        modes: Object.fromEntries(DOGE_BASELINE_MODES.map(mode => [mode.name, {
            enabled: enabledModes.includes(mode.name),
            minimumEdge: minimumEdges[mode.name] ?? DOGE_BASELINE_DEFAULT_MINIMUM_EDGE,
        }])) as Record<DogeBaselineModeName, DogeBaselineEntryModeSettings>,
    };
}

export function getDogeBaselineEntrySummary(entry: Readonly<DogeBaselineEntrySettings>): string {
    return DOGE_BASELINE_MODES
        .filter(mode => entry.modes[mode.name].enabled)
        .map(mode => `${mode.name}=${entry.modes[mode.name].minimumEdge.toFixed(2)}`)
        .join(',');
}
