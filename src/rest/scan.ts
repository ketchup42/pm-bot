import { retry, getISOTimestamp, safeToNum } from "../utils.js";
import {REST_DEFAULT_HOST_GAMMA} from "./hosts.js"

// Type definitions for the Gamma API response (fully parsed, no JSON strings)
export interface GammaMarket {
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

export interface GammaEvent {
  id: string;
  slug: string;
  //Start and end time of events
  startTime: string;
  endDate: string;

  conditionId: string;
  markets: GammaMarket[];
}

/**
 * Fetch event data from Polymarket Gamma API by slug.
 * Parses `outcomes`, `outcomePrices`, and `clobTokenIds` from JSON strings into proper types.
 */
export async function fetchEventBySlug(slug: string): Promise<GammaEvent> {
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
    console.warn(`[${getISOTimestamp()}] Returned slug (${rawData.slug}) does not match requested (${slug})`);
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
      console.error(`Failed to parse clobTokenIds for market ${market.id}`);
      clobTokenIds = [];
    }

    // Parse outcomes and outcomePrices (always JSON strings)
    let outcomes: string[] = [];
    let outcomePrices: number[] = [];
    try {
      outcomes = JSON.parse(market.outcomes);
      outcomePrices = JSON.parse(market.outcomePrices).map(safeToNum);
    } catch (error) {
      console.error(`Failed to parse outcomes/prices for market ${market.id}:`, error);
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
export async function fetchMarketById(marketId: string): Promise<GammaMarket> {
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
      console.error(`Failed to parse clobTokenIds for market ${marketId}`);
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
    console.error(`[${getISOTimestamp()}] Failed to parse market ${marketId}:`, error);
    throw error;
  }

  const market: GammaMarket = {
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