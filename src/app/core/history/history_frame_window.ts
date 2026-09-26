import type { HistoryFrameV3 } from './history_frame.js';

export type HistoryFrameRead = (path: string) => Promise<HistoryFrameV3 | undefined>;
export type HistoryReadStopCheck = () => boolean;

export interface HistoryFrameIndexEntry {
    path: string;
}

/**
 * A lightweight, sorted index of history files. It deliberately contains paths
 * only, leaving compressed payloads on disk until a consumer needs one frame.
 */
export class HistoryFrameIndex {
    public constructor(
        private readonly entries: readonly HistoryFrameIndexEntry[],
        private readonly readFrame: HistoryFrameRead,
    ) {}

    public get length(): number { return this.entries.length; }

    public at(index: number): HistoryFrameIndexEntry | undefined { return this.entries[index]; }

    public cursor(newestFirst = false, shouldStop: HistoryReadStopCheck = () => false): HistoryFrameCursor {
        return new HistoryFrameCursor(this, newestFirst, shouldStop);
    }

    public async read(index: number): Promise<HistoryFrameV3 | undefined> {
        const entry = this.at(index);
        return entry === undefined ? undefined : this.readFrame(entry.path);
    }
}

/** Sequential, one-frame-at-a-time access to a HistoryFrameIndex. */
export class HistoryFrameCursor implements AsyncIterable<HistoryFrameV3> {
    public constructor(
        private readonly index: HistoryFrameIndex,
        private readonly newestFirst: boolean,
        private readonly shouldStop: HistoryReadStopCheck,
    ) {}

    public async *[Symbol.asyncIterator](): AsyncIterator<HistoryFrameV3> {
        const first = this.newestFirst ? this.index.length - 1 : 0;
        const end = this.newestFirst ? -1 : this.index.length;
        const step = this.newestFirst ? -1 : 1;
        for (let position = first; position !== end; position += step) {
            if (this.shouldStop()) return;
            const frame = await this.index.read(position);
            if (frame !== undefined) yield frame;
        }
    }
}

/** A bounded FIFO that stores a caller-selected representation of each frame. */
export class HistoryFrameRollingWindow<T> {
    private readonly values_: T[] = [];

    public constructor(
        public readonly capacity: number,
        private readonly project: (frame: HistoryFrameV3) => T,
    ) {
        if (!Number.isSafeInteger(capacity) || capacity <= 0) throw new Error('invalid_history_frame_window_capacity');
    }

    public get length(): number { return this.values_.length; }

    public values(): readonly T[] { return this.values_; }

    public push(frame: HistoryFrameV3): void {
        if (this.values_.length >= this.capacity) throw new Error('history_frame_window_capacity_exceeded');
        this.values_.push(this.project(frame));
    }

    public shift(count = 1): T[] {
        if (!Number.isSafeInteger(count) || count < 0 || count > this.values_.length) {
            throw new Error('invalid_history_frame_window_shift');
        }
        return this.values_.splice(0, count);
    }
}
