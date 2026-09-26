import { HistoryFrameV3 } from '../../../history/history_frame.js';
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
    ) => {
        selected: DogeBaselineRegimeResearchArtifacts;
        evaluation: DogeBaselineConfigurationEvaluation | undefined;
    };
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

function areComparable(
    previous: Readonly<DogeBaselineEvaluationTradingPoint> | undefined,
    current: Readonly<DogeBaselineEvaluationTradingPoint>,
): previous is DogeBaselineEvaluationTradingPoint {
    return previous !== undefined && previous.replayFrames === current.replayFrames &&
        previous.initialBalance === current.initialBalance && previous.latencyMs === current.latencyMs;
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
    const comparable = areComparable(state.previous?.point, current);
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
