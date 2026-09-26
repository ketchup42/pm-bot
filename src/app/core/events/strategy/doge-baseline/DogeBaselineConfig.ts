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
/** Minimum probability assigned to the predicted token side. */
export const DOGE_BASELINE_DEFAULT_MINIMUM_CONFIDENCE = 0.5;
/** Minimum absolute DOGE movement from frame start, in basis points. */
export const DOGE_BASELINE_DEFAULT_MINIMUM_ABSOLUTE_DEVIATION_BPS = 0;

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

/** Smallest chronological replay-validation segment, except for a shorter whole replay. */
export const DOGE_BASELINE_REPLAY_SEGMENT_MINIMUM_FRAME_COUNT = 25;
/** Largest chronological replay-validation segment. */
export const DOGE_BASELINE_REPLAY_SEGMENT_MAXIMUM_FRAME_COUNT = 50;
/** Smallest number of segments for a normal replay-validation window. */
export const DOGE_BASELINE_REPLAY_SEGMENT_MINIMUM_COUNT = 4;
/** Required profitable-segment share before the replay has four full 50-frame segments. */
export const DOGE_BASELINE_REPLAY_SEGMENT_INITIAL_MINIMUM_PROFITABLE_RATIO = 0.5;
/** Required profitable-segment share once the replay has at least eight full 50-frame segments. */
export const DOGE_BASELINE_REPLAY_SEGMENT_MAXIMUM_MINIMUM_PROFITABLE_RATIO = 0.75;
/** Number of full 50-frame segments at which the profitable-segment requirement reaches its maximum. */
export const DOGE_BASELINE_REPLAY_SEGMENT_MAXIMUM_RATIO_FULL_SEGMENT_COUNT = 8;
/** Minimum trade activity required inside one replay-validation segment. */
export const DOGE_BASELINE_REPLAY_SEGMENT_MINIMUM_TRADE_COUNT = 2;
/** Minimum share of a segment that must contain trades. */
export const DOGE_BASELINE_REPLAY_SEGMENT_MINIMUM_TRADE_RATIO = 0.1;

/** Default number of completed frames used to compare working and candidate models. */
export const DOGE_BASELINE_DEFAULT_REPLAY_FRAME_COUNT = 100;
/** Theoretical CLOB request-and-match delay used by DOGE replay and refresh, in milliseconds. */
export const DOGE_BASELINE_DEFAULT_REPLAY_LATENCY_MS = 250;
/** Default selected replay net PnL per frame required to allow new live entries. */
export const DOGE_BASELINE_DEFAULT_MINIMUM_TRADING_NET_PNL_PER_REPLAY_FRAME = 0.5;
/** Default selected replay net-PnL change per frame considered a trading-regime trend. */
export const DOGE_BASELINE_DEFAULT_TRADING_NET_PNL_TREND_PER_REPLAY_FRAME = 0.1;
/** Default number of consecutive significant PnL rises required to resume trading. */
export const DOGE_BASELINE_DEFAULT_MINIMUM_CONSECUTIVE_RISES = 2;
/** Candidate regime thresholds evaluated by walk-forward research, in USDC per replay frame. */
export const DOGE_BASELINE_MINIMUM_TRADING_NET_PNL_PER_REPLAY_FRAME_VALUES = Object.freeze([0.3, 0.4, 0.5]);
/** Candidate significant PnL trend steps evaluated by walk-forward research, in USDC per replay frame. */
export const DOGE_BASELINE_TRADING_NET_PNL_TREND_PER_REPLAY_FRAME_VALUES = Object.freeze([0.1, 0.15, 0.2]);
/** Candidate consecutive-rise confirmations evaluated by walk-forward research. */
export const DOGE_BASELINE_MINIMUM_CONSECUTIVE_RISES_VALUES = Object.freeze([1, 2]);
/** Snapshot interval in milliseconds used to bound configuration-research memory use. */
export const DOGE_BASELINE_CONFIG_RESEARCH_SNAPSHOT_INTERVAL_MS = 250;

/** Candidate entry advantages, in USDC, evaluated during configuration research. */
export const DOGE_BASELINE_MINIMUM_EDGE_VALUES = Object.freeze([0.02, 0.04, 0.06, 0.08, 0.10]);
/** Candidate predicted-side probabilities evaluated during configuration research. */
export const DOGE_BASELINE_MINIMUM_CONFIDENCE_VALUES = Object.freeze([0.5, 0.55, 0.6, 0.65]);
/** Candidate absolute DOGE movements from frame start, in basis points. */
export const DOGE_BASELINE_MINIMUM_ABSOLUTE_DEVIATION_BPS_VALUES = Object.freeze([0, 0.5, 1, 2]);
/** Local edge adjustment around a coarse configuration winner, in USDC. */
export const DOGE_BASELINE_LOCAL_EDGE_DELTA = 0.01;
/** Local confidence adjustment around a coarse configuration winner. */
export const DOGE_BASELINE_LOCAL_CONFIDENCE_DELTA = 0.03;
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

/** Minimum number of filled orders required for a replay sample of the given size. */
export function getDogeBaselineMinimumReplayTradeCount(frameCount: number): number {
    return Math.min(frameCount, DOGE_BASELINE_CANDIDATE_MAXIMUM_TRADE_COUNT, Math.max(
        DOGE_BASELINE_CANDIDATE_MINIMUM_TRADE_COUNT,
        Math.ceil(frameCount * DOGE_BASELINE_CANDIDATE_MINIMUM_TRADE_RATIO),
    ));
}

export interface DogeBaselineEntryModeSettings {
    enabled: boolean;
    minimumEdge: number;
    minimumConfidence: number;
    minimumAbsoluteDeviationBps: number;
}

export interface DogeBaselineEntrySettings {
    modes: Record<DogeBaselineModeName, DogeBaselineEntryModeSettings>;
}

export type DogeBaselineEntryModeOverrides = Partial<Pick<DogeBaselineEntryModeSettings,
    'minimumEdge' | 'minimumConfidence' | 'minimumAbsoluteDeviationBps'>>;

export type DogeBaselineEntrySettingsOverrides = Partial<Record<DogeBaselineModeName, DogeBaselineEntryModeOverrides>>;

export function createDogeBaselineEntrySettings(
    enabledModes: readonly DogeBaselineModeName[] = DOGE_BASELINE_MODES.map(mode => mode.name),
    overrides: Readonly<DogeBaselineEntrySettingsOverrides> = {},
): DogeBaselineEntrySettings {
    return {
        modes: Object.fromEntries(DOGE_BASELINE_MODES.map(mode => [mode.name, {
            enabled: enabledModes.includes(mode.name),
            minimumEdge: DOGE_BASELINE_DEFAULT_MINIMUM_EDGE,
            minimumConfidence: DOGE_BASELINE_DEFAULT_MINIMUM_CONFIDENCE,
            minimumAbsoluteDeviationBps: DOGE_BASELINE_DEFAULT_MINIMUM_ABSOLUTE_DEVIATION_BPS,
            ...overrides[mode.name],
        }])) as Record<DogeBaselineModeName, DogeBaselineEntryModeSettings>,
    };
}

export function getDogeBaselineEntrySummary(entry: Readonly<DogeBaselineEntrySettings>): string {
    return DOGE_BASELINE_MODES
        .filter(mode => entry.modes[mode.name].enabled)
        .map(mode => {
            const settings = entry.modes[mode.name];
            return `${mode.name}=edge${settings.minimumEdge.toFixed(2)}` +
                `/confidence${settings.minimumConfidence.toFixed(2)}` +
                `/deviation${formatDogeBaselineDeviationBps(settings.minimumAbsoluteDeviationBps)}bps`;
        })
        .join(',');
}

export function formatDogeBaselineDeviationBps(deviationBps: number): string {
    return Number.isInteger(deviationBps) ? deviationBps.toFixed(0) : String(deviationBps);
}
