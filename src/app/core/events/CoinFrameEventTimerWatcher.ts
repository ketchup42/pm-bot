import { Coin } from "../../../market/coins.js";
import { EventFrame, getCoinSlug, getCurrentFrameStart, getFrameDuration } from "../../../market/frame.js";
import { MarketOrderBooksWatcher } from "../../../market/orderbook/watcher/MarketOrderBooksWatcher.js";
import { CoinFrameEventMarketData, MarketTokenSnapshot } from "../history/coin_frame.js";
import { CoinPriceWatcher } from "../../../market/price/CoinPriceWatcher.js";
import { EventWatcher } from "./EventWatcher.js";
import { TickTimer } from "../../../timer.js";
import { logger } from "../../../log.js";
import { CoinMarketOrderBooksWatcher } from "../../../market/orderbook/watcher/CoinMarketOrderBooksWatcher.js";

/**
 * Watches a coin's order book and price at a fixed interval (timer mode).
 * Takes snapshots every `tick` ms until the underlying order book watcher finishes its frame.
 * Start price is recorded from the first order book event (not from the timer).
 */
export class CoinFrameEventTimerWatcher implements EventWatcher<CoinFrameEventMarketData> {
  private _coin: Coin;
  private _frame: EventFrame;
  private _slug: string;

  private _watcherHistoryUp: CoinFrameEventMarketData;
  private _watcherHistoryDown: CoinFrameEventMarketData;
  
  private _orderBookWatcher: MarketOrderBooksWatcher | undefined;
  private _coinPriceWatcher: CoinPriceWatcher;

  private _isFinished: boolean = false;
  private _isDisposed: boolean = false;

  private _tickTimer: TickTimer;

  // Function for timer tick handle - by timer
  private async _timerModeTickHandler(): Promise<void> {
    if (this._isDisposed) return;
    if (this.isFinished()) return;

    if (this._orderBookWatcher!.isFinished()) {

      this._tickTimer.disable();
      // Frame end price is the next frame start price, so only real time price
      let price = undefined;
      try {
        price = await this._coinPriceWatcher.getPriceByFrame(this._frame);
        if (price === undefined)
          price = this._coinPriceWatcher.getCoinPrice();
      } catch(error) {
          logger.warn(`WARN: Frame end price is undefined for event with slug: ${this._slug}`);
      }

      this._watcherHistoryUp.coin_frame_end_price = price;
      this._watcherHistoryDown.coin_frame_end_price = price;

      this._isFinished = true;

      // Call dispose by hand in global circle
      return;
    }
    this.watcherMakeSnapshot();
  }

  private watcherMakeSnapshot(): void {
    if (this._isDisposed) return;
    if (this.isFinished()) return;
    if (!this._orderBookWatcher?.isActive()) return;

    const now = Date.now(); 
    const price = this._coinPriceWatcher.getCoinPrice();

    // If we have some problems with price mb connection errors than wait until next call
    if (!price) { logger.warn(`WARN: Coin price watcher returns undefined for ${this._coinPriceWatcher.getCoin().toString()}.`); return; }

    const coinFrameUpEventDTO: MarketTokenSnapshot =
    {
      coin_price: price,
      timestamp: now,

      asks: this._orderBookWatcher.getAsksUp(),
      bids: this._orderBookWatcher.getBidsUp(),

      price: this._orderBookWatcher.getUpPrice(),
      midpoint: this._orderBookWatcher.getUpMidpoint(),
      spread: this._orderBookWatcher.getUpSpread()
    };

    const coinFrameDownEventDTO: MarketTokenSnapshot =
    {
      coin_price: price,
      timestamp: now,

      asks: this._orderBookWatcher.getAsksDown(),
      bids: this._orderBookWatcher.getBidsDown(),

      price: this._orderBookWatcher.getDownPrice(),
      midpoint: this._orderBookWatcher.getDownMidpoint(),
      spread: this._orderBookWatcher.getDownSpread()
    };

    this._watcherHistoryUp.side_token_market_snapshots.push(coinFrameUpEventDTO);
    this._watcherHistoryDown.side_token_market_snapshots.push(coinFrameDownEventDTO);
  }

  private constructor(coin: Coin, frame: EventFrame, tick: number, watcher: CoinPriceWatcher)
  {
    if (tick <= 0) throw Error("Error: Ticks can not be less than zero!");
  
    this._coin = coin;
    this._frame = frame;
    this._slug = getCoinSlug(coin, this._frame);

    this._tickTimer = new TickTimer(tick, () => {
      this._timerModeTickHandler();
    });

    this._coinPriceWatcher = watcher;
    const frameStartTime = getCurrentFrameStart(this._frame);

    this._watcherHistoryUp = {
      event_slug: this._slug,
      eventId: '',
      marketId: '',
      coin: this._coin,
      side: 'up',
      start_time: frameStartTime,
      end_time: frameStartTime + getFrameDuration(this._frame),

      coin_frame_start_price: undefined,
      coin_frame_end_price:  undefined,
      
      side_token_market_snapshots: []
    };

    this._watcherHistoryDown = {
      event_slug: this._slug,
      eventId: '',
      marketId: '',
      coin: this._coin,
      side: 'down',
      start_time: frameStartTime,
      end_time: frameStartTime + getFrameDuration(this._frame),

      coin_frame_start_price: undefined,
      coin_frame_end_price:  undefined,
      
      side_token_market_snapshots: []
    };
  }

  private async init(): Promise<void>
  {
    this._orderBookWatcher = await CoinMarketOrderBooksWatcher.create(this._slug);
  
    const price = await this._coinPriceWatcher.getPriceByFrame(this._frame);
    this._watcherHistoryUp.coin_frame_start_price = price;
    this._watcherHistoryDown.coin_frame_start_price = price;

    this._watcherHistoryUp.eventId = this.getEventId();
    this._watcherHistoryDown.eventId =  this.getEventId();

    this._watcherHistoryUp.marketId = this._orderBookWatcher.getMarketData().marketId;
    this._watcherHistoryDown.marketId =  this._orderBookWatcher.getMarketData().marketId;

    this._tickTimer.enable();
  }

  /**
   * Creates a new timer‑driven watcher for the given coin and frame and other.
   * @param coin - The coin to watch.
   * @param frame - Time frame for the watcher.
   * @param tick - Snapshot interval in milliseconds (must be > 0).
   * @param watcher - Price watcher for the coin.
   * @returns A promise that resolves to the initialized watcher (timer already enabled).
   */
  public static async create(coin: Coin, frame: EventFrame, tick: number, watcher: CoinPriceWatcher): Promise<CoinFrameEventTimerWatcher> {
    if (watcher.getCoin() !== coin) throw new Error("Error: Given CoinPriceWatcher has a different target coin!");
    const instance = new CoinFrameEventTimerWatcher(coin, frame, tick, watcher);
    await instance.init();
    return instance;
  }

  /**
   * Returns the unique event ID of the underlying order book watcher.
   * This ID remains valid even after disposal.
   */
  public getEventId(): string {
    return this._orderBookWatcher!.getEventId();
  }

  /**
   * Returns the underlying order book watcher instance.
   */
  public getMarketOrderBooksWatchers(): MarketOrderBooksWatcher[] {
    return [this._orderBookWatcher!];
  }

  /**
   * Returns the collected market snapshots for the 'up' side.
   * Note: The returned object is mutable for performance reasons; avoid modifying it.
   */
  public getWatcherHistoryUp(): Readonly<CoinFrameEventMarketData>[] {
    return [this._watcherHistoryUp];
  }

  /**
   * Returns the collected market snapshots for the 'down' side.
   * Note: The returned object is mutable for performance reasons; avoid modifying it.
   */
  public getWatcherHistoryDown(): Readonly<CoinFrameEventMarketData>[] {
    return [this._watcherHistoryDown];
  }

  /**
   * Whether the watcher is active – not finished and the order book watcher is active.
   */
  public isActive(): boolean {
    if (this._isDisposed) return false;
    return !this.isFinished() && this._orderBookWatcher!.isActive();
  }

  /**
   * Whether the watcher is currently taking snapshots.
   * True if the timer is running, the order book watcher is watching, and the frame is not finished.
   */
  public isWatching(): boolean {
    if (this._isDisposed) return false;
    return this._tickTimer.isRunning() && this._orderBookWatcher!.isWatching() && !this.isFinished();
  }

  /**
   * Whether the 5‑minute frame has ended and no more snapshots will be taken.
   */
  public isFinished(): boolean {
    return this._isFinished;
  }

  /**
   * Releases all resources (timer and order book watcher).
   * Safe to call multiple times – subsequent calls have no effect.
   */
  public dispose(): void {
    if (!this._isDisposed) {
      this._tickTimer.dispose();
      this._orderBookWatcher!.disconnect();
      this._isDisposed = true;
    }
  }
}