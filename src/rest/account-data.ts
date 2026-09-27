const DATA_API_BASE_URL = 'https://data-api.polymarket.com/v2/';

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}

function getFiniteNumber(value: unknown): number | undefined {
    const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : undefined;
}

/** Returns the public Data API mark-to-market value of the account's open positions. */
export async function getAccountPortfolioValue(address: string): Promise<number> {
    const url = new URL('value', DATA_API_BASE_URL);
    url.searchParams.set('user', address);
    const response = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Data API returned HTTP ${response.status}`);
    const payload = asRecord(await response.json());
    const data = payload === undefined ? undefined : asRecord(payload.data);
    const value = data === undefined ? undefined : getFiniteNumber(data.value);
    if (value === undefined) throw new Error('Data API portfolio value is missing');
    return value;
}
