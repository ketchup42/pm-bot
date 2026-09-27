import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { gzip as gzipCallback } from 'node:zlib';
import { promisify } from 'node:util';
import { HistoryFrameV3, validateHistoryFrame } from './history_frame.js';
import { Coin } from '../../../market/coins.js';
import { isFileMissingError } from '../../../file_lock.js';
import { logger } from '../../../log.js';
import { error_str } from '../../../utils.js';
import { getHistoryFramePaths, readHistoryFrameIfPresent } from './HistoryFrameReader.js';
import { tryAcquireHistoryFrameLock } from './HistoryFrameLock.js';
import { updateHistoryProfileStatusesAfterWrite } from './HistoryProfileStatus.js';

const gzip = promisify(gzipCallback);

export interface HistoryFrameWriterOptions {
    directory: string;
    gzip: boolean;
    maxFrames: number;
    maxFramesPerCoin?: number;
    retainedCoins?: readonly Coin[];
    /** Incomplete frames kept outside the training directory for diagnostics. */
    diagnosticRetentionFrames?: number;
}

export interface HistoryWriteResult {
    path: string;
    bytes: number;
    deletedPaths: string[];
}

export class HistoryFrameWriter {
    private readonly options: HistoryFrameWriterOptions;
    private pendingWrite: Promise<void> = Promise.resolve();
    private retainedPaths: Map<Coin, string[]> | undefined;
    private readonly retentionPaths = new Map<string, Map<Coin, string[]>>();

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
        if (options.diagnosticRetentionFrames !== undefined &&
            (!Number.isInteger(options.diagnosticRetentionFrames) || options.diagnosticRetentionFrames < 0)) {
            throw new Error(`History diagnosticRetentionFrames must be an integer >= 0, got ${options.diagnosticRetentionFrames}`);
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

        const directory = frame.data_quality.complete ? this.options.directory : this.getDiagnosticDirectory();
        await fs.mkdir(directory, { recursive: true });
        const extension = this.options.gzip ? '.json.gz' : '.json';
        const fileName = `${frame.start_time}-${frame.market_data.eventId}${extension}`;
        const finalPath = path.join(directory, fileName);
        const temporaryPath = path.join(
            directory,
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

        const deletedPaths = frame.data_quality.complete ? await this.rotate(frame, finalPath) : [];
        if (!frame.data_quality.complete) this.rememberRetentionPath(this.getDiagnosticDirectory(), frame.coin, finalPath);
        await updateHistoryProfileStatusesAfterWrite(this.options.directory, frame, finalPath, deletedPaths).catch(error => {
            logger.warn(`[HistoryFrameWriter] Profile status cache update failed: path=${finalPath} reason=${error_str(error)}`);
        });
        return { path: finalPath, bytes: payload.byteLength, deletedPaths };
    }

    private getDiagnosticDirectory(): string {
        return path.join(path.dirname(this.options.directory), 'diagnostics');
    }

    private async rotate(frame: HistoryFrameV3, finalPath: string): Promise<string[]> {
        const deletedPaths = await this.rotateDiagnostics(frame);
        if ((this.options.maxFramesPerCoin ?? 0) > 0) {
            return [...deletedPaths, ...await this.rotateCoin(frame, finalPath)];
        }
        if (this.options.maxFrames === 0) return deletedPaths;
        const files = await getHistoryFramePaths(this.options.directory);
        const excess = Math.max(0, files.length - this.options.maxFrames);
        for (let index = 0; index < excess; index++) {
            const deleted = await this.tryDeleteFrame(files[index]!);
            if (!deleted) break;
            deletedPaths.push(files[index]!);
        }
        return deletedPaths;
    }

    private async rotateDiagnostics(frame: HistoryFrameV3): Promise<string[]> {
        const diagnosticLimit = this.options.diagnosticRetentionFrames ?? 0;
        const deletedPaths: string[] = [];
        if (diagnosticLimit > 0) {
            deletedPaths.push(...await this.rotateDirectoryForCoin(this.getDiagnosticDirectory(), frame.coin, diagnosticLimit));
        }
        return deletedPaths;
    }

    private async rotateDirectoryForCoin(directory: string, coin: Coin, limit: number): Promise<string[]> {
        const paths = await this.getRetentionPaths(directory, coin);
        const excess = Math.max(0, paths.length - limit);
        const deletedPaths: string[] = [];
        for (let index = 0; index < excess; index++) {
            if (!await this.tryDeleteFrame(paths[index]!)) break;
            deletedPaths.push(paths[index]!);
        }
        paths.splice(0, deletedPaths.length);
        return deletedPaths;
    }

    private rememberRetentionPath(directory: string, coin: Coin, filePath: string): void {
        const byCoin = this.retentionPaths.get(directory);
        const paths = byCoin?.get(coin);
        if (paths !== undefined && !paths.includes(filePath)) paths.push(filePath);
    }

    private async getRetentionPaths(directory: string, coin: Coin): Promise<string[]> {
        let byCoin = this.retentionPaths.get(directory);
        if (byCoin === undefined) {
            byCoin = new Map();
            this.retentionPaths.set(directory, byCoin);
            let filePaths: string[] = [];
            try {
                filePaths = await getHistoryFramePaths(directory);
            } catch (error) {
                if (!isFileMissingError(error)) throw error;
            }
            for (const filePath of filePaths) {
                const existing = await readHistoryFrameIfPresent(filePath);
                if (existing === undefined) continue;
                let paths = byCoin.get(existing.coin);
                if (paths === undefined) {
                    paths = [];
                    byCoin.set(existing.coin, paths);
                }
                paths.push(filePath);
            }
        }
        let paths = byCoin.get(coin);
        if (paths === undefined) {
            paths = [];
            byCoin.set(coin, paths);
        }
        return paths;
    }

    private async rotateCoin(frame: HistoryFrameV3, finalPath: string): Promise<string[]> {
        const retainedCoins = this.options.retainedCoins ?? [];
        if (!retainedCoins.includes(frame.coin)) return [];
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
        const deletedPaths: string[] = [];
        while (paths.length > this.options.maxFramesPerCoin!) {
            if (!await this.tryDeleteFrame(paths[0]!)) break;
            deletedPaths.push(paths[0]!);
            paths.shift();
        }
        return deletedPaths;
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
