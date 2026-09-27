import { logger, logger_shutdown, writeOutput } from '../log.js';
import { error_str } from '../utils.js';
import { runBacktest } from './backtest.js';
import { runBacktestMatrix } from './backtest-matrix.js';
import { runCollect } from './collect.js';
import { runDogeBaselineConfigResearch } from './doge-baseline-config-research.js';
import { runDogeBaselineModelResearch } from './doge-baseline-model-research.js';
import { runDogeBaselineRegimeResearch } from './doge-baseline-regime-research.js';
import { runDogeBaselineReplayCommand } from './doge-baseline-replay.js';
import { runDogeBaselineRefresh } from './doge-baseline-refresh.js';
import { runDogeBaselineStrategy } from './doge-baseline.js';
import { runDogeBaselineStatus } from './doge-baseline-status.js';
import { runAccountStatus } from './account-status.js';
import { runHistorySettlement } from './settle-history.js';

type CommandRunner = () => Promise<void>;

interface PmBotCommand {
    name: string;
    description: string;
    run: CommandRunner;
}

const commands: readonly PmBotCommand[] = [
    { name: 'collect', description: 'Collect HistoryFrameV3 data.', run: runCollect },
    { name: 'history:settle', description: 'Confirm outcomes in recorded history.', run: runHistorySettlement },
    { name: 'backtest', description: 'Run one reference strategy replay.', run: runBacktest },
    { name: 'backtest:matrix', description: 'Run every reference strategy replay.', run: runBacktestMatrix },
    { name: 'research:doge-baseline-model', description: 'Train and publish the DOGE model.', run: runDogeBaselineModelResearch },
    { name: 'research:doge-baseline-config', description: 'Tune the DOGE strategy configuration.', run: runDogeBaselineConfigResearch },
    { name: 'research:doge-baseline-regime', description: 'Evaluate DOGE PnL regime filters chronologically.', run: runDogeBaselineRegimeResearch },
    { name: 'replay:doge-baseline', description: 'Replay the published DOGE model.', run: runDogeBaselineReplayCommand },
    { name: 'strategy:doge-baseline', description: 'Run the DOGE strategy.', run: runDogeBaselineStrategy },
    { name: 'status:account', description: 'Return read-only account balance, positions and orders.', run: runAccountStatus },
    { name: 'status:doge-baseline', description: 'Return validated DOGE operating status as JSON.', run: runDogeBaselineStatus },
    { name: 'refresh:doge-baseline', description: 'Continuously settle, train and compare DOGE artifacts.', run: runDogeBaselineRefresh },
];

function writeHelp(): void {
    const rows = commands.map(command => `  ${command.name.padEnd(35)} ${command.description}`);
    writeOutput([
        'Usage: pm-bot <command> [arguments]',
        '',
        'Commands:',
        ...rows,
    ].join('\n'));
}

export async function runPmBot(): Promise<void> {
    const commandName = process.argv[2];
    if (commandName === undefined || commandName === 'help' || commandName === '--help') {
        writeHelp();
        return;
    }
    const command = commands.find(value => value.name === commandName);
    if (command === undefined) {
        throw new Error(`Unknown command: ${commandName}. Run pm-bot help.`);
    }
    await command.run();
}

void (async () => {
    try {
        await runPmBot();
    } catch (error) {
        logger.error(`[PmBot] Fatal error: ${error_str(error)}`);
        process.exitCode = 1;
    } finally {
        await logger_shutdown();
    }
})();
