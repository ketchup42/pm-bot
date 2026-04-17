import { MarketSide } from "../../side.js";

/** Intermediate layer after manager's internal book cache. */
export type OrderBookLevel = {
    price: string;
    size: string;
};

/** Parsed market data for one outcome (Up or Down) */
export interface MarketTokenData {
  outcome: string;     // 'up' or 'down'
  tokenId: string;
  marketId: string;    // id from REST Raw
  eventId: string;
}

export interface EventOrderBooksWatcher {

  /** Returns sorted COPY bid levels for the Up token (descending price) */
  getBidsUp(): OrderBookLevel[];

  /** Returns sorted COPY ask levels for the Up token (ascending price) */
  getAsksUp(): OrderBookLevel[];

  /** Returns sorted COPY bid levels for the Down token (descending price) */
  getBidsDown(): OrderBookLevel[];

  /** Returns sorted COPY ask levels for the Down token (ascending price) */
  getAsksDown(): OrderBookLevel[];

  /** Best bid (highest price) for the specified token */
  getBestBid(token: MarketSide): number | undefined;

  /** Best ask (lowest price) for the specified token */
  getBestAsk(token: MarketSide): number | undefined;

  getUpPrice(): number | undefined;
  getDownPrice(): number | undefined;

  getUpMidpoint(): number | undefined;
  getDownMidpoint(): number | undefined;

  getUpSpread(): number | undefined;
  getDownSpread(): number | undefined;

  getEventId(): string;
  getUpMarketData(): MarketTokenData;
  getDownMarketData(): MarketTokenData;

  /**
   * Returns the timestamp of the last received book update.
   */
  getTimeStamp(token: MarketSide): number | undefined;

  hasBidsUp(): boolean;

  hasAsksUp(): boolean

  hasBidsDown(): boolean;

  hasAsksDown(): boolean;

  isActive(): boolean;
  isWatching(): boolean;
  isFinished(): boolean;

  isUpBooked(): boolean;
  isDownBooked(): boolean;

  dispose(): void;
}