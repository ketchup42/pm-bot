import { readHistoryFramesNewestFirst } from '../../../history/HistoryFrameReader.js';
import { HistoryFrameV3 } from '../../../history/history_frame.js';
import {
    DogeBaselineModel,
    DogeBaselineObservation,
    makeDogeBaselineObservation,
    predictDogeBaseline,
    trainDogeBaselineWeights,
} from './DogeBaselineModel.js';
import {
    DOGE_BASELINE_COIN,
    DOGE_BASELINE_CONFIG_RESEARCH_SNAPSHOT_INTERVAL_MS,
    DOGE_BASELINE_FRAME,
    DOGE_BASELINE_MODES,
    DOGE_BASELINE_MODEL_VERSION,
    DOGE_BASELINE_SOURCE,
    DOGE_BASELINE_STRATEGY,
    DogeBaselineModeName,
} from './DogeBaselineConfig.js';

export interface DogeBaselineTrainingResult {
    model: DogeBaselineModel;
    metrics: Record<DogeBaselineModeName, DogeBaselineTrainingMetrics>;
}

export interface DogeBaselineEligibleFrame {
    frame: HistoryFrameV3;
    observation: DogeBaselineObservation;
}

export interface DogeBaselineTrainReplaySplit {
    trainingObservations: DogeBaselineObservation[];
    trainingFrames: HistoryFrameV3[];
    replay: HistoryFrameV3[];
}

export interface DogeBaselineFrameSelectionCounts {
    trainingCount: number;
    replayCount: number;
}

export type DogeBaselineTrainingStopCheck = () => boolean;

export interface DogeBaselineConfusionMatrix {
    predictedUpActualUp: number;
    predictedUpActualDown: number;
    predictedDownActualUp: number;
    predictedDownActualDown: number;
}

export interface DogeBaselineDeviationOutcome {
    rangeBps: string;
    frames: number;
    upOutcomeRate: number | undefined;
}

export interface DogeBaselineConfidenceCalibration {
    range: string;
    frames: number;
    averageConfidence: number | undefined;
    accuracy: number | undefined;
}

export interface DogeBaselineTrainingMetrics {
    frames: number;
    accuracy: number;
    brierScore: number;
    logLoss: number;
    predictedUp: number;
    predictedDown: number;
    continuationFrames: number;
    continuationAccuracy: number | undefined;
    confusion: DogeBaselineConfusionMatrix;
    outcomesByDeviation: DogeBaselineDeviationOutcome[];
    calibrationByConfidence: DogeBaselineConfidenceCalibration[];
}

interface DogeBaselineDeviationRange {
    label: string;
    minimum: number;
    maximum: number;
}

const DOGE_BASELINE_DEVIATION_RANGES: readonly DogeBaselineDeviationRange[] = Object.freeze([
    { label: '< -10', minimum: Number.NEGATIVE_INFINITY, maximum: -10 },
    { label: '-10 .. -5', minimum: -10, maximum: -5 },
    { label: '-5 .. -2', minimum: -5, maximum: -2 },
    { label: '-2 .. -1', minimum: -2, maximum: -1 },
    { label: '-1 .. 1', minimum: -1, maximum: 1 },
    { label: '1 .. 2', minimum: 1, maximum: 2 },
    { label: '2 .. 5', minimum: 2, maximum: 5 },
    { label: '5 .. 10', minimum: 5, maximum: 10 },
    { label: '>= 10', minimum: 10, maximum: Number.POSITIVE_INFINITY },
]);

interface DogeBaselineConfidenceRange {
    label: string;
    minimum: number;
    maximum: number;
}

const DOGE_BASELINE_CONFIDENCE_RANGES: readonly DogeBaselineConfidenceRange[] = Object.freeze([
    { label: '0.50 .. 0.55', minimum: 0.5, maximum: 0.55 },
    { label: '0.55 .. 0.60', minimum: 0.55, maximum: 0.6 },
    { label: '0.60 .. 0.65', minimum: 0.6, maximum: 0.65 },
    { label: '0.65 .. 0.70', minimum: 0.65, maximum: 0.7 },
    { label: '0.70 .. 0.75', minimum: 0.7, maximum: 0.75 },
    { label: '0.75 .. 0.80', minimum: 0.75, maximum: 0.8 },
    { label: '0.80 .. 0.85', minimum: 0.8, maximum: 0.85 },
    { label: '0.85 .. 0.90', minimum: 0.85, maximum: 0.9 },
    { label: '0.90 .. 0.95', minimum: 0.9, maximum: 0.95 },
    { label: '0.95 .. 1.00', minimum: 0.95, maximum: 1 },
]);

export function calculateDogeBaselineTrainingMetrics(
    observations: readonly DogeBaselineObservation[],
    model: Readonly<DogeBaselineModel>,
    mode: DogeBaselineModeName,
): DogeBaselineTrainingMetrics {
    const confusion: DogeBaselineConfusionMatrix = {
        predictedUpActualUp: 0,
        predictedUpActualDown: 0,
        predictedDownActualUp: 0,
        predictedDownActualDown: 0,
    };
    let correct = 0;
    let brierScore = 0;
    let logLoss = 0;
    let predictedUp = 0;
    let continuationFrames = 0;
    let continuationCorrect = 0;
    const probabilities = observations.map(observation => {
        const probability = predictDogeBaseline(model.modes[mode], observation.features[mode]);
        const actualUp = observation.outcome === 'up';
        const predictsUp = probability > 0.5;
        if (predictsUp) predictedUp++;
        if (predictsUp === actualUp) correct++;
        confusion[predictsUp
            ? (actualUp ? 'predictedUpActualUp' : 'predictedUpActualDown')
            : (actualUp ? 'predictedDownActualUp' : 'predictedDownActualDown')]++;
        const expected = actualUp ? 1 : 0;
        brierScore += (probability - expected) ** 2;
        const bounded = Math.min(1 - 1e-12, Math.max(1e-12, probability));
        logLoss -= actualUp ? Math.log(bounded) : Math.log(1 - bounded);
        const displacement = observation.features[mode].at(-1)!;
        if (displacement !== 0) {
            continuationFrames++;
            if ((displacement > 0) === actualUp) continuationCorrect++;
        }
        return {
            observation,
            deviationBps: (Math.exp(displacement) - 1) * 10_000,
            confidence: Math.max(probability, 1 - probability),
            correct: predictsUp === actualUp,
        };
    });
    const outcomesByDeviation = DOGE_BASELINE_DEVIATION_RANGES.map((range, index) => {
        const values = probabilities.filter(value => value.deviationBps >= range.minimum &&
            (index === DOGE_BASELINE_DEVIATION_RANGES.length - 1
                ? value.deviationBps <= range.maximum
                : value.deviationBps < range.maximum));
        const upOutcomes = values.filter(value => value.observation.outcome === 'up').length;
        return {
            rangeBps: range.label,
            frames: values.length,
            upOutcomeRate: values.length > 0 ? upOutcomes / values.length : undefined,
        };
    });
    const calibrationByConfidence = DOGE_BASELINE_CONFIDENCE_RANGES.map((range, index) => {
        const values = probabilities.filter(value => value.confidence >= range.minimum &&
            (index === DOGE_BASELINE_CONFIDENCE_RANGES.length - 1
                ? value.confidence <= range.maximum
                : value.confidence < range.maximum));
        return {
            range: range.label,
            frames: values.length,
            averageConfidence: values.length > 0
                ? values.reduce((total, value) => total + value.confidence, 0) / values.length
                : undefined,
            accuracy: values.length > 0
                ? values.filter(value => value.correct).length / values.length
                : undefined,
        };
    });
    return {
        frames: observations.length,
        accuracy: correct / observations.length,
        brierScore: brierScore / observations.length,
        logLoss: logLoss / observations.length,
        predictedUp,
        predictedDown: observations.length - predictedUp,
        continuationFrames,
        continuationAccuracy: continuationFrames > 0 ? continuationCorrect / continuationFrames : undefined,
        confusion,
        outcomesByDeviation,
        calibrationByConfidence,
    };
}

export async function readDogeBaselineObservations(
    historyDirectory: string,
    requestedFrames: number,
    shouldStop: DogeBaselineTrainingStopCheck = () => false,
): Promise<DogeBaselineObservation[]> {
    const observations: DogeBaselineObservation[] = [];
    let available = 0;
    for await (const value of readDogeBaselineEligibleFramesNewestFirst(historyDirectory, shouldStop)) {
        if (shouldStop()) throw new Error('doge_baseline_training_cancelled');
        observations.push(value.observation);
        available++;
        if (available === requestedFrames) break;
    }
    if (available < requestedFrames) {
        throw new Error(
            `Insufficient eligible DOGE frames: required=${requestedFrames} available=${available} ` +
            `training=${requestedFrames} replay=0`,
        );
    }
    return observations.reverse();
}

async function* readDogeBaselineEligibleFramesNewestFirst(
    historyDirectory: string,
    shouldStop: DogeBaselineTrainingStopCheck = () => false,
): AsyncGenerator<DogeBaselineEligibleFrame> {
    for await (const frame of readHistoryFramesNewestFirst(historyDirectory, shouldStop)) {
        const observation = makeDogeBaselineObservation(frame);
        if (!observation) continue;
        yield { frame, observation };
    }
}

export async function collectDogeBaselineTrainReplaySplit(
    framesNewestFirst: AsyncIterable<DogeBaselineEligibleFrame>,
    counts: Readonly<DogeBaselineFrameSelectionCounts>,
    shouldStop: DogeBaselineTrainingStopCheck = () => false,
): Promise<DogeBaselineTrainReplaySplit> {
    const trainingObservations: DogeBaselineObservation[] = [];
    const trainingFrames: HistoryFrameV3[] = [];
    const replay: HistoryFrameV3[] = [];
    const required = counts.trainingCount + counts.replayCount;
    let available = 0;
    for await (const value of framesNewestFirst) {
        if (shouldStop()) throw new Error('doge_baseline_training_cancelled');
        available++;
        if (replay.length < counts.replayCount) replay.push(value.frame);
        else if (trainingObservations.length < counts.trainingCount) {
            trainingObservations.push(value.observation);
            trainingFrames.push(compactDogeBaselineConfigurationFrame(value.frame));
        }
        if (available === required) break;
    }
    if (shouldStop()) throw new Error('doge_baseline_training_cancelled');
    if (available < required) {
        throw new Error(
            `Insufficient eligible DOGE frames: required=${required} available=${available} ` +
            `training=${counts.trainingCount} replay=${counts.replayCount}`,
        );
    }
    return {
        trainingObservations: trainingObservations.reverse(),
        trainingFrames: trainingFrames.reverse(),
        replay: replay.reverse(),
    };
}

function compactDogeBaselineConfigurationFrame(frame: HistoryFrameV3): HistoryFrameV3 {
    if (!Array.isArray(frame.snapshots)) return frame;
    const intervalMs = DOGE_BASELINE_CONFIG_RESEARCH_SNAPSHOT_INTERVAL_MS;
    const snapshots = [] as HistoryFrameV3['snapshots'];
    let previousTimestamp: number | undefined;
    for (const snapshot of frame.snapshots) {
        if (previousTimestamp !== undefined && snapshot.timestamp - previousTimestamp < intervalMs) continue;
        snapshots.push(snapshot);
        previousTimestamp = snapshot.timestamp;
    }
    const last = frame.snapshots.at(-1);
    if (last !== undefined && snapshots.at(-1) !== last) snapshots.push(last);
    return { ...frame, snapshots };
}

export async function readDogeBaselineTrainReplaySplit(
    historyDirectory: string,
    counts: Readonly<DogeBaselineFrameSelectionCounts>,
    shouldStop: DogeBaselineTrainingStopCheck = () => false,
): Promise<DogeBaselineTrainReplaySplit> {
    return collectDogeBaselineTrainReplaySplit(
        readDogeBaselineEligibleFramesNewestFirst(historyDirectory, shouldStop),
        counts,
        shouldStop,
    );
}

export function buildDogeBaselineModel(observations: readonly DogeBaselineObservation[]): DogeBaselineModel {
    if (observations.length === 0) throw new Error('doge_baseline_empty_training_set');
    const first = observations[0]!;
    const last = observations[observations.length - 1]!;
    const modes = Object.fromEntries(DOGE_BASELINE_MODES.map(mode => [
        mode.name,
        trainDogeBaselineWeights(observations, mode.name),
    ])) as DogeBaselineModel['modes'];
    return {
        version: DOGE_BASELINE_MODEL_VERSION,
        strategy: DOGE_BASELINE_STRATEGY,
        coin: DOGE_BASELINE_COIN,
        frame: DOGE_BASELINE_FRAME,
        source: DOGE_BASELINE_SOURCE,
        trainedAt: Date.now(),
        requestedFrames: observations.length,
        actualFrames: observations.length,
        firstFrameStart: first.startTime,
        lastFrameStart: last.startTime,
        modes,
    };
}

export async function trainDogeBaseline(
    historyDirectory: string,
    requestedFrames: number,
    shouldStop: DogeBaselineTrainingStopCheck = () => false,
): Promise<DogeBaselineTrainingResult> {
    const observations = await readDogeBaselineObservations(historyDirectory, requestedFrames, shouldStop);

    if (shouldStop()) throw new Error('doge_baseline_training_cancelled');

    const model = buildDogeBaselineModel(observations);
    const metrics = Object.fromEntries(DOGE_BASELINE_MODES.map(mode => [
        mode.name,
        calculateDogeBaselineTrainingMetrics(observations, model, mode.name),
    ])) as Record<DogeBaselineModeName, DogeBaselineTrainingMetrics>;
    if (shouldStop()) throw new Error('doge_baseline_training_cancelled');
    return { model, metrics };
}
