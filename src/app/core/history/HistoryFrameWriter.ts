import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { gzip as gzipCallback } from 'node:zlib';
import { promisify } from 'node:util';
import { HistoryFrameV3, validateHistoryFrame } from './history_frame.js';
import { Coin } from '../../../market/coins.js';
import { isFileMissingError } from '../../../file_lock.js';
import { getHistoryFramePaths, readHistoryFrameIfPresent } from './HistoryFrameReader.js';
import { tryAcquireHistoryFrameLock } from './HistoryFrameLock.js';

const gzip = promisify(gzipCallback);

export interface HistoryFrameWriterOptions {
    directory: string;
    gzip: boolean;
    maxFrames: number;
    maxFramesPerCoin?: number;
    retainedCoins?: readonly Coin[];
}

export interface HistoryWriteResult {
    path: string;
    bytes: number;
}

export class HistoryFrameWriter {
    private readonly options: HistoryFrameWriterOptions;
    private pendingWrite: Promise<void> = Promise.resolve();
    private retainedPaths: Map<Coin, string[]> | undefined;

    public constructor(options: HistoryFrameWriterOptions) {
        if (!options.directory) throw new Error('History directory must not be empty');
        if (!Number.isInteger(options.maxFrames) || options.maxFrames < 0) {
            throw new Error(`History maxFrames must be an integer >= 0, got ${options.maxFrames}`);
        }
        if (options.maxFramesPerCoin !== undefined &&
            (!Number.isInteger(options.maxFramesPerCoin) || options.maxFramesPerCoin < 0)) {
            throw new Error(`History maxFramesPerCoin must be an integer >= 0, got ${options.maxFramesPerCoin}`);
        }
        if ((options.maxFramesPerCoin ?? 0) > 0 && (options.retainedCoins?.length ?? 0) === 0) {
            throw new Error('History retainedCoins must not be empty when maxFramesPerCoin is enabled');
        }
        this.options = options;
    }

    public write(frame: HistoryFrameV3): Promise<HistoryWriteResult> {
        const write = this.pendingWrite.then(() => this.writeFrame(frame));
        this.pendingWrite = write.then(() => undefined, () => undefined);
        return write;
    }

    private async writeFrame(frame: HistoryFrameV3): Promise<HistoryWriteResult> {
        const validationErrors = validateHistoryFrame(frame);
        if (validationErrors.length > 0) {
            throw new Error(`Invalid history frame: ${validationErrors.join(', ')}`);
        }

        await fs.mkdir(this.options.directory, { recursive: true });
        const extension = this.options.gzip ? '.json.gz' : '.json';
        const fileName = `${frame.start_time}-${frame.market_data.eventId}${extension}`;
        const finalPath = path.join(this.options.directory, fileName);
        const temporaryPath = path.join(
            this.options.directory,
            `.${fileName}.${process.pid}-${Date.now()}.tmp`,
        );
        const json = Buffer.from(JSON.stringify(frame), 'utf8');
        const payload = this.options.gzip ? await gzip(json, { level: 9 }) : json;

        try {
            await fs.writeFile(temporaryPath, payload, { flag: 'wx' });
            await fs.rename(temporaryPath, finalPath);
        } catch (error) {
            await fs.unlink(temporaryPath).catch(() => {});
            throw error;
        }

        await this.rotate(frame, finalPath);
        return { path: finalPath, bytes: payload.byteLength };
    }

    private async rotate(frame: HistoryFrameV3, finalPath: string): Promise<void> {
        if ((this.options.maxFramesPerCoin ?? 0) > 0) {
            await this.rotateCoin(frame, finalPath);
            return;
        }
        if (this.options.maxFrames === 0) return;
        const files = await getHistoryFramePaths(this.options.directory);
        const excess = Math.max(0, files.length - this.options.maxFrames);
        for (let index = 0; index < excess; index++) {
            const deleted = await this.tryDeleteFrame(files[index]!);
            if (!deleted) break;
        }
    }

    private async rotateCoin(frame: HistoryFrameV3, finalPath: string): Promise<void> {
        const retainedCoins = this.options.retainedCoins ?? [];
        if (!retainedCoins.includes(frame.coin)) return;
        let initializedNow = false;
        if (!this.retainedPaths) {
            initializedNow = true;
            this.retainedPaths = new Map(retainedCoins.map(coin => [coin, []]));
            for (const filePath of await getHistoryFramePaths(this.options.directory)) {
                const existing = await readHistoryFrameIfPresent(filePath);
                if (existing === undefined) continue;
                this.retainedPaths.get(existing.coin)?.push(filePath);
            }
        }
        const paths = this.retainedPaths.get(frame.coin)!;
        if (!initializedNow) paths.push(finalPath);
        while (paths.length > this.options.maxFramesPerCoin!) {
            if (!await this.tryDeleteFrame(paths[0]!)) break;
            paths.shift();
        }
    }

    private async tryDeleteFrame(filePath: string): Promise<boolean> {
        const lock = await tryAcquireHistoryFrameLock(filePath);
        if (lock === undefined) return false;
        try {
            await fs.unlink(filePath).catch(error => {
                if (!isFileMissingError(error)) throw error;
            });
            return true;
        } finally {
            await lock.release();
        }
    }
}
