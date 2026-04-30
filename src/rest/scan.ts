import { retry, getISOTimestamp, safeToNum, error_str } from "../utils.js";
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
  conditionId: string;
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

  if (!rawData || typeof rawData !== 'object') {
    throw new Error(`[${getISOTimestamp()}] Invalid event by slug response!`);
  }
  if (rawData.slug !== slug) {
    throw new Error(
      `[${getISOTimestamp()}] Returned slug (${rawData.slug}) does not match requested (${slug})`
    );
  }
  if (!Array.isArray(rawData.markets)) {
    throw new Error(
      `Invalid response to event by slug data: markets is not an array!`
    );
  }

  const markets = rawData.markets.map((market: any) => {
    // clobTokenIds can be a JSON string or already an array
    let clobTokenIds: string[];
    try {
      clobTokenIds = Array.isArray(market.clobTokenIds)
        ? market.clobTokenIds
        : JSON.parse(market.clobTokenIds ?? '[]');
    } catch {
      clobTokenIds = [];
    }

    // outcomes and outcomePrices are always JSON strings
    let outcomes: string[] = [];
    let outcomePrices: number[] = [];
    try {
      outcomes = JSON.parse(market.outcomes);
      outcomePrices = JSON.parse(market.outcomePrices).map(safeToNum);
    } catch (error) {
      throw new Error(
        `Failed to parse outcomes/prices for market ${market.id}: ${error_str(error)}`
      );
    }

    return {
      ...market,
      outcomes,
      outcomePrices,
      clobTokenIds,
    };
  });

  return { ...rawData, markets };
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
  const marketData = rawData[0];

  // Parse clobTokenIds
  let clobTokenIds: string[];
  if (typeof marketData.clobTokenIds === 'string') {
    try {
      clobTokenIds = JSON.parse(marketData.clobTokenIds);
    } catch {
      clobTokenIds = [];
    }
  } else if (Array.isArray(marketData.clobTokenIds)) {
    clobTokenIds = marketData.clobTokenIds;
  } else {
    clobTokenIds = [];
  }

  // Parse outcomes and outcomePrices
  let outcomes: string[] = [];
  let outcomePrices: number[] = [];
  try {
    outcomes = JSON.parse(marketData.outcomes);
    outcomePrices = JSON.parse(marketData.outcomePrices).map(safeToNum);
  } catch (error) {
    throw new Error(
      `[${getISOTimestamp()}] Failed to parse market ${marketId}: ${error_str(error)}`
    );
  }

  return {
    id: marketData.id,
    conditionId: marketData.conditionId,
    clobTokenIds,
    liquidity: marketData.liquidity,
    fee: marketData.fee,
    volume: marketData.volume,
    active: marketData.active,
    closed: marketData.closed,
    enableOrderBook: marketData.enableOrderBook,
    orderMinSize: marketData.orderMinSize,
    orderPriceMinTickSize: marketData.orderPriceMinTickSize,
    outcomes,
    outcomePrices,
  };
}