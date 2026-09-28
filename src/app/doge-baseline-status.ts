import * as fs from 'node:fs/promises';
import { writeOutput } from '../log.js';
import { readArgument } from './cli_args.js';
import { DEFAULT_HISTORY_DIRECTORY } from './defaults.js';
import { getDogeBaselineEntrySummary } from './core/events/strategy/doge-baseline/DogeBaselineConfig.js';
import { getDogeBaselineEvaluationPath, readDogeBaselineEvaluationTradingState } from './core/events/strategy/doge-baseline/DogeBaselineEvaluation.js';
import { readDogeBaselineArtifacts } from './core/events/strategy/doge-baseline/artifacts.js';
import { readCurrentDogeBaselineHistoryStatus } from './core/events/strategy/doge-baseline/DogeBaselineHistoryStatus.js';
import { getHistoryFramePaths } from './core/history/HistoryFrameReader.js';

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
        completeFrames: number;
        eligibleFrames: number;
        firstFrameStart?: number;
        latestFrameStart?: number;
        historySpanMs?: number;
        latestFrameAgeMs?: number;
        error?: string;
    };
}

export interface DogeBaselineHealthStatus {
    artifacts: DogeBaselineStatus['artifacts'];
    evaluation: DogeBaselineStatus['evaluation'];
    history: {
        directory: string;
        latestFrameStart?: number;
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
    const history: DogeBaselineStatus['history'] = { directory, completeFrames: 0, eligibleFrames: 0 };
    try {
        const cached = await readCurrentDogeBaselineHistoryStatus(directory);
        history.completeFrames = Object.keys(cached.frames).length;
        history.eligibleFrames = cached.eligibleFrames;
        if (cached.firstEligibleFrameStart !== undefined) history.firstFrameStart = cached.firstEligibleFrameStart;
        if (cached.latestEligibleFrameStart !== undefined) history.latestFrameStart = cached.latestEligibleFrameStart;
    } catch (error) {
        history.error = getStatusError(error);
    }
    if (history.latestFrameStart !== undefined) {
        history.latestFrameAgeMs = Math.max(0, Date.now() - history.latestFrameStart * 1_000);
    }
    if (history.firstFrameStart !== undefined && history.latestFrameStart !== undefined) {
        history.historySpanMs = Math.max(0, (history.latestFrameStart - history.firstFrameStart) * 1_000);
    }
    return history;
}

async function getLatestHistoryStatus(directory: string): Promise<DogeBaselineHealthStatus['history']> {
    const history: DogeBaselineHealthStatus['history'] = { directory };
    try {
        const latest = (await getHistoryFramePaths(directory)).at(-1);
        const match = latest === undefined ? undefined : /(?:^|\/)(\d+)-[^/]+\.json(?:\.gz)?$/.exec(latest);
        if (match !== null && match !== undefined) history.latestFrameStart = Number(match[1]);
    } catch (error) {
        history.error = getStatusError(error);
    }
    return history;
}

async function getArtifactsStatus(): Promise<DogeBaselineStatus['artifacts']> {
    try {
        const artifacts = await readDogeBaselineArtifacts();
        const exit = artifacts.config.exit;
        return {
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
        return { available: false, error: getStatusError(error) };
    }
}

async function getEvaluationStatus(artifacts: DogeBaselineStatus['artifacts']): Promise<DogeBaselineStatus['evaluation']> {
    try {
        const [state, metadata] = await Promise.all([
            readDogeBaselineEvaluationTradingState(),
            fs.stat(getDogeBaselineEvaluationPath()),
        ]);
        if (state === undefined) return { available: false };
        const evaluation: DogeBaselineStatus['evaluation'] = {
            available: true,
            lastSuccessfulRefreshAt: metadata.mtimeMs,
            selectedNetPnl: state.point.netPnl,
            replayFrames: state.point.replayFrames,
            consecutiveRises: state.state.consecutiveRises,
        };
        if (artifacts.available && !artifacts.tradingEnabled) {
            artifacts.pauseReason = state.state.reason ?? 'trading_disabled_by_config';
        }
        return evaluation;
    } catch (error) {
        return { available: false, error: getStatusError(error) };
    }
}

export async function getDogeBaselineStatus(historyDirectory: string = process.env.HISTORY_DIR || DEFAULT_HISTORY_DIRECTORY): Promise<DogeBaselineStatus> {
    const artifacts = await getArtifactsStatus();
    const status: DogeBaselineStatus = {
        artifacts,
        evaluation: await getEvaluationStatus(artifacts),
        history: await getHistoryStatus(historyDirectory),
    };
    return status;
}

export async function getDogeBaselineHealthStatus(
    historyDirectory: string = process.env.HISTORY_DIR || DEFAULT_HISTORY_DIRECTORY,
): Promise<DogeBaselineHealthStatus> {
    const artifacts = await getArtifactsStatus();
    return {
        artifacts,
        evaluation: await getEvaluationStatus(artifacts),
        history: await getLatestHistoryStatus(historyDirectory),
    };
}

export async function runDogeBaselineStatus(): Promise<void> {
    const arguments_ = process.argv.slice(3);
    const health = arguments_.includes('--health');
    if (readArgument('history') !== undefined || !arguments_.includes('--json') ||
        arguments_.length !== (health ? 2 : 1) || arguments_.some(value => value !== '--json' && value !== '--health')) {
        throw new Error('Usage: pm-bot status:doge-baseline [--health] --json');
    }
    writeOutput(JSON.stringify(health ? await getDogeBaselineHealthStatus() : await getDogeBaselineStatus(), undefined, 2));
}
