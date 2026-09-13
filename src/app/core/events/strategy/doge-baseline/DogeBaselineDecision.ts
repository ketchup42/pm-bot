import { MarketSide } from '../../../../../market/side.js';
import { calculateTakerExecution, type TakerExecutionLevel } from '../../../../../market/orders/TakerExecution.js';
import { calculateTakerFee, feeRateBpsToDecimal } from '../../../../../rest/fees.js';
import {
    DOGE_BASELINE_EMERGENCY_EXIT_CONFIRMATION_MS,
    DOGE_BASELINE_EMERGENCY_EXIT_DEVIATION_FACTOR,
    DOGE_BASELINE_EMERGENCY_EXIT_RETRY_MS,
    DOGE_BASELINE_EMERGENCY_EXIT_WINDOW_MS,
    DOGE_BASELINE_DEFAULT_TRADE_VALUE,
    DOGE_BASELINE_DEFAULT_MINIMUM_EDGE,
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
    prices: Readonly<DogeBaselineMarketPrices>,
    minimumEdge: number = DOGE_BASELINE_DEFAULT_MINIMUM_EDGE,
): DogeBaselineEntry | undefined {
    const side = getDogeBaselinePredictedSide(upProbability);
    if (side === undefined) return undefined;
    const probability = side === 'up' ? upProbability : 1 - upProbability;
    const ask = side === 'up' ? prices.upAsk : prices.downAsk;
    if (ask === undefined || !Number.isFinite(ask) || ask <= 0 || ask >= 1) return undefined;
    const feeRate = feeRateBpsToDecimal(prices.takerBaseFee);
    const fee = prices.feesEnabled ? calculateTakerFee(1, ask, feeRate) : 0;
    const edge = probability - ask - fee;
    return edge >= minimumEdge ? { side, ask, fee, edge } : undefined;
}

export function selectDogeBaselineExecutableEntry(
    upProbability: number,
    prices: Readonly<DogeBaselineMarketPrices>,
    book: Readonly<DogeBaselineEntryBook>,
    minimumEdge: number = DOGE_BASELINE_DEFAULT_MINIMUM_EDGE,
    tradeValue: number = DOGE_BASELINE_DEFAULT_TRADE_VALUE,
): DogeBaselineExecutableEntry | undefined {
    const side = getDogeBaselinePredictedSide(upProbability);
    if (side === undefined) return undefined;
    const ask = side === 'up' ? prices.upAsk : prices.downAsk;
    if (ask === undefined || !Number.isFinite(ask) || ask <= 0 || ask >= 1) return undefined;
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
    if (execution.fillStatus === 'none' || execution.grossValue < book.minimumOrderValue) return undefined;
    const probability = side === 'up' ? upProbability : 1 - upProbability;
    const fee = execution.fee / execution.filledQuantity;
    const edge = probability - execution.averagePrice - fee;
    if (edge < minimumEdge) return undefined;
    return {
        side,
        ask,
        fee,
        edge,
        limitPrice,
        requestedQuantity,
        expectedQuantity: execution.filledQuantity,
        expectedPrice: execution.averagePrice,
        expectedGrossValue: execution.grossValue,
    };
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
