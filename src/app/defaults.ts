import { EventFrame } from '../market/frame.js';
import { PriceSource, PS_CHAINLINK_TWAP_60 } from '../market/price/price_source.js';

/** Default directory for collected history frame files. */
export const DEFAULT_HISTORY_DIRECTORY = 'history/frames';
export const DEFAULT_HISTORY_REPORTS_DIRECTORY = 'history/reports';
export const DEFAULT_BACKTEST_OUTPUT_DIRECTORY = `${DEFAULT_HISTORY_REPORTS_DIRECTORY}/latest`;
export const DEFAULT_BACKTEST_MATRIX_OUTPUT_DIRECTORY = `${DEFAULT_HISTORY_REPORTS_DIRECTORY}/matrix/latest`;
export const DEFAULT_DOGE_BASELINE_REPLAY_OUTPUT_DIRECTORY = `${DEFAULT_HISTORY_REPORTS_DIRECTORY}/doge-baseline/latest`;
export const DEFAULT_STRATEGY_MODELS_DIRECTORY = 'models';

export const HISTORY_COIN_ALL = 'all' as const;
export const DEFAULT_HISTORY_COIN = HISTORY_COIN_ALL;
export const DEFAULT_HISTORY_FRAME: EventFrame = '5m';
export const DEFAULT_HISTORY_SOURCE: PriceSource = PS_CHAINLINK_TWAP_60;
export const DEFAULT_HISTORY_SNAPSHOT_INTERVAL_MS = 100;
export const DEFAULT_HISTORY_BOOK_DEPTH = 10;
export const DEFAULT_HISTORY_GZIP = true;
export const DEFAULT_HISTORY_FRAME_COUNT = 0;
/** Diagnostic incomplete frames retained per collected coin. */
export const DEFAULT_HISTORY_DIAGNOSTIC_FRAMES = 100;

export const DEFAULT_REPLAY_INITIAL_BALANCE = 100;
/** Artificial delay between a replay decision and its execution, in milliseconds. */
export const DEFAULT_REPLAY_LATENCY_MS = 0;
export const DEFAULT_REPLAY_MINIMUM_ORDER_VALUE = 1;

export const REPLAY_STRATEGY_NO_TRADE = 'no-trade' as const;
export const REPLAY_STRATEGY_TREND_LINE_V1 = 'v1' as const;
export const REPLAY_STRATEGY_TREND_LINE_V2 = 'v2' as const;

export const TREND_LINE_REPLAY_STRATEGY_IDS = Object.freeze([
    REPLAY_STRATEGY_TREND_LINE_V1,
    REPLAY_STRATEGY_TREND_LINE_V2,
] as const);

export type TrendLineReplayStrategyId = typeof TREND_LINE_REPLAY_STRATEGY_IDS[number];

export const DEFAULT_REPLAY_STRATEGY = REPLAY_STRATEGY_NO_TRADE;
