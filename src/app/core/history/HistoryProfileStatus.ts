import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Coin } from '../../../market/coins.js';
import type { EventFrame } from '../../../market/frame.js';
import type { PriceSource } from '../../../market/price/price_source.js';
import type { HistoryFrameV3 } from './history_frame.js';
import { getHistoryFramePaths, readHistoryFrameIfPresent } from './HistoryFrameReader.js';

export const HISTORY_PROFILE_STATUS_VERSION = 1 as const;

export interface HistoryProfile {
    coin: Coin;
    frame: EventFrame;
    source: PriceSource;
}

export interface HistoryProfileStatusFrame {
    startTime: number;
    eligible: boolean;
}

/**
 * Compact, profile-scoped cache. Eligibility is intentionally supplied by its
 * consumer: the history subsystem only owns frame paths and collector profile.
 */
export interface HistoryProfileStatus {
    version: typeof HISTORY_PROFILE_STATUS_VERSION;
    profile: HistoryProfile;
    /** Complete-frame filenames in the history directory, including other profiles. */
    knownFiles: string[];
    frames: Record<string, HistoryProfileStatusFrame>;
    eligibleFrames: number;
    latestEligibleFrameStart: number | undefined;
    stale: boolean;
}

function sameProfile(left: Readonly<HistoryProfile>, right: Readonly<HistoryProfile>): boolean {
    return left.coin === right.coin && left.frame === right.frame && left.source === right.source;
}

function compareHistoryFileNames(left: string, right: string): number {
    const leftStart = Number(left.split('-', 1)[0]);
    const rightStart = Number(right.split('-', 1)[0]);
    return leftStart - rightStart || left.localeCompare(right);
}

function isProfile(value: unknown): value is HistoryProfile {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Record<string, unknown>;
    return typeof candidate.coin === 'string' && typeof candidate.frame === 'string' && typeof candidate.source === 'string';
}

function isFrameStatus(value: unknown): value is HistoryProfileStatusFrame {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Record<string, unknown>;
    return typeof candidate.startTime === 'number' && Number.isInteger(candidate.startTime) && candidate.startTime >= 0 &&
        typeof candidate.eligible === 'boolean';
}

function isHistoryProfileStatus(value: unknown): value is HistoryProfileStatus {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Record<string, unknown>;
    return candidate.version === HISTORY_PROFILE_STATUS_VERSION && isProfile(candidate.profile) &&
        candidate.frames !== null && typeof candidate.frames === 'object' &&
        Object.values(candidate.frames).every(isFrameStatus) &&
        Array.isArray(candidate.knownFiles) && candidate.knownFiles.every(value => typeof value === 'string') &&
        typeof candidate.eligibleFrames === 'number' && Number.isInteger(candidate.eligibleFrames) && candidate.eligibleFrames >= 0 &&
        (candidate.latestEligibleFrameStart === undefined ||
            (typeof candidate.latestEligibleFrameStart === 'number' && Number.isInteger(candidate.latestEligibleFrameStart) &&
                candidate.latestEligibleFrameStart >= 0)) &&
        typeof candidate.stale === 'boolean';
}

export function getHistoryProfileStatusDirectory(historyDirectory: string): string {
    return path.join(path.dirname(historyDirectory), 'status');
}

export function getHistoryProfileStatusPath(historyDirectory: string, profile: Readonly<HistoryProfile>): string {
    return path.join(getHistoryProfileStatusDirectory(historyDirectory), `${profile.coin}-${profile.frame}-${profile.source}.json`);
}

function getSummary(frames: Readonly<Record<string, HistoryProfileStatusFrame>>): Pick<HistoryProfileStatus, 'eligibleFrames' | 'latestEligibleFrameStart'> {
    const eligible = Object.values(frames).filter(frame => frame.eligible);
    return {
        eligibleFrames: eligible.length,
        latestEligibleFrameStart: eligible.reduce<number | undefined>(
        (latest, frame) => latest === undefined || frame.startTime > latest ? frame.startTime : latest,
        undefined,
        ),
    };
}

function summarize(status: HistoryProfileStatus): void {
    Object.assign(status, getSummary(status.frames));
}

function hasConsistentSummary(status: Readonly<HistoryProfileStatus>): boolean {
    const summary = getSummary(status.frames);
    return summary.eligibleFrames === status.eligibleFrames &&
        summary.latestEligibleFrameStart === status.latestEligibleFrameStart;
}

export async function readHistoryProfileStatus(
    historyDirectory: string,
    profile: Readonly<HistoryProfile>,
): Promise<HistoryProfileStatus | undefined> {
    try {
        const payload = await fs.readFile(getHistoryProfileStatusPath(historyDirectory, profile), 'utf8');
        const value: unknown = JSON.parse(payload);
        if (!isHistoryProfileStatus(value) || !sameProfile(value.profile, profile) || !hasConsistentSummary(value)) return undefined;
        return value;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        if (error instanceof SyntaxError) return undefined;
        throw error;
    }
}

export async function writeHistoryProfileStatus(historyDirectory: string, status: Readonly<HistoryProfileStatus>): Promise<void> {
    const directory = getHistoryProfileStatusDirectory(historyDirectory);
    await fs.mkdir(directory, { recursive: true });
    const finalPath = getHistoryProfileStatusPath(historyDirectory, status.profile);
    const temporaryPath = path.join(directory, `.${path.basename(finalPath)}.${process.pid}-${Date.now()}.tmp`);
    try {
        await fs.writeFile(temporaryPath, `${JSON.stringify(status)}\n`, { flag: 'wx' });
        await fs.rename(temporaryPath, finalPath);
    } catch (error) {
        await fs.unlink(temporaryPath).catch(() => {});
        throw error;
    }
}

export async function rebuildHistoryProfileStatus(
    historyDirectory: string,
    profile: Readonly<HistoryProfile>,
    isEligible: (frame: HistoryFrameV3) => boolean,
): Promise<HistoryProfileStatus> {
    const frames: Record<string, HistoryProfileStatusFrame> = {};
    const paths = await getHistoryFramePaths(historyDirectory);
    for (const filePath of paths) {
        const frame = await readHistoryFrameIfPresent(filePath);
        if (frame === undefined || !sameProfile(frame, profile)) continue;
        frames[path.basename(filePath)] = { startTime: frame.start_time, eligible: isEligible(frame) };
    }
    const status: HistoryProfileStatus = {
        version: HISTORY_PROFILE_STATUS_VERSION,
        profile: { ...profile },
        knownFiles: paths.map(filePath => path.basename(filePath)),
        frames,
        eligibleFrames: 0,
        latestEligibleFrameStart: undefined,
        stale: false,
    };
    summarize(status);
    await writeHistoryProfileStatus(historyDirectory, status);
    return status;
}

export async function isHistoryProfileStatusCurrent(
    historyDirectory: string,
    status: Readonly<HistoryProfileStatus>,
): Promise<boolean> {
    if (status.stale) return false;
    const fileNames = (await getHistoryFramePaths(historyDirectory)).map(filePath => path.basename(filePath));
    const cachedNames = status.knownFiles;
    return fileNames.length === cachedNames.length && fileNames.every((name, index) => name === cachedNames[index]);
}

/**
 * Generic write-side maintenance. It never computes a strategy's eligibility:
 * a settled replacement is marked stale for the strategy to rebuild later.
 */
export async function updateHistoryProfileStatusesAfterWrite(
    historyDirectory: string,
    frame: Readonly<HistoryFrameV3>,
    finalPath: string,
    deletedPaths: readonly string[],
): Promise<void> {
    let names: string[];
    try {
        names = await fs.readdir(getHistoryProfileStatusDirectory(historyDirectory));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
    }
    const deleted = new Set(deletedPaths
        .filter(filePath => path.dirname(filePath) === historyDirectory)
        .map(filePath => path.basename(filePath)));
    for (const name of names.filter(name => name.endsWith('.json'))) {
        const cachePath = path.join(getHistoryProfileStatusDirectory(historyDirectory), name);
        let status: HistoryProfileStatus;
        try {
            const value: unknown = JSON.parse(await fs.readFile(cachePath, 'utf8'));
            if (!isHistoryProfileStatus(value)) continue;
            status = value;
        } catch {
            continue;
        }
        let changed = false;
        for (const deletedName of deleted) {
            const knownIndex = status.knownFiles.indexOf(deletedName);
            if (knownIndex !== -1) {
                status.knownFiles.splice(knownIndex, 1);
                changed = true;
            }
            if (status.frames[deletedName] === undefined) continue;
            delete status.frames[deletedName];
            changed = true;
        }
        if (frame.data_quality.complete) {
            const finalName = path.basename(finalPath);
            if (!status.knownFiles.includes(finalName)) {
                status.knownFiles.push(finalName);
                status.knownFiles.sort(compareHistoryFileNames);
                changed = true;
            }
        }
        if (!sameProfile(status.profile, frame)) {
            if (changed) await writeHistoryProfileStatus(historyDirectory, status);
            continue;
        }
        if (frame.data_quality.complete) {
            const finalName = path.basename(finalPath);
            if (frame.settlement.confirmed_outcome === undefined) {
                if (status.frames[finalName] === undefined) {
                    status.frames[finalName] = { startTime: frame.start_time, eligible: false };
                    changed = true;
                }
            } else {
                status.stale = true;
                changed = true;
            }
        }
        if (!changed) continue;
        summarize(status);
        await writeHistoryProfileStatus(historyDirectory, status);
    }
}
