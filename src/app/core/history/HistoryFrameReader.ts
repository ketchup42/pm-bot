import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { gunzip as gunzipCallback } from 'node:zlib';
import { promisify } from 'node:util';
import { HISTORY_SCHEMA_VERSION, HistoryFrameV2, validateHistoryFrame } from './history_frame.js';

const gunzip = promisify(gunzipCallback);

export async function readHistoryFrame(filePath: string): Promise<HistoryFrameV2> {
    const payload = await fs.readFile(filePath);
    const json = filePath.endsWith('.gz') ? await gunzip(payload) : payload;
    const value: unknown = JSON.parse(json.toString('utf8'));
    if (!value || typeof value !== 'object') throw new Error(`Invalid history frame root: ${filePath}`);
    const version = (value as { schema_version?: unknown }).schema_version;
    if (version !== HISTORY_SCHEMA_VERSION) {
        throw new Error(`unsupported_schema_version: expected ${HISTORY_SCHEMA_VERSION}, got ${String(version)} (${filePath})`);
    }
    const candidate = value as Record<string, unknown>;
    if (!candidate.settlement || !candidate.market_data || !candidate.data_quality ||
        !Array.isArray(candidate.snapshots) || !Array.isArray(candidate.connection_events) || !Array.isArray(candidate.data_gaps)) {
        throw new Error(`Invalid HistoryFrameV2 structure: ${filePath}`);
    }
    const frame = value as HistoryFrameV2;
    const errors = validateHistoryFrame(frame);
    if (errors.length > 0) throw new Error(`Invalid history frame ${filePath}: ${errors.join(', ')}`);
    return frame;
}

export async function getHistoryFramePaths(directory: string): Promise<string[]> {
    return (await fs.readdir(directory))
        .filter(name => /^\d+-[^/]+\.json(?:\.gz)?$/.test(name))
        .sort((left, right) => {
            const leftStart = Number(left.split('-', 1)[0]);
            const rightStart = Number(right.split('-', 1)[0]);
            return leftStart - rightStart || left.localeCompare(right);
        })
        .map(name => path.join(directory, name));
}

export async function* readHistoryFrames(directory: string): AsyncGenerator<HistoryFrameV2> {
    for (const filePath of await getHistoryFramePaths(directory)) yield await readHistoryFrame(filePath);
}
