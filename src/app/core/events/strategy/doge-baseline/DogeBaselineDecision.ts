import { MarketSide } from '../../../../../market/side.js';
import { calculateTakerExecution, type TakerExecutionLevel } from '../../../../../market/orders/TakerExecution.js';
import { calculateBuyTakerFeeReserve, calculateTakerFee, feeRateBpsToDecimal } from '../../../../../rest/fees.js';
import {
    DOGE_BASELINE_EMERGENCY_EXIT_CONFIRMATION_MS,
    DOGE_BASELINE_EMERGENCY_EXIT_DEVIATION_FACTOR,
    DOGE_BASELINE_EMERGENCY_EXIT_RETRY_MS,
    DOGE_BASELINE_EMERGENCY_EXIT_WINDOW_MS,
    DOGE_BASELINE_DEFAULT_MINIMUM_ABSOLUTE_DEVIATION_BPS,
    DOGE_BASELINE_DEFAULT_MINIMUM_CONFIDENCE,
    DOGE_BASELINE_DEFAULT_MINIMUM_EDGE,
    DOGE_BASELINE_DEFAULT_TRADE_VALUE,
    type DogeBaselineEntryModeSettings,
} from './DogeBaselineConfig.js';

export interface DogeBaselineMarketPrices {
    upAsk: number | undefined;
    downAsk: number | undefined;
    feesEnabled: boolean;
    takerBaseFee: number;
}

export interface DogeBaselineEntry {
    side: MarketSide;
    ask: number;
    fee: number;
    edge: number;
}

export interface DogeBaselineExecutableEntry extends DogeBaselineEntry {
    limitPrice: number;
    requestedQuantity: number;
    expectedQuantity: number;
    expectedPrice: number;
    expectedGrossValue: number;
}

export const DOGE_BASELINE_ENTRY_REJECTION_REASONS = Object.freeze([
    'neutral_prediction',
    'below_minimum_confidence',
    'below_minimum_absolute_deviation',
    'predicted_side_unavailable',
    'insufficient_book_liquidity',
    'below_minimum_order_value',
    'insufficient_edge_after_execution_costs',
    'insufficient_strategy_balance',
] as const);

export type DogeBaselineEntryRejectionReason = typeof DOGE_BASELINE_ENTRY_REJECTION_REASONS[number];

type DogeBaselineSignalRejectionReason = Extract<DogeBaselineEntryRejectionReason,
    'neutral_prediction' | 'below_minimum_confidence' | 'below_minimum_absolute_deviation'>;

interface DogeBaselineEligibleSignal {
    side: MarketSide;
}

interface DogeBaselineRejectedSignal {
    side: undefined;
    reason: DogeBaselineSignalRejectionReason;
}

type DogeBaselineSignalSelection = DogeBaselineEligibleSignal | DogeBaselineRejectedSignal;

const DOGE_BASELINE_DEFAULT_ENTRY_SETTINGS: Readonly<DogeBaselineEntryModeSettings> = Object.freeze({
    enabled: true,
    minimumEdge: DOGE_BASELINE_DEFAULT_MINIMUM_EDGE,
    minimumConfidence: DOGE_BASELINE_DEFAULT_MINIMUM_CONFIDENCE,
    minimumAbsoluteDeviationBps: DOGE_BASELINE_DEFAULT_MINIMUM_ABSOLUTE_DEVIATION_BPS,
});

export interface DogeBaselineExecutableEntryAccepted {
    candidate: DogeBaselineExecutableEntry;
}

export interface DogeBaselineExecutableEntryRejected {
    candidate: undefined;
    reason: DogeBaselineEntryRejectionReason;
}

export type DogeBaselineExecutableEntrySelection =
    | DogeBaselineExecutableEntryAccepted
    | DogeBaselineExecutableEntryRejected;

export interface DogeBaselineEntryBook {
    upAsks: readonly TakerExecutionLevel[];
    downAsks: readonly TakerExecutionLevel[];
    tickSize: number;
    minimumOrderValue: number;
}

export interface DogeBaselineEmergencyExitConfig {
    windowMs: number;
    deviationFactor: number;
    confirmationMs: number;
    retryMs: number;
}

export interface DogeBaselineEmergencyExitState {
    adverseSince: number | undefined;
    adverse: boolean;
    triggered: boolean;
}

export interface DogeBaselineEmergencyExitParams {
    side: MarketSide;
    frameStartPrice: number;
    currentPrice: number;
    timestamp: number;
    frameEndTimestamp: number;
    adverseSince: number | undefined;
}

export function getDogeBaselineEmergencyExitConfig(): DogeBaselineEmergencyExitConfig {
    return {
        windowMs: DOGE_BASELINE_EMERGENCY_EXIT_WINDOW_MS,
        deviationFactor: DOGE_BASELINE_EMERGENCY_EXIT_DEVIATION_FACTOR,
        confirmationMs: DOGE_BASELINE_EMERGENCY_EXIT_CONFIRMATION_MS,
        retryMs: DOGE_BASELINE_EMERGENCY_EXIT_RETRY_MS,
    };
}

export function canRetryDogeBaselineEmergencyExit(
    timestamp: number,
    nextAttemptTimestamp: number | undefined,
): boolean {
    return nextAttemptTimestamp === undefined || timestamp >= nextAttemptTimestamp;
}

export function getDogeBaselinePredictedSide(upProbability: number): MarketSide | undefined {
    if (!Number.isFinite(upProbability) || upProbability < 0 || upProbability > 1 || upProbability === 0.5) {
        return undefined;
    }
    return upProbability > 0.5 ? 'up' : 'down';
}

export function selectDogeBaselineEntry(
    upProbability: number,
    deviationBps: number,
    prices: Readonly<DogeBaselineMarketPrices>,
    settings: Readonly<DogeBaselineEntryModeSettings> = DOGE_BASELINE_DEFAULT_ENTRY_SETTINGS,
): DogeBaselineEntry | undefined {
    const signal = selectDogeBaselineSignal(upProbability, deviationBps, settings);
    if (signal.side === undefined) return undefined;
    const { side } = signal;
    const probability = side === 'up' ? upProbability : 1 - upProbability;
    const ask = side === 'up' ? prices.upAsk : prices.downAsk;
    if (ask === undefined || !Number.isFinite(ask) || ask <= 0 || ask >= 1) return undefined;
    const feeRate = feeRateBpsToDecimal(prices.takerBaseFee);
    const fee = prices.feesEnabled ? calculateTakerFee(1, ask, feeRate) : 0;
    const edge = probability - ask - fee;
    return edge >= settings.minimumEdge ? { side, ask, fee, edge } : undefined;
}

export function selectDogeBaselineExecutableEntry(
    upProbability: number,
    deviationBps: number,
    prices: Readonly<DogeBaselineMarketPrices>,
    book: Readonly<DogeBaselineEntryBook>,
    settings: Readonly<DogeBaselineEntryModeSettings> = DOGE_BASELINE_DEFAULT_ENTRY_SETTINGS,
    tradeValue: number = DOGE_BASELINE_DEFAULT_TRADE_VALUE,
): DogeBaselineExecutableEntry | undefined {
    return selectDogeBaselineExecutableEntryWithReason(
        upProbability, deviationBps, prices, book, settings, tradeValue,
    ).candidate;
}

export function selectDogeBaselineExecutableEntryWithReason(
    upProbability: number,
    deviationBps: number,
    prices: Readonly<DogeBaselineMarketPrices>,
    book: Readonly<DogeBaselineEntryBook>,
    settings: Readonly<DogeBaselineEntryModeSettings> = DOGE_BASELINE_DEFAULT_ENTRY_SETTINGS,
    tradeValue: number = DOGE_BASELINE_DEFAULT_TRADE_VALUE,
    availableBalance: number | undefined = undefined,
): DogeBaselineExecutableEntrySelection {
    const signal = selectDogeBaselineSignal(upProbability, deviationBps, settings);
    if (signal.side === undefined) return { candidate: undefined, reason: signal.reason };
    const { side } = signal;
    const probability = side === 'up' ? upProbability : 1 - upProbability;
    const ask = side === 'up' ? prices.upAsk : prices.downAsk;
    if (ask === undefined || !Number.isFinite(ask) || ask <= 0 || ask >= 1) {
        return { candidate: undefined, reason: 'predicted_side_unavailable' };
    }
    const limitPrice = calculateDogeBaselineEntryLimit(ask, book.tickSize);
    const requestedQuantity = tradeValue / limitPrice;
    const execution = calculateTakerExecution({
        action: 'buy',
        levels: side === 'up' ? book.upAsks : book.downAsks,
        quantity: requestedQuantity,
        limitPrice,
        tickSize: book.tickSize,
        feesEnabled: prices.feesEnabled,
        takerBaseFeeBps: prices.takerBaseFee,
    });
    if (execution.fillStatus === 'none') return { candidate: undefined, reason: 'insufficient_book_liquidity' };
    if (execution.grossValue < book.minimumOrderValue) return { candidate: undefined, reason: 'below_minimum_order_value' };
    const fee = execution.fee / execution.filledQuantity;
    const edge = probability - execution.averagePrice - fee;
    if (edge < settings.minimumEdge) return { candidate: undefined, reason: 'insufficient_edge_after_execution_costs' };
    const requiredBalance = limitPrice * requestedQuantity +
        calculateBuyTakerFeeReserve(prices.feesEnabled, prices.takerBaseFee, limitPrice, requestedQuantity);
    if (availableBalance !== undefined && requiredBalance > availableBalance) {
        return { candidate: undefined, reason: 'insufficient_strategy_balance' };
    }
    return {
        candidate: {
            side,
            ask,
            fee,
            edge,
            limitPrice,
            requestedQuantity,
            expectedQuantity: execution.filledQuantity,
            expectedPrice: execution.averagePrice,
            expectedGrossValue: execution.grossValue,
        },
    };
}

function selectDogeBaselineSignal(
    upProbability: number,
    deviationBps: number,
    settings: Readonly<DogeBaselineEntryModeSettings>,
): DogeBaselineSignalSelection {
    const side = getDogeBaselinePredictedSide(upProbability);
    if (side === undefined) return { side: undefined, reason: 'neutral_prediction' };
    const probability = side === 'up' ? upProbability : 1 - upProbability;
    if (probability < settings.minimumConfidence) return { side: undefined, reason: 'below_minimum_confidence' };
    if (Math.abs(deviationBps) < settings.minimumAbsoluteDeviationBps) {
        return { side: undefined, reason: 'below_minimum_absolute_deviation' };
    }
    return { side };
}

export function evaluateDogeBaselineEmergencyExit(
    params: Readonly<DogeBaselineEmergencyExitParams>,
    config: Readonly<DogeBaselineEmergencyExitConfig> = getDogeBaselineEmergencyExitConfig(),
): DogeBaselineEmergencyExitState {
    if (params.timestamp < params.frameEndTimestamp - config.windowMs ||
        params.frameStartPrice <= 0 || params.currentPrice <= 0) {
        return { adverseSince: undefined, adverse: false, triggered: false };
    }
    const deviation = params.frameStartPrice * config.deviationFactor;
    const adverse = params.side === 'up'
        ? params.currentPrice <= params.frameStartPrice - deviation
        : params.currentPrice >= params.frameStartPrice + deviation;
    if (!adverse) return { adverseSince: undefined, adverse: false, triggered: false };
    const adverseSince = params.adverseSince ?? params.timestamp;
    return {
        adverseSince,
        adverse: true,
        triggered: params.timestamp - adverseSince >= config.confirmationMs,
    };
}

export function calculateDogeBaselineEntryLimit(ask: number, tick: number): number {
    return Math.min(1 - tick, ask + tick);
}
