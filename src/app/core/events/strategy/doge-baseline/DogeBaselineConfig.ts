import type { Coin } from '../../../../../market/coins.js';
import type { EventFrame } from '../../../../../market/frame.js';
import { PS_CHAINLINK_TWAP_60, type PriceSource } from '../../../../../market/price/price_source.js';

/** Strategy identity and names of files stored in its models directory. */
export const DOGE_BASELINE_STRATEGY = 'doge-baseline' as const;
export const DOGE_BASELINE_MODEL_DIRECTORY = DOGE_BASELINE_STRATEGY;
export const DOGE_BASELINE_MODEL_FILE = 'model.json';
export const DOGE_BASELINE_CONFIG_FILE = 'config.json';
export const DOGE_BASELINE_CANDIDATE_MODEL_FILE = 'candidate.json';
export const DOGE_BASELINE_LATEST_EVALUATION_FILE = 'latest-evaluation.json';
export const DOGE_BASELINE_REFRESH_LOCK_FILE = 'refresh.lock';
export type DogeBaselineArtifactFile =
    | typeof DOGE_BASELINE_MODEL_FILE
    | typeof DOGE_BASELINE_CONFIG_FILE
    | typeof DOGE_BASELINE_CANDIDATE_MODEL_FILE
    | typeof DOGE_BASELINE_LATEST_EVALUATION_FILE;

/** Published model schema version. */
export const DOGE_BASELINE_MODEL_VERSION = 1 as const;

/** Fixed market and price-source inputs for the DOGE strategy. */
export const DOGE_BASELINE_COIN = 'doge' satisfies Coin;
export const DOGE_BASELINE_FRAME = '5m' satisfies EventFrame;
export const DOGE_BASELINE_SOURCE = PS_CHAINLINK_TWAP_60 satisfies PriceSource;

/** Default live and replay account values, in USDC. */
export const DOGE_BASELINE_DEFAULT_BALANCE = 100;
export const DOGE_BASELINE_DEFAULT_TRADE_VALUE = 10;
/** Minimum expected net advantage over the selected token price, in USDC. */
export const DOGE_BASELINE_DEFAULT_MINIMUM_EDGE = 0.04;

/** L2 penalty that limits the size of logistic-regression weights during training. */
export const DOGE_BASELINE_L2 = 1;

/** Candidate-model quality and activity requirements during refresh evaluation. */
export const DOGE_BASELINE_CANDIDATE_MINIMUM_TRADE_COUNT = 5;
export const DOGE_BASELINE_CANDIDATE_MAXIMUM_TRADE_COUNT = 20;
/** Minimum proportion of replay frames that must contain trades, before the absolute cap. */
export const DOGE_BASELINE_CANDIDATE_MINIMUM_TRADE_RATIO = 0.1;
/** Maximum share by which a candidate may trail a profitable working model's net PnL. */
export const DOGE_BASELINE_CANDIDATE_MAXIMUM_PNL_UNDERPERFORMANCE_RATIO = 0.2;
/** Minimum directional accuracy required from each entry mode. */
export const DOGE_BASELINE_CANDIDATE_MINIMUM_ACCURACY = 0.55;
/** Strict upper bound for the Brier probability error of each entry mode. */
export const DOGE_BASELINE_CANDIDATE_MAXIMUM_BRIER_SCORE = 0.25;

/** Default number of completed frames used to compare working and candidate models. */
export const DOGE_BASELINE_DEFAULT_REPLAY_FRAME_COUNT = 100;
/** Snapshot interval in milliseconds used to bound configuration-research memory use. */
export const DOGE_BASELINE_CONFIG_RESEARCH_SNAPSHOT_INTERVAL_MS = 250;

/** Candidate entry advantages, in USDC, evaluated during configuration research. */
export const DOGE_BASELINE_MINIMUM_EDGE_VALUES = Object.freeze([0.02, 0.04, 0.06, 0.08, 0.10]);
/** Number of strongest entry configurations advanced to emergency-exit research. */
export const DOGE_BASELINE_CONFIG_FINALIST_COUNT = 3;

/** Default emergency-exit settings used until a published strategy config replaces them. */
/** Time before frame end, in milliseconds, when an emergency exit may begin. */
export const DOGE_BASELINE_EMERGENCY_EXIT_WINDOW_MS = 60_000;
/** Relative adverse DOGE move required to confirm an emergency exit. */
export const DOGE_BASELINE_EMERGENCY_EXIT_DEVIATION_FACTOR = 0.0005;
/** Required duration of the adverse move, in milliseconds. */
export const DOGE_BASELINE_EMERGENCY_EXIT_CONFIRMATION_MS = 5_000;
/** Minimum interval in milliseconds between repeated emergency-sale attempts. */
export const DOGE_BASELINE_EMERGENCY_EXIT_RETRY_MS = 1_000;
/** Emergency-exit windows, in milliseconds, evaluated during configuration research. */
export const DOGE_BASELINE_EMERGENCY_EXIT_WINDOWS_MS = Object.freeze([60_000, 90_000, 120_000]);
/** Relative emergency-exit deviations evaluated during configuration research. */
export const DOGE_BASELINE_EMERGENCY_EXIT_DEVIATION_FACTORS = Object.freeze([0.0001, 0.0002, 0.0003, 0.0005]);

/**
 * Shadow-scheduler settings. They only govern whether the next trading frame may start;
 * they do not change an already active position or its exit rules.
 */
/** Relative band around the frame-start price; movements inside it do not form a crossing side. */
export const DOGE_BASELINE_CROSSING_DEVIATION_FACTOR = 0.0005;
/** One crossing is allowed; the master scheduler pauses only from the second crossing onward. */
export const DOGE_BASELINE_MAX_CROSSINGS = 1;

/** Model entry modes: their decision offsets and historical price lookback windows, in milliseconds. */
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
