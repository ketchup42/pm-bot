import { MarketSide, MARKET_SIDES } from '../../../../market/side.js';
import { safeToNum } from '../../../../utils.js';
import {
    REPLAY_STRATEGY_TREND_LINE_V1,
    REPLAY_STRATEGY_TREND_LINE_V2,
    TREND_LINE_REPLAY_STRATEGY_IDS,
    TrendLineReplayStrategyId,
} from '../../../defaults.js';
import {
    COIN_TREND_LINE_V1_CONFIG,
    COIN_TREND_LINE_V2_CONFIG,
    TrendLineStrategyConfig,
} from '../../events/strategy/trend-line/TrendLineStrategyConfig.js';
import {
    ReplayDecision,
    ReplayFill,
    ReplayOrderSubmission,
    ReplayStrategy,
    ReplayStrategyContext,
} from '../replay.js';

export type TrendLineReplayPreset = TrendLineReplayStrategyId;

interface TrendLineReplayOptions {
    directional: boolean;
    mirrorEnabled: boolean;
    maxEntryPriceAlways: boolean;
    exitsEnabled: boolean;
}

interface TrendLineReplayState {
    mirror: boolean;
    activated: boolean;
    entered: boolean;
    exited: boolean;
    pendingAction: 'buy' | 'sell' | undefined;
}

const PRESET_OPTIONS: Readonly<Record<TrendLineReplayPreset, Readonly<TrendLineReplayOptions>>> = Object.freeze({
    [REPLAY_STRATEGY_TREND_LINE_V1]: { directional: false, mirrorEnabled: true, maxEntryPriceAlways: false, exitsEnabled: true },
    [REPLAY_STRATEGY_TREND_LINE_V2]: { directional: false, mirrorEnabled: true, maxEntryPriceAlways: false, exitsEnabled: true },
});

export const TREND_LINE_REPLAY_PRESETS: readonly TrendLineReplayPreset[] = TREND_LINE_REPLAY_STRATEGY_IDS;

function getConfig(preset: TrendLineReplayPreset): Readonly<TrendLineStrategyConfig> {
    return preset === REPLAY_STRATEGY_TREND_LINE_V1 ? COIN_TREND_LINE_V1_CONFIG : COIN_TREND_LINE_V2_CONFIG;
}

/**
 * Pure replay implementation of the V1/V2 trend-line signal rules.
 * It intentionally shares no wallet, timer, network or future-frame state with live code.
 */
export class TrendLineReplayStrategy implements ReplayStrategy {
    public readonly name: string;
    private readonly config: Readonly<TrendLineStrategyConfig>;
    private readonly options: Readonly<TrendLineReplayOptions>;
    private readonly states = new Map<string, TrendLineReplayState>();
    private readonly selectedSides = new Map<number, MarketSide>();

    public constructor(private readonly preset: TrendLineReplayPreset) {
        this.name = preset;
        this.config = getConfig(preset);
        this.options = PRESET_OPTIONS[preset];
    }

    public decide(context: Readonly<ReplayStrategyContext>): ReplayDecision {
        return this.decideAll(context)[0] ?? { action: 'hold', reason_code: 'no_signal', order: undefined };
    }

    public decideAll(context: Readonly<ReplayStrategyContext>): readonly ReplayDecision[] {
        return this.decideWithStartPrice(context, context.frame.coin_frame_start_price);
    }

    public onFill(fill: Readonly<ReplayFill>): void {
        const state = this.states.get(`${fill.frame_start}:${fill.side}`);
        if (!state) return;
        state.pendingAction = undefined;
        if (fill.status === 'rejected') return;
        if (fill.action === 'buy') state.entered = true;
        else state.exited = true;
    }

    public onOrderQueued(order: Readonly<ReplayOrderSubmission>): void {
        const state = this.states.get(`${order.frame_start}:${order.side}`);
        if (state) state.pendingAction = order.action;
    }

    private decideWithStartPrice(context: Readonly<ReplayStrategyContext>, frameStartPrice: number | undefined): readonly ReplayDecision[] {
        if (frameStartPrice === undefined || context.snapshot.coin_price === undefined) return [];
        const isStartPeriod = context.progress >= this.config.startIntervalFactor;
        const deviation = context.snapshot.coin_price - frameStartPrice;
        if (!isStartPeriod) return [];
        if (this.options.directional && !this.selectedSides.has(context.frame.start_time) &&
            (this.config.startDiffPriceFactor === undefined || Math.abs(deviation) >= this.config.startDiffPriceFactor)) {
            this.selectedSides.set(context.frame.start_time, deviation > 0 ? 'up' : 'down');
        }
        return MARKET_SIDES.flatMap(side => this.decideSide(context, side));
    }

    private decideSide(context: Readonly<ReplayStrategyContext>, side: MarketSide): ReplayDecision[] {
        if (this.options.directional && this.selectedSides.get(context.frame.start_time) !== side) return [];
        const sideSnapshot = side === 'up' ? context.snapshot.up : context.snapshot.down;
        const ask = safeToNum(sideSnapshot.asks[0]?.price, Number.NaN);
        const bid = safeToNum(sideSnapshot.bids[0]?.price, Number.NaN);
        if (!Number.isFinite(ask) || !Number.isFinite(bid)) return [];
        const key = `${context.frame.start_time}:${side}`;
        const state = this.states.get(key) ?? {
            mirror: false,
            activated: false,
            entered: false,
            exited: false,
            pendingAction: undefined,
        };
        this.states.set(key, state);
        if (state.pendingAction !== undefined) return [];
        if (!state.activated && this.config.startDiffPriceFactor !== undefined) {
            if (context.snapshot.coin_price === undefined || context.frame.coin_frame_start_price === undefined ||
                Math.abs(context.snapshot.coin_price - context.frame.coin_frame_start_price) < this.config.startDiffPriceFactor) return [];
            state.activated = true;
        }
        const mirrorLine = this.config.mirrorLineStart * (1 - context.progress);
        if (this.options.mirrorEnabled && bid < mirrorLine) state.mirror = true;
        const buyStart = state.mirror ? this.config.priceBuyStartMirror : this.config.priceBuyStart;
        const entryLine = buyStart + (this.config.priceBuyEnd - buyStart) * context.progress;
        const maxEntryPrice = state.mirror ? this.config.mirrorMaxBuyPrice : this.config.maxBuyPrice;
        const quantity = side === 'up' ? context.up_quantity : context.down_quantity;

        if (this.options.exitsEnabled && quantity >= this.config.orderVolume && !state.exited) {
            if (!state.mirror && bid < this.config.priceSellLevel) return [this.sell(side, quantity, context.frame.market_data.tick_size, 'exit_a')];
            if (state.mirror && bid < this.config.mirrorExitLevel) return [this.sell(side, quantity, context.frame.market_data.tick_size, 'exit_b')];
            if (this.config.exitCTimeFactor !== undefined && maxEntryPrice !== undefined &&
                bid > maxEntryPrice && context.progress < this.config.exitCTimeFactor) {
                return [this.sell(side, quantity, maxEntryPrice, 'exit_c')];
            }
        }
        if (state.entered || state.exited || quantity >= this.config.orderVolume || context.progress >= this.config.endIntervalFactor || ask <= entryLine) return [];
        const limitPrice = ask + context.frame.market_data.tick_size;
        const capApplies = this.options.maxEntryPriceAlways || this.config.exitCTimeFactor === undefined ||
            context.progress < this.config.exitCTimeFactor;
        if (capApplies && maxEntryPrice !== undefined && limitPrice > maxEntryPrice) return [];
        return [{
            action: 'buy',
            reason_code: `entry_${state.mirror ? 'mirror' : 'normal'}`,
            order: { action: 'buy', side, quantity: this.config.orderVolume, limit_price: limitPrice },
        }];
    }

    private sell(side: MarketSide, quantity: number, limitPrice: number, reasonCode: string): ReplayDecision {
        return {
            action: 'sell',
            reason_code: reasonCode,
            order: { action: 'sell', side, quantity, limit_price: limitPrice },
        };
    }
}
