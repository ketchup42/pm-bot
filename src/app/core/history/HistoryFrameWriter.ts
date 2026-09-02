import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { gzip as gzipCallback } from 'node:zlib';
import { promisify } from 'node:util';
import { HistoryFrameV2, validateHistoryFrame } from './history_frame.js';

const gzip = promisify(gzipCallback);

export interface HistoryFrameWriterOptions {
    directory: string;
    gzip: boolean;
    maxFrames: number;
}

export interface HistoryWriteResult {
    path: string;
    bytes: number;
}

export class HistoryFrameWriter {
    private readonly options: HistoryFrameWriterOptions;

    public constructor(options: HistoryFrameWriterOptions) {
        if (!options.directory) throw new Error('History directory must not be empty');
        if (!Number.isInteger(options.maxFrames) || options.maxFrames < 0) {
            throw new Error(`History maxFrames must be an integer >= 0, got ${options.maxFrames}`);
        }
        this.options = options;
    }

    public async write(frame: HistoryFrameV2): Promise<HistoryWriteResult> {
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

        await this.rotate();
        return { path: finalPath, bytes: payload.byteLength };
    }

    private async rotate(): Promise<void> {
        if (this.options.maxFrames === 0) return;
        const files = (await fs.readdir(this.options.directory))
            .filter(name => /^\d+-[^/]+\.json(?:\.gz)?$/.test(name))
            .sort((left, right) => {
                const leftStart = Number(left.split('-', 1)[0]);
                const rightStart = Number(right.split('-', 1)[0]);
                return leftStart - rightStart || left.localeCompare(right);
            });
        const toDelete = files.slice(0, Math.max(0, files.length - this.options.maxFrames));
        await Promise.all(toDelete.map(name => fs.unlink(path.join(this.options.directory, name))));
    }
}
