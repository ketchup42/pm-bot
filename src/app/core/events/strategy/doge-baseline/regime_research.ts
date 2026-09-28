import { HistoryFrameV3 } from '../../../history/history_frame.js';
import { getHistoryFrameIndex } from '../../../history/HistoryFrameReader.js';
import { HistoryFrameRollingWindow } from '../../../history/history_frame_window.js';
import { ReplayMetrics, type ReplayExecutionConfig } from '../../../backtest/replay.js';
import { runDogeBaselineReplay } from '../../../backtest/strategy/DogeBaselineReplayStrategy.js';
import { type DogeBaselineRegimeSettings, type DogeBaselineStrategyConfig, toDogeBaselineRuntimeConfig } from './artifacts.js';
import {
    DOGE_BASELINE_DEFAULT_MINIMUM_CONSECUTIVE_RISES,
    DOGE_BASELINE_DEFAULT_MINIMUM_TRADING_NET_PNL_PER_REPLAY_FRAME,
    DOGE_BASELINE_DEFAULT_TRADING_NET_PNL_TREND_PER_REPLAY_FRAME,
    DOGE_BASELINE_MINIMUM_CONSECUTIVE_RISES_VALUES,
    DOGE_BASELINE_MINIMUM_TRADING_NET_PNL_PER_REPLAY_FRAME_VALUES,
    DOGE_BASELINE_TRADING_NET_PNL_TREND_PER_REPLAY_FRAME_VALUES,
} from './DogeBaselineConfig.js';
import { makeDogeBaselineObservation, type DogeBaselineModel, type DogeBaselineObservation } from './DogeBaselineModel.js';
import { compactDogeBaselineConfigurationFrame } from './DogeBaselineResearch.js';
import {
    areDogeBaselineEvaluationTradingPointsComparable,
    type DogeBaselineConfigurationEvaluation,
    getDogeBaselineEvaluationTradingPoint,
    type DogeBaselineEvaluationTradingPoint,
    type DogeBaselineEvaluationTradingState,
} from './DogeBaselineEvaluation.js';

export interface DogeBaselineRegimeResearchPolicy extends DogeBaselineRegimeSettings {
    id: string;
}

export interface DogeBaselineRegimeResearchWindow {
    firstFrameStart: number;
    lastFrameStart: number;
    tradingEnabled: boolean;
    selectedNetPnl: number | undefined;
    previousNetPnl: number | undefined;
    netPnlDelta: number | undefined;
    consecutiveRises: number;
    netPnl: number;
    tradeCount: number;
    fees: number;
    spreadCost: number;
    slippageCost: number;
    maxDrawdown: number;
    missedProfitablePnl: number;
}

export interface DogeBaselineRegimeResearchSummary {
    windows: number;
    activeWindows: number;
    profitableWindows: number;
    losingWindows: number;
    netPnl: number;
    missedProfitablePnl: number;
    tradeCount: number;
    fees: number;
    spreadCost: number;
    slippageCost: number;
    maxDrawdown: number;
}

export interface DogeBaselineRegimeResearchPolicyResult {
    policy: DogeBaselineRegimeResearchPolicy;
    windows: DogeBaselineRegimeResearchWindow[];
    selection: DogeBaselineRegimeResearchSummary;
    validation: DogeBaselineRegimeResearchSummary;
}

export interface DogeBaselineRegimeResearchResult {
    requiredFrames: number;
    availableFrames: number;
    refreshFrames: number;
    trainingFrames: number;
    replayFrames: number;
    policies: DogeBaselineRegimeResearchPolicyResult[];
    baseline: DogeBaselineRegimeResearchPolicy;
    selected: DogeBaselineRegimeResearchPolicyResult | undefined;
}

interface DogeBaselineRegimeResearchArtifacts {
    model: DogeBaselineModel;
    config: DogeBaselineStrategyConfig;
}

interface DogeBaselineEligibleHistoryFrame {
    historyPosition: number;
    observation: DogeBaselineObservation;
}

export interface DogeBaselineRegimeResearchInputs {
    frames: readonly HistoryFrameV3[];
    trainingFrames: number;
    replayFrames: number;
    refreshFrames: number;
    executionConfig: ReplayExecutionConfig;
    tradeValue: number;
    selectArtifacts: (
        observations: readonly DogeBaselineObservation[],
        training: readonly HistoryFrameV3[],
        replay: readonly HistoryFrameV3[],
        working: DogeBaselineRegimeResearchArtifacts | undefined,
        config: ReplayExecutionConfig,
        tradeValue: number,
    ) => {
        selected: DogeBaselineRegimeResearchArtifacts;
        evaluation: DogeBaselineConfigurationEvaluation | undefined;
    };
}

export interface DogeBaselineRegimeHistoryResearchInputs extends Omit<DogeBaselineRegimeResearchInputs, 'frames'> {
    historyDirectory: string;
}

interface PolicyState {
    tradingEnabled: boolean;
    previous: { point: DogeBaselineEvaluationTradingPoint; state: DogeBaselineEvaluationTradingState } | undefined;
}

function makePolicy(
    minimumNetPnlPerReplayFrame: number,
    trendStepPerReplayFrame: number,
    minimumConsecutiveRises: number,
): DogeBaselineRegimeResearchPolicy {
    return {
        id: `minimum${minimumNetPnlPerReplayFrame.toFixed(2)}-trend${trendStepPerReplayFrame.toFixed(2)}-rises${minimumConsecutiveRises}`,
        minimumNetPnlPerReplayFrame,
        trendStepPerReplayFrame,
        minimumConsecutiveRises,
    };
}

export function getDogeBaselineRegimeResearchPolicies(): readonly DogeBaselineRegimeResearchPolicy[] {
    return Object.freeze(
        DOGE_BASELINE_MINIMUM_TRADING_NET_PNL_PER_REPLAY_FRAME_VALUES.flatMap(minimum =>
            DOGE_BASELINE_TRADING_NET_PNL_TREND_PER_REPLAY_FRAME_VALUES.flatMap(trend =>
                DOGE_BASELINE_MINIMUM_CONSECUTIVE_RISES_VALUES.map(rises => makePolicy(minimum, trend, rises)),
            ),
        ),
    );
}

export function getDogeBaselineRegimeResearchBaseline(): DogeBaselineRegimeResearchPolicy {
    return makePolicy(
        DOGE_BASELINE_DEFAULT_MINIMUM_TRADING_NET_PNL_PER_REPLAY_FRAME,
        DOGE_BASELINE_DEFAULT_TRADING_NET_PNL_TREND_PER_REPLAY_FRAME,
        DOGE_BASELINE_DEFAULT_MINIMUM_CONSECUTIVE_RISES,
    );
}

function getSummary(windows: readonly DogeBaselineRegimeResearchWindow[]): DogeBaselineRegimeResearchSummary {
    const active = windows.filter(window => window.tradingEnabled);
    let cumulativeNetPnl = 0;
    let cumulativePeak = 0;
    let maxDrawdown = 0;
    for (const window of active) {
        cumulativeNetPnl += window.netPnl;
        cumulativePeak = Math.max(cumulativePeak, cumulativeNetPnl);
        maxDrawdown = Math.max(maxDrawdown, cumulativePeak - cumulativeNetPnl);
    }
    return {
        windows: windows.length,
        activeWindows: active.length,
        profitableWindows: active.filter(window => window.netPnl > 0).length,
        losingWindows: active.filter(window => window.netPnl < 0).length,
        netPnl: cumulativeNetPnl,
        missedProfitablePnl: windows.filter(window => !window.tradingEnabled)
            .reduce((total, window) => total + window.missedProfitablePnl, 0),
        tradeCount: active.reduce((total, window) => total + window.tradeCount, 0),
        fees: active.reduce((total, window) => total + window.fees, 0),
        spreadCost: active.reduce((total, window) => total + window.spreadCost, 0),
        slippageCost: active.reduce((total, window) => total + window.slippageCost, 0),
        maxDrawdown,
    };
}

function decide(
    state: Readonly<PolicyState>,
    policy: Readonly<DogeBaselineRegimeResearchPolicy>,
    evaluation: Readonly<DogeBaselineConfigurationEvaluation> | undefined,
): { state: PolicyState; selectedNetPnl: number | undefined; previousNetPnl: number | undefined; netPnlDelta: number | undefined; consecutiveRises: number } {
    if (evaluation === undefined) return {
        state: { tradingEnabled: state.tradingEnabled, previous: state.previous },
        selectedNetPnl: undefined, previousNetPnl: undefined, netPnlDelta: undefined,
        consecutiveRises: state.previous?.state.consecutiveRises ?? 0,
    };
    const current = getDogeBaselineEvaluationTradingPoint(evaluation);
    const comparable = areDogeBaselineEvaluationTradingPointsComparable(state.previous?.point, current);
    const previousNetPnl = comparable ? state.previous!.point.netPnl : undefined;
    const netPnlDelta = comparable ? current.netPnl - state.previous!.point.netPnl : undefined;
    const minimumNetPnl = current.replayFrames * policy.minimumNetPnlPerReplayFrame;
    const trendStep = current.replayFrames * policy.trendStepPerReplayFrame;
    let consecutiveRises = netPnlDelta !== undefined && netPnlDelta >= trendStep
        ? state.previous!.state.consecutiveRises + 1
        : 0;
    let tradingEnabled = state.tradingEnabled;
    if (evaluation.combinations.every(value => value.replayMetrics.net_pnl <= 0)) {
        tradingEnabled = false;
        consecutiveRises = 0;
    } else if (current.netPnl < minimumNetPnl) {
        tradingEnabled = false;
    } else if (netPnlDelta === undefined) {
        consecutiveRises = 0;
    } else if (netPnlDelta <= -trendStep) {
        tradingEnabled = false;
        consecutiveRises = 0;
    } else if (!tradingEnabled && consecutiveRises >= policy.minimumConsecutiveRises) {
        tradingEnabled = true;
    }
    return {
        state: { tradingEnabled, previous: { point: current, state: { consecutiveRises } } },
        selectedNetPnl: current.netPnl,
        previousNetPnl,
        netPnlDelta,
        consecutiveRises,
    };
}

function getReplayMetrics(
    frames: readonly HistoryFrameV3[],
    artifacts: Readonly<{ model: DogeBaselineModel; config: DogeBaselineStrategyConfig }>,
    config: Readonly<ReplayExecutionConfig>,
    tradeValue: number,
): ReplayMetrics {
    return runDogeBaselineReplay(frames, artifacts.model, config, {
        ...toDogeBaselineRuntimeConfig(artifacts.config),
        tradeValue,
    }).combined.metrics;
}

function isPolicyEligible(
    candidate: Readonly<DogeBaselineRegimeResearchPolicyResult>,
    baseline: Readonly<DogeBaselineRegimeResearchPolicyResult>,
): boolean {
    const value = candidate.validation;
    return value.netPnl > 0 && value.maxDrawdown <= baseline.validation.maxDrawdown &&
        value.profitableWindows >= Math.ceil(value.activeWindows / 2);
}

function comparePolicyResults(
    left: Readonly<DogeBaselineRegimeResearchPolicyResult>,
    right: Readonly<DogeBaselineRegimeResearchPolicyResult>,
): number {
    if (left.selection.netPnl !== right.selection.netPnl) return right.selection.netPnl - left.selection.netPnl;
    if (left.selection.profitableWindows !== right.selection.profitableWindows) {
        return right.selection.profitableWindows - left.selection.profitableWindows;
    }
    if (left.selection.maxDrawdown !== right.selection.maxDrawdown) return left.selection.maxDrawdown - right.selection.maxDrawdown;
    const leftCosts = left.selection.fees + left.selection.spreadCost + left.selection.slippageCost;
    const rightCosts = right.selection.fees + right.selection.spreadCost + right.selection.slippageCost;
    return leftCosts - rightCosts;
}

export function runDogeBaselineRegimeResearch(inputs: Readonly<DogeBaselineRegimeResearchInputs>): DogeBaselineRegimeResearchResult {
    const eligible = inputs.frames.map(frame => ({ frame, observation: makeDogeBaselineObservation(frame) }))
        .filter((value): value is { frame: HistoryFrameV3; observation: DogeBaselineObservation } => value.observation !== undefined);
    const minimumWindows = 12;
    const requiredFrames = inputs.trainingFrames + inputs.replayFrames + inputs.refreshFrames * minimumWindows;
    if (eligible.length < requiredFrames) {
        throw new Error(`Insufficient eligible DOGE frames: required=${requiredFrames} available=${eligible.length} ` +
            `training=${inputs.trainingFrames} replay=${inputs.replayFrames} forward=${inputs.refreshFrames * minimumWindows}`);
    }
    const baselinePolicy = getDogeBaselineRegimeResearchBaseline();
    const policies = [baselinePolicy, ...getDogeBaselineRegimeResearchPolicies()
        .filter(policy => policy.id !== baselinePolicy.id)];
    const windows = new Map(policies.map(policy => [policy.id, [] as DogeBaselineRegimeResearchWindow[]]));
    const states = new Map(policies.map(policy => [policy.id, { tradingEnabled: true, previous: undefined } as PolicyState]));
    let working: DogeBaselineRegimeResearchArtifacts | undefined;
    for (let cursor = inputs.trainingFrames + inputs.replayFrames;
        cursor + inputs.refreshFrames <= eligible.length;
        cursor += inputs.refreshFrames) {
        const training = eligible.slice(cursor - inputs.trainingFrames - inputs.replayFrames, cursor - inputs.replayFrames);
        const replay = eligible.slice(cursor - inputs.replayFrames, cursor);
        const future = eligible.slice(cursor, cursor + inputs.refreshFrames);
        const selection = inputs.selectArtifacts(
            training.map(value => value.observation),
            training.map(value => compactDogeBaselineConfigurationFrame(value.frame)),
            replay.map(value => value.frame),
            working,
            inputs.executionConfig,
            inputs.tradeValue,
        );
        working = selection.selected;
        const forwardMetrics = getReplayMetrics(future.map(value => value.frame), working, inputs.executionConfig, inputs.tradeValue);
        for (const policy of policies) {
            const decision = decide(states.get(policy.id)!, policy, selection.evaluation);
            states.set(policy.id, decision.state);
            const metrics = decision.state.tradingEnabled ? forwardMetrics : undefined;
            windows.get(policy.id)!.push({
                firstFrameStart: future[0]!.frame.start_time,
                lastFrameStart: future.at(-1)!.frame.start_time,
                tradingEnabled: decision.state.tradingEnabled,
                selectedNetPnl: decision.selectedNetPnl,
                previousNetPnl: decision.previousNetPnl,
                netPnlDelta: decision.netPnlDelta,
                consecutiveRises: decision.consecutiveRises,
                netPnl: metrics?.net_pnl ?? 0,
                tradeCount: metrics?.trade_count ?? 0,
                fees: metrics?.fees ?? 0,
                spreadCost: metrics?.spread_cost ?? 0,
                slippageCost: metrics?.slippage_cost ?? 0,
                maxDrawdown: metrics?.max_drawdown ?? 0,
                missedProfitablePnl: metrics === undefined && forwardMetrics.net_pnl > 0 ? forwardMetrics.net_pnl : 0,
            });
        }
    }
    const results = policies.map(policy => {
        const values = windows.get(policy.id)!;
        const midpoint = Math.floor(values.length / 2);
        return { policy, windows: values, selection: getSummary(values.slice(0, midpoint)), validation: getSummary(values.slice(midpoint)) };
    });
    const baseline = results[0]!;
    const selected = results.filter(result => isPolicyEligible(result, baseline)).sort(comparePolicyResults)[0];
    return {
        requiredFrames,
        availableFrames: eligible.length,
        refreshFrames: inputs.refreshFrames,
        trainingFrames: inputs.trainingFrames,
        replayFrames: inputs.replayFrames,
        policies: results,
        baseline: baseline.policy,
        selected,
    };
}

/**
 * Runs the same walk-forward calculation as runDogeBaselineRegimeResearch without
 * retaining the full parsed history. Only the bounded training/replay/future
 * windows are resident while frames themselves remain compressed on disk.
 */
export async function runDogeBaselineRegimeHistoryResearch(
    inputs: Readonly<DogeBaselineRegimeHistoryResearchInputs>,
): Promise<DogeBaselineRegimeResearchResult> {
    const index = await getHistoryFrameIndex(inputs.historyDirectory);
    const eligible: DogeBaselineEligibleHistoryFrame[] = [];
    for (let position = 0; position < index.length; position++) {
        const frame = await index.read(position);
        if (frame === undefined) continue;
        const observation = makeDogeBaselineObservation(frame);
        if (observation !== undefined) eligible.push({ historyPosition: position, observation });
    }
    const minimumWindows = 12;
    const requiredFrames = inputs.trainingFrames + inputs.replayFrames + inputs.refreshFrames * minimumWindows;
    if (eligible.length < requiredFrames) {
        throw new Error(`Insufficient eligible DOGE frames: required=${requiredFrames} available=${eligible.length} ` +
            `training=${inputs.trainingFrames} replay=${inputs.replayFrames} forward=${inputs.refreshFrames * minimumWindows}`);
    }

    const readEligible = async (position: number): Promise<HistoryFrameV3> => {
        const descriptor = eligible[position];
        const frame = descriptor === undefined ? undefined : await index.read(descriptor.historyPosition);
        if (frame === undefined) throw new Error(`history_frame_disappeared_during_regime_research: ${position}`);
        return frame;
    };
    const training = new HistoryFrameRollingWindow(inputs.trainingFrames, compactDogeBaselineConfigurationFrame);
    const replay = new HistoryFrameRollingWindow(inputs.replayFrames, value => value);
    const future = new HistoryFrameRollingWindow(inputs.refreshFrames, value => value);
    const trainingObservations: DogeBaselineObservation[] = [];
    for (let position = 0; position < inputs.trainingFrames; position++) {
        training.push(await readEligible(position));
        trainingObservations.push(eligible[position]!.observation);
    }
    for (let position = inputs.trainingFrames; position < inputs.trainingFrames + inputs.replayFrames; position++) {
        replay.push(await readEligible(position));
    }
    let cursor = inputs.trainingFrames + inputs.replayFrames;
    for (let position = cursor; position < cursor + inputs.refreshFrames; position++) future.push(await readEligible(position));

    const baselinePolicy = getDogeBaselineRegimeResearchBaseline();
    const policies = [baselinePolicy, ...getDogeBaselineRegimeResearchPolicies()
        .filter(policy => policy.id !== baselinePolicy.id)];
    const windows = new Map(policies.map(policy => [policy.id, [] as DogeBaselineRegimeResearchWindow[]]));
    const states = new Map(policies.map(policy => [policy.id, { tradingEnabled: true, previous: undefined } as PolicyState]));
    let working: DogeBaselineRegimeResearchArtifacts | undefined;

    while (cursor + inputs.refreshFrames <= eligible.length) {
        const selection = inputs.selectArtifacts(
            trainingObservations,
            training.values(),
            replay.values(),
            working,
            inputs.executionConfig,
            inputs.tradeValue,
        );
        working = selection.selected;
        const futureFrames = future.values();
        const forwardMetrics = getReplayMetrics(futureFrames, working, inputs.executionConfig, inputs.tradeValue);
        for (const policy of policies) {
            const decision = decide(states.get(policy.id)!, policy, selection.evaluation);
            states.set(policy.id, decision.state);
            const metrics = decision.state.tradingEnabled ? forwardMetrics : undefined;
            windows.get(policy.id)!.push({
                firstFrameStart: futureFrames[0]!.start_time,
                lastFrameStart: futureFrames.at(-1)!.start_time,
                tradingEnabled: decision.state.tradingEnabled,
                selectedNetPnl: decision.selectedNetPnl,
                previousNetPnl: decision.previousNetPnl,
                netPnlDelta: decision.netPnlDelta,
                consecutiveRises: decision.consecutiveRises,
                netPnl: metrics?.net_pnl ?? 0,
                tradeCount: metrics?.trade_count ?? 0,
                fees: metrics?.fees ?? 0,
                spreadCost: metrics?.spread_cost ?? 0,
                slippageCost: metrics?.slippage_cost ?? 0,
                maxDrawdown: metrics?.max_drawdown ?? 0,
                missedProfitablePnl: metrics === undefined && forwardMetrics.net_pnl > 0 ? forwardMetrics.net_pnl : 0,
            });
        }
        if (cursor + inputs.refreshFrames * 2 > eligible.length) break;
        const promoted = replay.shift(inputs.refreshFrames);
        training.shift(inputs.refreshFrames);
        trainingObservations.splice(0, inputs.refreshFrames);
        for (let offset = 0; offset < promoted.length; offset++) {
            training.push(promoted[offset]!);
            trainingObservations.push(eligible[cursor - inputs.replayFrames + offset]!.observation);
        }
        for (const frame of future.shift(inputs.refreshFrames)) replay.push(frame);
        cursor += inputs.refreshFrames;
        for (let position = cursor; position < cursor + inputs.refreshFrames; position++) {
            future.push(await readEligible(position));
        }
    }
    const results = policies.map(policy => {
        const values = windows.get(policy.id)!;
        const midpoint = Math.floor(values.length / 2);
        return { policy, windows: values, selection: getSummary(values.slice(0, midpoint)), validation: getSummary(values.slice(midpoint)) };
    });
    const baseline = results[0]!;
    const selected = results.filter(result => isPolicyEligible(result, baseline)).sort(comparePolicyResults)[0];
    return {
        requiredFrames,
        availableFrames: eligible.length,
        refreshFrames: inputs.refreshFrames,
        trainingFrames: inputs.trainingFrames,
        replayFrames: inputs.replayFrames,
        policies: results,
        baseline: baseline.policy,
        selected,
    };
}
