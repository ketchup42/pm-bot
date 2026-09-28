import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isFileMissingError } from '../../../../../file_lock.js';
import { ReplayExecutionConfig, ReplayMetrics, runReplay } from '../../../backtest/replay.js';
import {
    DogeBaselineEntryDecisionMetricsByMode,
    DogeBaselineReplayStrategy,
} from '../../../backtest/strategy/DogeBaselineReplayStrategy.js';
import { HistoryFrameV3 } from '../../../history/history_frame.js';
import {
    DOGE_BASELINE_CANDIDATE_MAXIMUM_BRIER_SCORE,
    DOGE_BASELINE_CANDIDATE_MAXIMUM_PNL_UNDERPERFORMANCE_RATIO,
    DOGE_BASELINE_CANDIDATE_MINIMUM_ACCURACY,
    DOGE_BASELINE_LATEST_EVALUATION_FILE,
    DOGE_BASELINE_DEFAULT_TRADE_VALUE,
    DOGE_BASELINE_MODES,
    DOGE_BASELINE_REPLAY_SEGMENT_MAXIMUM_FRAME_COUNT,
    DOGE_BASELINE_REPLAY_SEGMENT_MINIMUM_COUNT,
    DOGE_BASELINE_REPLAY_SEGMENT_MINIMUM_FRAME_COUNT,
    DOGE_BASELINE_REPLAY_SEGMENT_INITIAL_MINIMUM_PROFITABLE_RATIO,
    DOGE_BASELINE_REPLAY_SEGMENT_MAXIMUM_MINIMUM_PROFITABLE_RATIO,
    DOGE_BASELINE_REPLAY_SEGMENT_MAXIMUM_RATIO_FULL_SEGMENT_COUNT,
    DOGE_BASELINE_REPLAY_SEGMENT_MINIMUM_TRADE_COUNT,
    DOGE_BASELINE_REPLAY_SEGMENT_MINIMUM_TRADE_RATIO,
    DogeBaselineModeName,
    getDogeBaselineMinimumReplayTradeCount,
} from './DogeBaselineConfig.js';
import { DogeBaselineModel, DogeBaselineObservation, getDogeBaselineArtifactPath, makeDogeBaselineObservation } from './DogeBaselineModel.js';
import { DogeBaselineTrainingMetrics, calculateDogeBaselineTrainingMetrics } from './DogeBaselineResearch.js';
import {
    type DogeBaselineRegimeSettings,
    type DogeBaselineStrategyConfig,
    toDogeBaselineRuntimeConfig,
} from './artifacts.js';

export interface DogeBaselineEvaluationModel {
    trainedAt: number;
    validationMetrics: Record<DogeBaselineModeName, DogeBaselineTrainingMetrics>;
    replayMetrics: ReplayMetrics;
    replaySegments: DogeBaselineReplaySegment[];
    entryDecisions: DogeBaselineEntryDecisionMetricsByMode;
}

export interface DogeBaselineReplaySegment {
    firstFrameStart: number;
    lastFrameStart: number;
    frames: number;
    minimumTradeCount: number;
    tradeCount: number;
    netPnl: number;
    profitable: boolean;
}

export interface DogeBaselineEvaluationCombination extends DogeBaselineEvaluationModel {
    id: 'working-current' | 'working-selected' | 'candidate-current' | 'candidate-selected';
    model: 'working' | 'candidate';
    strategyConfig: DogeBaselineStrategyConfig;
}

export interface DogeBaselineConfigurationEvaluation {
    trainingFrames: number;
    replayFrames: number;
    replayFirstFrameStart: number;
    replayLastFrameStart: number;
    minimumCandidateTradeCount: number;
    minimumProfitableSegmentCount: number;
    replayConfig: ReplayExecutionConfig;
    tradeValue: number;
    combinations: DogeBaselineEvaluationCombination[];
    selected: DogeBaselineEvaluationCombination;
    promoted: boolean;
    reasons: DogeBaselineSelectionRejectionReason[];
    tradingRegime?: DogeBaselineEvaluationTradingState;
}

/** The subset of a persisted evaluation needed to compare consecutive replay PnL values. */
export interface DogeBaselineEvaluationTradingPoint {
    replayFrames: number;
    initialBalance: number;
    latencyMs: number;
    tradeValue: number | undefined;
    netPnl: number;
}

export function areDogeBaselineEvaluationTradingPointsComparable(
    previous: Readonly<DogeBaselineEvaluationTradingPoint> | undefined,
    current: Readonly<DogeBaselineEvaluationTradingPoint>,
): previous is DogeBaselineEvaluationTradingPoint {
    return previous !== undefined && previous.replayFrames === current.replayFrames &&
        previous.initialBalance === current.initialBalance && previous.latencyMs === current.latencyMs &&
        previous.tradeValue !== undefined && previous.tradeValue === current.tradeValue;
}

/** Persisted refresh-only state used to confirm a recovery across evaluations. */
export interface DogeBaselineEvaluationTradingState {
    consecutiveRises: number;
    regime?: DogeBaselineRegimeSettings;
    /** Last refresh decision, persisted for operational status only. */
    reason?: string;
}

export interface DogeBaselineEvaluationTradingPointSource {
    replayFrames: number;
    replayConfig: Pick<ReplayExecutionConfig, 'initial_balance' | 'latency_ms'>;
    tradeValue?: number;
    selected: { replayMetrics: Pick<ReplayMetrics, 'net_pnl'> };
}

export interface DogeBaselineEvaluationTradingStateSource {
    tradingRegime?: DogeBaselineEvaluationTradingState;
}

export type DogeBaselineSelectionRejectionReason =
    | 'candidate_trade_count_below_minimum'
    | 'candidate_net_pnl_not_positive'
    | 'candidate_net_pnl_significantly_below_working'
    | 'candidate_profit_factor_not_above_one'
    | 'candidate_profitable_segment_count_below_minimum'
    | `${DogeBaselineModeName}_accuracy_below_minimum`
    | `${DogeBaselineModeName}_brier_score_not_below_maximum`;

function getObservations(frames: readonly HistoryFrameV3[]): DogeBaselineObservation[] {
    if (frames.length === 0) throw new Error('doge_baseline_empty_replay_set');
    const observations = frames.map(makeDogeBaselineObservation).filter((value): value is DogeBaselineObservation => value !== undefined);
    if (observations.length !== frames.length) throw new Error('doge_baseline_invalid_replay_set');
    return observations;
}

function createEvaluationModel(
    frames: readonly HistoryFrameV3[],
    observations: readonly DogeBaselineObservation[],
    model: Readonly<DogeBaselineModel>,
    config: ReplayExecutionConfig,
    strategyConfig: Readonly<DogeBaselineStrategyConfig>,
    tradeValue: number,
): DogeBaselineEvaluationModel {
    const runtimeConfig = { ...toDogeBaselineRuntimeConfig(strategyConfig), tradeValue };
    const replayStrategy = new DogeBaselineReplayStrategy(model, runtimeConfig);
    const replay = runReplay(frames, replayStrategy, config);
    const replaySegments = splitDogeBaselineReplayFrames(frames).map(segment => {
        const metrics = runReplay(segment, new DogeBaselineReplayStrategy(model, runtimeConfig), config).metrics;
        const minimumTradeCount = getDogeBaselineMinimumSegmentTradeCount(segment.length);
        return {
            firstFrameStart: segment[0]!.start_time,
            lastFrameStart: segment.at(-1)!.start_time,
            frames: segment.length,
            minimumTradeCount,
            tradeCount: metrics.trade_count,
            netPnl: metrics.net_pnl,
            profitable: metrics.net_pnl > 0 && metrics.trade_count >= minimumTradeCount,
        };
    });
    return {
        trainedAt: model.trainedAt,
        validationMetrics: Object.fromEntries(DOGE_BASELINE_MODES.map(mode => [
            mode.name,
            calculateDogeBaselineTrainingMetrics(observations, model, mode.name),
        ])) as Record<DogeBaselineModeName, DogeBaselineTrainingMetrics>,
        replayMetrics: replay.metrics,
        replaySegments,
        entryDecisions: replayStrategy.getEntryDecisionMetrics(),
    };
}

export function evaluateDogeBaselineModelConfigurations(
    trainingFrames: number,
    frames: readonly HistoryFrameV3[],
    workingModel: Readonly<DogeBaselineModel>,
    workingCurrent: Readonly<DogeBaselineStrategyConfig>,
    workingSelected: Readonly<DogeBaselineStrategyConfig>,
    candidateModel: Readonly<DogeBaselineModel>,
    candidateCurrent: Readonly<DogeBaselineStrategyConfig>,
    candidateSelected: Readonly<DogeBaselineStrategyConfig>,
    config: ReplayExecutionConfig,
    tradeValue: number = DOGE_BASELINE_DEFAULT_TRADE_VALUE,
): DogeBaselineConfigurationEvaluation {
    const observations = getObservations(frames);
    const inputs = [
        ['working-current', 'working', workingModel, workingCurrent],
        ['working-selected', 'working', workingModel, workingSelected],
        ['candidate-current', 'candidate', candidateModel, candidateCurrent],
        ['candidate-selected', 'candidate', candidateModel, candidateSelected],
    ] as const;
    const combinations = inputs.map(([id, modelName, model, strategyConfig]) => ({
        id,
        model: modelName,
        strategyConfig: {
            ...strategyConfig,
            model: { ...strategyConfig.model },
            entry: {
                modes: Object.fromEntries(DOGE_BASELINE_MODES.map(mode => [
                    mode.name,
                    { ...strategyConfig.entry.modes[mode.name] },
                ])) as DogeBaselineStrategyConfig['entry']['modes'],
            },
            regime: { ...strategyConfig.regime },
            exit: { ...strategyConfig.exit },
        },
        ...createEvaluationModel(frames, observations, model, config, strategyConfig, tradeValue),
    }));
    const baseline = combinations[0]!;
    const candidates = combinations.slice(1).map(value => ({
        value,
        reasons: getDogeBaselineSelectionRejectionReasons(
            frames.length, baseline, value, value.model === 'candidate',
        ),
    }));
    const accepted = candidates.filter(value => value.reasons.length === 0).map(value => value.value);
    const selected = [baseline, ...accepted].sort((left, right) => right.replayMetrics.net_pnl - left.replayMetrics.net_pnl)[0]!;
    const selectedReasons = candidates.find(value => value.value.id === selected.id)?.reasons ?? [];
    return {
        trainingFrames, replayFrames: frames.length,
        replayFirstFrameStart: frames[0]!.start_time, replayLastFrameStart: frames.at(-1)!.start_time,
        minimumCandidateTradeCount: getDogeBaselineMinimumReplayTradeCount(frames.length),
        minimumProfitableSegmentCount: getDogeBaselineMinimumProfitableSegmentCount(frames.length),
        replayConfig: { ...config }, tradeValue,
        combinations, selected, promoted: selected.id !== 'working-current', reasons: selectedReasons,
    };
}

export function splitDogeBaselineReplayFrames(frames: readonly HistoryFrameV3[]): HistoryFrameV3[][] {
    if (frames.length === 0) return [];
    const segmentCount = getDogeBaselineReplaySegmentCount(frames.length);
    const baseSize = Math.floor(frames.length / segmentCount);
    const remainder = frames.length % segmentCount;
    const segments: HistoryFrameV3[][] = [];
    let start = 0;
    for (let index = 0; index < segmentCount; index++) {
        const size = baseSize + (index < remainder ? 1 : 0);
        segments.push(frames.slice(start, start + size));
        start += size;
    }
    return segments;
}

export function getDogeBaselineReplaySegmentCount(replayFrames: number): number {
    if (replayFrames <= 0) return 0;
    if (replayFrames < DOGE_BASELINE_REPLAY_SEGMENT_MINIMUM_FRAME_COUNT) return 1;
    return Math.min(
        Math.floor(replayFrames / DOGE_BASELINE_REPLAY_SEGMENT_MINIMUM_FRAME_COUNT),
        Math.max(
            DOGE_BASELINE_REPLAY_SEGMENT_MINIMUM_COUNT,
            Math.ceil(replayFrames / DOGE_BASELINE_REPLAY_SEGMENT_MAXIMUM_FRAME_COUNT),
        ),
    );
}

export function getDogeBaselineMinimumProfitableSegmentCount(replayFrames: number): number {
    const segmentCount = getDogeBaselineReplaySegmentCount(replayFrames);
    const fullSegmentCount = Math.floor(replayFrames / DOGE_BASELINE_REPLAY_SEGMENT_MAXIMUM_FRAME_COUNT);
    const ratioProgress = Math.min(1, Math.max(0,
        (fullSegmentCount - DOGE_BASELINE_REPLAY_SEGMENT_MINIMUM_COUNT) /
        (DOGE_BASELINE_REPLAY_SEGMENT_MAXIMUM_RATIO_FULL_SEGMENT_COUNT -
            DOGE_BASELINE_REPLAY_SEGMENT_MINIMUM_COUNT),
    ));
    const profitableRatio = DOGE_BASELINE_REPLAY_SEGMENT_INITIAL_MINIMUM_PROFITABLE_RATIO +
        (DOGE_BASELINE_REPLAY_SEGMENT_MAXIMUM_MINIMUM_PROFITABLE_RATIO -
            DOGE_BASELINE_REPLAY_SEGMENT_INITIAL_MINIMUM_PROFITABLE_RATIO) * ratioProgress;
    return Math.max(1, Math.ceil(segmentCount * profitableRatio));
}

export function getDogeBaselineMinimumSegmentTradeCount(segmentFrames: number): number {
    return Math.min(
        segmentFrames,
        Math.max(
            DOGE_BASELINE_REPLAY_SEGMENT_MINIMUM_TRADE_COUNT,
            Math.ceil(segmentFrames * DOGE_BASELINE_REPLAY_SEGMENT_MINIMUM_TRADE_RATIO),
        ),
    );
}

export function getDogeBaselineSelectionRejectionReasons(
    replayFrames: number,
    working: Readonly<DogeBaselineEvaluationModel>,
    candidate: Readonly<DogeBaselineEvaluationModel>,
    requireModelQuality: boolean = true,
): DogeBaselineSelectionRejectionReason[] {
    const reasons: DogeBaselineSelectionRejectionReason[] = [];
    const metrics = candidate.replayMetrics;
    if (metrics.trade_count < getDogeBaselineMinimumReplayTradeCount(replayFrames)) reasons.push('candidate_trade_count_below_minimum');
    if (metrics.net_pnl <= 0) reasons.push('candidate_net_pnl_not_positive');
    if (working.replayMetrics.net_pnl > 0 && metrics.net_pnl < working.replayMetrics.net_pnl *
        (1 - DOGE_BASELINE_CANDIDATE_MAXIMUM_PNL_UNDERPERFORMANCE_RATIO)) reasons.push('candidate_net_pnl_significantly_below_working');
    if (metrics.profit_factor === undefined || metrics.profit_factor <= 1) reasons.push('candidate_profit_factor_not_above_one');
    const profitableSegments = candidate.replaySegments.filter(segment => segment.profitable).length;
    if (profitableSegments < getDogeBaselineMinimumProfitableSegmentCount(replayFrames)) {
        reasons.push('candidate_profitable_segment_count_below_minimum');
    }
    if (requireModelQuality) for (const mode of DOGE_BASELINE_MODES) {
        const validation = candidate.validationMetrics[mode.name];
        if (validation.accuracy < DOGE_BASELINE_CANDIDATE_MINIMUM_ACCURACY) reasons.push(`${mode.name}_accuracy_below_minimum`);
        if (validation.brierScore >= DOGE_BASELINE_CANDIDATE_MAXIMUM_BRIER_SCORE) reasons.push(`${mode.name}_brier_score_not_below_maximum`);
    }
    return reasons;
}

export function getDogeBaselineEvaluationPath(): string {
    return getDogeBaselineArtifactPath(DOGE_BASELINE_LATEST_EVALUATION_FILE);
}

export function getDogeBaselineEvaluationTradingPoint(
    evaluation: Readonly<DogeBaselineEvaluationTradingPointSource>,
): DogeBaselineEvaluationTradingPoint {
    return {
        replayFrames: evaluation.replayFrames,
        initialBalance: evaluation.replayConfig.initial_balance,
        latencyMs: evaluation.replayConfig.latency_ms,
        tradeValue: evaluation.tradeValue,
        netPnl: evaluation.selected.replayMetrics.net_pnl,
    };
}

export function getDogeBaselineEvaluationTradingState(
    evaluation: Readonly<DogeBaselineEvaluationTradingStateSource>,
): DogeBaselineEvaluationTradingState {
    const consecutiveRises = evaluation.tradingRegime?.consecutiveRises ?? 0;
    if (!Number.isInteger(consecutiveRises) || consecutiveRises < 0) {
        throw new Error('invalid_doge_baseline_latest_evaluation_trading_regime');
    }
    const regime = evaluation.tradingRegime?.regime;
    if (regime !== undefined && (!Number.isFinite(regime.minimumNetPnlPerReplayFrame) ||
        regime.minimumNetPnlPerReplayFrame <= 0 || !Number.isFinite(regime.trendStepPerReplayFrame) ||
        regime.trendStepPerReplayFrame <= 0 || !Number.isInteger(regime.minimumConsecutiveRises) ||
        regime.minimumConsecutiveRises <= 0)) {
        throw new Error('invalid_doge_baseline_latest_evaluation_trading_regime');
    }
    const reason = evaluation.tradingRegime?.reason;
    if (reason !== undefined && (typeof reason !== 'string' || reason.length === 0)) {
        throw new Error('invalid_doge_baseline_latest_evaluation_trading_regime');
    }
    return {
        consecutiveRises,
        ...(regime === undefined ? {} : { regime: { ...regime } }),
        ...(reason === undefined ? {} : { reason }),
    };
}

function parseDogeBaselineEvaluationTradingPoint(value: unknown): DogeBaselineEvaluationTradingPoint {
    if (!value || typeof value !== 'object') throw new Error('invalid_doge_baseline_latest_evaluation');
    const evaluation = value as Partial<DogeBaselineConfigurationEvaluation>;
    const replayConfig = evaluation.replayConfig;
    const selected = evaluation.selected;
    const replayFrames = evaluation.replayFrames;
    const netPnl = selected?.replayMetrics?.net_pnl;
    if (typeof replayFrames !== 'number' || !Number.isInteger(replayFrames) || replayFrames <= 0 ||
        !replayConfig || !Number.isFinite(replayConfig.initial_balance) ||
        !Number.isInteger(replayConfig.latency_ms) || replayConfig.latency_ms < 0 ||
        typeof netPnl !== 'number' || !Number.isFinite(netPnl)) {
        throw new Error('invalid_doge_baseline_latest_evaluation');
    }
    const tradeValue = evaluation.tradeValue;
    if (tradeValue !== undefined && (!Number.isFinite(tradeValue) || tradeValue <= 0)) {
        throw new Error('invalid_doge_baseline_latest_evaluation');
    }
    const source: DogeBaselineEvaluationTradingPointSource = {
        replayFrames,
        replayConfig,
        ...(tradeValue === undefined ? {} : { tradeValue }),
        selected: { replayMetrics: { net_pnl: netPnl } },
    };
    const stateSource = evaluation.tradingRegime === undefined ? {} : { tradingRegime: evaluation.tradingRegime };
    getDogeBaselineEvaluationTradingState(stateSource);
    return getDogeBaselineEvaluationTradingPoint(source);
}

function parseDogeBaselineEvaluationTradingState(value: unknown): DogeBaselineEvaluationTradingState {
    if (!value || typeof value !== 'object') throw new Error('invalid_doge_baseline_latest_evaluation');
    const evaluation = value as Partial<DogeBaselineConfigurationEvaluation>;
    const source: DogeBaselineEvaluationTradingStateSource = {};
    if (evaluation.tradingRegime !== undefined) source.tradingRegime = evaluation.tradingRegime;
    return getDogeBaselineEvaluationTradingState(source);
}

/** Reads the previous refresh PnL point, if a refresh evaluation has been published before. */
export async function readDogeBaselineEvaluationTradingPoint(): Promise<DogeBaselineEvaluationTradingPoint | undefined> {
    try {
        return parseDogeBaselineEvaluationTradingPoint(
            JSON.parse(await fs.readFile(getDogeBaselineEvaluationPath(), 'utf8')) as unknown,
        );
    } catch (error) {
        if (isFileMissingError(error)) return undefined;
        throw error;
    }
}

/** Reads the previous refresh point and its recovery-confirmation state. */
export async function readDogeBaselineEvaluationTradingState(): Promise<
    { point: DogeBaselineEvaluationTradingPoint; state: DogeBaselineEvaluationTradingState } | undefined
> {
    try {
        const value: unknown = JSON.parse(await fs.readFile(getDogeBaselineEvaluationPath(), 'utf8')) as unknown;
        const point = parseDogeBaselineEvaluationTradingPoint(value);
        return { point, state: parseDogeBaselineEvaluationTradingState(value) };
    } catch (error) {
        if (isFileMissingError(error)) return undefined;
        throw error;
    }
}

export async function writeDogeBaselineEvaluation(
    evaluation: Readonly<DogeBaselineConfigurationEvaluation>,
    tradingRegime: Readonly<DogeBaselineEvaluationTradingState> | undefined = undefined,
): Promise<void> {
    const filePath = getDogeBaselineEvaluationPath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}-${Date.now()}.tmp`;
    try {
        const value = tradingRegime === undefined ? evaluation : { ...evaluation, tradingRegime };
        await fs.writeFile(temporary, `${JSON.stringify(value, undefined, 2)}\n`, { flag: 'wx' });
        await fs.rename(temporary, filePath);
    } catch (error) {
        await fs.unlink(temporary).catch(() => {});
        throw error;
    }
}
