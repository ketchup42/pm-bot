import * as fs from 'node:fs/promises';
import { writeOutput } from '../log.js';
import { readArgument } from './cli_args.js';
import { DEFAULT_HISTORY_DIRECTORY } from './defaults.js';
import { getDogeBaselineEntrySummary } from './core/events/strategy/doge-baseline/DogeBaselineConfig.js';
import { getDogeBaselineEvaluationPath, readDogeBaselineEvaluationTradingState } from './core/events/strategy/doge-baseline/DogeBaselineEvaluation.js';
import { readDogeBaselineArtifacts } from './core/events/strategy/doge-baseline/artifacts.js';
import { readCurrentDogeBaselineHistoryStatus } from './core/events/strategy/doge-baseline/DogeBaselineHistoryStatus.js';

export interface DogeBaselineStatus {
    artifacts: {
        available: boolean;
        error?: string;
        model?: { version: number; trainedAt: number; actualFrames: number; firstFrameStart: number; lastFrameStart: number };
        configVersion?: number;
        tradingEnabled?: boolean;
        pauseReason?: string;
        entryProfile?: string;
        exitProfile?: string;
    };
    evaluation: {
        available: boolean;
        error?: string;
        lastSuccessfulRefreshAt?: number;
        selectedNetPnl?: number;
        replayFrames?: number;
        consecutiveRises?: number;
    };
    history: {
        directory: string;
        eligibleFrames: number;
        latestFrameStart?: number;
        latestFrameAgeMs?: number;
        error?: string;
    };
}

function formatExit(enabled: boolean, windowMs: number, deviationFactor: number): string {
    return enabled ? `${windowMs / 1_000}s/${(deviationFactor * 100).toFixed(2)}%` : 'natural';
}

function getStatusError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

async function getHistoryStatus(directory: string): Promise<DogeBaselineStatus['history']> {
    const history: DogeBaselineStatus['history'] = { directory, eligibleFrames: 0 };
    try {
        const cached = await readCurrentDogeBaselineHistoryStatus(directory);
        history.eligibleFrames = cached.eligibleFrames;
        if (cached.latestEligibleFrameStart !== undefined) history.latestFrameStart = cached.latestEligibleFrameStart;
    } catch (error) {
        history.error = getStatusError(error);
    }
    if (history.latestFrameStart !== undefined) {
        history.latestFrameAgeMs = Math.max(0, Date.now() - history.latestFrameStart * 1_000);
    }
    return history;
}

export async function getDogeBaselineStatus(historyDirectory: string = process.env.HISTORY_DIR || DEFAULT_HISTORY_DIRECTORY): Promise<DogeBaselineStatus> {
    const status: DogeBaselineStatus = {
        artifacts: { available: false },
        evaluation: { available: false },
        history: await getHistoryStatus(historyDirectory),
    };
    try {
        const artifacts = await readDogeBaselineArtifacts();
        const exit = artifacts.config.exit;
        status.artifacts = {
            available: true,
            model: {
                version: artifacts.model.version,
                trainedAt: artifacts.model.trainedAt,
                actualFrames: artifacts.model.actualFrames,
                firstFrameStart: artifacts.model.firstFrameStart,
                lastFrameStart: artifacts.model.lastFrameStart,
            },
            configVersion: artifacts.config.version,
            tradingEnabled: artifacts.config.tradingEnabled,
            entryProfile: getDogeBaselineEntrySummary(artifacts.config.entry),
            exitProfile: formatExit(exit.enabled, exit.windowMs, exit.deviationFactor),
        };
    } catch (error) {
        status.artifacts.error = getStatusError(error);
    }
    try {
        const [state, metadata] = await Promise.all([
            readDogeBaselineEvaluationTradingState(),
            fs.stat(getDogeBaselineEvaluationPath()),
        ]);
        if (state !== undefined) {
            status.evaluation = {
                available: true,
                lastSuccessfulRefreshAt: metadata.mtimeMs,
                selectedNetPnl: state.point.netPnl,
                replayFrames: state.point.replayFrames,
                consecutiveRises: state.state.consecutiveRises,
            };
            if (status.artifacts.available && !status.artifacts.tradingEnabled) {
                status.artifacts.pauseReason = state.state.reason ?? 'trading_disabled_by_config';
            }
        }
    } catch (error) {
        status.evaluation.error = getStatusError(error);
    }
    return status;
}

export async function runDogeBaselineStatus(): Promise<void> {
    const json = process.argv.includes('--json');
    if (!json || readArgument('history') !== undefined || process.argv.some(value => value.startsWith('--') && value !== '--json')) {
        throw new Error('Usage: pm-bot status:doge-baseline --json');
    }
    writeOutput(JSON.stringify(await getDogeBaselineStatus(), undefined, 2));
}
