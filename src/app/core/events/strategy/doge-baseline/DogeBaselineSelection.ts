import type { ReplayExecutionConfig } from '../../../backtest/replay.js';
import type { HistoryFrameV3 } from '../../../history/history_frame.js';
import { createDogeBaselineStrategyConfig, rebindDogeBaselineStrategyConfig, type DogeBaselineStrategyConfig } from './artifacts.js';
import { evaluateDogeBaselineModelConfigurations, type DogeBaselineConfigurationEvaluation } from './DogeBaselineEvaluation.js';
import { buildDogeBaselineModel } from './DogeBaselineResearch.js';
import type { DogeBaselineModel, DogeBaselineObservation } from './DogeBaselineModel.js';
import { researchDogeBaselineConfigMatrix } from './research_matrix.js';

/** A model/config pair considered by refresh and chronological regime research. */
export interface DogeBaselineRefreshArtifacts {
    model: DogeBaselineModel;
    config: DogeBaselineStrategyConfig;
}

export interface DogeBaselineRefreshSelection {
    candidate: DogeBaselineModel;
    selected: DogeBaselineRefreshArtifacts;
    evaluation: DogeBaselineConfigurationEvaluation | undefined;
}

/** Pure model/config selection shared by live refresh and historical regime research. */
export function selectDogeBaselineRefreshArtifacts(
    trainingObservations: readonly DogeBaselineObservation[],
    trainingFrames: readonly HistoryFrameV3[],
    replay: readonly HistoryFrameV3[],
    working: Readonly<DogeBaselineRefreshArtifacts> | undefined,
    executionConfig: Readonly<ReplayExecutionConfig>,
    tradeValue: number,
): DogeBaselineRefreshSelection {
    const candidate = buildDogeBaselineModel(trainingObservations);
    if (working === undefined) {
        const selected = researchDogeBaselineConfigMatrix(
            trainingFrames, candidate, executionConfig, createDogeBaselineStrategyConfig(candidate), tradeValue,
        ).selected.config;
        return { candidate, selected: { model: candidate, config: selected }, evaluation: undefined };
    }
    const workingMatrix = researchDogeBaselineConfigMatrix(
        trainingFrames, working.model, executionConfig, working.config, tradeValue,
    );
    const candidateCurrent = rebindDogeBaselineStrategyConfig(candidate, working.config);
    const candidateMatrix = researchDogeBaselineConfigMatrix(
        trainingFrames, candidate, executionConfig, candidateCurrent, tradeValue,
    );
    const evaluation = evaluateDogeBaselineModelConfigurations(
        trainingObservations.length,
        replay,
        working.model,
        working.config,
        workingMatrix.selected.config,
        candidate,
        candidateCurrent,
        candidateMatrix.selected.config,
        executionConfig,
        tradeValue,
    );
    return {
        candidate,
        selected: evaluation.selected.model === 'working'
            ? { model: working.model, config: evaluation.selected.strategyConfig }
            : { model: candidate, config: evaluation.selected.strategyConfig },
        evaluation,
    };
}
