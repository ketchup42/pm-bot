import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

const FILE_LOCK_PROCESS_IDENTITY_UNAVAILABLE = 'unavailable';

interface FileLockData {
    pid: number;
    createdAt: number;
    owner: string;
    processIdentity: string;
}

function isFileExistsError(error: unknown): boolean {
    return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}

export function isFileMissingError(error: unknown): boolean {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function isProcessRunning(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return !(error instanceof Error && 'code' in error && error.code === 'ESRCH');
    }
}

async function readProcessIdentity(pid: number): Promise<string | undefined> {
    try {
        const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
        return fields[19];
    } catch {
        return undefined;
    }
}

async function isLockOwnerRunning(data: FileLockData): Promise<boolean> {
    if (!isProcessRunning(data.pid)) return false;
    const processIdentity = await readProcessIdentity(data.pid);
    return data.processIdentity === FILE_LOCK_PROCESS_IDENTITY_UNAVAILABLE ||
        processIdentity === undefined || processIdentity === data.processIdentity;
}

async function readLockDataIfPresent(filePath: string): Promise<FileLockData | undefined> {
    let content: string;
    try {
        content = await fs.readFile(filePath, 'utf8');
    } catch (error) {
        if (isFileMissingError(error)) return undefined;
        throw error;
    }

    let value: unknown;
    try {
        value = JSON.parse(content);
    } catch {
        throw new Error(`invalid_file_lock: ${filePath}`);
    }
    if (!value || typeof value !== 'object') throw new Error(`invalid_file_lock: ${filePath}`);
    const candidate = value as Partial<FileLockData>;
    if (!Number.isInteger(candidate.pid) || !Number.isFinite(candidate.createdAt) ||
        typeof candidate.owner !== 'string' || candidate.owner.length === 0 ||
        typeof candidate.processIdentity !== 'string' || candidate.processIdentity.length === 0) {
        throw new Error(`invalid_file_lock: ${filePath}`);
    }
    return candidate as FileLockData;
}

async function unlinkIfPresent(filePath: string): Promise<void> {
    await fs.unlink(filePath).catch(error => {
        if (!isFileMissingError(error)) throw error;
    });
}

function getOwnerFilePath(filePath: string, owner: string): string {
    return `${filePath}.${owner}.owner`;
}

/** Cross-process lock backed by an atomically published local file. */
export class FileLock {
    private released = false;

    private constructor(
        private readonly filePath: string,
        private readonly data: FileLockData,
        private readonly ownerFilePath: string,
    ) {}

    public static async tryAcquire(filePath: string): Promise<FileLock | undefined> {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        const data = {
            pid: process.pid,
            createdAt: Date.now(),
            owner: randomUUID(),
            processIdentity: await readProcessIdentity(process.pid) ?? FILE_LOCK_PROCESS_IDENTITY_UNAVAILABLE,
        };
        const ownerFilePath = getOwnerFilePath(filePath, data.owner);
        let lockAcquired = false;

        try {
            await fs.writeFile(ownerFilePath, `${JSON.stringify(data)}\n`, { flag: 'wx' });
            for (;;) {
                try {
                    await fs.link(ownerFilePath, filePath);
                    lockAcquired = true;
                    return new FileLock(filePath, data, ownerFilePath);
                } catch (error) {
                    if (!isFileExistsError(error)) throw error;
                    const existing = await readLockDataIfPresent(filePath);
                    if (existing === undefined) continue;
                    if (await isLockOwnerRunning(existing)) return undefined;
                    await unlinkIfPresent(filePath);
                    await unlinkIfPresent(getOwnerFilePath(filePath, existing.owner));
                }
            }
        } finally {
            if (!lockAcquired) await unlinkIfPresent(ownerFilePath);
        }
    }

    public async release(): Promise<void> {
        if (this.released) return;
        const existing = await readLockDataIfPresent(this.filePath);
        if (existing?.owner === this.data.owner) await unlinkIfPresent(this.filePath);
        await unlinkIfPresent(this.ownerFilePath);
        this.released = true;
    }
}
