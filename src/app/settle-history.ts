import 'dotenv/config';
import { logger, logger_shutdown } from '../log.js';
import { error_str } from '../utils.js';
import { settleHistoryDirectory } from './core/history/HistorySettlementService.js';
import { DEFAULT_HISTORY_DIRECTORY } from './defaults.js';

async function main(): Promise<void> {
    const directory = process.env.HISTORY_DIR || DEFAULT_HISTORY_DIRECTORY;
    const result = await settleHistoryDirectory({ directory });
    for (const failure of result.failures) {
        logger.warn(`[HistorySettlement] Failed ${failure.file_path}: ${failure.reason}`);
    }
    logger.info(
        `[HistorySettlement] Checked=${result.checked} updated=${result.updated} ` +
        `unresolved=${result.unresolved} disappeared=${result.disappeared} failed=${result.failed}`,
    );
    if (result.failed > 0) process.exitCode = 1;
}

async function run(): Promise<void> {
    try {
        await main();
    } catch (error) {
        logger.error(`[HistorySettlement] Fatal error: ${error_str(error)}`);
        process.exitCode = 1;
    } finally {
        await logger_shutdown();
    }
}

void run();
