import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { HistoryFrameV3, HistoryPriceV3 } from '../../../history/history_frame.js';
import { MarketSide } from '../../../../../market/side.js';
import { DEFAULT_STRATEGY_MODELS_DIRECTORY } from '../../../../defaults.js';
import { getPriceSourceConfig } from '../../../../../market/price/price_source.js';
import {
    DOGE_BASELINE_COIN, DOGE_BASELINE_FRAME, DOGE_BASELINE_L2, DOGE_BASELINE_MODEL_DIRECTORY,
    DOGE_BASELINE_MODEL_FILE, DOGE_BASELINE_MODES, DOGE_BASELINE_SOURCE, DOGE_BASELINE_STRATEGY,
    DOGE_BASELINE_MODEL_VERSION, DogeBaselineArtifactFile, DogeBaselineModeName,
} from './DogeBaselineConfig.js';

export interface DogeBaselineObservation {
    slug: string;
    startTime: number;
    outcome: MarketSide;
    features: Record<DogeBaselineModeName, number[]>;
}

export interface DogeBaselineWeights {
    means: number[];
    scales: number[];
    weights: number[];
}

export interface DogeBaselinePricePoint {
    price: number;
    timestamp: number;
}

type DogeBaselinePriceResolver = (timestamp: number) => DogeBaselinePricePoint | undefined;

export interface DogeBaselineModel {
    version: typeof DOGE_BASELINE_MODEL_VERSION;
    strategy: typeof DOGE_BASELINE_STRATEGY;
    coin: typeof DOGE_BASELINE_COIN;
    frame: typeof DOGE_BASELINE_FRAME;
    source: typeof DOGE_BASELINE_SOURCE;
    trainedAt: number;
    requestedFrames: number;
    actualFrames: number;
    firstFrameStart: number;
    lastFrameStart: number;
    modes: Record<DogeBaselineModeName, DogeBaselineWeights>;
}

function priceAt(frame: HistoryFrameV3, timestamp: number): HistoryPriceV3 | undefined {
    const start = frame.start_time * 1_000;
    if (timestamp <= (frame.snapshots[0]?.timestamp ?? start)) return frame.indicator_frame_start_prices[DOGE_BASELINE_COIN];
    for (let index = frame.snapshots.length - 1; index >= 0; index--) {
        const snapshot = frame.snapshots[index]!;
        if (snapshot.timestamp <= timestamp) return snapshot.indicator_prices[DOGE_BASELINE_COIN];
    }
    return undefined;
}

export function makeDogeBaselineFeatures(
    frame: HistoryFrameV3,
    offsetMs: number,
    lookbacksMs: readonly number[],
): number[] | undefined {
    const decisionTimestamp = frame.start_time * 1_000 + offsetMs;
    return calculateDogeBaselineFeatures(
        decisionTimestamp,
        lookbacksMs,
        getPriceSourceConfig(frame.source).maxAgeMs,
        timestamp => priceAt(frame, timestamp),
    );
}

export function makeDogeBaselineFeaturesFromPrices(
    frameStartPrice: number | undefined,
    frameStartTimestamp: number,
    prices: readonly DogeBaselinePricePoint[],
    offsetMs: number,
    lookbacksMs: readonly number[],
): number[] | undefined {
    if (frameStartPrice === undefined || frameStartPrice <= 0) return undefined;
    const decisionTimestamp = frameStartTimestamp + offsetMs;
    const findPrice = (timestamp: number): DogeBaselinePricePoint | undefined => {
        if (timestamp <= frameStartTimestamp) return { price: frameStartPrice, timestamp: frameStartTimestamp };
        for (let index = prices.length - 1; index >= 0; index--) {
            const point = prices[index]!;
            if (point.timestamp <= timestamp) return point;
        }
        return undefined;
    };
    return calculateDogeBaselineFeatures(
        decisionTimestamp,
        lookbacksMs,
        getPriceSourceConfig(DOGE_BASELINE_SOURCE).maxAgeMs,
        findPrice,
    );
}

function calculateDogeBaselineFeatures(
    decisionTimestamp: number,
    lookbacksMs: readonly number[],
    maximumAgeMs: number,
    resolvePrice: DogeBaselinePriceResolver,
): number[] | undefined {
    const current = resolvePrice(decisionTimestamp);
    if (!isUsablePrice(current, decisionTimestamp, maximumAgeMs)) return undefined;
    const features: number[] = [];
    for (const lookback of lookbacksMs) {
        const previousTimestamp = decisionTimestamp - lookback;
        const previous = resolvePrice(previousTimestamp);
        if (!isUsablePrice(previous, previousTimestamp, maximumAgeMs)) return undefined;
        features.push(Math.log(current.price / previous.price));
    }
    return features;
}

function isUsablePrice(
    point: DogeBaselinePricePoint | undefined,
    timestamp: number,
    maximumAgeMs: number,
): point is DogeBaselinePricePoint {
    return point !== undefined && point.price > 0 && point.timestamp <= timestamp &&
        timestamp - point.timestamp <= maximumAgeMs;
}

export function makeDogeBaselineObservation(frame: HistoryFrameV3): DogeBaselineObservation | undefined {
    if (frame.coin !== DOGE_BASELINE_COIN || frame.frame !== DOGE_BASELINE_FRAME || frame.source !== DOGE_BASELINE_SOURCE ||
        !frame.data_quality.complete || frame.settlement.confirmed_outcome === undefined) return undefined;
    const features = {} as Record<DogeBaselineModeName, number[]>;
    for (const mode of DOGE_BASELINE_MODES) {
        const values = makeDogeBaselineFeatures(frame, mode.offsetMs, mode.lookbacksMs);
        if (!values) return undefined;
        features[mode.name] = values;
    }
    return { slug: frame.slug, startTime: frame.start_time, outcome: frame.settlement.confirmed_outcome, features };
}

function sigmoid(value: number): number {
    return value >= 0 ? 1 / (1 + Math.exp(-value)) : Math.exp(value) / (1 + Math.exp(value));
}

export function trainDogeBaselineWeights(
    observations: readonly DogeBaselineObservation[],
    mode: DogeBaselineModeName,
): DogeBaselineWeights {
    if (observations.length === 0) throw new Error('doge_baseline_empty_training_set');
    const size = observations[0]!.features[mode].length;
    const means = Array.from({ length: size }, (_, index) => observations.reduce(
        (sum, value) => sum + value.features[mode][index]!, 0,
    ) / observations.length);
    const scales = means.map((mean, index) => Math.sqrt(observations.reduce(
        (sum, value) => sum + (value.features[mode][index]! - mean) ** 2, 0,
    ) / observations.length) || 1);
    const weights = Array.from({ length: size + 1 }, () => 0);
    for (let iteration = 0; iteration < 500; iteration++) {
        const gradient = Array.from({ length: size + 1 }, () => 0);
        for (const observation of observations) {
            const values = observation.features[mode].map((value, index) => (value - means[index]!) / scales[index]!);
            const predicted = sigmoid(weights[0]! + values.reduce(
                (sum, value, index) => sum + value * weights[index + 1]!, 0,
            ));
            const error = predicted - (observation.outcome === 'up' ? 1 : 0);
            gradient[0] = gradient[0]! + error;
            values.forEach((value, index) => {
                gradient[index + 1] = gradient[index + 1]! + error * value;
            });
        }
        weights[0] = weights[0]! - 0.05 * gradient[0]! / observations.length;
        for (let index = 0; index < size; index++) {
            weights[index + 1] = weights[index + 1]! - 0.05 * (
                gradient[index + 1]! / observations.length +
                DOGE_BASELINE_L2 * weights[index + 1]! / observations.length
            );
        }
    }
    return { means, scales, weights };
}

export function predictDogeBaseline(weights: DogeBaselineWeights, features: readonly number[]): number {
    if (features.length !== weights.means.length) throw new Error('doge_baseline_feature_count_mismatch');
    return sigmoid(weights.weights[0]! + features.reduce((sum, value, index) => sum +
        (value - weights.means[index]!) / weights.scales[index]! * weights.weights[index + 1]!, 0));
}

export function getDogeBaselineArtifactPath(fileName: DogeBaselineArtifactFile): string {
    const root = process.env.STRATEGY_MODELS_DIR || DEFAULT_STRATEGY_MODELS_DIRECTORY;
    return path.join(root, DOGE_BASELINE_MODEL_DIRECTORY, fileName);
}

export function getDogeBaselineModelPath(): string {
    return getDogeBaselineArtifactPath(DOGE_BASELINE_MODEL_FILE);
}

export function validateDogeBaselineModel(value: unknown): DogeBaselineModel {
    if (!value || typeof value !== 'object') throw new Error('invalid_doge_baseline_model');
    const model = value as DogeBaselineModel;
    if (model.version !== DOGE_BASELINE_MODEL_VERSION || model.strategy !== DOGE_BASELINE_STRATEGY ||
        model.coin !== DOGE_BASELINE_COIN || model.frame !== DOGE_BASELINE_FRAME ||
        model.source !== DOGE_BASELINE_SOURCE) throw new Error('incompatible_doge_baseline_model');
    if (!Number.isFinite(model.trainedAt) || !Number.isInteger(model.requestedFrames) || model.requestedFrames <= 0 ||
        !Number.isInteger(model.actualFrames) || model.actualFrames !== model.requestedFrames ||
        !Number.isFinite(model.firstFrameStart) || !Number.isFinite(model.lastFrameStart) ||
        model.firstFrameStart > model.lastFrameStart) throw new Error('invalid_doge_baseline_metadata');
    for (const mode of DOGE_BASELINE_MODES) {
        const weights = model.modes?.[mode.name];
        if (!weights || weights.means.length !== mode.lookbacksMs.length ||
            weights.scales.length !== mode.lookbacksMs.length ||
            weights.weights.length !== mode.lookbacksMs.length + 1 ||
            [...weights.means, ...weights.scales, ...weights.weights].some(value => !Number.isFinite(value)) ||
            weights.scales.some(value => value <= 0)) {
            throw new Error(`invalid_doge_baseline_weights:${mode.name}`);
        }
    }
    return model;
}

export async function readDogeBaselineModel(filePath: string = getDogeBaselineModelPath()): Promise<DogeBaselineModel> {
    return validateDogeBaselineModel(JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown);
}

export async function writeDogeBaselineModel(
    model: DogeBaselineModel,
    filePath: string = getDogeBaselineModelPath(),
): Promise<void> {
    validateDogeBaselineModel(model);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}-${Date.now()}.tmp`;
    try {
        await fs.writeFile(temporary, `${JSON.stringify(model, undefined, 2)}\n`, { flag: 'wx' });
        await fs.rename(temporary, filePath);
    } catch (error) {
        await fs.unlink(temporary).catch(() => {});
        throw error;
    }
}
