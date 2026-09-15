import {
    readArgument,
    readOptionalPositiveIntegerArgument,
    readReplayExecutionConfig,
    readRequiredTradeArguments,
} from './cli_args.js';
import { DEFAULT_DOGE_BASELINE_REPLAY_OUTPUT_DIRECTORY, DEFAULT_HISTORY_DIRECTORY } from './defaults.js';
import { writeReplayReport } from './core/backtest/replay.js';
import { runDogeBaselineReplay } from './core/backtest/strategy/DogeBaselineReplayStrategy.js';
import { readDogeBaselineTrainReplaySplit } from './core/events/strategy/doge-baseline/DogeBaselineResearch.js';
import {
    readDogeBaselineArtifacts,
    toDogeBaselineRuntimeConfig,
} from './core/events/strategy/doge-baseline/artifacts.js';
import { DOGE_BASELINE_DEFAULT_REPLAY_FRAME_COUNT, DOGE_BASELINE_MODES } from './core/events/strategy/doge-baseline/DogeBaselineConfig.js';
import { DOGE_BASELINE_ENTRY_REJECTION_REASONS } from './core/events/strategy/doge-baseline/DogeBaselineDecision.js';
import { logger } from '../log.js';
import { fileWrite } from '../utils.js';

function readFrameCount(): number {
    return readOptionalPositiveIntegerArgument('count') ?? DOGE_BASELINE_DEFAULT_REPLAY_FRAME_COUNT;
}

export async function runDogeBaselineReplayCommand(): Promise<void> {
    const history = readArgument('history') ?? DEFAULT_HISTORY_DIRECTORY;
    const output = readArgument('output') ?? DEFAULT_DOGE_BASELINE_REPLAY_OUTPUT_DIRECTORY;
    const count = readFrameCount();
    const { replay: frames } = await readDogeBaselineTrainReplaySplit(
        history,
        { trainingCount: 0, replayCount: count },
    );
    const modelPath = readArgument('model');
    const configPath = readArgument('config');
    if ((modelPath === undefined) !== (configPath === undefined)) {
        throw new Error('--model and --config must be provided together');
    }
    const artifacts = modelPath === undefined
        ? await readDogeBaselineArtifacts()
        : await readDogeBaselineArtifacts(modelPath, configPath!);
    const trade = readRequiredTradeArguments();
    const config = readReplayExecutionConfig(trade.balance);
    const replay = runDogeBaselineReplay(frames, artifacts.model, config, {
        ...toDogeBaselineRuntimeConfig(artifacts.config),
        tradeValue: trade.tradeValue,
    });
    const results = [
        { mode: 'combined', result: replay.combined },
        ...DOGE_BASELINE_MODES.map(mode => ({ mode: mode.name, result: replay.modes[mode.name] })),
    ];
    await Promise.all(results.map(value => writeReplayReport(value.result, `${output}/${value.mode}`)));
    const rows = results.map(value =>
        `| ${value.mode.padEnd(9)} | ${String(value.result.metrics.trade_count).padStart(6)} | ` +
        `${value.result.metrics.net_pnl.toFixed(6).padStart(11)} | ${value.result.metrics.profit_factor?.toFixed(4).padStart(8) ?? '       -'} | ` +
        `${value.result.metrics.max_drawdown.toFixed(6).padStart(12)} |`,
    );
    const decisionRows = DOGE_BASELINE_MODES.map(mode => {
        const decisions = replay.entryDecisions[mode.name];
        return `| ${mode.name.padEnd(9)} | ${String(decisions.evaluated).padStart(9)} | ` +
            `${String(decisions.accepted).padStart(8)} | ${DOGE_BASELINE_ENTRY_REJECTION_REASONS.map(reason =>
                String(decisions.rejectedByReason[reason] ?? 0).padStart(5)).join(' | ')} |`;
    });
    await fileWrite(`${output}/summary.md`, [
        '# DOGE baseline replay', '',
        `Model: ${modelPath ?? 'working model'}`,
        `Balance: $${trade.balance.toFixed(2)}`,
        `Trade value: $${trade.tradeValue.toFixed(2)}`, '',
        '| Mode      | Trades |     Net PnL | Profit factor | Max drawdown |',
        '| --------- | -----: | ----------: | ------------: | -----------: |',
        ...rows, '',
        '## Entry decisions', '',
        '| Mode      | Evaluated | Accepted | Neutral | Confidence | Deviation | Side unavailable | Liquidity | Minimum value | Edge | Balance |',
        '| --------- | --------: | -------: | ------: | ---------: | --------: | ---------------: | --------: | ------------: | ---: | ------: |',
        ...decisionRows, '',
    ].join('\n'));
    await fileWrite(`${output}/entry-decisions.json`, `${JSON.stringify(replay.entryDecisions, undefined, 2)}\n`);
    logger.info(
        `[DogeBaselineReplay] Result:\n${JSON.stringify(
            {
                metrics: Object.fromEntries(results.map(value => [value.mode, value.result.metrics])),
                entryDecisions: replay.entryDecisions,
            },
            undefined,
            2,
        )}`,
    );
}
