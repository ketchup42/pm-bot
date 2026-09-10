import * as path from 'node:path';
import { FileLock } from '../../../file_lock.js';

export function getHistoryFrameLockPath(filePath: string): string {
    return path.join(path.dirname(filePath), `.${path.basename(filePath)}.lock`);
}

export function tryAcquireHistoryFrameLock(filePath: string): Promise<FileLock | undefined> {
    return FileLock.tryAcquire(getHistoryFrameLockPath(filePath));
}
