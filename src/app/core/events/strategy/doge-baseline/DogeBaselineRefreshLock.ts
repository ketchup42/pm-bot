import * as path from 'node:path';
import { FileLock } from '../../../../../file_lock.js';
import { DOGE_BASELINE_REFRESH_LOCK_FILE } from './DogeBaselineConfig.js';
import { getDogeBaselineModelPath } from './DogeBaselineModel.js';

/** Prevents concurrent processes from publishing the same DOGE model. */
export class DogeBaselineRefreshLock {
    private constructor(private readonly lock: FileLock) {}

    public static async acquire(): Promise<DogeBaselineRefreshLock> {
        const filePath = path.join(path.dirname(getDogeBaselineModelPath()), DOGE_BASELINE_REFRESH_LOCK_FILE);
        const lock = await FileLock.tryAcquire(filePath);
        if (lock === undefined) throw new Error('doge_baseline_refresh_already_running');
        return new DogeBaselineRefreshLock(lock);
    }

    public async release(): Promise<void> {
        await this.lock.release();
    }
}
