import { MarketSide } from '../../../../../market/side.js';
import { calculateTakerFee, feeRateBpsToDecimal } from '../../../../../rest/fees.js';
import {
    DOGE_BASELINE_EMERGENCY_EXIT_CONFIRMATION_MS,
    DOGE_BASELINE_EMERGENCY_EXIT_DEVIATION_FACTOR,
    DOGE_BASELINE_EMERGENCY_EXIT_WINDOW_MS,
    DOGE_BASELINE_MINIMUM_EDGE,
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

export function getDogeBaselinePredictedSide(upProbability: number): MarketSide | undefined {
    if (!Number.isFinite(upProbability) || upProbability < 0 || upProbability > 1 || upProbability === 0.5) {
        return undefined;
    }
    return upProbability > 0.5 ? 'up' : 'down';
}

export function selectDogeBaselineEntry(
    upProbability: number,
    prices: Readonly<DogeBaselineMarketPrices>,
): DogeBaselineEntry | undefined {
    const side = getDogeBaselinePredictedSide(upProbability);
    if (side === undefined) return undefined;
    const probability = side === 'up' ? upProbability : 1 - upProbability;
    const ask = side === 'up' ? prices.upAsk : prices.downAsk;
    if (ask === undefined || !Number.isFinite(ask) || ask <= 0 || ask >= 1) return undefined;
    const feeRate = feeRateBpsToDecimal(prices.takerBaseFee);
    const fee = prices.feesEnabled ? calculateTakerFee(1, ask, feeRate) : 0;
    const edge = probability - ask - fee;
    return edge >= DOGE_BASELINE_MINIMUM_EDGE ? { side, ask, fee, edge } : undefined;
}

export function evaluateDogeBaselineEmergencyExit(
    params: Readonly<DogeBaselineEmergencyExitParams>,
): DogeBaselineEmergencyExitState {
    if (params.timestamp < params.frameEndTimestamp - DOGE_BASELINE_EMERGENCY_EXIT_WINDOW_MS ||
        params.frameStartPrice <= 0 || params.currentPrice <= 0) {
        return { adverseSince: undefined, adverse: false, triggered: false };
    }
    const deviation = params.frameStartPrice * DOGE_BASELINE_EMERGENCY_EXIT_DEVIATION_FACTOR;
    const adverse = params.side === 'up'
        ? params.currentPrice <= params.frameStartPrice - deviation
        : params.currentPrice >= params.frameStartPrice + deviation;
    if (!adverse) return { adverseSince: undefined, adverse: false, triggered: false };
    const adverseSince = params.adverseSince ?? params.timestamp;
    return {
        adverseSince,
        adverse: true,
        triggered: params.timestamp - adverseSince >= DOGE_BASELINE_EMERGENCY_EXIT_CONFIRMATION_MS,
    };
}

export function calculateDogeBaselineEntryLimit(ask: number, tick: number): number {
    return Math.min(1 - tick, ask + tick);
}
