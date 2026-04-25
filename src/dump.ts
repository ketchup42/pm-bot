import * as fs from 'fs/promises';
import * as path from 'path';
import 'dotenv/config';

import { error_str, fileWrite, safeToNum } from './utils.js';
import { logger } from './log.js';

/**
 * Directory where dump files are stored.
 * @default 'dumps'
 */
const DUMPS_DIR = process.env.DUMPS_DIR || 'dumps';

/**
 * Maximum number of dump files to keep. Older files are deleted first.
 * @default 10
 */
const DUMP_MAX_FILES = Math.max(1, safeToNum(process.env.DUMP_MAX_FILES || '10'));

/**
 * A simple rotating JSON dumper.
 * 
 * Writes JSON representations of objects to a specified directory.
 * Once the number of dump files exceeds the configured maximum,
 * the oldest files are automatically deleted.
 */
class Dumper {
    /** Base directory where dump files are stored. */
    private readonly _basepath: string;
    /** Maximum number of dump files to retain. */
    private readonly _maxDumps: number;
    /** Prefix used for dump file names. */
    private readonly _prefix = 'DUMP-';

    /**
     * @param basepath - Directory where dump files will be stored.
     * @param maxDumps - Maximum number of dump files to keep.
     */
    private constructor(basepath: string, maxDumps: number) {
        this._basepath = basepath;
        this._maxDumps = maxDumps;
    }

    /**
     * Creates a new Dumper instance.
     * @param basepath - Directory for dump files.
     * @param maxdumps - Maximum number of dump files to keep.
     * @returns A configured Dumper instance.
     */
    public static create(basepath: string, maxdumps: number): Dumper {
        return new Dumper(basepath, maxdumps);
    }

    /**
     * Writes an object as JSON to a new dump file.
     * The filename includes a timestamp and the given suffix.
     * Old dump files are rotated asynchronously.
     *
     * @param data   - The value to serialise. Must be JSON‑serialisable.
     * @param suffix - A short string appended to the filename.
     */
    public async dump(data: unknown, suffix: string): Promise<void> {
        const cleanSuffix = suffix.replace(/[^a-zA-Z0-9_\-]/g, '-');
        const ts = Date.now().toString();
        const fileName = `${this._prefix}${ts}-${cleanSuffix}.json`;
        const filePath = path.join(this._basepath, fileName);

        const json = JSON.stringify(data, null, 2);
        await fileWrite(filePath, json, { encoding: 'utf-8' });

        this.rotate().catch(error => logger.error(`Dumper rotation error: ${error_str(error)}`));
    }

    /**
     * Deletes the oldest dump files until only {@link _maxDumps} remain.
     * Files are sorted by the numeric timestamp extracted from their names.
     */
    private async rotate(): Promise<void> {
        let files: string[];
        try {
            files = await fs.readdir(this._basepath);
        } catch {
            return; // directory missing or unreadable – nothing to rotate
        }

        const dumpFiles = files.filter(f => f.startsWith(this._prefix) && f.endsWith('.json'));
        if (dumpFiles.length <= this._maxDumps) return;

        const prefixLen = this._prefix.length;
        dumpFiles.sort((a, b) => {
            const extractTs = (name: string) => {
                const start = prefixLen;
                const end = name.indexOf('-', start);
                return end === -1 ? 0 : parseInt(name.slice(start, end), 10);
            };
            return extractTs(a) - extractTs(b);
        });

        const toDelete = dumpFiles.slice(0, dumpFiles.length - this._maxDumps);
        await Promise.allSettled(toDelete.map(f => fs.unlink(path.join(this._basepath, f))));
    }
}

/**
 * Global dumper instance for system‑wide use.
 */
export const dumper = Dumper.create(DUMPS_DIR, safeToNum(DUMP_MAX_FILES));