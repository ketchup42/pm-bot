import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
    NoTradeReplayStrategy,
    ReplayRunner,
    runReplay,
    simulateTakerFill,
    writeReplayReport,
} from '../dist/app/core/backtest/replay.js';
import { TrendLineReplayStrategy } from '../dist/app/core/backtest/strategy/TrendLineReplayStrategy.js';
import { runDogeBaselineReplay } from '../dist/app/core/backtest/strategy/DogeBaselineReplayStrategy.js';
import { REPLAY_STRATEGY_PRESETS } from '../dist/app/core/backtest/replay_presets.js';
import { runReplayMatrix, writeReplayMatrixReport } from '../dist/app/core/backtest/replay_matrix.js';
import { HISTORY_SCHEMA_VERSION, buildHistoryGaps, buildHistoryQuality } from '../dist/app/core/history/history_frame.js';
import { PS_CHAINLINK_TWAP_60 } from '../dist/market/price/price_source.js';
import { getSupportedCoins } from '../dist/market/coins.js';
import { VirtualTakerLiveOrderWallet } from '../dist/market/orders/VirtualTakerLiveOrderWallet.js';
import { TakerLiveOrderWallet } from '../dist/market/orders/TakerLiveOrderWallet.js';
import { calculateTakerExecution } from '../dist/market/orders/TakerExecution.js';
import { HistoryFrameWriter } from '../dist/app/core/history/HistoryFrameWriter.js';
import { getDogeBaselineStatus } from '../dist/app/doge-baseline-status.js';
import { calculateTakerFee } from '../dist/rest/fees.js';
import { placeMakerOrder } from '../dist/rest/orders.js';
import { createDogeBaselineSettlementReport } from '../dist/app/core/events/strategy/doge-baseline/settlement_report.js';
import { csvValue } from '../dist/utils.js';
import {
    makeDogeBaselineFeaturesFromPrices,
    getDogeBaselineFrameStartDeviationBps,
    predictDogeBaseline,
    trainDogeBaselineWeights,
} from '../dist/app/core/events/strategy/doge-baseline/DogeBaselineModel.js';
import {
    calculateDogeBaselineTrainingMetrics,
    collectDogeBaselineTrainReplaySplit,
} from '../dist/app/core/events/strategy/doge-baseline/DogeBaselineResearch.js';
import {
    getDogeBaselineSelectionRejectionReasons,
    getDogeBaselineMinimumProfitableSegmentCount,
    getDogeBaselineMinimumSegmentTradeCount,
    splitDogeBaselineReplayFrames,
} from '../dist/app/core/events/strategy/doge-baseline/DogeBaselineEvaluation.js';
import {
    createDogeBaselineStrategyConfig,
    readDogeBaselineArtifacts,
    validateDogeBaselineStrategyConfig,
    writeDogeBaselineArtifacts,
} from '../dist/app/core/events/strategy/doge-baseline/artifacts.js';
import {
    researchDogeBaselineConfigMatrix,
} from '../dist/app/core/events/strategy/doge-baseline/research_matrix.js';
import {
    calculateDogeBaselineEntryLimit,
    canRetryDogeBaselineEmergencyExit,
    evaluateDogeBaselineEmergencyExit,
    getDogeBaselinePredictedSide,
    selectDogeBaselineExecutableEntry,
    selectDogeBaselineExecutableEntryWithReason,
    selectDogeBaselineEntry,
} from '../dist/app/core/events/strategy/doge-baseline/DogeBaselineDecision.js';
import {
    createDogeBaselineEntrySettings,
    formatDogeBaselineDeviationBps,
    getDogeBaselineMinimumReplayTradeCount,
} from '../dist/app/core/events/strategy/doge-baseline/DogeBaselineConfig.js';
import {
    getDogeBaselineRegimeResearchBaseline,
    getDogeBaselineRegimeResearchPolicies,
} from '../dist/app/core/events/strategy/doge-baseline/regime_research.js';
import {
    REPLAY_STRATEGY_TREND_LINE_V2,
} from '../dist/app/defaults.js';

function makeFrame() {
    const start = 1_000;
    const indicatorPrices = timestamp => Object.fromEntries(getSupportedCoins().map(coin => [coin, { price: 60_000, timestamp }]));
    const snapshots = [0, 1].map(index => ({
        timestamp: start * 1_000 + index * 100,
        coin_price: 60_000,
        coin_timestamp: start * 1_000 + index * 100,
        indicator_prices: indicatorPrices(start * 1_000 + index * 100),
        book_watching: true,
        up: {
            book_timestamp: start * 1_000 + index * 100,
            midpoint: 0.5,
            spread: 0.02,
            bids: [{ price: '0.49', size: '5' }, { price: '0.48', size: '5' }],
            asks: [{ price: '0.51', size: '5' }, { price: '0.52', size: '5' }],
        },
        down: {
            book_timestamp: start * 1_000 + index * 100,
            midpoint: 0.5,
            spread: 0.02,
            bids: [{ price: '0.49', size: '10' }],
            asks: [{ price: '0.51', size: '10' }],
        },
    }));
    return {
        schema_version: HISTORY_SCHEMA_VERSION,
        source: PS_CHAINLINK_TWAP_60, indicator_coins: [...getSupportedCoins()],
        coin: 'btc', frame: '5m', slug: 'btc-updown-5m-1000',
        start_time: start, end_time: start + 300, collected_at: start * 1_000 + 300_000,
        snapshot_interval_ms: 100, book_depth: 10,
        coin_frame_start_price: 60_000, coin_frame_end_price: 60_010,
        indicator_frame_start_prices: indicatorPrices(start * 1_000),
        indicator_frame_end_prices: indicatorPrices((start + 300) * 1_000),
        market_data: {
            eventId: 'event', marketId: 'market', conditionId: 'condition', tick_size: 0.01,
            min_order_size: 5, fees_enabled: true, maker_base_fee: 0, taker_base_fee: 700,
            rewards_max_spread: 0, rewards_min_size: 0,
            up: { outcome: 'up', tokenId: 'up' }, down: { outcome: 'down', tokenId: 'down' },
        },
        settlement: { derived_outcome: 'up', confirmed_outcome: undefined, confirmed_at: undefined },
        connection_events: [],
        data_gaps: buildHistoryGaps(snapshots, 100, 'btc', PS_CHAINLINK_TWAP_60, getSupportedCoins()),
        snapshots,
        data_quality: buildHistoryQuality({
            snapshots,
            startPrice: 60_000,
            endPrice: 60_010,
            indicatorStartPrices: indicatorPrices(start * 1_000),
            indicatorEndPrices: indicatorPrices((start + 300) * 1_000),
            frameStartMs: start * 1_000,
            frameDurationMs: 200,
            snapshotIntervalMs: 100,
            stoppedEarly: false,
            source: PS_CHAINLINK_TWAP_60,
            indicatorCoins: getSupportedCoins(),
        }),
    };
}

const config = { initial_balance: 100, latency_ms: 0, minimum_order_value: 1 };

test('incremental replay runner matches the eager replay result', () => {
    const first = makeFrame();
    first.settlement.confirmed_outcome = 'up';
    const second = structuredClone(first);
    second.start_time += 300;
    second.end_time += 300;
    second.slug = 'btc-updown-5m-1300';
    second.snapshots = second.snapshots.map(snapshot => ({
        ...snapshot,
        timestamp: snapshot.timestamp + 300_000,
        coin_timestamp: snapshot.coin_timestamp + 300_000,
    }));
    second.settlement.confirmed_outcome = 'down';
    const frames = [first, second];
    const eager = runReplay(frames, new TrendLineReplayStrategy(), config);
    const runner = new ReplayRunner(new TrendLineReplayStrategy(), config);
    for (const frame of frames) runner.consume(frame);
    assert.deepEqual(runner.finish(), eager);
});

test('DOGE replay mode reports use decisions from their own single-mode runs', () => {
    const frame = makeFrame();
    frame.coin = 'doge';
    frame.slug = 'doge-updown-5m-1000';
    frame.coin_frame_start_price = 1;
    frame.settlement.confirmed_outcome = 'up';
    frame.snapshots = Array.from({ length: 121 }, (_, seconds) => {
        const timestamp = frame.start_time * 1_000 + seconds * 1_000;
        const price = 1 + seconds / 10_000;
        return {
            ...frame.snapshots[0],
            timestamp,
            coin_price: price,
            coin_timestamp: timestamp,
            indicator_prices: Object.fromEntries(getSupportedCoins().map(coin => [coin, { price, timestamp }])),
        };
    });
    const weights = { means: [0, 0, 0], scales: [1, 1, 1], weights: [10, 0, 0, 0] };
    const model = {
        version: 1, strategy: 'doge-baseline', coin: 'doge', frame: '5m', source: PS_CHAINLINK_TWAP_60,
        trainedAt: 1, requestedFrames: 1, actualFrames: 1, firstFrameStart: 1_000, lastFrameStart: 1_000,
        modes: { 'early-60': weights, 'late-120': weights },
    };

    const replay = runDogeBaselineReplay([frame], model, config, { emergencyExitEnabled: false });

    assert.equal(replay.modes['early-60'].metrics.trade_count, 1);
    assert.equal(replay.modes['late-120'].metrics.trade_count, 1);
    assert.equal(replay.entryDecisions['early-60'].accepted, 1);
    assert.equal(replay.entryDecisions['late-120'].accepted, 1);
});

test('DOGE status excludes complete frames that cannot produce a DOGE observation', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-bot-doge-status-'));
    const historyDirectory = path.join(root, 'history', 'frames');
    const previousModelsDirectory = process.env.STRATEGY_MODELS_DIR;
    const previousHistoryDirectory = process.env.HISTORY_DIR;
    process.env.STRATEGY_MODELS_DIR = path.join(root, 'models');
    process.env.HISTORY_DIR = historyDirectory;
    try {
        await new HistoryFrameWriter({ directory: historyDirectory, gzip: true, maxFrames: 0 }).write(makeFrame());
        const status = await getDogeBaselineStatus();
        assert.equal(status.history.eligibleFrames, 0);
        assert.equal(status.history.latestFrameStart, undefined);
        const cachePath = path.join(root, 'history', 'status', 'doge-5m-chainlink-twap-60.json');
        assert.ok((await fs.stat(cachePath)).isFile());
        await fs.writeFile(cachePath, '{broken');
        const rebuilt = await getDogeBaselineStatus(historyDirectory);
        assert.equal(rebuilt.history.eligibleFrames, 0);
        const rebuiltCachePayload = await fs.readFile(cachePath, 'utf8');
        assert.doesNotThrow(() => JSON.parse(rebuiltCachePayload));
    } finally {
        if (previousModelsDirectory === undefined) delete process.env.STRATEGY_MODELS_DIR;
        else process.env.STRATEGY_MODELS_DIR = previousModelsDirectory;
        if (previousHistoryDirectory === undefined) delete process.env.HISTORY_DIR;
        else process.env.HISTORY_DIR = previousHistoryDirectory;
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('DOGE baseline features use only prices available at the decision timestamp', () => {
    const start = 1_000_000;
    const prices = [15, 30, 45, 60, 75].map(seconds => ({
        timestamp: start + seconds * 1_000,
        price: 100 + seconds,
    }));
    assert.deepEqual(
        makeDogeBaselineFeaturesFromPrices(100, start, prices, 60_000, [15_000, 30_000, 60_000]),
        [Math.log(160 / 145), Math.log(160 / 130), Math.log(160 / 100)],
    );
});

test('DOGE frame-start deviation uses the final log-return feature', () => {
    assert.ok(Math.abs(getDogeBaselineFrameStartDeviationBps([0, Math.log(1.0001)]) - 1) < 1e-12);
});

test('DOGE baseline probability applies saved normalization and logistic weights', () => {
    const probability = predictDogeBaseline(
        { means: [1, 2], scales: [2, 4], weights: [0, 2, -1] },
        [3, 6],
    );
    assert.ok(Math.abs(probability - 0.7310585786300049) < 1e-12);
});

test('DOGE baseline training learns the direction of a simple signal', () => {
    const observation = (feature, outcome) => ({
        slug: String(feature),
        startTime: feature,
        outcome,
        features: { 'early-60': [feature], 'late-120': [feature] },
    });
    const weights = trainDogeBaselineWeights([
        observation(-2, 'down'), observation(-1, 'down'),
        observation(1, 'up'), observation(2, 'up'),
    ], 'early-60');
    assert.ok(predictDogeBaseline(weights, [2]) > 0.5);
    assert.ok(predictDogeBaseline(weights, [-2]) < 0.5);
});

test('DOGE training metrics compare predictions and signed price continuation with the confirmed outcome', () => {
    const observation = (feature, outcome) => ({
        slug: String(feature), startTime: feature, outcome,
        features: { 'early-60': [feature], 'late-120': [feature] },
    });
    const observations = [observation(-0.001, 'down'), observation(0.001, 'up')];
    const weights = { means: [0], scales: [1], weights: [0, 10_000] };
    const model = { modes: { 'early-60': weights, 'late-120': weights } };
    const metrics = calculateDogeBaselineTrainingMetrics(observations, model, 'early-60');
    assert.equal(metrics.accuracy, 1);
    assert.equal(metrics.continuationAccuracy, 1);
    assert.equal(metrics.predictedUp, 1);
    assert.equal(metrics.predictedDown, 1);
    assert.equal(metrics.confusion.predictedUpActualUp, 1);
    assert.equal(metrics.confusion.predictedDownActualDown, 1);
    assert.equal(metrics.outcomesByDeviation.reduce((sum, value) => sum + value.frames, 0), 2);
    assert.equal(metrics.calibrationByConfidence.reduce((sum, value) => sum + value.frames, 0), 2);
});

test('DOGE candidate replay window follows the training window chronologically', async () => {
    const frames = Array.from({ length: 10 }, (_, index) => ({
        frame: { start_time: index }, observation: { startTime: index },
    }));
    let consumed = 0;
    const newestFirst = values => (async function* () {
        for (const value of [...values].reverse()) {
            consumed++;
            yield value;
        }
    })();
    const split = await collectDogeBaselineTrainReplaySplit(
        newestFirst(frames),
        { trainingCount: 5, replayCount: 3 },
    );
    assert.deepEqual(split.trainingObservations.map(value => value.startTime), [2, 3, 4, 5, 6]);
    assert.deepEqual(split.replay.map(value => value.start_time), [7, 8, 9]);
    assert.equal(consumed, 8);
    consumed = 0;
    await assert.rejects(
        collectDogeBaselineTrainReplaySplit(
            newestFirst(frames),
            { trainingCount: 8, replayCount: 3 },
        ),
        /required=11 available=10 training=8 replay=3/,
    );
});

test('DOGE candidate publication requires profitable replay and direction quality', () => {
    const working = {
        replayMetrics: { trade_count: 10, net_pnl: 0.01, profit_factor: 1.01 },
        validationMetrics: {
            'early-60': { accuracy: 0.55, brierScore: 0.24 },
            'late-120': { accuracy: 0.55, brierScore: 0.24 },
        },
        replaySegments: Array.from({ length: 4 }, () => ({ profitable: true })),
    };
    const candidate = {
        replayMetrics: { trade_count: 10, net_pnl: 0.01, profit_factor: 1.01 },
        validationMetrics: {
            'early-60': { accuracy: 0.55, brierScore: 0.24 },
            'late-120': { accuracy: 0.55, brierScore: 0.24 },
        },
        replaySegments: Array.from({ length: 4 }, () => ({ profitable: true })),
    };
    assert.deepEqual(getDogeBaselineSelectionRejectionReasons(100, working, candidate), []);
    assert.deepEqual(getDogeBaselineSelectionRejectionReasons(100, working, {
        ...candidate,
        replayMetrics: { ...candidate.replayMetrics, net_pnl: 0 },
    }), [
        'candidate_net_pnl_not_positive',
        'candidate_net_pnl_significantly_below_working',
    ]);
});

test('DOGE candidate minimum trade count follows replay size within bounds', () => {
    assert.equal(getDogeBaselineMinimumReplayTradeCount(1), 1);
    assert.equal(getDogeBaselineMinimumReplayTradeCount(4), 4);
    assert.equal(getDogeBaselineMinimumReplayTradeCount(5), 5);
    assert.equal(getDogeBaselineMinimumReplayTradeCount(50), 5);
    assert.equal(getDogeBaselineMinimumReplayTradeCount(100), 10);
    assert.equal(getDogeBaselineMinimumReplayTradeCount(101), 11);
    assert.equal(getDogeBaselineMinimumReplayTradeCount(150), 15);
    assert.equal(getDogeBaselineMinimumReplayTradeCount(200), 20);
    assert.equal(getDogeBaselineMinimumReplayTradeCount(500), 20);
});

test('DOGE replay segmentation adapts between twenty-five and fifty frames', () => {
    const frames = Array.from({ length: 500 }, (_, start_time) => ({ start_time }));
    assert.deepEqual(splitDogeBaselineReplayFrames(frames.slice(0, 1)).map(segment => segment.length), [1]);
    assert.deepEqual(splitDogeBaselineReplayFrames(frames.slice(0, 50)).map(segment => segment.length), [25, 25]);
    assert.deepEqual(splitDogeBaselineReplayFrames(frames.slice(0, 75)).map(segment => segment.length), [25, 25, 25]);
    assert.deepEqual(splitDogeBaselineReplayFrames(frames.slice(0, 99)).map(segment => segment.length), [33, 33, 33]);
    assert.deepEqual(splitDogeBaselineReplayFrames(frames.slice(0, 100)).map(segment => segment.length), [25, 25, 25, 25]);
    assert.deepEqual(splitDogeBaselineReplayFrames(frames.slice(0, 150)).map(segment => segment.length), [38, 38, 37, 37]);
    assert.deepEqual(splitDogeBaselineReplayFrames(frames.slice(0, 200)).map(segment => segment.length), [50, 50, 50, 50]);
    assert.deepEqual(splitDogeBaselineReplayFrames(frames.slice(0, 400)).map(segment => segment.length), Array(8).fill(50));
    assert.deepEqual(splitDogeBaselineReplayFrames(frames).map(segment => segment.length), Array(10).fill(50));
    assert.equal(getDogeBaselineMinimumProfitableSegmentCount(1), 1);
    assert.equal(getDogeBaselineMinimumProfitableSegmentCount(50), 1);
    assert.equal(getDogeBaselineMinimumProfitableSegmentCount(75), 2);
    assert.equal(getDogeBaselineMinimumProfitableSegmentCount(100), 2);
    assert.equal(getDogeBaselineMinimumProfitableSegmentCount(200), 2);
    assert.equal(getDogeBaselineMinimumProfitableSegmentCount(250), 3);
    assert.equal(getDogeBaselineMinimumProfitableSegmentCount(300), 4);
    assert.equal(getDogeBaselineMinimumProfitableSegmentCount(350), 5);
    assert.equal(getDogeBaselineMinimumProfitableSegmentCount(400), 6);
    assert.equal(getDogeBaselineMinimumProfitableSegmentCount(500), 8);
    assert.equal(getDogeBaselineMinimumSegmentTradeCount(25), 3);
    assert.equal(getDogeBaselineMinimumSegmentTradeCount(33), 4);
    assert.equal(getDogeBaselineMinimumSegmentTradeCount(50), 5);
});

test('DOGE candidate requires profitable chronological replay segments', () => {
    const evaluationModel = replaySegments => ({
        replayMetrics: { trade_count: 10, net_pnl: 1, profit_factor: 1.01 },
        validationMetrics: {
            'early-60': { accuracy: 0.55, brierScore: 0.24 },
            'late-120': { accuracy: 0.55, brierScore: 0.24 },
        },
        replaySegments,
    });
    const profitable = Array.from({ length: 4 }, () => ({ profitable: true }));
    assert.deepEqual(
        getDogeBaselineSelectionRejectionReasons(100, evaluationModel(profitable), evaluationModel([
            ...profitable.slice(0, 1), { profitable: false }, { profitable: false }, { profitable: false },
        ])),
        ['candidate_profitable_segment_count_below_minimum'],
    );
});

test('DOGE configuration research excludes inactive entry settings from finalists', () => {
    const frame = makeFrame();
    frame.coin = 'doge';
    frame.slug = 'doge-updown-5m-1000';
    frame.settlement.confirmed_outcome = 'up';
    const weights = { means: [0, 0, 0], scales: [1, 1, 1], weights: [0, 0, 0, 0] };
    const model = {
        version: 1, strategy: 'doge-baseline', coin: 'doge', frame: '5m', source: PS_CHAINLINK_TWAP_60,
        trainedAt: 1, requestedFrames: 500, actualFrames: 500, firstFrameStart: 1, lastFrameStart: 500,
        modes: { 'early-60': weights, 'late-120': weights },
    };
    const matrix = researchDogeBaselineConfigMatrix([frame], model, config, createDogeBaselineStrategyConfig(model));
    assert.equal(matrix.entryRows.length, 160);
    assert.equal(matrix.finalists.length, 0);
    assert.equal(matrix.rows.length, 160);
    assert.ok(matrix.entryRows.every(row => row.config.exit.enabled === false));
    assert.ok(matrix.rows.slice(matrix.entryRows.length).every(row => row.config.exit.enabled === true));
    assert.ok(matrix.rows.every(row => row.config.regime.minimumConsecutiveRises === 2));
});

test('DOGE regime research includes the published default and all eighteen profiles', () => {
    const baseline = getDogeBaselineRegimeResearchBaseline();
    const policies = getDogeBaselineRegimeResearchPolicies();
    assert.equal(policies.length, 18);
    assert.ok(policies.some(policy => policy.id === baseline.id));
    assert.deepEqual(baseline, {
        id: 'minimum0.50-trend0.10-rises2',
        minimumNetPnlPerReplayFrame: 0.5,
        trendStepPerReplayFrame: 0.1,
        minimumConsecutiveRises: 2,
    });
});

test('DOGE strategy config V5 requires a trade flag, regime and an enabled entry mode', () => {
    const weights = { means: [0, 0, 0], scales: [1, 1, 1], weights: [0, 0, 0, 0] };
    const model = {
        version: 1, strategy: 'doge-baseline', coin: 'doge', frame: '5m', source: PS_CHAINLINK_TWAP_60,
        trainedAt: 1, requestedFrames: 500, actualFrames: 500, firstFrameStart: 1, lastFrameStart: 500,
        modes: { 'early-60': weights, 'late-120': weights },
    };
    const strategyConfig = createDogeBaselineStrategyConfig(model);
    assert.equal(strategyConfig.version, 5);
    assert.equal(strategyConfig.tradingEnabled, true);
    assert.deepEqual(strategyConfig.regime, {
        minimumNetPnlPerReplayFrame: 0.5,
        trendStepPerReplayFrame: 0.1,
        minimumConsecutiveRises: 2,
    });
    assert.equal(strategyConfig.entry.modes['early-60'].minimumEdge, 0.04);
    assert.equal(strategyConfig.entry.modes['late-120'].minimumEdge, 0.04);
    assert.equal(strategyConfig.entry.modes['early-60'].minimumConfidence, 0.5);
    assert.equal(strategyConfig.entry.modes['late-120'].minimumAbsoluteDeviationBps, 0);
    strategyConfig.entry.modes['early-60'].enabled = false;
    strategyConfig.entry.modes['late-120'].enabled = false;
    assert.throws(() => validateDogeBaselineStrategyConfig(strategyConfig, model),
        /invalid_doge_baseline_strategy_config_entry/);

    const withoutTradeFlag = { ...createDogeBaselineStrategyConfig(model) };
    delete withoutTradeFlag.tradingEnabled;
    assert.throws(() => validateDogeBaselineStrategyConfig(withoutTradeFlag, model),
        /invalid_doge_baseline_strategy_config_trading_enabled/);
    assert.throws(() => validateDogeBaselineStrategyConfig({ ...createDogeBaselineStrategyConfig(model), version: 3 }, model),
        /incompatible_doge_baseline_strategy_config/);

    const v4 = { ...createDogeBaselineStrategyConfig(model), version: 4 };
    delete v4.regime;
    const migrated = validateDogeBaselineStrategyConfig(v4, model);
    assert.equal(migrated.version, 5);
    assert.equal(migrated.regime.minimumConsecutiveRises, 2);
});

test('DOGE artifact reader restores a stale interrupted pair publication', async () => {
    const modelsDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-bot-doge-artifacts-'));
    const previousModelsDirectory = process.env.STRATEGY_MODELS_DIR;
    process.env.STRATEGY_MODELS_DIR = modelsDirectory;
    const weights = { means: [0, 0, 0], scales: [1, 1, 1], weights: [0, 0, 0, 0] };
    const model = {
        version: 1, strategy: 'doge-baseline', coin: 'doge', frame: '5m', source: PS_CHAINLINK_TWAP_60,
        trainedAt: 1, requestedFrames: 500, actualFrames: 500, firstFrameStart: 1, lastFrameStart: 500,
        modes: { 'early-60': weights, 'late-120': weights },
    };
    try {
        const strategyConfig = createDogeBaselineStrategyConfig(model);
        await writeDogeBaselineArtifacts(model, strategyConfig);
        const artifactDirectory = path.join(modelsDirectory, 'doge-baseline');
        const modelPath = path.join(artifactDirectory, 'model.json');
        const configPath = path.join(artifactDirectory, 'config.json');
        const backupDirectory = path.join(artifactDirectory, '.publish-backup');
        await fs.mkdir(backupDirectory);
        await fs.copyFile(modelPath, path.join(backupDirectory, 'model.json'));
        await fs.copyFile(configPath, path.join(backupDirectory, 'config.json'));
        await fs.writeFile(path.join(backupDirectory, 'state.json'), JSON.stringify({
            pid: 999_999_999, modelExists: true, configExists: true,
        }));
        await fs.writeFile(modelPath, `${JSON.stringify({ ...model, trainedAt: 2 })}\n`);
        const restored = await readDogeBaselineArtifacts();
        assert.equal(restored.model.trainedAt, 1);
        await assert.rejects(fs.access(backupDirectory));
    } finally {
        if (previousModelsDirectory === undefined) delete process.env.STRATEGY_MODELS_DIR;
        else process.env.STRATEGY_MODELS_DIR = previousModelsDirectory;
        await fs.rm(modelsDirectory, { recursive: true, force: true });
    }
});

test('DOGE candidate may trail profitable working model by at most twenty percent', () => {
    const evaluationModel = netPnl => ({
        replayMetrics: { trade_count: 10, net_pnl: netPnl, profit_factor: 1.01 },
        validationMetrics: {
            'early-60': { accuracy: 0.55, brierScore: 0.24 },
            'late-120': { accuracy: 0.55, brierScore: 0.24 },
        },
        replaySegments: Array.from({ length: 4 }, () => ({ profitable: true })),
    });
    assert.deepEqual(
        getDogeBaselineSelectionRejectionReasons(100, evaluationModel(10), evaluationModel(7.99)),
        ['candidate_net_pnl_significantly_below_working'],
    );
    assert.deepEqual(
        getDogeBaselineSelectionRejectionReasons(100, evaluationModel(10), evaluationModel(8)),
        [],
    );
    assert.deepEqual(
        getDogeBaselineSelectionRejectionReasons(100, evaluationModel(-1), evaluationModel(0.01)),
        [],
    );
});

test('DOGE baseline buys only the side predicted by the model', () => {
    assert.equal(selectDogeBaselineEntry(0.51, 1, {
        upAsk: 0.50, downAsk: 0.50, feesEnabled: false, takerBaseFee: 0,
    }), undefined);
    assert.equal(selectDogeBaselineEntry(0.80, 1, {
        upAsk: 0.50, downAsk: 0.05, feesEnabled: false, takerBaseFee: 0,
    })?.side, 'up');
    assert.equal(selectDogeBaselineEntry(0.20, -1, {
        upAsk: 0.05, downAsk: 0.50, feesEnabled: false, takerBaseFee: 0,
    })?.side, 'down');
    assert.equal(selectDogeBaselineEntry(0.80, 1, {
        upAsk: 0.90, downAsk: 0.05, feesEnabled: false, takerBaseFee: 0,
    }), undefined);
    assert.equal(getDogeBaselinePredictedSide(0.5), undefined);
});

test('DOGE emergency exit requires the final window, adverse deviation and confirmation', () => {
    const base = {
        side: 'up', frameStartPrice: 100, currentPrice: 99.94,
        frameEndTimestamp: 300_000, adverseSince: undefined,
    };
    assert.deepEqual(evaluateDogeBaselineEmergencyExit({ ...base, timestamp: 239_999 }), {
        adverseSince: undefined, adverse: false, triggered: false,
    });
    assert.deepEqual(evaluateDogeBaselineEmergencyExit({ ...base, timestamp: 240_000 }), {
        adverseSince: 240_000, adverse: true, triggered: false,
    });
    assert.deepEqual(evaluateDogeBaselineEmergencyExit({ ...base, timestamp: 245_000, adverseSince: 240_000 }), {
        adverseSince: 240_000, adverse: true, triggered: true,
    });
    assert.deepEqual(evaluateDogeBaselineEmergencyExit({
        ...base, timestamp: 245_000, currentPrice: 100, adverseSince: 240_000,
    }), { adverseSince: undefined, adverse: false, triggered: false });
    assert.equal(evaluateDogeBaselineEmergencyExit({
        ...base, side: 'down', timestamp: 245_000, currentPrice: 100.06, adverseSince: 240_000,
    }).triggered, true);
});

test('DOGE baseline entry crosses one tick without producing an invalid unit price', () => {
    assert.equal(calculateDogeBaselineEntryLimit(0.50, 0.01), 0.51);
    assert.equal(calculateDogeBaselineEntryLimit(0.99, 0.01), 0.99);
});

test('DOGE executable entry rejects a top-of-book edge erased by depth and fees', () => {
    const prices = { upAsk: 0.51, downAsk: 0.51, feesEnabled: true, takerBaseFee: 700 };
    const settings = createDogeBaselineEntrySettings(undefined, { 'early-60': { minimumEdge: 0.02 } }).modes['early-60'];
    assert.ok(selectDogeBaselineEntry(0.55, 1, prices, settings));
    assert.equal(selectDogeBaselineExecutableEntry(0.55, 1, prices, {
        upAsks: [{ price: '0.51', size: '5' }, { price: '0.52', size: '20' }],
        downAsks: [{ price: '0.51', size: '25' }],
        tickSize: 0.01,
        minimumOrderValue: 1,
    }, settings), undefined);
});

test('DOGE executable entry reports the exact rejection reason without changing replay selection', () => {
    const book = {
        upAsks: [{ price: '0.50', size: '50' }],
        downAsks: [{ price: '0.50', size: '50' }],
        tickSize: 0.01,
        minimumOrderValue: 1,
    };
    const prices = { upAsk: 0.50, downAsk: 0.50, feesEnabled: false, takerBaseFee: 0 };

    const strictEdge = createDogeBaselineEntrySettings(undefined, { 'early-60': { minimumEdge: 0.051 } }).modes['early-60'];
    const minimumSize = createDogeBaselineEntrySettings(undefined, { 'early-60': { minimumEdge: 0.02 } }).modes['early-60'];
    assert.equal(selectDogeBaselineExecutableEntryWithReason(0.5, 0, prices, book).reason, 'neutral_prediction');
    assert.equal(selectDogeBaselineExecutableEntryWithReason(0.8, 1, { ...prices, upAsk: undefined }, book).reason, 'predicted_side_unavailable');
    assert.equal(selectDogeBaselineExecutableEntryWithReason(0.8, 1, prices, { ...book, upAsks: [] }).reason, 'insufficient_book_liquidity');
    assert.equal(selectDogeBaselineExecutableEntryWithReason(0.8, 1, prices, book, minimumSize, 0.5).reason, 'below_minimum_order_value');
    assert.equal(selectDogeBaselineExecutableEntryWithReason(0.55, 1, prices, book, strictEdge).reason, 'insufficient_edge_after_execution_costs');

    const pricedWithFees = { ...prices, feesEnabled: true, takerBaseFee: 700 };
    assert.equal(
        selectDogeBaselineExecutableEntryWithReason(0.8, 1, pricedWithFees, book, minimumSize, 10, 10).reason,
        'insufficient_strategy_balance',
    );

    const selection = selectDogeBaselineExecutableEntryWithReason(0.8, 1, prices, book);
    assert.ok(selection.candidate);
    assert.deepEqual(selectDogeBaselineExecutableEntry(0.8, 1, prices, book), selection.candidate);
});

test('DOGE entry applies mode-specific confidence and absolute-deviation filters', () => {
    const book = {
        upAsks: [{ price: '0.50', size: '50' }],
        downAsks: [{ price: '0.50', size: '50' }],
        tickSize: 0.01,
        minimumOrderValue: 1,
    };
    const prices = { upAsk: 0.50, downAsk: 0.50, feesEnabled: false, takerBaseFee: 0 };
    const confidenceSettings = createDogeBaselineEntrySettings(undefined, {
        'early-60': { minimumConfidence: 0.55 },
    }).modes['early-60'];
    const deviationSettings = createDogeBaselineEntrySettings(undefined, {
        'early-60': { minimumAbsoluteDeviationBps: 0.5 },
    }).modes['early-60'];

    assert.equal(
        selectDogeBaselineExecutableEntryWithReason(0.54, 2, prices, book, confidenceSettings).reason,
        'below_minimum_confidence',
    );
    assert.equal(
        selectDogeBaselineExecutableEntryWithReason(0.8, -0.49, prices, book, deviationSettings).reason,
        'below_minimum_absolute_deviation',
    );
    assert.ok(selectDogeBaselineExecutableEntryWithReason(0.8, -0.5, prices, book, deviationSettings).candidate);
    assert.equal(formatDogeBaselineDeviationBps(0.5), '0.5');
});

test('DOGE emergency exit retry waits for the configured retry interval', () => {
    assert.equal(canRetryDogeBaselineEmergencyExit(215_000, undefined), true);
    assert.equal(canRetryDogeBaselineEmergencyExit(215_500, 216_000), false);
    assert.equal(canRetryDogeBaselineEmergencyExit(216_000, 216_000), true);
});


test('CSV values preserve commas, quotes, newlines and undefined fields', () => {
    assert.equal(csvValue(undefined), '');
    assert.equal(csvValue('plain'), 'plain');
    assert.equal(csvValue('entry,normal'), '"entry,normal"');
    assert.equal(csvValue('say "yes"'), '"say ""yes"""');
    assert.equal(csvValue('first\nsecond'), '"first\nsecond"');
});

test('taker execution walks depth, calculates VWAP and fees', () => {
    const frame = makeFrame();
    const fill = simulateTakerFill(frame, frame.snapshots[0], {
        action: 'buy', side: 'up', quantity: 8, limit_price: 0.52,
    }, 100, 0, config);
    assert.equal(fill.status, 'filled');
    assert.equal(fill.filled_quantity, 8);
    assert.equal(fill.average_price, 0.51375);
    assert.equal(Number(fill.fee.toFixed(5)), 0.13989);
});

test('taker fees use Polymarket precision without floating-point tails', () => {
    assert.equal(calculateTakerFee(0.001, 0.01, 0.07), 0);

    const execution = calculateTakerExecution({
        action: 'sell',
        levels: [{ price: '0.49', size: '4' }, { price: '0.48', size: '6' }],
        quantity: 10,
        limitPrice: 0.01,
        tickSize: 0.01,
        feesEnabled: true,
        takerBaseFeeBps: 700,
    });
    assert.equal(execution.fillStatus, 'full');
    assert.equal(execution.averagePrice, 0.484);
    assert.equal(execution.bestPrice, 0.49);
    assert.equal(execution.fee, 0.1748);
    assert.equal(execution.fee.toString(), '0.1748');
    const roundedPrice = calculateTakerExecution({
        action: 'buy', levels: [{ price: '0.75', size: '13.157895' }], quantity: 13.157895,
        limitPrice: 0.75, tickSize: 0.01, feesEnabled: false, takerBaseFeeBps: 0,
    });
    assert.equal(roundedPrice.averagePrice, 0.75);
    const none = calculateTakerExecution({
        action: 'buy', levels: [], quantity: 10, limitPrice: 1, tickSize: 0.01,
        feesEnabled: false, takerBaseFeeBps: 0,
    });
    assert.equal(none.fillStatus, 'none');
    assert.equal(none.averagePrice, undefined);
    assert.equal(none.bestPrice, undefined);

    const partial = calculateTakerExecution({
        action: 'buy', levels: [{ price: '0.51', size: '5' }], quantity: 10, limitPrice: 0.52, tickSize: 0.01,
        feesEnabled: false, takerBaseFeeBps: 0,
    });
    assert.equal(partial.fillStatus, 'partial');
    assert.equal(partial.averagePrice, 0.51);
    assert.equal(partial.bestPrice, 0.51);

    const fractionalPartial = calculateTakerExecution({
        action: 'buy', levels: [{ price: '0.74', size: '12.7' }], quantity: 13.333333, limitPrice: 0.75,
        tickSize: 0.01, feesEnabled: false, takerBaseFeeBps: 0,
    });
    assert.equal(fractionalPartial.fillStatus, 'partial');
    assert.equal(fractionalPartial.filledQuantity, 12.7);
    assert.equal(fractionalPartial.remainingQuantity, 0.633333);
    assert.equal(fractionalPartial.grossValue, 9.398);
});

test('immediately matched GTC orders return taker fee from actual trades', async () => {
    const client = {
        createOrder: async value => value,
        postOrder: async () => ({ success: true, orderID: 'order', status: 'matched', tradeIDs: ['first', 'second'] }),
        getTrades: async ({ id }) => id === 'first'
            ? [{ size: '4', price: '0.49', fee_rate_bps: '700', trader_side: 'TAKER' }]
            : [{ size: '6', price: '0.48', fee_rate_bps: '700', trader_side: 'TAKER' }],
    };
    const order = await placeMakerOrder(client, 'token', 'BUY', 0.5, 10, true, 700);
    assert.equal(order.executed_size, 10);
    assert.equal(order.average_price, 0.484);
    assert.equal(order.taker_fee, 0.1748);
});

test('real taker wallet cancels the remainder and accounts for the actual partial fill', async () => {
    let canceledOrderId;
    const client = {
        getBalanceAllowance: async () => ({ balance: '100000000' }),
        createOrder: async value => value,
        postOrder: async () => ({ success: true, orderID: 'order', tradeIDs: ['trade'] }),
        getOrder: async () => ({ size_matched: '4', associate_trades: ['trade'] }),
        cancelOrder: async ({ orderID }) => { canceledOrderId = orderID; return {}; },
        getTrades: async () => [{
            size: '4', price: '0.49', fee_rate_bps: '700', trader_side: 'TAKER',
        }],
    };
    const wallet = await TakerLiveOrderWallet.create(client, {
        token_id: 'up', balance: 100, tick_size: 0.01,
        min_order_size: 5, min_buy_order_value: 1,
        fees_enabled: true, taker_base_fee: 700,
    }, {
        isActive: () => true,
        isFullMatched: () => false,
        isPartialMatched: () => false,
        isLive: () => false,
        hasCanceled: () => false,
        setUpdateHandler: () => {},
        resetUpdateHandler: () => {},
        disconnect: () => {},
    });
    const order = await wallet.buy(0.5, 10);
    assert.equal(canceledOrderId, 'order');
    assert.equal(order?.value.quantity, 4);
    assert.equal(order?.value.price, 0.49);
    assert.equal(order?.fast_full_trade, false);
    assert.equal(wallet.getTokensQuantity(), 4);
    assert.equal(wallet.getBalance(), 97.97003);
    assert.equal(wallet.isPartialFilled('order'), true);
    assert.equal(wallet.hasCanceled('order'), true);
    assert.equal(wallet.isLive('order'), false);
    assert.equal(wallet.getBuyOrdersCount(), 0);
});

test('real taker wallet reconciles a known order after an immediate status failure', async () => {
    let getOrderCalls = 0;
    let updateHandler;
    const client = {
        getBalanceAllowance: async () => ({ balance: '100000000' }),
        createOrder: async value => value,
        postOrder: async () => ({ success: true, orderID: 'recovery-order', tradeIDs: ['trade'] }),
        getOrder: async () => {
            getOrderCalls++;
            if (getOrderCalls === 1) throw new Error('temporary status failure');
            return { size_matched: '4', associate_trades: ['trade'] };
        },
        cancelOrder: async () => ({}),
        getTrades: async () => [{ size: '4', price: '0.49', fee_rate_bps: '700', trader_side: 'TAKER' }],
    };
    const watcher = {
        isActive: () => true,
        isFullMatched: () => false,
        isPartialMatched: () => false,
        isLive: () => false,
        hasCanceled: () => true,
        setUpdateHandler: (orderId, handler) => { if (orderId === 'recovery-order') updateHandler = handler; },
        resetUpdateHandler: () => {},
        disconnect: () => {},
    };
    const wallet = await TakerLiveOrderWallet.create(client, {
        token_id: 'up', balance: 100, tick_size: 0.01,
        min_order_size: 5, min_buy_order_value: 1,
        fees_enabled: true, taker_base_fee: 700,
    }, watcher);
    const pending = await wallet.buy(0.5, 10);
    assert.equal(pending?.id, 'recovery-order');
    assert.equal(wallet.isLive('recovery-order'), true);

    await new Promise(resolve => setTimeout(resolve, 0));
    updateHandler?.({});
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.equal(wallet.getTokensQuantity(), 4);
    assert.equal(wallet.getBalance(), 97.97003);
    assert.equal(wallet.isPartialFilled('recovery-order'), true);
    assert.equal(wallet.isLive('recovery-order'), false);
});

test('live settlement report separates expected payout from executable bid proceeds', () => {
    const report = createDogeBaselineSettlementReport({
        cash: 90,
        side: 'up',
        tokenQuantity: 10,
        frameStartPrice: 1,
        frameEndPrice: 2,
        bids: [{ price: '0.60', size: '5' }, { price: '0.50', size: '5' }],
        tickSize: 0.01,
        feesEnabled: false,
        takerBaseFeeBps: 0,
    });
    assert.equal(report.sourceOutcome, 'up');
    assert.equal(report.expectedPayout, 10);
    assert.equal(report.expectedEquity, 100);
    assert.equal(report.executableQuantity, 10);
    assert.equal(report.executableProceeds, 5.5);
    assert.equal(report.liquidationEquity, 95.5);
});

test('taker execution reports partial depth and rejects invalid minimum', () => {
    const frame = makeFrame();
    const partial = simulateTakerFill(frame, frame.snapshots[0], {
        action: 'buy', side: 'up', quantity: 15, limit_price: 0.60,
    }, 100, 0, config);
    assert.equal(partial.status, 'partial');
    assert.equal(partial.filled_quantity, 10);
    const rejected = simulateTakerFill(frame, frame.snapshots[0], {
        action: 'buy', side: 'up', quantity: 4, limit_price: 0.52,
    }, 100, 0, config);
    assert.equal(rejected.reason_code, 'below_minimum_size');
});

test('virtual taker wallet accounts for depth, partial fills, fees and settlement', async () => {
    let upBids = [];
    const marketData = {
        eventId: 'event', marketId: 'market', conditionId: 'condition', tick_size: 0.01,
        min_order_size: 5, fees_enabled: true, maker_base_fee: 0, taker_base_fee: 700,
        rewards_max_spread: 0, rewards_min_size: 0,
        up: { outcome: 'up', tokenId: 'up' }, down: { outcome: 'down', tokenId: 'down' },
    };
    const book = {
        getMarketData: () => marketData,
        getUpMarketData: () => marketData.up,
        getDownMarketData: () => marketData.down,
        getAsksUp: () => [{ price: '0.51', size: '5' }, { price: '0.52', size: '5' }],
        getAsksDown: () => [],
        getBidsUp: () => upBids,
        getBidsDown: () => [],
    };
    const createWallet = () => VirtualTakerLiveOrderWallet.create({
        token_id: 'up', balance: 100, tick_size: 0.01,
        min_order_size: 5, min_buy_order_value: 1,
        fees_enabled: true, taker_base_fee: 700,
    }, book);
    const wallet = createWallet();

    const buy = await wallet.buy(0.52, 10);
    assert.equal(buy?.fast_full_trade, true);
    assert.equal(buy?.value.quantity, 10);
    assert.equal(buy?.value.price, 0.515);

    const noLiquiditySell = await wallet.sell(0.01, 10);
    assert.equal(noLiquiditySell, undefined);
    assert.equal(wallet.getTokensQuantity(), 10);

    upBids = [{ price: '0.49', size: '4' }];
    const partialSell = await wallet.sell(0.01, 10);
    assert.equal(partialSell?.fast_full_trade, false);
    assert.equal(partialSell?.value.quantity, 4);
    assert.equal(wallet.isPartialFilled(partialSell.id), true);
    assert.equal(wallet.getTokensQuantity(), 6);

    upBids = [{ price: '0.48', size: '6' }];
    const finalSell = await wallet.sell(0.01, wallet.getTokensQuantity());
    assert.equal(finalSell?.fast_full_trade, true);
    assert.equal(finalSell?.value.quantity, 6);
    assert.equal(wallet.isFullFilled(finalSell.id), true);
    assert.equal(wallet.getTokensQuantity(), 0);
    assert.equal(wallet.getBalance(), 99.34037);

    const winningWallet = createWallet();
    await winningWallet.buy(0.52, 10);
    assert.equal(winningWallet.settle('up'), 10);
    assert.equal(winningWallet.getTokensQuantity(), 0);
    assert.equal(winningWallet.getBalance(), 104.67517);

    const losingWallet = createWallet();
    await losingWallet.buy(0.52, 10);
    assert.equal(losingWallet.settle('down'), 0);
    assert.equal(losingWallet.getTokensQuantity(), 0);
    assert.equal(losingWallet.getBalance(), 94.67517);
});

test('buy limit is rounded down to the market tick', () => {
    const frame = makeFrame();
    const fill = simulateTakerFill(frame, frame.snapshots[0], {
        action: 'buy', side: 'up', quantity: 8, limit_price: 0.519,
    }, 100, 0, config);
    assert.equal(fill.status, 'partial');
    assert.equal(fill.filled_quantity, 5);
    assert.equal(fill.average_price, 0.51);
});

test('execution rejects a snapshot with an aged coin observation', () => {
    const frame = makeFrame();
    frame.snapshots[0].coin_timestamp -= 6_000;
    const fill = simulateTakerFill(frame, frame.snapshots[0], {
        action: 'buy', side: 'up', quantity: 5, limit_price: 0.51,
    }, 100, 0, config);
    assert.equal(fill.status, 'rejected');
    assert.equal(fill.reason_code, 'coin_data_gap');
});

test('replay carries cash through settlement and is deterministic', () => {
    const frame = makeFrame();
    let entered = false;
    const strategy = {
        name: 'fixture-buy',
        decide() {
            if (entered) return { action: 'hold', reason_code: 'already_entered', order: undefined };
            entered = true;
            return { action: 'buy', reason_code: 'fixture', order: { action: 'buy', side: 'up', quantity: 5, limit_price: 0.51 } };
        },
    };
    const first = runReplay([frame], strategy, config);
    entered = false;
    const second = runReplay([frame], strategy, config);
    assert.deepEqual(first, second);
    assert.ok(first.metrics.net_pnl > 0);
    assert.equal(first.metrics.derived_settlements, 1);
    assert.equal(Number((first.metrics.gross_pnl - first.metrics.net_pnl).toFixed(8)), Number(first.metrics.fees.toFixed(8)));
    assert.equal(
        Number((first.metrics.pre_execution_cost_pnl - first.metrics.gross_pnl).toFixed(8)),
        Number((first.metrics.spread_cost + first.metrics.slippage_cost).toFixed(8)),
    );
    assert.equal(first.metrics.position_frames, 1);
});

test('replay rejects a malformed external order decision', () => {
    const strategy = {
        name: 'invalid-order-decision',
        decide() {
            return {
                action: 'buy',
                reason_code: 'fixture',
                order: { action: 'sell', side: 'up', quantity: 5, limit_price: 0.51 },
            };
        },
    };
    assert.throws(() => runReplay([makeFrame()], strategy, config), /invalid_order_decision/);
});

test('strategy context does not expose future snapshots or settlement', () => {
    const frame = makeFrame();
    const strategy = {
        name: 'look-ahead-check',
        decide(context) {
            assert.equal(context.frame.snapshots, undefined);
            assert.equal(context.frame.settlement, undefined);
            assert.equal(context.frame.coin_frame_end_price, undefined);
            assert.equal(context.frame.coin_frame_start_price, 60_000);
            return { action: 'hold', reason_code: 'checked', order: undefined };
        },
    };
    runReplay([frame], strategy, config);
});

test('millisecond latency executes against the first eligible later book', () => {
    const frame = makeFrame();
    frame.snapshots[1].timestamp = frame.snapshots[0].timestamp + 100;
    frame.snapshots[1].up.asks = [{ price: '0.55', size: '10' }];
    frame.snapshots.push({
        ...frame.snapshots[1],
        timestamp: frame.snapshots[0].timestamp + 250,
        up: { ...frame.snapshots[1].up, asks: [{ price: '0.60', size: '10' }] },
    });
    let entered = false;
    const strategy = {
        name: 'latency-check',
        decide() {
            if (entered) return { action: 'hold', reason_code: 'done', order: undefined };
            entered = true;
            return { action: 'buy', reason_code: 'fixture', order: { action: 'buy', side: 'up', quantity: 5, limit_price: 0.60 } };
        },
    };
    const result = runReplay([frame], strategy, { ...config, latency_ms: 250 });
    assert.equal(result.fills[0].average_price, 0.60);
    assert.equal(result.fills[0].timestamp, frame.snapshots[2].timestamp);
});

test('delayed replay execution hides future fills and reserves its funds', () => {
    const frame = makeFrame();
    frame.snapshots.push({
        ...frame.snapshots[1],
        timestamp: frame.snapshots[0].timestamp + 250,
        up: { ...frame.snapshots[1].up, asks: [{ price: '0.60', size: '10' }] },
    });
    const contexts = [];
    const events = [];
    const strategy = {
        name: 'delayed-state-check',
        decide(context) {
            contexts.push({ index: context.snapshot_index, cash: context.cash, upQuantity: context.up_quantity });
            if (context.snapshot_index !== 0) return { action: 'hold', reason_code: 'done', order: undefined };
            return { action: 'buy', reason_code: 'fixture', order: { action: 'buy', side: 'up', quantity: 5, limit_price: 0.60 } };
        },
        onOrderQueued(order) {
            events.push(`queued:${order.execution_timestamp}`);
        },
        onFill(fill) {
            events.push(`filled:${fill.timestamp}`);
        },
    };
    runReplay([frame], strategy, { ...config, initial_balance: 3.10, latency_ms: 250 });
    assert.equal(contexts[1].index, 1);
    assert.ok(contexts[1].cash > 0 && contexts[1].cash < 0.02);
    assert.equal(contexts[1].upQuantity, 0);
    assert.deepEqual(events, [
        `queued:${frame.snapshots[2].timestamp}`,
        `filled:${frame.snapshots[2].timestamp}`,
    ]);
});

test('millisecond latency does not execute when the frame has no later eligible snapshot', () => {
    const frame = makeFrame();
    const lastSnapshot = frame.snapshots.at(-1);
    lastSnapshot.timestamp = frame.end_time * 1_000 - 50;
    const lastTimestamp = lastSnapshot.timestamp;
    let entered = false;
    const strategy = {
        name: 'latency-frame-end-check',
        decide(context) {
            if (context.snapshot.timestamp !== lastTimestamp) {
                return { action: 'hold', reason_code: 'waiting', order: undefined };
            }
            if (entered) return { action: 'hold', reason_code: 'done', order: undefined };
            entered = true;
            return { action: 'buy', reason_code: 'fixture', order: { action: 'buy', side: 'up', quantity: 5, limit_price: 0.60 } };
        },
    };
    const result = runReplay([frame], strategy, { ...config, latency_ms: 250 });
    assert.equal(result.fills.length, 0);
});

test('no-trade baseline leaves equity unchanged', () => {
    const result = runReplay([makeFrame()], new NoTradeReplayStrategy(), config);
    assert.equal(result.metrics.final_balance, 100);
    assert.equal(result.metrics.trade_count, 0);
});

test('batched decisions reserve cash for each successive fill', () => {
    let entered = false;
    const strategy = {
        name: 'batched-cash-check',
        decide() {
            return { action: 'hold', reason_code: 'unused', order: undefined };
        },
        decideAll() {
            if (entered) return [{ action: 'hold', reason_code: 'done', order: undefined }];
            entered = true;
            return [
                { action: 'buy', reason_code: 'buy_up', order: { action: 'buy', side: 'up', quantity: 5, limit_price: 0.51 } },
                { action: 'buy', reason_code: 'buy_down', order: { action: 'buy', side: 'down', quantity: 5, limit_price: 0.51 } },
            ];
        },
    };

    const result = runReplay([makeFrame()], strategy, { ...config, initial_balance: 5 });

    assert.deepEqual(result.fills.map(fill => fill.status), ['filled', 'rejected']);
    assert.equal(result.fills[1]?.reason_code, 'insufficient_balance');
    assert.equal(result.metrics.filled_orders, 1);
    assert.equal(result.metrics.rejected_orders, 1);
    assert.ok(result.metrics.final_balance >= 0);
});

function makeTrendFrame(progress = 0.02) {
    const frame = makeFrame();
    for (const [index, snapshot] of frame.snapshots.entries()) {
        snapshot.timestamp = frame.start_time * 1_000 + (progress + index * 0.01) * 300_000;
        snapshot.coin_price = 60_006;
        snapshot.coin_timestamp = snapshot.timestamp;
        snapshot.up.asks = [{ price: '0.56', size: '10' }];
        snapshot.down.asks = [{ price: '0.56', size: '10' }];
        snapshot.up.bids = [{ price: '0.55', size: '10' }];
        snapshot.down.bids = [{ price: '0.55', size: '10' }];
    }
    return frame;
}

test('V2 baseline can enter both sides from the same snapshot', () => {
    const result = runReplay([makeTrendFrame()], new TrendLineReplayStrategy(REPLAY_STRATEGY_TREND_LINE_V2), config);
    assert.equal(result.metrics.trade_count, 2);
    assert.deepEqual(result.fills.map(fill => fill.side).sort(), ['down', 'up']);
});

test('matrix uses every registered preset and excludes incomplete or unconfirmed frames', async () => {
    const confirmed = makeFrame();
    confirmed.settlement.confirmed_outcome = 'up';
    confirmed.settlement.confirmed_at = confirmed.end_time * 1_000;
    const incomplete = makeFrame();
    incomplete.slug = 'btc-updown-5m-incomplete';
    incomplete.data_quality.complete = false;
    const unconfirmed = makeFrame();
    unconfirmed.slug = 'btc-updown-5m-unconfirmed';
    const result = runReplayMatrix([confirmed, incomplete, unconfirmed], REPLAY_STRATEGY_PRESETS, config);
    assert.equal(result.frames.length, 1);
    assert.deepEqual(result.excluded_frames.map(frame => frame.reason).sort(), ['incomplete', 'unconfirmed_settlement']);
    assert.deepEqual(Object.keys(result.results), REPLAY_STRATEGY_PRESETS.map(preset => preset.id));

    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-bot-matrix-'));
    try {
        await writeReplayMatrixReport(result, directory);
        const files = await fs.readdir(directory);
        assert.ok(files.includes('manifest.json'));
        assert.ok(files.includes('summary.csv'));
        assert.ok(files.includes('summary.md'));
        assert.ok(files.includes(REPLAY_STRATEGY_TREND_LINE_V2));
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});

test('replay rejects overlapping frames instead of reusing future capital', () => {
    const first = makeFrame();
    const second = makeFrame();
    second.slug = 'btc-updown-5m-1100';
    second.start_time = 1_100;
    second.end_time = 1_400;
    assert.throws(() => runReplay([first, second], new NoTradeReplayStrategy(), config), /overlapping_frames_not_supported/);
});

test('report writer creates the complete deterministic artifact set', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-bot-report-'));
    try {
        const result = runReplay([makeFrame()], new NoTradeReplayStrategy(), config);
        await writeReplayReport(result, directory);
        assert.deepEqual((await fs.readdir(directory)).sort(), [
            'config.json', 'equity.svg', 'metrics.json', 'report.md', 'trades.csv',
        ]);
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});
