import { logger } from '../log.js';
import {
    readFlag,
    readArgument,
    readPositiveIntegerArgument,
    readReplayExecutionConfig,
    readRequiredTradeArguments,
} from './cli_args.js';
import { DEFAULT_HISTORY_DIRECTORY, DEFAULT_HISTORY_REPORTS_DIRECTORY } from './defaults.js';
import { isEventFrame } from '../market/frame.js';
import {
    createDogeBaselineStrategyConfig,
    readDogeBaselineArtifacts,
    writeDogeBaselineStrategyConfig,
} from './core/events/strategy/doge-baseline/artifacts.js';
import { DOGE_BASELINE_DEFAULT_REPLAY_LATENCY_MS } from './core/events/strategy/doge-baseline/DogeBaselineConfig.js';
import { DogeBaselineRefreshLock } from './core/events/strategy/doge-baseline/DogeBaselineRefreshLock.js';
import { runDogeBaselineRegimeHistoryResearch as runResearch } from './core/events/strategy/doge-baseline/regime_research.js';
import { selectDogeBaselineRefreshArtifacts } from './core/events/strategy/doge-baseline/DogeBaselineSelection.js';
import { fileWrite } from '../utils.js';

const DOGE_BASELINE_REGIME_RESEARCH_OUTPUT_DIRECTORY = `${DEFAULT_HISTORY_REPORTS_DIRECTORY}/doge-baseline-regime/latest`;
const DOGE_BASELINE_REGIME_RESEARCH_APPLY_MINIMUM_WINDOWS = 24;

function formatNumber(value: number): string {
    return value.toFixed(6);
}

export async function runDogeBaselineRegimeResearch(): Promise<void> {
    const frame = readArgument('frame');
    if (frame === undefined || !isEventFrame(frame)) throw new Error('--frame must be a supported frame');
    const refreshFrames = readPositiveIntegerArgument('count');
    const trainingFrames = readPositiveIntegerArgument('train-count');
    const replayFrames = readPositiveIntegerArgument('replay');
    const history = readArgument('history') ?? DEFAULT_HISTORY_DIRECTORY;
    const apply = readFlag('apply');
    const output = readArgument('output') ?? DOGE_BASELINE_REGIME_RESEARCH_OUTPUT_DIRECTORY;
    if (apply && readArgument('output') !== undefined) throw new Error('--output cannot be used with --apply');
    const trade = readRequiredTradeArguments();
    const executionConfig = readReplayExecutionConfig(
        trade.balance,
        DOGE_BASELINE_DEFAULT_REPLAY_LATENCY_MS,
    );
    const result = await runResearch({
        historyDirectory: history,
        trainingFrames,
        replayFrames,
        refreshFrames,
        executionConfig,
        tradeValue: trade.tradeValue,
        selectArtifacts: selectDogeBaselineRefreshArtifacts,
    });
    if (!apply) {
        const rows = result.policies.map(value => {
            const policy = value.policy;
            const selection = value.selection;
            const validation = value.validation;
            return `| ${policy.id} | ${formatNumber(selection.netPnl)} | ${selection.profitableWindows}/${selection.activeWindows} | ` +
                `${formatNumber(selection.missedProfitablePnl)} | ${selection.tradeCount} | ${formatNumber(selection.fees)} | ` +
                `${formatNumber(selection.spreadCost)} | ${formatNumber(selection.slippageCost)} | ${formatNumber(selection.maxDrawdown)} | ` +
                `${formatNumber(validation.netPnl)} | ${validation.profitableWindows}/${validation.activeWindows} | ` +
                `${formatNumber(validation.missedProfitablePnl)} | ${validation.tradeCount} | ${formatNumber(validation.fees)} | ` +
                `${formatNumber(validation.spreadCost)} | ${formatNumber(validation.slippageCost)} | ${formatNumber(validation.maxDrawdown)} |`;
        });
        await fileWrite(`${output}/summary.md`, [
            '# DOGE baseline regime walk-forward research', '',
            `Eligible frames: ${result.availableFrames}`, `Required frames: ${result.requiredFrames}`,
            `Refresh step: ${result.refreshFrames}`, `Training frames: ${result.trainingFrames}`,
            `Replay frames: ${result.replayFrames}`, '',
            `Baseline: ${result.baseline.id}`, `Selected: ${result.selected?.policy.id ?? 'none'}`, '',
            '| Policy | Selection PnL | Selection profitable/active | Selection missed PnL | Selection trades | Selection fees | Selection spread | Selection slippage | Selection drawdown | Validation PnL | Validation profitable/active | Validation missed PnL | Validation trades | Validation fees | Validation spread | Validation slippage | Validation drawdown |',
            '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |', ...rows, '',
        ].join('\n'));
        await fileWrite(`${output}/result.json`, `${JSON.stringify(result, undefined, 2)}\n`);
        logger.info(`[DogeBaselineRegimeResearch] Report written to ${output}; selected=${result.selected?.policy.id ?? 'none'}`);
        return;
    }
    const selected = result.selected;
    if (selected === undefined) throw new Error('doge_baseline_regime_research_no_eligible_policy');
    if (selected.windows.length < DOGE_BASELINE_REGIME_RESEARCH_APPLY_MINIMUM_WINDOWS) {
        throw new Error(`Insufficient walk-forward windows to apply regime: required=${DOGE_BASELINE_REGIME_RESEARCH_APPLY_MINIMUM_WINDOWS} ` +
            `available=${selected.windows.length}`);
    }
    const lock = await DogeBaselineRefreshLock.acquire();
    try {
        const artifacts = await readDogeBaselineArtifacts();
        const config = createDogeBaselineStrategyConfig(artifacts.model, {
            tradingEnabled: artifacts.config.tradingEnabled,
            regime: selected.policy,
            entry: artifacts.config.entry,
            exit: artifacts.config.exit,
        });
        await writeDogeBaselineStrategyConfig(config, artifacts.model);
        logger.info(
            `[DogeBaselineRegimeResearch] Applied ${selected.policy.id}: ` +
            `validationNetPnL=${formatNumber(selected.validation.netPnl)} ` +
            `profitableWindows=${selected.validation.profitableWindows}/${selected.validation.activeWindows}`,
        );
    } finally {
        await lock.release();
    }
}
