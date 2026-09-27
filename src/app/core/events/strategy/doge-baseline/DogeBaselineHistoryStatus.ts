import {
    isHistoryProfileStatusCurrent,
    readHistoryProfileStatus,
    rebuildHistoryProfileStatus,
    type HistoryProfile,
    type HistoryProfileStatus,
} from '../../../history/HistoryProfileStatus.js';
import {
    DOGE_BASELINE_COIN,
    DOGE_BASELINE_FRAME,
    DOGE_BASELINE_SOURCE,
} from './DogeBaselineConfig.js';
import { makeDogeBaselineObservation } from './DogeBaselineModel.js';

export const DOGE_BASELINE_HISTORY_PROFILE: Readonly<HistoryProfile> = Object.freeze({
    coin: DOGE_BASELINE_COIN,
    frame: DOGE_BASELINE_FRAME,
    source: DOGE_BASELINE_SOURCE,
});

export async function rebuildDogeBaselineHistoryStatus(historyDirectory: string): Promise<HistoryProfileStatus> {
    return rebuildHistoryProfileStatus(
        historyDirectory,
        DOGE_BASELINE_HISTORY_PROFILE,
        frame => makeDogeBaselineObservation(frame) !== undefined,
    );
}

export async function readCurrentDogeBaselineHistoryStatus(historyDirectory: string): Promise<HistoryProfileStatus> {
    const cached = await readHistoryProfileStatus(historyDirectory, DOGE_BASELINE_HISTORY_PROFILE);
    if (cached !== undefined && await isHistoryProfileStatusCurrent(historyDirectory, cached)) return cached;
    return rebuildDogeBaselineHistoryStatus(historyDirectory);
}
