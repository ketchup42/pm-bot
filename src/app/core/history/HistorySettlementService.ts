import { MarketSide } from '../../../market/side.js';
import { EventRaw, fetchEventBySlug, MarketRaw } from '../../../rest/scan.js';
import { error_str } from '../../../utils.js';
import { HistoryFrameV2 } from './history_frame.js';
import { getHistoryFramePaths, readHistoryFrame } from './HistoryFrameReader.js';
import { HistoryFrameWriter } from './HistoryFrameWriter.js';

export interface HistorySettlementOptions {
    directory: string;
}

export interface SettlementFailure {
    file_path: string;
    reason: string;
}

export interface SettlementResult {
    checked: number;
    updated: number;
    unresolved: number;
    failed: number;
    failures: SettlementFailure[];
}

export type EventResolver = (slug: string) => Promise<EventRaw>;
export type SettlementResolver = (frame: HistoryFrameV2) => Promise<MarketSide | undefined>;

export function getConfirmedOutcome(market: MarketRaw): MarketSide | undefined {
    if (!market.closed || market.outcomes.length !== market.outcomePrices.length) return undefined;
    const winnerIndex = market.outcomePrices.findIndex(price => price >= 0.99);
    if (winnerIndex < 0) return undefined;
    const outcome = market.outcomes[winnerIndex]?.toLowerCase();
    return outcome === 'up' || outcome === 'down' ? outcome : undefined;
}

export function getConfirmedOutcomeForFrame(frame: HistoryFrameV2, event: EventRaw): MarketSide | undefined {
    if (event.id !== frame.market_data.eventId) {
        throw new Error(`event_id_mismatch: expected ${frame.market_data.eventId}, got ${event.id}`);
    }
    const market = event.markets.find(candidate =>
        candidate.id === frame.market_data.marketId && candidate.conditionId === frame.market_data.conditionId,
    );
    if (market === undefined) {
        throw new Error(`market_not_found_in_event: ${frame.market_data.marketId}`);
    }
    return getConfirmedOutcome(market);
}

export async function fetchConfirmedOutcome(
    frame: HistoryFrameV2,
    fetchEvent: EventResolver = fetchEventBySlug,
): Promise<MarketSide | undefined> {
    return getConfirmedOutcomeForFrame(frame, await fetchEvent(frame.slug));
}

export async function settleHistoryDirectory(
    options: HistorySettlementOptions,
    resolveOutcome: SettlementResolver = fetchConfirmedOutcome,
    now: () => number = Date.now,
): Promise<SettlementResult> {
    let checked = 0;
    let updated = 0;
    let unresolved = 0;
    const failures: SettlementFailure[] = [];
    for (const filePath of await getHistoryFramePaths(options.directory)) {
        const frame = await readHistoryFrame(filePath);
        if (frame.settlement.confirmed_outcome !== undefined) continue;
        checked++;
        let outcome: MarketSide | undefined;
        try {
            outcome = await resolveOutcome(frame);
        } catch (error) {
            failures.push({ file_path: filePath, reason: error_str(error) });
            continue;
        }
        if (outcome === undefined) {
            unresolved++;
            continue;
        }
        frame.settlement.confirmed_outcome = outcome;
        frame.settlement.confirmed_at = now();
        const writer = new HistoryFrameWriter({ directory: options.directory, gzip: filePath.endsWith('.gz'), maxFrames: 0 });
        await writer.write(frame);
        updated++;
    }
    return { checked, updated, unresolved, failed: failures.length, failures };
}
