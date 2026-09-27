const DATA_API_BASE_URL = 'https://data-api.polymarket.com/v2/';

export const ACCOUNT_STATUS_MAX_POSITIONS = 50;

export interface AccountPosition {
    market: string;
    outcome: string;
    size?: number;
    averagePrice?: number;
    currentValue?: number;
    cashPnl?: number;
}

export interface AccountPositionsResult {
    positions: AccountPosition[];
    truncated: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}

function stringField(value: Readonly<Record<string, unknown>>, ...names: string[]): string | undefined {
    for (const name of names) {
        const candidate = value[name];
        if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    }
    return undefined;
}

function numberField(value: Readonly<Record<string, unknown>>, ...names: string[]): number | undefined {
    for (const name of names) {
        const candidate = value[name];
        const parsed = typeof candidate === 'number' ? candidate : typeof candidate === 'string' ? Number(candidate) : Number.NaN;
        if (Number.isFinite(parsed)) return parsed;
    }
    return undefined;
}

async function requestDataApi(path: string, parameters: Readonly<Record<string, string>>): Promise<Record<string, unknown>> {
    const url = new URL(path, DATA_API_BASE_URL);
    for (const [name, value] of Object.entries(parameters)) url.searchParams.set(name, value);
    const response = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Data API returned HTTP ${response.status}`);
    const payload = asRecord(await response.json());
    if (payload === undefined) throw new Error('Data API returned an invalid response');
    return payload;
}

function mapPosition(value: unknown): AccountPosition | undefined {
    const record = asRecord(value);
    if (record === undefined) return undefined;
    const size = numberField(record, 'size', 'current_size', 'currentSize');
    const averagePrice = numberField(record, 'avgPrice', 'avg_price', 'entry_avg_price_usdc');
    const currentValue = numberField(record, 'currentValue', 'current_value', 'current_value_usdc');
    const cashPnl = numberField(record, 'cashPnl', 'cash_pnl', 'cash_pnl_usdc');
    return {
        market: stringField(record, 'title', 'market_title', 'slug') ?? 'Unknown market',
        outcome: stringField(record, 'outcome') ?? 'Unknown outcome',
        ...(size === undefined ? {} : { size }),
        ...(averagePrice === undefined ? {} : { averagePrice }),
        ...(currentValue === undefined ? {} : { currentValue }),
        ...(cashPnl === undefined ? {} : { cashPnl }),
    };
}

function getNextCursor(payload: Readonly<Record<string, unknown>>): string | undefined {
    const pagination = asRecord(payload.pagination);
    return pagination === undefined ? undefined : stringField(pagination, 'next_cursor', 'nextCursor');
}

/** Returns the Data API mark-to-market value of the wallet's open positions. */
export async function getAccountPortfolioValue(address: string): Promise<number> {
    const payload = await requestDataApi('value', { user: address });
    const data = asRecord(payload.data);
    const value = data === undefined ? undefined : numberField(data, 'value');
    if (value === undefined) throw new Error('Data API portfolio value is missing');
    return value;
}

/**
 * Returns up to `maximum` open positions. The API is public and does not receive
 * account credentials. Cursor pagination prevents a single status request from
 * loading an unbounded portfolio.
 */
export async function getAccountOpenPositions(
    address: string,
    maximum: number = ACCOUNT_STATUS_MAX_POSITIONS,
): Promise<AccountPositionsResult> {
    const positions: AccountPosition[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    let truncated = false;
    do {
        const parameters: Record<string, string> = {
            user: address,
            status: 'OPEN',
            sort_by: 'CURRENT_VALUE',
            sort_direction: 'DESC',
        };
        if (cursor !== undefined) parameters.cursor = cursor;
        const payload = await requestDataApi('positions', parameters);
        if (!Array.isArray(payload.data)) throw new Error('Data API positions are missing');
        for (const value of payload.data) {
            const position = mapPosition(value);
            if (position !== undefined) positions.push(position);
            if (positions.length >= maximum) {
                truncated = true;
                break;
            }
        }
        const nextCursor = getNextCursor(payload);
        if (positions.length >= maximum) break;
        if (nextCursor === undefined || seenCursors.has(nextCursor)) break;
        seenCursors.add(nextCursor);
        cursor = nextCursor;
    } while (true);
    return { positions, truncated };
}
