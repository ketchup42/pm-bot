import { MarketSide } from '../../../market/side.js';
import { Coin } from '../../../market/coins.js';
import { EventFrame } from '../../../market/frame.js';
import { getPriceSourceConfig, PriceSource } from '../../../market/price/price_source.js';
import { EventMarketData } from '../../../market/orderbook/watcher/MarketOrderBooksWatcher.js';
import { calculateTakerExecution, type TakerExecutionAction } from '../../../market/orders/TakerExecution.js';
import { calculateBuyTakerFeeReserve } from '../../../rest/fees.js';
import { csvValue, fileWrite } from '../../../utils.js';
import { HistoryFrameV3, HistorySnapshotV3 } from '../history/history_frame.js';
import { REPLAY_STRATEGY_NO_TRADE } from '../../defaults.js';

export type ReplayOrderAction = TakerExecutionAction;
export type ReplayDecisionAction = ReplayOrderAction | 'hold' | 'skip';
export type ReplayFillStatus = 'filled' | 'partial' | 'rejected';

export interface ReplayOrder<Action extends ReplayOrderAction = ReplayOrderAction> {
    action: Action;
    side: MarketSide;
    quantity: number;
    limit_price: number;
}

interface ReplayOrderDecision<Action extends ReplayOrderAction> {
    action: Action;
    reason_code: string;
    order: ReplayOrder<Action>;
}

interface ReplayNoOrderDecision {
    action: 'hold' | 'skip';
    reason_code: string;
    order: undefined;
}

export type ReplayDecision =
    | ReplayOrderDecision<'buy'>
    | ReplayOrderDecision<'sell'>
    | ReplayNoOrderDecision;

export interface ReplayStrategyContext {
    frame: ReplayFrameContext;
    snapshot: HistorySnapshotV3;
    snapshot_index: number;
    progress: number;
    /** Cash available after reserving submitted orders that have not executed yet. */
    cash: number;
    /** Available Up tokens after reserving submitted sell orders. */
    up_quantity: number;
    /** Available Down tokens after reserving submitted sell orders. */
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
    coin_frame_start_price: number | undefined;
    market_data: EventMarketData;
}

export interface ReplayStrategy {
    readonly name: string;
    decide(context: Readonly<ReplayStrategyContext>): ReplayDecision;
    decideAll?(context: Readonly<ReplayStrategyContext>): readonly ReplayDecision[];
    onOrderQueued?(order: Readonly<ReplayOrderSubmission>): void;
    onFill?(fill: Readonly<ReplayFill>): void;
}

export interface ReplayExecutionConfig {
    initial_balance: number;
    /** Artificial delay between a strategy decision and its execution, in milliseconds. */
    latency_ms: number;
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

/** An accepted decision that is waiting for its delayed execution snapshot. */
export interface ReplayOrderSubmission {
    timestamp: number;
    execution_timestamp: number;
    frame_start: number;
    action: ReplayOrderAction;
    side: MarketSide;
}

interface PendingReplayOrder {
    decision: ReplayOrderDecision<ReplayOrderAction>;
    executionIndex: number;
    cashReserve: number;
    tokenReserve: number;
}

export interface ReplayMetrics {
    strategy: string;
    initial_balance: number;
    final_balance: number;
    /** PnL from actual fill prices before taker fees. */
    gross_pnl: number;
    /** Theoretical PnL before fees, spread crossing and book-walk slippage. */
    pre_execution_cost_pnl: number;
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
    /** Frames in which the strategy held a non-zero token position. */
    position_frames: number;
    filled_orders: number;
    partial_orders: number;
    rejected_orders: number;
    rejected_orders_by_reason: Record<string, number>;
    frames: number;
    skipped_frames: number;
    confirmed_settlements: number;
    derived_settlements: number;
    settlement_mismatches: number;
    profit_factor: number | undefined;
    max_drawdown: number;
}

export interface ReplayResult {
    config: ReplayExecutionConfig & { strategy: string };
    metrics: ReplayMetrics;
    fills: ReplayFill[];
    equity_curve: Array<{ timestamp: number; equity: number }>;
}

export class NoTradeReplayStrategy implements ReplayStrategy {
    public readonly name = REPLAY_STRATEGY_NO_TRADE;

    public decide(): ReplayDecision {
        return { action: 'hold', reason_code: 'baseline_no_trade', order: undefined };
    }
}

export function simulateTakerFill(
    frame: HistoryFrameV3,
    snapshot: HistorySnapshotV3,
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
    const execution = calculateTakerExecution({
        action: order.action,
        levels: order.action === 'buy' ? side.asks : side.bids,
        quantity: order.quantity,
        limitPrice: order.limit_price,
        tickSize: frame.market_data.tick_size,
        feesEnabled: frame.market_data.fees_enabled,
        takerBaseFeeBps: frame.market_data.taker_base_fee,
    });
    if (execution.fillStatus === 'none') return rejected('no_executable_liquidity');
    if (execution.grossValue < config.minimum_order_value) return rejected('below_minimum_value');
    if (order.action === 'buy' && execution.grossValue + execution.fee > availableCash) return rejected('insufficient_balance');
    const status: ReplayFillStatus = execution.fillStatus === 'full' ? 'filled' : 'partial';
    const averagePrice = execution.averagePrice;
    const bestPrice = execution.bestPrice;
    const midpoint = order.side === 'up' ? snapshot.up.midpoint : snapshot.down.midpoint;
    const spreadCost = midpoint === undefined ? 0 : Math.max(0,
        (order.action === 'buy' ? bestPrice - midpoint : midpoint - bestPrice) * execution.filledQuantity,
    );
    return {
        timestamp: snapshot.timestamp,
        frame_start: frame.start_time,
        action: order.action,
        side: order.side,
        status,
        reason_code: status === 'filled' ? 'filled' : 'insufficient_depth',
        requested_quantity: execution.requestedQuantity,
        filled_quantity: execution.filledQuantity,
        average_price: averagePrice,
        gross_value: execution.grossValue,
        fee: execution.fee,
        spread_cost: spreadCost,
        slippage_cost: Math.abs(averagePrice - bestPrice) * execution.filledQuantity,
    };
}

function findReplayExecutionIndex(
    snapshots: readonly HistorySnapshotV3[],
    decisionIndex: number,
    executionTimestamp: number,
): number | undefined {
    for (let index = decisionIndex; index < snapshots.length; index++) {
        if (snapshots[index]!.timestamp >= executionTimestamp) return index;
    }
    return undefined;
}

function getReplayOrderReservation(
    frame: Readonly<HistoryFrameV3>,
    order: Readonly<ReplayOrder>,
): Pick<PendingReplayOrder, 'cashReserve' | 'tokenReserve'> {
    if (!Number.isFinite(order.quantity) || order.quantity <= 0) {
        return { cashReserve: 0, tokenReserve: 0 };
    }
    if (order.action === 'sell') return { cashReserve: 0, tokenReserve: order.quantity };
    if (!Number.isFinite(order.limit_price) || order.limit_price <= 0) return { cashReserve: 0, tokenReserve: 0 };
    const feeReserve = calculateBuyTakerFeeReserve(
        frame.market_data.fees_enabled,
        frame.market_data.taker_base_fee,
        order.limit_price,
        order.quantity,
    );
    return { cashReserve: order.quantity * order.limit_price + feeReserve, tokenReserve: 0 };
}

export function runReplay(
    frames: readonly HistoryFrameV3[],
    strategy: ReplayStrategy,
    config: ReplayExecutionConfig,
): ReplayResult {
    if (!Number.isFinite(config.initial_balance) || config.initial_balance < 0) throw new Error('invalid_initial_balance');
    if (!Number.isFinite(config.minimum_order_value) || config.minimum_order_value < 0) throw new Error('invalid_minimum_order_value');
    if (!Number.isSafeInteger(config.latency_ms) || config.latency_ms < 0) throw new Error('invalid_latency_ms');
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
    let positionFrames = 0;
    const framePnls: number[] = [];
    const frameReturns: number[] = [];
    const pnlByUtcHour: Record<string, number> = {};
    const fills: ReplayFill[] = [];
    const equityCurve: Array<{ timestamp: number; equity: number }> = [];

    const applyFill = (fill: ReplayFill): void => {
        if (fill.status === 'rejected') return;
        fees += fill.fee;
        spreadCost += fill.spread_cost;
        slippageCost += fill.slippage_cost;
        if (fill.action === 'buy') {
            cash -= fill.gross_value + fill.fee;
        } else {
            cash += fill.gross_value - fill.fee;
        }
    };

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
        let hadPosition = false;
        const pendingOrders: PendingReplayOrder[] = [];
        let reservedCash = 0;
        let reservedUpQuantity = 0;
        let reservedDownQuantity = 0;
        const strategyFrame: ReplayFrameContext = {
            source: frame.source,
            coin: frame.coin,
            frame: frame.frame,
            slug: frame.slug,
            start_time: frame.start_time,
            end_time: frame.end_time,
            snapshot_interval_ms: frame.snapshot_interval_ms,
            coin_frame_start_price: frame.coin_frame_start_price,
            market_data: frame.market_data,
        };
        const executePendingOrders = (index: number, snapshot: HistorySnapshotV3): void => {
            while (pendingOrders[0]?.executionIndex === index) {
                const pending = pendingOrders.shift()!;
                reservedCash -= pending.cashReserve;
                if (pending.decision.order.side === 'up') reservedUpQuantity -= pending.tokenReserve;
                else reservedDownQuantity -= pending.tokenReserve;
                const order = pending.decision.order;
                const tokens = order.side === 'up' ? upQuantity : downQuantity;
                const fill = simulateTakerFill(frame, snapshot, order, cash, tokens, config);
                if (fill.status !== 'rejected') fill.reason_code = pending.decision.reason_code;
                fills.push(fill);
                strategy.onFill?.(fill);
                applyFill(fill);
                if (fill.status === 'rejected') continue;
                if (fill.action === 'buy') {
                    if (fill.side === 'up') upQuantity += fill.filled_quantity;
                    else downQuantity += fill.filled_quantity;
                } else {
                    if (fill.side === 'up') upQuantity -= fill.filled_quantity;
                    else downQuantity -= fill.filled_quantity;
                }
                if (upQuantity > 0 || downQuantity > 0) hadPosition = true;
            }
        };
        for (let index = 0; index < frame.snapshots.length; index++) {
            const snapshot = frame.snapshots[index]!;
            executePendingOrders(index, snapshot);
            const context: ReplayStrategyContext = {
                frame: strategyFrame,
                snapshot,
                snapshot_index: index,
                progress: (snapshot.timestamp - frame.start_time * 1_000) / ((frame.end_time - frame.start_time) * 1_000),
                cash: cash - reservedCash,
                up_quantity: upQuantity - reservedUpQuantity,
                down_quantity: downQuantity - reservedDownQuantity,
            };
            const decisions = strategy.decideAll?.(context) ?? [strategy.decide(context)];
            for (const decision of decisions) {
                if (!decision.reason_code) throw new Error(`missing_reason_code: ${strategy.name} at ${snapshot.timestamp}`);
                if (decision.action === 'hold' || decision.action === 'skip') continue;
                const order = decision.order as ReplayOrder | undefined;
                if (order === undefined || order.action !== decision.action) {
                    throw new Error(`invalid_order_decision: ${strategy.name} at ${snapshot.timestamp}`);
                }
                const executionIndex = findReplayExecutionIndex(
                    frame.snapshots,
                    index,
                    snapshot.timestamp + config.latency_ms,
                );
                if (executionIndex === undefined) continue;
                const reservation = getReplayOrderReservation(frame, order);
                pendingOrders.push({ decision, executionIndex, ...reservation });
                reservedCash += reservation.cashReserve;
                if (order.side === 'up') reservedUpQuantity += reservation.tokenReserve;
                else reservedDownQuantity += reservation.tokenReserve;
                strategy.onOrderQueued?.({
                    timestamp: snapshot.timestamp,
                    execution_timestamp: frame.snapshots[executionIndex]!.timestamp,
                    frame_start: frame.start_time,
                    action: order.action,
                    side: order.side,
                });
            }
            executePendingOrders(index, snapshot);
        }
        cash += outcome === 'up' ? upQuantity : downQuantity;
        if (hadPosition) positionFrames++;
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
    const grossPnl = netPnl + fees;
    const preExecutionCostPnl = grossPnl + spreadCost + slippageCost;
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
    const rejectedOrdersByReason: Record<string, number> = {};
    for (const fill of fills) {
        if (fill.status === 'rejected') {
            rejectedOrdersByReason[fill.reason_code] = (rejectedOrdersByReason[fill.reason_code] ?? 0) + 1;
        }
    }
    return {
        config: { ...config, strategy: strategy.name },
        metrics: {
            strategy: strategy.name,
            initial_balance: config.initial_balance,
            final_balance: cash,
            gross_pnl: grossPnl,
            pre_execution_cost_pnl: preExecutionCostPnl,
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
            position_frames: positionFrames,
            filled_orders: fills.filter(fill => fill.status === 'filled').length,
            partial_orders: fills.filter(fill => fill.status === 'partial').length,
            rejected_orders: fills.filter(fill => fill.status === 'rejected').length,
            rejected_orders_by_reason: rejectedOrdersByReason,
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
        `- Replay latency: ${result.config.latency_ms} ms\n` +
        `- Net PnL: ${result.metrics.net_pnl}\n- Gross PnL before fees: ${result.metrics.gross_pnl}\n` +
        `- PnL before execution costs: ${result.metrics.pre_execution_cost_pnl}\n` +
        `- Fees: ${result.metrics.fees}\n- Spread cost: ${result.metrics.spread_cost}\n` +
        `- Slippage cost: ${result.metrics.slippage_cost}\n- Max drawdown: ${result.metrics.max_drawdown}\n` +
        `- Trades: ${result.metrics.trade_count}\n- Position frames: ${result.metrics.position_frames}\n` +
        `- Rejections by reason: ${JSON.stringify(result.metrics.rejected_orders_by_reason)}\n` +
        `- Frames: ${result.metrics.frames}\n`;
    await Promise.all([
        fileWrite(`${directory}/config.json`, `${JSON.stringify(result.config, undefined, 2)}\n`),
        fileWrite(`${directory}/metrics.json`, `${JSON.stringify(result.metrics, undefined, 2)}\n`),
        fileWrite(`${directory}/trades.csv`, `${rows.map(row => row.map(csvValue).join(',')).join('\n')}\n`),
        fileWrite(`${directory}/report.md`, markdown),
        fileWrite(`${directory}/equity.svg`, makeEquitySvg(result.equity_curve)),
    ]);
}
