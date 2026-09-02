import 'dotenv/config';
import { logger, logger_shutdown } from '../log.js';
import { error_str } from '../utils.js';
import { settleHistoryDirectory } from './core/history/HistorySettlementService.js';

async function main(): Promise<void> {
    const directory = process.env.HISTORY_DIR || 'history/frames';
    const result = await settleHistoryDirectory({ directory });
    for (const failure of result.failures) {
        logger.warn(`[HistorySettlement] Failed ${failure.file_path}: ${failure.reason}`);
    }
    logger.info(
        `[HistorySettlement] Checked=${result.checked} updated=${result.updated} ` +
        `unresolved=${result.unresolved} failed=${result.failed}`,
    );
    if (result.failed > 0) process.exitCode = 1;
    await logger_shutdown();
}

main().catch(async error => {
    logger.error(`[HistorySettlement] Fatal error: ${error_str(error)}`);
    await logger_shutdown();
    process.exitCode = 1;
});
