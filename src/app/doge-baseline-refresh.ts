import { logger } from '../log.js';
import { getFrameDurationMs, isEventFrame, waitFrameStartMsUntil } from '../market/frame.js';
import { delay, error_str, killSignalsHook } from '../utils.js';
import { readArgument, readPositiveIntegerArgument, readReplayExecutionConfig } from './cli_args.js';
import { DEFAULT_HISTORY_DIRECTORY } from './defaults.js';
import {
    DOGE_BASELINE_CANDIDATE_MODEL_FILE,
    DOGE_BASELINE_DEFAULT_BALANCE,
    DOGE_BASELINE_DEFAULT_REPLAY_LATENCY_MS,
    DOGE_BASELINE_MINIMUM_TRADING_NET_PNL_PER_REPLAY_FRAME,
    DOGE_BASELINE_TRADING_NET_PNL_TREND_PER_REPLAY_FRAME,
    getDogeBaselineEntrySummary,
} from './core/events/strategy/doge-baseline/DogeBaselineConfig.js';
import { buildDogeBaselineModel, readDogeBaselineTrainReplaySplit } from './core/events/strategy/doge-baseline/DogeBaselineResearch.js';
import { type DogeBaselineModel, getDogeBaselineArtifactPath, readDogeBaselineModel, writeDogeBaselineModel } from './core/events/strategy/doge-baseline/DogeBaselineModel.js';
import {
    createDogeBaselineStrategyConfig,
    readDogeBaselineStrategyConfigOrDefault,
    rebindDogeBaselineStrategyConfig,
    type DogeBaselineStrategyConfig,
    writeDogeBaselineArtifacts,
    writeDogeBaselineStrategyConfig,
} from './core/events/strategy/doge-baseline/artifacts.js';
import { researchDogeBaselineConfigMatrix } from './core/events/strategy/doge-baseline/research_matrix.js';
import {
    type DogeBaselineConfigurationEvaluation,
    type DogeBaselineEvaluationTradingPoint,
    evaluateDogeBaselineModelConfigurations,
    getDogeBaselineEvaluationTradingPoint,
    readDogeBaselineEvaluationTradingPoint,
    writeDogeBaselineEvaluation,
} from './core/events/strategy/doge-baseline/DogeBaselineEvaluation.js';
import { DogeBaselineRefreshLock } from './core/events/strategy/doge-baseline/DogeBaselineRefreshLock.js';
import { settleHistoryDirectory } from './core/history/HistorySettlementService.js';
import { isFileMissingError } from '../file_lock.js';

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
    | 'selected_net_pnl_rising'
    | 'selected_net_pnl_falling'
    | 'selected_net_pnl_stably_above_minimum'
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
}

function areDogeBaselineTradingPointsComparable(
    previous: Readonly<DogeBaselineEvaluationTradingPoint> | undefined,
    current: Readonly<DogeBaselineEvaluationTradingPoint>,
): previous is DogeBaselineEvaluationTradingPoint {
    return previous !== undefined && previous.replayFrames === current.replayFrames &&
        previous.initialBalance === current.initialBalance && previous.latencyMs === current.latencyMs;
}

export function getDogeBaselineTradingRegimeDecision(
    currentTradingEnabled: boolean,
    evaluation: Pick<DogeBaselineConfigurationEvaluation, 'combinations' | 'replayFrames' | 'replayConfig' | 'selected'>,
    previous: Readonly<DogeBaselineEvaluationTradingPoint> | undefined,
): DogeBaselineTradingRegimeDecision {
    const current = getDogeBaselineEvaluationTradingPoint(evaluation);
    const minimumNetPnl = current.replayFrames * DOGE_BASELINE_MINIMUM_TRADING_NET_PNL_PER_REPLAY_FRAME;
    const trendStep = current.replayFrames * DOGE_BASELINE_TRADING_NET_PNL_TREND_PER_REPLAY_FRAME;
    const previousComparable = areDogeBaselineTradingPointsComparable(previous, current);
    const previousNetPnl = previousComparable ? previous.netPnl : undefined;
    const netPnlDelta = previousComparable ? current.netPnl - previous.netPnl : undefined;
    const decisionBase = { selectedNetPnl: current.netPnl, previousNetPnl, netPnlDelta, minimumNetPnl, trendStep };
    if (evaluation.combinations.length > 0 && evaluation.combinations.every(value => value.replayMetrics.net_pnl <= 0)) {
        return { tradingEnabled: false, reason: 'all_combinations_non_positive', ...decisionBase };
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
    if (netPnlDelta >= trendStep) {
        return { tradingEnabled: true, reason: 'selected_net_pnl_rising', ...decisionBase };
    }
    if (netPnlDelta <= -trendStep) {
        return { tradingEnabled: false, reason: 'selected_net_pnl_falling', ...decisionBase };
    }
    if (!currentTradingEnabled && previousNetPnl !== undefined && previousNetPnl >= minimumNetPnl) {
        return { tradingEnabled: true, reason: 'selected_net_pnl_stably_above_minimum', ...decisionBase };
    }
    return { tradingEnabled: currentTradingEnabled, reason: 'selected_net_pnl_stable', ...decisionBase };
}

export function formatDogeBaselineTradingRegimeDecision(
    decision: Readonly<DogeBaselineTradingRegimeDecision>,
): string {
    const previousNetPnl = decision.previousNetPnl?.toFixed(6) ?? 'none';
    const netPnlDelta = decision.netPnlDelta?.toFixed(6) ?? 'none';
    return `trading ${decision.tradingEnabled ? 'enabled' : 'paused'}: selectedNetPnL=${decision.selectedNetPnl.toFixed(6)} ` +
        `previousNetPnL=${previousNetPnl} delta=${netPnlDelta} minimumNetPnL=${decision.minimumNetPnl.toFixed(6)} ` +
        `trendStep=${decision.trendStep.toFixed(6)} reason=${decision.reason}`;
}

function withDogeBaselineTradingEnabled(
    model: Readonly<DogeBaselineModel>,
    config: Readonly<DogeBaselineStrategyConfig>,
    tradingEnabled: boolean,
): DogeBaselineStrategyConfig {
    return createDogeBaselineStrategyConfig(model, {
        tradingEnabled,
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
    const candidate = buildDogeBaselineModel(trainingObservations);
    await writeDogeBaselineModel(candidate, getDogeBaselineArtifactPath(DOGE_BASELINE_CANDIDATE_MODEL_FILE));

    let workingModel;
    try {
        workingModel = await readDogeBaselineModel();
    } catch (error) {
        if (!isFileMissingError(error)) throw error;
    }
    if (workingModel === undefined) {
        const initialConfig = createDogeBaselineStrategyConfig(candidate);
        const selected = researchDogeBaselineConfigMatrix(
            trainingFrames,
            candidate,
            executionConfig,
            initialConfig,
        );
        await writeDogeBaselineArtifacts(candidate, selected.selected.config);
        return `Initial model and config published from ${candidate.actualFrames} frames`;
    }

    const workingConfig = await readWorkingConfig(workingModel);
    const workingMatrix = researchDogeBaselineConfigMatrix(
        trainingFrames, workingModel, executionConfig, workingConfig,
    );
    const candidateCurrent = rebindDogeBaselineStrategyConfig(candidate, workingConfig);
    const candidateMatrix = researchDogeBaselineConfigMatrix(
        trainingFrames, candidate, executionConfig, candidateCurrent,
    );
    const evaluation = evaluateDogeBaselineModelConfigurations(
        trainFrames,
        replay,
        workingModel,
        workingConfig,
        workingMatrix.selected.config,
        candidate,
        candidateCurrent,
        candidateMatrix.selected.config,
        executionConfig,
    );
    const previousEvaluation = await readDogeBaselineEvaluationTradingPoint();
    await writeDogeBaselineEvaluation(evaluation);
    const selectionMessage = formatDogeBaselineRefreshSelection(evaluation);
    const regime = getDogeBaselineTradingRegimeDecision(workingConfig.tradingEnabled, evaluation, previousEvaluation);
    const regimeMessage = formatDogeBaselineTradingRegimeDecision(regime);
    const tradingEnabled = regime.tradingEnabled;
    if (!evaluation.promoted) {
        if (tradingEnabled !== workingConfig.tradingEnabled) {
            await writeDogeBaselineStrategyConfig(
                withDogeBaselineTradingEnabled(workingModel, workingConfig, tradingEnabled),
                workingModel,
            );
        }
        return `${selectionMessage}, ${regimeMessage}`;
    }

    if (evaluation.selected.model === 'working') {
        await writeDogeBaselineStrategyConfig(
            withDogeBaselineTradingEnabled(workingModel, evaluation.selected.strategyConfig, tradingEnabled),
            workingModel,
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
