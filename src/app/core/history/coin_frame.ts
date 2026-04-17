import { Coin } from "../../../market/coins.js";
import { OrderBookLevel } from "../../../market/orderbook/watcher/EventOrderBooksWatcher.js";
import { MarketSide } from "../../../market/side.js";

export interface CoinFrameEventMarketData
{
  coin: Coin;
  side: MarketSide;
  start_time: number;
  end_time: number;

  coin_frame_start_price: number | undefined;

  // Coin end price is the coin start price of next frame
  coin_frame_end_price?: number | undefined;

  side_token_market_snapshots: Array<MarketTokenSnapshot>;
}

export interface MarketTokenSnapshot
{
  coin_price: number | undefined; // Real time crypto coin price
  timestamp: number;

  // Token market info
  asks?: OrderBookLevel[];
  bids?: OrderBookLevel[];
  price: number | undefined;
  midpoint: number | undefined;
  spread: number | undefined;
}