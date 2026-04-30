import { MarketRaw } from "./scan.js";
import { retry, safeToNum } from "../utils.js";

import { REST_DEFAULT_HOST_CLOB } from "./hosts.js";
import { ClobClient } from "@polymarket/clob-client-v2";

/**
 * Raw order book response from the CLOB /book endpoint.
 * Includes market metadata and order book depth.
 */
export interface OrderBookRaw {
  bids: { price: string; size: string }[]; // Buy orders
  asks: { price: string; size: string }[]; // Sell orders
  tick_size: string;      // Minimum price increment for this market
  min_order_size: string; // Minimum order size (in shares) for this market
  last_trade_price: string; // Price of the most recent trade
  timestamp: string;        // ISO timestamp of the snapshot
}

/**
 * Fetch the full order book for a given token ID.
 * @param tokenId - The token ID (e.g., from clobTokenIds)
 * @param market - GammaMarket object; if provided, checks `enableOrderBook` before fetching.
 * @returns Promise with the order book conforming to the OrderBook interface.
 */
export async function getOrderBookByTokenId(
  tokenId: string,
  market: MarketRaw
): Promise<OrderBookRaw> {
  if (!market.enableOrderBook) {
    throw new Error(`Order book is disabled for token ${tokenId} (market ${market.id})`);
  }
  const url = `${REST_DEFAULT_HOST_CLOB}book?token_id=${tokenId}`;

  const raw = await retry(
    async () => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    }
  );

  // Ensure required fields exist; provide fallbacks if missing (should not happen on a live market)
  return {
    bids: raw.bids ?? [],
    asks: raw.asks ?? [],
    tick_size: raw.tick_size,
    min_order_size: raw.min_order_size,
    last_trade_price: raw.last_trade_price,
    timestamp: raw.timestamp
  };
}

/**
 * Retrieves the current order book for a given token.
 * This is a thin wrapper around the CLOB client's `getOrderBook` method.
 *
 * @param client - An authenticated CLOB client.
 * @param tokenId - The ID of the token (asset_id).
 * @returns The raw order book snapshot containing `bids` and `asks`.
 */
export async function getOrderBookSafe(client: ClobClient, tokenId: string): Promise<OrderBookRaw> {
    const book: OrderBookRaw = await client.getOrderBook(tokenId);
    return book;
}

/**
 * Checks whether the bid (buy) side of the order book is empty for a given token.
 *
 * @param client - An authenticated CLOB client.
 * @param tokenId - The ID of the token (asset_id).
 * @returns `true` if there are no bids, `false` otherwise.
 */
export async function isBidsEmpty(client: ClobClient, tokenId: string): Promise<boolean> {
    const { bids } = await getOrderBookSafe(client, tokenId);
    return bids.length === 0;
}

/**
 * Checks whether the ask (sell) side of the order book is empty for a given token.
 *
 * @param client - An authenticated CLOB client.
 * @param tokenId - The ID of the token (asset_id).
 * @returns `true` if there are no asks, `false` otherwise.
 */
export async function isAsksEmpty(client: ClobClient, tokenId: string): Promise<boolean> {
    const { asks } = await getOrderBookSafe(client, tokenId);
    return asks.length === 0;
}

/**
 * Get the current best price and size (best bid for buying, best ask for selling) for a specific token.
 * Uses `getOrderBookByTokenId` and finds the true best price.
 * @param tokenId - The token ID
 * @param side - 'buy' returns the highest bid price, 'sell' returns the lowest ask price
 * @param market - GammaMarket object (to check enableOrderBook)
 * @returns Object containing the best price and the size (number of shares) available at that price.
 * @throws Error if no bids (for buy) or no asks (for sell) are present.
 */
export async function getPriceByTokenId(
  tokenId: string,
  side: 'buy' | 'sell',
  market: MarketRaw
): Promise<{ price: number; size: number }> {
  const orderBook = await getOrderBookByTokenId(tokenId, market);

  if (side === 'buy') {
    if (!orderBook.bids.length) {
      throw new Error(`No bids available for token ${tokenId}`);
    }
    // Find highest bid price
    const bestBid = orderBook.bids.reduce((best, current) =>
      safeToNum(current.price) > safeToNum(best.price) ? current : best
    );
    return {
      price: safeToNum(String(bestBid.price)),
      size: safeToNum(String(bestBid.size)),
    };
  } else {
    if (!orderBook.asks.length) {
      throw new Error(`No asks available for token ${tokenId}`);
    }
    // Find lowest ask price
    const bestAsk = orderBook.asks.reduce((best, current) =>
      safeToNum(current.price) < safeToNum(best.price) ? current : best
    );
    return {
      price: safeToNum(String(bestAsk.price)),
      size: safeToNum(String(bestAsk.size)),
    };
  }
}