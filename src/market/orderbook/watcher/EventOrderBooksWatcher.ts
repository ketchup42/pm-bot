/** Intermediate layer after manager's internal book cache. */
export type OrderBookLevel = {
    price: string;
    size: string;
};

/** Parsed market data for one outcome (Up or Down) */
export interface MarketTokenData {
  outcome: string;     // 'Up' or 'Down'
  tokenId: string;
  marketId: string;    // id from REST Raw
  eventId: string;
}

export interface EventOrderBooksWatcher {

  /** Returns sorted bid levels for the Up token (descending price) */
  getBidsUp(): OrderBookLevel[];

  /** Returns sorted ask levels for the Up token (ascending price) */
  getAsksUp(): OrderBookLevel[];

  /** Returns sorted bid levels for the Down token (descending price) */
  getBidsDown(): OrderBookLevel[];

  /** Returns sorted ask levels for the Down token (ascending price) */
  getAsksDown(): OrderBookLevel[];

  /** Best bid (highest price) for the specified token */
  getBestBid(token: 'up' | 'down'): number | undefined;

  /** Best ask (lowest price) for the specified token */
  getBestAsk(token: 'up' | 'down'): number | undefined;

  getUpPrice(): number | undefined;
  getDownPrice(): number | undefined;

  getUpMidpoint(): number | undefined;
  getDownMidpoint(): number | undefined;

  getUpSpread(): number | undefined;
  getDownSpread(): number | undefined;

  getEventId(): string;
  getUpMarketData(): MarketTokenData;
  getDownMarketData(): MarketTokenData;

  isActive(): boolean;
  isWatching(): boolean;

  isUpBooked(): boolean;
  isDownBooked(): boolean;

  dispose(): void;
}