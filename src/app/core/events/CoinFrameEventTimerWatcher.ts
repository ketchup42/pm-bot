import { Coin, coin_precis } from "../../../market/coins.js";
import { EventFrame, getCoinSlug, getCurrentFrameStart, getFrameDuration } from "../../../market/frame.js";
import { EventOrderBooksWatcherFactory } from "../../../market/orderbook/watcher/EventOrderBooksWatcherFactory.js";
import { EventOrderBooksWatcher } from "../../../market/orderbook/watcher/EventOrderBooksWatcher.js";
import { CoinFrameEventMarketData, MarketTokenSnapshot } from "../history/coin_frame.js";
import { EventWatcher } from "./EventWatcher.js";
import { PriceWatcher } from "../../../market/price/PriceWatcher.js";
import { PriceWatcherFactory } from "../../../market/price/PriceWatcherFactory.js";
import { roundTo } from "../../../utils.js";
import { TickTimer } from "../../../timer.js";
import { logger } from "../../../log.js";

/**
 * Watches a coin's order book and price at a fixed interval (timer mode).
 * Takes snapshots every `tick` ms until the underlying order book watcher finishes its frame.
 * Start price is recorded from the first order book event (not from the timer).
 */
export class CoinFrameEventTimerWatcher implements EventWatcher<CoinFrameEventMarketData> {
  private _coin: Coin;
  private _slug: string;

  private _watcherHistoryUp: CoinFrameEventMarketData;
  private _watcherHistoryDown: CoinFrameEventMarketData;
  
  private _orderBookWatcher: EventOrderBooksWatcher | undefined;
  private _coinPriceWatcher: PriceWatcher;
  private _isFinished: boolean = false;
  private _isDisposed: boolean = false;

  private _tickTimer: TickTimer;

  // Event handling service values for special starting price forming logic
  private ___coinFrameStartPriceReal: number | undefined = undefined;
  private ___isCoinFrameStartPriceRealWritten = false;
  private _priceChangeEventStartPriceHandler(): void {
    if (this.___isCoinFrameStartPriceRealWritten) return;
    const coinCurrentPrice = this._coinPriceWatcher.getCurrentPrice();
    if (this.___coinFrameStartPriceReal && !this.___isCoinFrameStartPriceRealWritten && this.___coinFrameStartPriceReal !== coinCurrentPrice) {
      const startPrice = roundTo(coinCurrentPrice, coin_precis(this._coin));

      this._watcherHistoryUp.coin_frame_start_price = startPrice;
      this._watcherHistoryDown.coin_frame_start_price = startPrice;

      this.___isCoinFrameStartPriceRealWritten = true;
    }
  }

  private _startPriceBookEventHandler(): void {
    if (this.___isCoinFrameStartPriceRealWritten) return;
    const coinCurrentPrice = this._coinPriceWatcher.getCurrentPrice();
    if (!this.___coinFrameStartPriceReal && !this.___isCoinFrameStartPriceRealWritten) {
      this.___coinFrameStartPriceReal = coinCurrentPrice;
    }
  }

  // Function for timer tick handle - by timer
  private _timerModeTickHandler(): void {
    if (this._isDisposed) return;
    if (this.isFinished()) return;
    if (this._orderBookWatcher!.isFinished()) {
        this._tickTimer.disable();

        ///////////////////////////////////////////////////////////////////////
        // Frame end price is approximate!
        // Frame end price is the next frame start price, so only real time price, or the last snapshot coin price
        const price = this._coinPriceWatcher.getCurrentPrice();
        this._watcherHistoryUp.coin_frame_end_price = roundTo(price, coin_precis(this._coin));
        this._watcherHistoryDown.coin_frame_end_price = roundTo(price, coin_precis(this._coin));
        ///////////////////////////////////////////////////////////////////////
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
    
    const coinCurrentPrice = roundTo(this._coinPriceWatcher.getCurrentPrice(), coin_precis(this._coin));

    // If we have some problems with price mb connection errors than wait until next call
    if (!coinCurrentPrice) { logger.warn(`WARN: Coin price watcher current price return error for ${this._coinPriceWatcher.getSymbol()}.`); return; }

    const coinFrameUpEventDTO: MarketTokenSnapshot =
    {
      coin_price: coinCurrentPrice,
      timestamp: now,

      asks: this._orderBookWatcher.getAsksUp(),
      bids: this._orderBookWatcher.getBidsUp(),

      price: this._orderBookWatcher.getUpPrice(),
      midpoint: this._orderBookWatcher.getUpMidpoint(),
      spread: this._orderBookWatcher.getUpSpread()
    };

    const coinFrameDownEventDTO: MarketTokenSnapshot =
    {
      coin_price: coinCurrentPrice,
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


  private constructor(coin: Coin, tick: number, frame: EventFrame = '5m')
  {
    if (tick <= 0) throw Error("Error: Ticks can not be less than zero!");
    
    this._coin = coin;
    this._slug = getCoinSlug(coin, frame);

    this._tickTimer = new TickTimer(tick, () => {
      this._timerModeTickHandler();
    });

    this._coinPriceWatcher = PriceWatcherFactory.getCoinWatcher(coin, 'chainlink');
    const frameStartTime = getCurrentFrameStart(frame);

    this._watcherHistoryUp = {
      coin: coin,
      side: 'up',
      start_time: frameStartTime,
      end_time: frameStartTime + getFrameDuration(frame),

      coin_frame_start_price: undefined,
      coin_frame_end_price:  undefined,
      
      side_token_market_snapshots: []
    };

    this._watcherHistoryDown = {
      coin: coin,
      side: 'down',
      start_time: frameStartTime,
      end_time: frameStartTime + getFrameDuration(frame),

      coin_frame_start_price: undefined,
      coin_frame_end_price:  undefined,
      
      side_token_market_snapshots: []
    };
  }

  private async init(): Promise<void>
  {
    this._orderBookWatcher = await EventOrderBooksWatcherFactory.createNewCoinWatcher(this._slug,
    {onBook: async (events) => {
        this._startPriceBookEventHandler();
        this._priceChangeEventStartPriceHandler();
      },
      onPriceChange: async (events) => {
        this._priceChangeEventStartPriceHandler();
      },
      onLastTradePrice:  async (events) => {
        this._priceChangeEventStartPriceHandler();
      },
      onTickSizeChange: async (events) => {
        this._priceChangeEventStartPriceHandler();
      },
      onPolymarketPriceUpdate: async (events) => {
        this._priceChangeEventStartPriceHandler();
      }
    });
    
    this._tickTimer.enable();
  }


  /**
   * Creates a new timer‑driven watcher for the given coin and frame.
   * @param coin - The coin to watch.
   * @param tick - Snapshot interval in milliseconds (must be > 0).
   * @param frame - Time frame for the watcher (default '5m').
   * @returns A promise that resolves to the initialized watcher (timer already enabled).
   */
  public static async create(coin: Coin, tick: number, frame: EventFrame = '5m'): Promise<CoinFrameEventTimerWatcher> {
    const instance = new CoinFrameEventTimerWatcher(coin, tick, frame);
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
  public getEventOrderBooksWatcher(): EventOrderBooksWatcher {
    return this._orderBookWatcher!;
  }

  /**
   * Returns the collected market snapshots for the 'up' side.
   * Note: The returned object is mutable for performance reasons; avoid modifying it.
   */
  public getWatcherHistoryUp(): Readonly<CoinFrameEventMarketData> {
    return this._watcherHistoryUp;
  }

  /**
   * Returns the collected market snapshots for the 'down' side.
   * Note: The returned object is mutable for performance reasons; avoid modifying it.
   */
  public getWatcherHistoryDown(): Readonly<CoinFrameEventMarketData> {
    return this._watcherHistoryDown;
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
      this._orderBookWatcher!.dispose();
      this._isDisposed = true;
    }
  }
}