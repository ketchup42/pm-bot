import { logger } from '../log.js';
import { getFrameDurationMs, isEventFrame, waitFrameStartMsUntil } from '../market/frame.js';
import { delay, error_str, killSignalsHook } from '../utils.js';
import { readArgument, readPositiveIntegerArgument, readReplayExecutionConfig } from './cli_args.js';
import { DEFAULT_HISTORY_DIRECTORY } from './defaults.js';
import {
    DOGE_BASELINE_CANDIDATE_MODEL_FILE,
    DOGE_BASELINE_DEFAULT_BALANCE,
    DOGE_BASELINE_DEFAULT_REPLAY_LATENCY_MS,
    getDogeBaselineEntrySummary,
} from './core/events/strategy/doge-baseline/DogeBaselineConfig.js';
import {
    buildDogeBaselineModel,
    readDogeBaselineTrainReplaySplit,
} from './core/events/strategy/doge-baseline/DogeBaselineResearch.js';
import {
    type DogeBaselineModel,
    type DogeBaselineObservation,
    getDogeBaselineArtifactPath,
    readDogeBaselineModel,
    writeDogeBaselineModel,
} from './core/events/strategy/doge-baseline/DogeBaselineModel.js';
import {
    createDogeBaselineStrategyConfig,
    readDogeBaselineStrategyConfigOrDefault,
    rebindDogeBaselineStrategyConfig,
    type DogeBaselineStrategyConfig,
    type DogeBaselineRegimeSettings,
    writeDogeBaselineArtifacts,
    writeDogeBaselineStrategyConfig,
} from './core/events/strategy/doge-baseline/artifacts.js';
import { researchDogeBaselineConfigMatrix } from './core/events/strategy/doge-baseline/research_matrix.js';
import {
    type DogeBaselineConfigurationEvaluation,
    type DogeBaselineEvaluationTradingPoint,
    type DogeBaselineEvaluationTradingState,
    evaluateDogeBaselineModelConfigurations,
    getDogeBaselineEvaluationTradingPoint,
    readDogeBaselineEvaluationTradingState,
    writeDogeBaselineEvaluation,
} from './core/events/strategy/doge-baseline/DogeBaselineEvaluation.js';
import { DogeBaselineRefreshLock } from './core/events/strategy/doge-baseline/DogeBaselineRefreshLock.js';
import { settleHistoryDirectory } from './core/history/HistorySettlementService.js';
import { isFileMissingError } from '../file_lock.js';
import type { ReplayExecutionConfig } from './core/backtest/replay.js';
import type { HistoryFrameV3 } from './core/history/history_frame.js';

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
): DogeBaselineRefreshSelection {
    const candidate = buildDogeBaselineModel(trainingObservations);
    if (working === undefined) {
        const selected = researchDogeBaselineConfigMatrix(
            trainingFrames, candidate, executionConfig, createDogeBaselineStrategyConfig(candidate),
        ).selected.config;
        return { candidate, selected: { model: candidate, config: selected }, evaluation: undefined };
    }
    const workingMatrix = researchDogeBaselineConfigMatrix(
        trainingFrames, working.model, executionConfig, working.config,
    );
    const candidateCurrent = rebindDogeBaselineStrategyConfig(candidate, working.config);
    const candidateMatrix = researchDogeBaselineConfigMatrix(
        trainingFrames, candidate, executionConfig, candidateCurrent,
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
    );
    return {
        candidate,
        selected: evaluation.selected.model === 'working'
            ? { model: working.model, config: evaluation.selected.strategyConfig }
            : { model: candidate, config: evaluation.selected.strategyConfig },
        evaluation,
    };
}

async function readWorkingConfig(model: Readonly<DogeBaselineModel>) {
    const config = await readDogeBaselineStrategyConfigOrDefault(model);
    await writeDogeBaselineStrategyConfig(config, model);
    return config;
}

export function formatDogeBaselineRefreshSelection(
    evaluation: Pick<DogeBaselineConfigurationEvaluation, 'promoted' | 'replayFrames' | 'selected'>,
): string {
    const selected = evaluation.selected;
    const exit = selected.strategyConfig.exit;
    const details = `modes=${getDogeBaselineEntrySummary(selected.strategyConfig.entry)} ` +
        `exit=${exit.enabled ? `${exit.windowMs / 1_000}s/${(exit.deviationFactor * 100).toFixed(2)}%` : 'natural'} ` +
        `frames=${evaluation.replayFrames} netPnL=${selected.replayMetrics.net_pnl.toFixed(6)}`;
    if (!evaluation.promoted) {
        return `Working model and config retained: selected=${selected.id} ${details}`;
    }
    return `Published ${selected.id}: ${details}`;
}

export type DogeBaselineTradingRegimeReason =
    | 'all_combinations_non_positive'
    | 'selected_net_pnl_below_minimum'
    | 'selected_net_pnl_recovery_confirmed'
    | 'selected_net_pnl_recovery_pending'
    | 'selected_net_pnl_falling'
    | 'selected_net_pnl_stable'
    | 'no_comparable_previous_evaluation';

export interface DogeBaselineTradingRegimeDecision {
    tradingEnabled: boolean;
    reason: DogeBaselineTradingRegimeReason;
    selectedNetPnl: number;
    previousNetPnl: number | undefined;
    netPnlDelta: number | undefined;
    minimumNetPnl: number;
    trendStep: number;
    consecutiveRises: number;
    requiredConsecutiveRises: number;
}

function areDogeBaselineTradingPointsComparable(
    previous: Readonly<DogeBaselineEvaluationTradingPoint> | undefined,
    current: Readonly<DogeBaselineEvaluationTradingPoint>,
): previous is DogeBaselineEvaluationTradingPoint {
    return previous !== undefined && previous.replayFrames === current.replayFrames &&
        previous.initialBalance === current.initialBalance && previous.latencyMs === current.latencyMs;
}

function isDogeBaselineTradingRegimeComparable(
    previous: Readonly<DogeBaselineRegimeSettings> | undefined,
    current: Readonly<DogeBaselineRegimeSettings>,
): boolean {
    return previous !== undefined &&
        previous.minimumNetPnlPerReplayFrame === current.minimumNetPnlPerReplayFrame &&
        previous.trendStepPerReplayFrame === current.trendStepPerReplayFrame &&
        previous.minimumConsecutiveRises === current.minimumConsecutiveRises;
}

export function getDogeBaselineTradingRegimeDecision(
    currentTradingEnabled: boolean,
    evaluation: Pick<DogeBaselineConfigurationEvaluation, 'combinations' | 'replayFrames' | 'replayConfig' | 'selected'>,
    previous: Readonly<{ point: DogeBaselineEvaluationTradingPoint; state: DogeBaselineEvaluationTradingState }> | undefined,
    settings: Readonly<DogeBaselineRegimeSettings>,
): DogeBaselineTradingRegimeDecision {
    const current = getDogeBaselineEvaluationTradingPoint(evaluation);
    const minimumNetPnl = current.replayFrames * settings.minimumNetPnlPerReplayFrame;
    const trendStep = current.replayFrames * settings.trendStepPerReplayFrame;
    const previousComparable = areDogeBaselineTradingPointsComparable(previous?.point, current);
    const previousNetPnl = previousComparable ? previous.point.netPnl : undefined;
    const netPnlDelta = previousComparable ? current.netPnl - previous.point.netPnl : undefined;
    const previousRises = previousComparable && isDogeBaselineTradingRegimeComparable(previous?.state.regime, settings)
        ? previous!.state.consecutiveRises
        : 0;
    const rises = netPnlDelta !== undefined && netPnlDelta >= trendStep
        ? previousRises + 1
        : 0;
    const decisionBase = {
        selectedNetPnl: current.netPnl, previousNetPnl, netPnlDelta, minimumNetPnl, trendStep,
        consecutiveRises: rises, requiredConsecutiveRises: settings.minimumConsecutiveRises,
    };
    if (evaluation.combinations.length > 0 && evaluation.combinations.every(value => value.replayMetrics.net_pnl <= 0)) {
        return { tradingEnabled: false, reason: 'all_combinations_non_positive', ...decisionBase, consecutiveRises: 0 };
    }
    if (current.netPnl < minimumNetPnl) {
        return { tradingEnabled: false, reason: 'selected_net_pnl_below_minimum', ...decisionBase };
    }
    if (netPnlDelta === undefined) {
        return {
            tradingEnabled: currentTradingEnabled, reason: 'no_comparable_previous_evaluation',
            ...decisionBase,
        };
    }
    if (netPnlDelta <= -trendStep) {
        return { tradingEnabled: false, reason: 'selected_net_pnl_falling', ...decisionBase, consecutiveRises: 0 };
    }
    if (!currentTradingEnabled && rises >= settings.minimumConsecutiveRises) {
        return { tradingEnabled: true, reason: 'selected_net_pnl_recovery_confirmed', ...decisionBase };
    }
    if (!currentTradingEnabled && rises > 0) return { tradingEnabled: false, reason: 'selected_net_pnl_recovery_pending', ...decisionBase };
    return { tradingEnabled: currentTradingEnabled, reason: 'selected_net_pnl_stable', ...decisionBase };
}

export function formatDogeBaselineTradingRegimeDecision(
    decision: Readonly<DogeBaselineTradingRegimeDecision>,
): string {
    const previousNetPnl = decision.previousNetPnl?.toFixed(6) ?? 'none';
    const netPnlDelta = decision.netPnlDelta?.toFixed(6) ?? 'none';
    return `trading ${decision.tradingEnabled ? 'enabled' : 'paused'}: selectedNetPnL=${decision.selectedNetPnl.toFixed(6)} ` +
        `previousNetPnL=${previousNetPnl} delta=${netPnlDelta} minimumNetPnL=${decision.minimumNetPnl.toFixed(6)} ` +
        `trendStep=${decision.trendStep.toFixed(6)} rises=${decision.consecutiveRises}/${decision.requiredConsecutiveRises} ` +
        `reason=${decision.reason}`;
}

function withDogeBaselineTradingEnabled(
    model: Readonly<DogeBaselineModel>,
    config: Readonly<DogeBaselineStrategyConfig>,
    tradingEnabled: boolean,
): DogeBaselineStrategyConfig {
    return createDogeBaselineStrategyConfig(model, {
        tradingEnabled,
        regime: config.regime,
        entry: config.entry,
        exit: config.exit,
    });
}

async function refreshModel(
    history: string,
    trainFrames: number,
    replayFrames: number,
    shouldStop: () => boolean,
): Promise<string> {
    const executionConfig = readReplayExecutionConfig(
        DOGE_BASELINE_DEFAULT_BALANCE,
        DOGE_BASELINE_DEFAULT_REPLAY_LATENCY_MS,
    );
    const { trainingObservations, trainingFrames, replay } = await readDogeBaselineTrainReplaySplit(
        history, { trainingCount: trainFrames, replayCount: replayFrames }, shouldStop,
    );
    let workingModel;
    try {
        workingModel = await readDogeBaselineModel();
    } catch (error) {
        if (!isFileMissingError(error)) throw error;
    }
    const workingConfig = workingModel === undefined ? undefined : await readWorkingConfig(workingModel);
    const selection = selectDogeBaselineRefreshArtifacts(
        trainingObservations,
        trainingFrames,
        replay,
        workingModel === undefined || workingConfig === undefined ? undefined : { model: workingModel, config: workingConfig },
        executionConfig,
    );
    const { candidate, evaluation } = selection;
    await writeDogeBaselineModel(candidate, getDogeBaselineArtifactPath(DOGE_BASELINE_CANDIDATE_MODEL_FILE));
    if (evaluation === undefined) {
        await writeDogeBaselineArtifacts(candidate, selection.selected.config);
        return `Initial model and config published from ${candidate.actualFrames} frames`;
    }
    const working = { model: workingModel!, config: workingConfig! };
    const previousEvaluation = await readDogeBaselineEvaluationTradingState();
    const selectionMessage = formatDogeBaselineRefreshSelection(evaluation);
    const regime = getDogeBaselineTradingRegimeDecision(working.config.tradingEnabled, evaluation, previousEvaluation, working.config.regime);
    await writeDogeBaselineEvaluation(evaluation, {
        consecutiveRises: regime.consecutiveRises,
        regime: working.config.regime,
    });
    const regimeMessage = formatDogeBaselineTradingRegimeDecision(regime);
    const tradingEnabled = regime.tradingEnabled;
    if (!evaluation.promoted) {
        if (tradingEnabled !== working.config.tradingEnabled) {
            await writeDogeBaselineStrategyConfig(
                withDogeBaselineTradingEnabled(working.model, working.config, tradingEnabled),
                working.model,
            );
        }
        return `${selectionMessage}, ${regimeMessage}`;
    }

    if (evaluation.selected.model === 'working') {
        await writeDogeBaselineStrategyConfig(
            withDogeBaselineTradingEnabled(working.model, evaluation.selected.strategyConfig, tradingEnabled),
            working.model,
        );
    } else {
        await writeDogeBaselineArtifacts(
            candidate,
            withDogeBaselineTradingEnabled(candidate, evaluation.selected.strategyConfig, tradingEnabled),
        );
    }
    return `${selectionMessage}, ${regimeMessage}`;
}

export async function runDogeBaselineRefresh(): Promise<void> {
    const frameRaw = readArgument('frame');
    if (!frameRaw || !isEventFrame(frameRaw)) throw new Error('--frame must be a supported frame');
    const refreshFrames = readPositiveIntegerArgument('count');
    const trainFrames = readPositiveIntegerArgument('train-count');
    const replayFrames = readPositiveIntegerArgument('replay');
    const history = readArgument('history') ?? DEFAULT_HISTORY_DIRECTORY;
    const lock = await DogeBaselineRefreshLock.acquire();
    logger.info('[DogeBaselineRefresh] Refresh lock acquired');
    let stopped = false;
    const unsubscribe = killSignalsHook(() => {
        stopped = true;
        logger.info('[DogeBaselineRefresh] Shutdown signal received');
    });
    try {
        while (!stopped) {
            const settlement = await settleHistoryDirectory({ directory: history, shouldStop: () => stopped });
            logger.info(
                `[DogeBaselineRefresh] Settlement checked=${settlement.checked} updated=${settlement.updated} ` +
                `unresolved=${settlement.unresolved} disappeared=${settlement.disappeared} failed=${settlement.failed}`,
            );
            if (stopped) break;
            try {
                logger.info(`[DogeBaselineRefresh] ${await refreshModel(history, trainFrames, replayFrames, () => stopped)}`);
            } catch (error) {
                if (stopped) break;
                logger.error(`[DogeBaselineRefresh] Refresh failed, working artifacts retained: ${error_str(error)}`);
            }
            for (let index = 0; index < refreshFrames && !stopped; index++) {
                await waitFrameStartMsUntil(getFrameDurationMs(frameRaw), () => stopped);
                if (!stopped) await delay(1);
            }
        }
    } finally {
        unsubscribe();
        await lock.release();
        logger.info('[DogeBaselineRefresh] Refresh lock released');
    }
}
