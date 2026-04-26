import { MarketSide } from "../../side.js";

/** Intermediate layer after manager's internal book cache. */
export type OrderBookLevel = {
    price: string;
    size: string;
};

export interface EventMarketData
{
  eventId: string;
  marketId: string;
  conditionId: string;
  tick_size: number;
  min_order_size: number

  up: TokenMarketData;
  down: TokenMarketData;
}

/** Parsed market data for one outcome (Up or Down) */
export interface TokenMarketData {
  outcome: string;     // 'up' or 'down'
  tokenId: string;
}

export interface MarketOrderBooksWatcher {

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
  getMarketId(): string;
  getMarketData(): EventMarketData;
  getUpMarketData(): TokenMarketData;
  getDownMarketData(): TokenMarketData;

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

  disconnect(): void;
}