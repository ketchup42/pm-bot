import { retry, getISOTimestamp, safeToNum, error_str } from "../utils.js";
import {REST_DEFAULT_HOST_GAMMA} from "./hosts.js"

// Type definitions for the Gamma API response (fully parsed, no JSON strings)
export interface Market {
  id: string;
  conditionId: string;
  clobTokenIds: string[];
  liquidity: string;
  fee: string; //TODO: check if needed
  volume: string;
  active: boolean;
  closed: boolean;
  enableOrderBook: boolean;
  outcomes: string[];
  outcomePrices: number[];
}

export interface Event {
  id: string;
  slug: string;
  //Start and end time of events
  startTime: string;
  endDate: string;

  conditionId: string;
  markets: Market[];
}

/**
 * Fetch event data from Polymarket Gamma API by slug.
 * Parses `outcomes`, `outcomePrices`, and `clobTokenIds` from JSON strings into proper types.
 */
export async function fetchEventBySlug(slug: string): Promise<Event> {
  const url = `${REST_DEFAULT_HOST_GAMMA}/events/slug/${slug}`;

  const rawData = await retry(
    async () => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      const json = await response.json();
      if (!json || typeof json !== 'object') throw new Error('Invalid JSON response');
      return json;
    }
  );

  if (rawData.slug !== slug) {
    throw new Error(`[${getISOTimestamp()}] Returned slug (${rawData.slug}) does not match requested (${slug})`);
  }

  // Parse markets if present, with safe handling of clobTokenIds
  const markets = rawData.markets.map((market: any) => {
    // Safely parse clobTokenIds (might be JSON string or already array)
    let clobTokenIds: string[];
    try {
      clobTokenIds = Array.isArray(market.clobTokenIds)
        ? market.clobTokenIds
        : JSON.parse(market.clobTokenIds ?? '[]');
    } catch {
      clobTokenIds = [];
    }

    // Parse outcomes and outcomePrices (always JSON strings)
    let outcomes: string[] = [];
    let outcomePrices: number[] = [];
    try {
      outcomes = JSON.parse(market.outcomes);
      outcomePrices = JSON.parse(market.outcomePrices).map(safeToNum);
    } catch (error) {
      throw new Error(`Failed to parse outcomes/prices for market ${market.id}: ${error_str(error)}`);
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
 * Fetch a single market by its ID from the Gamma API.
 * Parses `outcomes`, `outcomePrices`, and `clobTokenIds` into fully typed arrays.
 */
export async function fetchMarketById(marketId: string): Promise<Market> {
  const url = `${REST_DEFAULT_HOST_GAMMA}/markets?id=${marketId}`;

  const rawData = await retry(
    async () => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      const json = await response.json();
      if (!Array.isArray(json) || json.length === 0) throw new Error(`No market found for id ${marketId}`);
      return json[0];
    }
  );

  // Parse clobTokenIds (string -> array)
  let clobTokenIds: string[];
  if (typeof rawData.clobTokenIds === 'string') {
    try {
      clobTokenIds = JSON.parse(rawData.clobTokenIds);
    } catch {
      clobTokenIds = [];
    }
  } else if (Array.isArray(rawData.clobTokenIds)) {
    clobTokenIds = rawData.clobTokenIds;
  } else {
    clobTokenIds = [];
  }

  // Parse outcomes and outcomePrices
  let outcomes: string[] = [];
  let outcomePrices: number[] = [];
  try {
    outcomes = JSON.parse(rawData.outcomes);
    outcomePrices = JSON.parse(rawData.outcomePrices).map(safeToNum);
  } catch (error) {
    throw new Error(`[${getISOTimestamp()}] Failed to parse market ${marketId}: ${error_str(error)}`);
  }

  const market: Market = {
    id: rawData.id,
    conditionId: rawData.conditionId,
    clobTokenIds,
    liquidity: rawData.liquidity,
    fee: rawData.fee,
    volume: rawData.volume,
    active: rawData.active,
    closed: rawData.closed,
    enableOrderBook: rawData.enableOrderBook,
    outcomes,
    outcomePrices,
  };

  return market;
}