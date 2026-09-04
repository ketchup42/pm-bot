import { NoTradeReplayStrategy, ReplayStrategy } from './replay.js';
import { REPLAY_STRATEGY_NO_TRADE } from '../../defaults.js';
import {
    TrendLineReplayPreset,
    TrendLineReplayStrategy,
    TREND_LINE_REPLAY_PRESETS,
} from './strategy/TrendLineReplayStrategy.js';

export interface ReplayStrategyPreset {
    id: string;
    create: () => ReplayStrategy;
}

function trendLinePreset(id: TrendLineReplayPreset): ReplayStrategyPreset {
    return { id, create: () => new TrendLineReplayStrategy(id) };
}

/** Canonical registry: add a preset here for both single replay and matrix replay. */
export const REPLAY_STRATEGY_PRESETS: readonly ReplayStrategyPreset[] = Object.freeze([
    { id: REPLAY_STRATEGY_NO_TRADE, create: () => new NoTradeReplayStrategy() },
    ...TREND_LINE_REPLAY_PRESETS.map(trendLinePreset),
]);

export function getReplayStrategyPreset(id: string): ReplayStrategyPreset | undefined {
    return REPLAY_STRATEGY_PRESETS.find(preset => preset.id === id);
}
