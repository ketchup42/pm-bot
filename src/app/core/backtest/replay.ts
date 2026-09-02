import { MarketSide } from '../../../market/side.js';
import { Coin } from '../../../market/coins.js';
import { EventFrame } from '../../../market/frame.js';
import { getPriceSourceConfig, PriceSource } from '../../../market/price/price_source.js';
import { EventMarketData } from '../../../market/orderbook/watcher/MarketOrderBooksWatcher.js';
import { calculateTakerFee } from '../../../rest/fees.js';
import { fileWrite, safeToNum } from '../../../utils.js';
import { HistoryFrameV2, HistorySnapshotV2 } from '../history/history_frame.js';

export type ReplayOrderAction = 'buy' | 'sell';
export type ReplayDecisionAction = ReplayOrderAction | 'hold' | 'skip';
export type ReplayFillStatus = 'filled' | 'partial' | 'rejected';

export interface ReplayOrder {
    action: ReplayOrderAction;
    side: MarketSide;
    quantity: number;
    limit_price: number;
}

export interface ReplayDecision {
    action: ReplayDecisionAction;
    reason_code: string;
    order: ReplayOrder | undefined;
}

export interface ReplayStrategyContext {
    frame: ReplayFrameContext;
    snapshot: HistorySnapshotV2;
    snapshot_index: number;
    progress: number;
    cash: number;
    up_quantity: number;
    down_quantity: number;
}

/** Frame data that is safe to expose before settlement without future prices or snapshots. */
export interface ReplayFrameContext {
    source: PriceSource;
    coin: Coin;
    frame: EventFrame;
    slug: string;
    start_time: number;
    end_time: number;
    snapshot_interval_ms: number;
    market_data: EventMarketData;
}

export interface ReplayStrategy {
    readonly name: string;
    decide(context: Readonly<ReplayStrategyContext>): ReplayDecision;
}

export interface ReplayExecutionConfig {
    initial_balance: number;
    latency_snapshots: 0 | 1;
    minimum_order_value: number;
}

export interface ReplayFill {
    timestamp: number;
    frame_start: number;
    action: ReplayOrderAction;
    side: MarketSide;
    status: ReplayFillStatus;
    reason_code: string;
    requested_quantity: number;
    filled_quantity: number;
    average_price: number | undefined;
    gross_value: number;
    fee: number;
    spread_cost: number;
    slippage_cost: number;
}

export interface ReplayMetrics {
    strategy: string;
    initial_balance: number;
    final_balance: number;
    gross_pnl: number;
    net_pnl: number;
    fees: number;
    spread_cost: number;
    slippage_cost: number;
    winning_frames: number;
    losing_frames: number;
    win_rate: number | undefined;
    average_win: number | undefined;
    average_loss: number | undefined;
    payoff_ratio: number | undefined;
    max_losing_streak: number;
    sharpe: number | undefined;
    top_1_percent_profit_share: number | undefined;
    top_5_percent_profit_share: number | undefined;
    top_10_percent_profit_share: number | undefined;
    pnl_by_utc_hour: Record<string, number>;
    trade_count: number;
    filled_orders: number;
    partial_orders: number;
    rejected_orders: number;
    frames: number;
    skipped_frames: number;
    confirmed_settlements: number;
    derived_settlements: number;
    settlement_mismatches: number;
    profit_factor: number | undefined;
    max_drawdown: number;
}

export interface ReplayResult {
    config: ReplayExecutionConfig;
    metrics: ReplayMetrics;
    fills: ReplayFill[];
    equity_curve: Array<{ timestamp: number; equity: number }>;
}

export class NoTradeReplayStrategy implements ReplayStrategy {
    public readonly name = 'no-trade';

    public decide(): ReplayDecision {
        return { action: 'hold', reason_code: 'baseline_no_trade', order: undefined };
    }
}

function roundLimit(price: number, tick: number, action: ReplayOrderAction): number {
    const units = price / tick;
    const rounded = action === 'buy' ? Math.floor(units + 1e-9) : Math.ceil(units - 1e-9);
    return Math.round(rounded * tick * 1e8) / 1e8;
}

export function simulateTakerFill(
    frame: HistoryFrameV2,
    snapshot: HistorySnapshotV2,
    order: ReplayOrder,
    availableCash: number,
    availableTokens: number,
    config: ReplayExecutionConfig,
): ReplayFill {
    const rejected = (reasonCode: string): ReplayFill => ({
        timestamp: snapshot.timestamp,
        frame_start: frame.start_time,
        action: order.action,
        side: order.side,
        status: 'rejected',
        reason_code: reasonCode,
        requested_quantity: order.quantity,
        filled_quantity: 0,
        average_price: undefined,
        gross_value: 0,
        fee: 0,
        spread_cost: 0,
        slippage_cost: 0,
    });
    if (!snapshot.book_watching) return rejected('clob_not_watching');
    if (snapshot.coin_price === undefined || snapshot.coin_timestamp === undefined ||
        snapshot.timestamp - snapshot.coin_timestamp > getPriceSourceConfig(frame.source).maxAgeMs) {
        return rejected('coin_data_gap');
    }
    if (!Number.isFinite(order.quantity) || order.quantity < frame.market_data.min_order_size) return rejected('below_minimum_size');
    if (!Number.isFinite(order.limit_price) || order.limit_price <= 0 || order.limit_price >= 1) return rejected('invalid_limit_price');
    if (order.action === 'sell' && availableTokens < order.quantity) return rejected('insufficient_tokens');

    const side = order.side === 'up' ? snapshot.up : snapshot.down;
    const limit = roundLimit(order.limit_price, frame.market_data.tick_size, order.action);
    const levels = (order.action === 'buy' ? side.asks : side.bids)
        .map(level => ({ price: safeToNum(level.price, Number.NaN), size: safeToNum(level.size, Number.NaN) }))
        .filter(level => Number.isFinite(level.price) && Number.isFinite(level.size) && level.size > 0)
        .sort((left, right) => order.action === 'buy' ? left.price - right.price : right.price - left.price);

    let remaining = order.quantity;
    let grossValue = 0;
    let fee = 0;
    for (const level of levels) {
        const executable = order.action === 'buy' ? level.price <= limit : level.price >= limit;
        if (!executable) break;
        const quantity = Math.min(remaining, level.size);
        grossValue += quantity * level.price;
        if (frame.market_data.fees_enabled) fee += calculateTakerFee(quantity, level.price, frame.market_data.taker_base_fee);
        remaining -= quantity;
        if (remaining <= 1e-9) break;
    }
    const filledQuantity = order.quantity - remaining;
    if (filledQuantity <= 1e-9) return rejected('no_executable_liquidity');
    if (grossValue < config.minimum_order_value) return rejected('below_minimum_value');
    if (order.action === 'buy' && grossValue + fee > availableCash) return rejected('insufficient_balance');
    const status: ReplayFillStatus = remaining <= 1e-9 ? 'filled' : 'partial';
    const averagePrice = grossValue / filledQuantity;
    const bestPrice = levels[0]?.price ?? averagePrice;
    const midpoint = order.side === 'up' ? snapshot.up.midpoint : snapshot.down.midpoint;
    const spreadCost = midpoint === undefined ? 0 : Math.max(0,
        (order.action === 'buy' ? bestPrice - midpoint : midpoint - bestPrice) * filledQuantity,
    );
    return {
        timestamp: snapshot.timestamp,
        frame_start: frame.start_time,
        action: order.action,
        side: order.side,
        status,
        reason_code: status === 'filled' ? 'filled' : 'insufficient_depth',
        requested_quantity: order.quantity,
        filled_quantity: filledQuantity,
        average_price: averagePrice,
        gross_value: grossValue,
        fee,
        spread_cost: spreadCost,
        slippage_cost: Math.abs(averagePrice - bestPrice) * filledQuantity,
    };
}

export function runReplay(
    frames: readonly HistoryFrameV2[],
    strategy: ReplayStrategy,
    config: ReplayExecutionConfig,
): ReplayResult {
    if (!Number.isFinite(config.initial_balance) || config.initial_balance < 0) throw new Error('invalid_initial_balance');
    if (!Number.isFinite(config.minimum_order_value) || config.minimum_order_value < 0) throw new Error('invalid_minimum_order_value');
    if (config.latency_snapshots !== 0 && config.latency_snapshots !== 1) throw new Error('invalid_latency_snapshots');
    let cash = config.initial_balance;
    let fees = 0;
    let spreadCost = 0;
    let slippageCost = 0;
    let skippedFrames = 0;
    let confirmedSettlements = 0;
    let derivedSettlements = 0;
    let settlementMismatches = 0;
    let peak = cash;
    let maxDrawdown = 0;
    let positiveFramePnl = 0;
    let negativeFramePnl = 0;
    let losingStreak = 0;
    let maxLosingStreak = 0;
    const framePnls: number[] = [];
    const frameReturns: number[] = [];
    const pnlByUtcHour: Record<string, number> = {};
    const fills: ReplayFill[] = [];
    const equityCurve: Array<{ timestamp: number; equity: number }> = [];

    for (let frameIndex = 0; frameIndex < frames.length; frameIndex++) {
        const frame = frames[frameIndex]!;
        const previous = frames[frameIndex - 1];
        if (previous && frame.start_time < previous.end_time) {
            throw new Error(`overlapping_frames_not_supported: ${previous.slug} and ${frame.slug}`);
        }
        const outcome = frame.settlement.confirmed_outcome ?? frame.settlement.derived_outcome;
        if (outcome !== 'up' && outcome !== 'down') {
            skippedFrames++;
            continue;
        }
        if (frame.settlement.confirmed_outcome !== undefined) confirmedSettlements++;
        else derivedSettlements++;
        if (frame.settlement.confirmed_outcome !== undefined && frame.settlement.derived_outcome !== 'unknown' &&
            frame.settlement.confirmed_outcome !== frame.settlement.derived_outcome) settlementMismatches++;
        const frameStartCash = cash;
        let upQuantity = 0;
        let downQuantity = 0;
        const strategyFrame: ReplayFrameContext = {
            source: frame.source,
            coin: frame.coin,
            frame: frame.frame,
            slug: frame.slug,
            start_time: frame.start_time,
            end_time: frame.end_time,
            snapshot_interval_ms: frame.snapshot_interval_ms,
            market_data: frame.market_data,
        };
        for (let index = 0; index < frame.snapshots.length; index++) {
            const snapshot = frame.snapshots[index]!;
            const decision = strategy.decide({
                frame: strategyFrame,
                snapshot,
                snapshot_index: index,
                progress: (snapshot.timestamp - frame.start_time * 1_000) / ((frame.end_time - frame.start_time) * 1_000),
                cash,
                up_quantity: upQuantity,
                down_quantity: downQuantity,
            });
            if (!decision.reason_code) throw new Error(`missing_reason_code: ${strategy.name} at ${snapshot.timestamp}`);
            if ((decision.action === 'buy' || decision.action === 'sell') &&
                (decision.order === undefined || decision.order.action !== decision.action)) {
                throw new Error(`invalid_order_decision: ${strategy.name} at ${snapshot.timestamp}`);
            }
            if ((decision.action !== 'buy' && decision.action !== 'sell') || decision.order === undefined) continue;
            const executionIndex = index + config.latency_snapshots;
            const executionSnapshot = frame.snapshots[executionIndex];
            if (!executionSnapshot) continue;
            const tokens = decision.order.side === 'up' ? upQuantity : downQuantity;
            const fill = simulateTakerFill(frame, executionSnapshot, decision.order, cash, tokens, config);
            fills.push(fill);
            if (fill.status === 'rejected') continue;
            fees += fill.fee;
            spreadCost += fill.spread_cost;
            slippageCost += fill.slippage_cost;
            if (fill.action === 'buy') {
                cash -= fill.gross_value + fill.fee;
                if (fill.side === 'up') upQuantity += fill.filled_quantity;
                else downQuantity += fill.filled_quantity;
            } else {
                cash += fill.gross_value - fill.fee;
                if (fill.side === 'up') upQuantity -= fill.filled_quantity;
                else downQuantity -= fill.filled_quantity;
            }
        }
        cash += outcome === 'up' ? upQuantity : downQuantity;
        const framePnl = cash - frameStartCash;
        framePnls.push(framePnl);
        if (frameStartCash > 0) frameReturns.push(framePnl / frameStartCash);
        if (framePnl >= 0) positiveFramePnl += framePnl;
        else negativeFramePnl += -framePnl;
        if (framePnl < 0) {
            losingStreak++;
            maxLosingStreak = Math.max(maxLosingStreak, losingStreak);
        } else {
            losingStreak = 0;
        }
        const hour = String(new Date(frame.start_time * 1_000).getUTCHours()).padStart(2, '0');
        pnlByUtcHour[hour] = (pnlByUtcHour[hour] ?? 0) + framePnl;
        peak = Math.max(peak, cash);
        maxDrawdown = Math.max(maxDrawdown, peak - cash);
        equityCurve.push({ timestamp: frame.end_time * 1_000, equity: cash });
    }

    const netPnl = cash - config.initial_balance;
    const wins = framePnls.filter(value => value > 0);
    const losses = framePnls.filter(value => value < 0);
    const tradedFrames = wins.length + losses.length;
    const averageWin = wins.length > 0 ? wins.reduce((sum, value) => sum + value, 0) / wins.length : undefined;
    const averageLoss = losses.length > 0 ? losses.reduce((sum, value) => sum + value, 0) / losses.length : undefined;
    const meanReturn = frameReturns.length > 0 ? frameReturns.reduce((sum, value) => sum + value, 0) / frameReturns.length : 0;
    const returnVariance = frameReturns.length > 1
        ? frameReturns.reduce((sum, value) => sum + (value - meanReturn) ** 2, 0) / (frameReturns.length - 1)
        : 0;
    const sharpe = frameReturns.length >= 30 && returnVariance > 0
        ? meanReturn / Math.sqrt(returnVariance) * Math.sqrt(frameReturns.length)
        : undefined;
    const profitConcentration = (percent: number): number | undefined => {
        if (positiveFramePnl <= 0 || wins.length === 0) return undefined;
        const count = Math.max(1, Math.ceil(wins.length * percent));
        return [...wins].sort((left, right) => right - left).slice(0, count)
            .reduce((sum, value) => sum + value, 0) / positiveFramePnl;
    };
    return {
        config: { ...config },
        metrics: {
            strategy: strategy.name,
            initial_balance: config.initial_balance,
            final_balance: cash,
            gross_pnl: netPnl + fees + spreadCost + slippageCost,
            net_pnl: netPnl,
            fees,
            spread_cost: spreadCost,
            slippage_cost: slippageCost,
            winning_frames: wins.length,
            losing_frames: losses.length,
            win_rate: tradedFrames > 0 ? wins.length / tradedFrames : undefined,
            average_win: averageWin,
            average_loss: averageLoss,
            payoff_ratio: averageWin !== undefined && averageLoss !== undefined ? averageWin / Math.abs(averageLoss) : undefined,
            max_losing_streak: maxLosingStreak,
            sharpe,
            top_1_percent_profit_share: profitConcentration(0.01),
            top_5_percent_profit_share: profitConcentration(0.05),
            top_10_percent_profit_share: profitConcentration(0.10),
            pnl_by_utc_hour: pnlByUtcHour,
            trade_count: fills.filter(fill => fill.status !== 'rejected').length,
            filled_orders: fills.filter(fill => fill.status === 'filled').length,
            partial_orders: fills.filter(fill => fill.status === 'partial').length,
            rejected_orders: fills.filter(fill => fill.status === 'rejected').length,
            frames: frames.length,
            skipped_frames: skippedFrames,
            confirmed_settlements: confirmedSettlements,
            derived_settlements: derivedSettlements,
            settlement_mismatches: settlementMismatches,
            profit_factor: negativeFramePnl > 0 ? positiveFramePnl / negativeFramePnl : undefined,
            max_drawdown: maxDrawdown,
        },
        fills,
        equity_curve: equityCurve,
    };
}

function csvValue(value: unknown): string {
    return value === undefined ? '' : String(value);
}

function makeEquitySvg(points: readonly { timestamp: number; equity: number }[]): string {
    const width = 800;
    const height = 300;
    const values = points.map(point => point.equity);
    const min = Math.min(...values, 0);
    const max = Math.max(...values, 1);
    const range = max - min || 1;
    const coordinates = points.map((point, index) => {
        const x = points.length <= 1 ? 0 : index * width / (points.length - 1);
        const y = height - (point.equity - min) * height / range;
        return `${x.toFixed(2)},${y.toFixed(2)}`;
    }).join(' ');
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}"><polyline fill="none" stroke="currentColor" stroke-width="2" points="${coordinates}"/></svg>\n`;
}

export async function writeReplayReport(result: ReplayResult, directory: string): Promise<void> {
    const rows = [
        ['timestamp', 'frame_start', 'action', 'side', 'status', 'reason_code', 'requested_quantity', 'filled_quantity', 'average_price', 'gross_value', 'fee', 'spread_cost', 'slippage_cost'],
        ...result.fills.map(fill => [fill.timestamp, fill.frame_start, fill.action, fill.side, fill.status, fill.reason_code,
            fill.requested_quantity, fill.filled_quantity, fill.average_price, fill.gross_value, fill.fee, fill.spread_cost, fill.slippage_cost]),
    ];
    const markdown = `# Backtest report\n\nStrategy: ${result.metrics.strategy}\n\n` +
        `- Net PnL: ${result.metrics.net_pnl}\n- Gross PnL: ${result.metrics.gross_pnl}\n` +
        `- Fees: ${result.metrics.fees}\n- Spread cost: ${result.metrics.spread_cost}\n` +
        `- Slippage cost: ${result.metrics.slippage_cost}\n- Max drawdown: ${result.metrics.max_drawdown}\n` +
        `- Trades: ${result.metrics.trade_count}\n- Frames: ${result.metrics.frames}\n`;
    await Promise.all([
        fileWrite(`${directory}/config.json`, `${JSON.stringify(result.config, undefined, 2)}\n`),
        fileWrite(`${directory}/metrics.json`, `${JSON.stringify(result.metrics, undefined, 2)}\n`),
        fileWrite(`${directory}/trades.csv`, `${rows.map(row => row.map(csvValue).join(',')).join('\n')}\n`),
        fileWrite(`${directory}/report.md`, markdown),
        fileWrite(`${directory}/equity.svg`, makeEquitySvg(result.equity_curve)),
    ]);
}
