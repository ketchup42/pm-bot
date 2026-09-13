import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ReplayExecutionConfig, ReplayMetrics, runReplay } from '../../../backtest/replay.js';
import { DogeBaselineReplayStrategy } from '../../../backtest/strategy/DogeBaselineReplayStrategy.js';
import { HistoryFrameV3 } from '../../../history/history_frame.js';
import {
    DOGE_BASELINE_CANDIDATE_MAXIMUM_BRIER_SCORE,
    DOGE_BASELINE_CANDIDATE_MAXIMUM_PNL_UNDERPERFORMANCE_RATIO,
    DOGE_BASELINE_CANDIDATE_MAXIMUM_TRADE_COUNT,
    DOGE_BASELINE_CANDIDATE_MINIMUM_ACCURACY,
    DOGE_BASELINE_CANDIDATE_MINIMUM_TRADE_COUNT,
    DOGE_BASELINE_CANDIDATE_MINIMUM_TRADE_RATIO,
    DOGE_BASELINE_LATEST_EVALUATION_FILE,
    DOGE_BASELINE_MODES,
    DogeBaselineModeName,
} from './DogeBaselineConfig.js';
import { DogeBaselineModel, DogeBaselineObservation, getDogeBaselineArtifactPath, makeDogeBaselineObservation } from './DogeBaselineModel.js';
import { DogeBaselineTrainingMetrics, calculateDogeBaselineTrainingMetrics } from './DogeBaselineResearch.js';
import { DogeBaselineStrategyConfig, toDogeBaselineRuntimeConfig } from './artifacts.js';

export interface DogeBaselineEvaluationModel {
    trainedAt: number;
    validationMetrics: Record<DogeBaselineModeName, DogeBaselineTrainingMetrics>;
    replayMetrics: ReplayMetrics;
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
    replayConfig: ReplayExecutionConfig;
    combinations: DogeBaselineEvaluationCombination[];
    selected: DogeBaselineEvaluationCombination;
    promoted: boolean;
    reasons: DogeBaselineCandidateRejectionReason[];
}

export type DogeBaselineCandidateRejectionReason =
    | 'candidate_trade_count_below_minimum'
    | 'candidate_net_pnl_not_positive'
    | 'candidate_net_pnl_significantly_below_working'
    | 'candidate_profit_factor_not_above_one'
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
): DogeBaselineEvaluationModel {
    const replay = runReplay(frames, new DogeBaselineReplayStrategy(
        model, toDogeBaselineRuntimeConfig(strategyConfig),
    ), config);
    return {
        trainedAt: model.trainedAt,
        validationMetrics: Object.fromEntries(DOGE_BASELINE_MODES.map(mode => [
            mode.name,
            calculateDogeBaselineTrainingMetrics(observations, model, mode.name),
        ])) as Record<DogeBaselineModeName, DogeBaselineTrainingMetrics>,
        replayMetrics: replay.metrics,
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
            exit: { ...strategyConfig.exit },
        },
        ...createEvaluationModel(frames, observations, model, config, strategyConfig),
    }));
    const baseline = combinations[0]!;
    const candidates = combinations.slice(1).map(value => ({
        value,
        reasons: getDogeBaselineCandidateRejectionReasons(
            frames.length, baseline, value, value.model === 'candidate',
        ),
    }));
    const accepted = candidates.filter(value => value.reasons.length === 0).map(value => value.value);
    const selected = [baseline, ...accepted].sort((left, right) => right.replayMetrics.net_pnl - left.replayMetrics.net_pnl)[0]!;
    const selectedReasons = candidates.find(value => value.value.id === selected.id)?.reasons ?? [];
    return {
        trainingFrames, replayFrames: frames.length,
        replayFirstFrameStart: frames[0]!.start_time, replayLastFrameStart: frames.at(-1)!.start_time,
        minimumCandidateTradeCount: getDogeBaselineMinimumCandidateTradeCount(frames.length), replayConfig: { ...config },
        combinations, selected, promoted: selected.id !== 'working-current', reasons: selectedReasons,
    };
}

export function getDogeBaselineMinimumCandidateTradeCount(replayFrames: number): number {
    return Math.min(DOGE_BASELINE_CANDIDATE_MAXIMUM_TRADE_COUNT, Math.max(
        DOGE_BASELINE_CANDIDATE_MINIMUM_TRADE_COUNT,
        Math.ceil(replayFrames * DOGE_BASELINE_CANDIDATE_MINIMUM_TRADE_RATIO),
    ));
}

export function getDogeBaselineCandidateRejectionReasons(
    replayFrames: number,
    working: Readonly<DogeBaselineEvaluationModel>,
    candidate: Readonly<DogeBaselineEvaluationModel>,
    requireModelQuality: boolean = true,
): DogeBaselineCandidateRejectionReason[] {
    const reasons: DogeBaselineCandidateRejectionReason[] = [];
    const metrics = candidate.replayMetrics;
    if (metrics.trade_count < getDogeBaselineMinimumCandidateTradeCount(replayFrames)) reasons.push('candidate_trade_count_below_minimum');
    if (metrics.net_pnl <= 0) reasons.push('candidate_net_pnl_not_positive');
    if (working.replayMetrics.net_pnl > 0 && metrics.net_pnl < working.replayMetrics.net_pnl *
        (1 - DOGE_BASELINE_CANDIDATE_MAXIMUM_PNL_UNDERPERFORMANCE_RATIO)) reasons.push('candidate_net_pnl_significantly_below_working');
    if (metrics.profit_factor === undefined || metrics.profit_factor <= 1) reasons.push('candidate_profit_factor_not_above_one');
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

export async function writeDogeBaselineEvaluation(evaluation: Readonly<DogeBaselineConfigurationEvaluation>): Promise<void> {
    const filePath = getDogeBaselineEvaluationPath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}-${Date.now()}.tmp`;
    try {
        await fs.writeFile(temporary, `${JSON.stringify(evaluation, undefined, 2)}\n`, { flag: 'wx' });
        await fs.rename(temporary, filePath);
    } catch (error) {
        await fs.unlink(temporary).catch(() => {});
        throw error;
    }
}
