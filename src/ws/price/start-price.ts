import { CoinPriceWatcherRTDS } from "./CoinPriceWatcherRTDS.js";

/**
 * Waits for the start of the next 5-minute interval and captures the starting price.
 *
 * @description
 * This function calculates the time remaining until the next 5-minute UTC interval boundary,
 * waits until that exact moment, then listens for the **first** `price` event emitted by the
 * WebSocket feed and resolves with that price as the interval's starting price.
 *
 * This is critical for trading on Polymarket 5-minute markets, because the "Up/Down" outcome
 * is determined by comparing the price at the end of the interval with the price at its start.
 *
 * @param priceFeed - An instance of `PolymarketPriceFeed` that emits a `price` event
 *                    whenever a new price is received from the Polymarket WebSocket.
 *
 * @returns Promise<number> - Resolves with the numeric starting price (e.g., BTC price in USDT).
 *
 */
export async function waitForStartPrice(priceWatcher: CoinPriceWatcherRTDS): Promise<number> {
  return new Promise((resolve) => {
    const now = Math.floor(Date.now() / 1000);
    const secondsUntilNext = 300 - (now % 300);
    
    setTimeout(() => {
      // Interval has started – capture the next price
        resolve(priceWatcher.getCurrentPrice());
    }, secondsUntilNext * 1000);
  });
}