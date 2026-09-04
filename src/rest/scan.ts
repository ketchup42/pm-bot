import { retry, getISOTimestamp, safeToNum } from "../utils.js";
import { REST_DEFAULT_HOST_GAMMA } from "./hosts.js";

export interface MarketRaw {
  id: string;
  conditionId: string;
  clobTokenIds: string[];
  liquidity: string;
  fee: string;
  volume: string;
  active: boolean;
  closed: boolean;
  enableOrderBook: boolean;

  feesEnabled: boolean;
  makerBaseFee: number;
  takerBaseFee: number;

  rewardsMaxSpread: number;
  rewardsMinSize: number;

  orderMinSize: number;
  orderPriceMinTickSize: number;
  outcomes: string[];
  outcomePrices: number[];
}

export interface EventRaw {
  id: string;
  slug: string;
  startTime: string;
  endDate: string;
  // There is no such data field in the Gamma API
  // conditionId: string;
  markets: MarketRaw[];
}

/**
 * Performs a GET request and ensures the response is valid JSON.
 * Throws a descriptive error if the server returns HTML (e.g. a Cloudflare block page)
 * or any non‑JSON content type.
 *
 * @param url – The full URL to fetch.
 * @returns Parsed JSON body.
 */
async function fetchJson(url: string): Promise<any> {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status}: ${response.statusText} (url: ${url})`
    );
  }

  const contentType = response.headers.get('content-type');
  const text = await response.text();

  // HTML responses often start with '<' (e.g. <!DOCTYPE html>)
  if (text.trimStart().startsWith('<')) {
    throw new Error(
      `[${getISOTimestamp()}] Response from ${url} is HTML, possible IP block or redirect. ` +
      `First 200 chars: ${text.substring(0, 200)}`
    );
  }

  // Explicitly declared non‑JSON type → bail out
  if (contentType && !contentType.includes('application/json')) {
    throw new Error(
      `[${getISOTimestamp()}] Unexpected content type "${contentType}" for ${url}. ` +
      `Body: ${text.substring(0, 200)}`
    );
  }

  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(
      `[${getISOTimestamp()}] Failed to parse JSON from ${url}: ${(err as Error).message}. ` +
      `Body: ${text.substring(0, 200)}`
    );
  }
}

type GammaRecord = Record<string, unknown>;

interface MarketOutcomes {
  outcomes: string[];
  outcomePrices: number[];
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Invalid ${field}: expected a non-empty string`);
  }
  return value;
}

function asGammaRecord(value: unknown, context: string): GammaRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ${context}: expected an object`);
  }
  return value as GammaRecord;
}

function parseArrayOrEmpty(value: unknown): unknown[] {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseMarketOutcomes(market: GammaRecord): MarketOutcomes {
  return {
    outcomes: parseArrayOrEmpty(market.outcomes) as string[],
    outcomePrices: parseArrayOrEmpty(market.outcomePrices).map(value => safeToNum(value)),
  };
}

function parseClobTokenIds(market: GammaRecord): string[] {
  return parseArrayOrEmpty(market.clobTokenIds) as string[];
}

function parseMarket(marketValue: unknown): MarketRaw {
  const market = asGammaRecord(marketValue, 'market');
  const id = requireNonEmptyString(market.id, 'market.id');
  requireNonEmptyString(market.conditionId, `market ${id}.conditionId`);

  return {
    ...market,
    ...parseMarketOutcomes(market),
    clobTokenIds: parseClobTokenIds(market),
  } as MarketRaw;
}

/**
 * Fetches event data from Polymarket's Gamma API by event slug.
 *
 * The raw response contains JSON‑stringified arrays for `outcomes`,
 * `outcomePrices` and sometimes `clobTokenIds`. This function parses
 * them into proper TypeScript types.
 *
 * @param slug – The unique slug of the event (e.g. "will-eth-break-5000").
 * @returns A fully parsed {@link EventRaw} object.
 */
export async function fetchEventBySlug(slug: string): Promise<EventRaw> {
  const url = `${REST_DEFAULT_HOST_GAMMA}/events/slug/${slug}`;
  const rawData = await retry(() => fetchJson(url));

  const event = asGammaRecord(rawData, 'event by slug response');
  const eventId = requireNonEmptyString(event.id, 'event.id');
  const returnedSlug = requireNonEmptyString(event.slug, `event ${eventId}.slug`);
  if (returnedSlug !== slug) {
    throw new Error(
      `[${getISOTimestamp()}] Returned slug (${returnedSlug}) does not match requested (${slug})`
    );
  }
  if (!Array.isArray(event.markets)) {
    throw new Error(
      `Invalid response to event by slug data: markets is not an array!`
    );
  }

  const markets = event.markets.map(parseMarket);

  return { ...event, markets } as EventRaw;
}

/**
 * Fetches a single market by its numeric ID from the Gamma API.
 *
 * The response is an array containing one market object. Like
 * `fetchEventBySlug`, it handles JSON‑encoded fields for
 * `outcomes`, `outcomePrices`, and `clobTokenIds`.
 *
 * @param marketId – The market identifier (e.g. "123456").
 * @returns A fully parsed {@link MarketRaw} object.
 */
export async function fetchMarketById(marketId: string): Promise<MarketRaw> {
  const url = `${REST_DEFAULT_HOST_GAMMA}/markets?id=${marketId}`;
  const rawData = await retry(() => fetchJson(url));

  if (!Array.isArray(rawData) || rawData.length === 0) {
    throw new Error(`No market found for id ${marketId}`);
  }
  return parseMarket(rawData[0]);
}
