import { logger } from '../log.js';
import { getFrameDurationMs, isEventFrame, waitFrameStartMsUntil } from '../market/frame.js';
import { delay, error_str, killSignalsHook } from '../utils.js';
import { readArgument, readPositiveIntegerArgument, readReplayExecutionConfig } from './cli_args.js';
import { DEFAULT_HISTORY_DIRECTORY } from './defaults.js';
import {
    DOGE_BASELINE_CANDIDATE_MODEL_FILE,
    DOGE_BASELINE_DEFAULT_BALANCE,
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
    evaluateDogeBaselineModelConfigurations,
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

export function getDogeBaselineTradingEnabled(
    currentTradingEnabled: boolean,
    evaluation: Pick<DogeBaselineConfigurationEvaluation, 'combinations' | 'promoted'>,
): boolean {
    if (evaluation.combinations.length > 0 && evaluation.combinations.every(value => value.replayMetrics.net_pnl <= 0)) {
        return false;
    }
    return evaluation.promoted ? true : currentTradingEnabled;
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
    const executionConfig = readReplayExecutionConfig(DOGE_BASELINE_DEFAULT_BALANCE);
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
    await writeDogeBaselineEvaluation(evaluation);
    const selectionMessage = formatDogeBaselineRefreshSelection(evaluation);
    const tradingEnabled = getDogeBaselineTradingEnabled(workingConfig.tradingEnabled, evaluation);
    if (!evaluation.promoted) {
        if (tradingEnabled === workingConfig.tradingEnabled) return selectionMessage;
        await writeDogeBaselineStrategyConfig(
            withDogeBaselineTradingEnabled(workingModel, workingConfig, tradingEnabled),
            workingModel,
        );
        return `${selectionMessage}, trading paused: all combinations have non-positive net PnL`;
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
    return selectionMessage;
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
