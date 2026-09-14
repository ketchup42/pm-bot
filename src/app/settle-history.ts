import { logger } from '../log.js';
import { settleHistoryDirectory } from './core/history/HistorySettlementService.js';
import { DEFAULT_HISTORY_DIRECTORY } from './defaults.js';

export async function runHistorySettlement(): Promise<void> {
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
