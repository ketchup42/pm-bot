import { ClobClient } from "@polymarket/clob-client-v2";
import { EventStrategy } from "./EventStrategy.js";
import { CoinFrameEventMarketData } from "../../history/coin_frame.js";
import { EventWatcher } from "../EventWatcher.js";
import { logger } from "../../../../log.js";
import { error_str, safeFloat } from "../../../../utils.js";
import { DEFAULT_BUY_ORDER_MIN_VALUE } from "../../../../rest/orders.js";
import { MarketSide } from "../../../../market/side.js";
import { MarketOrderBooksWatcher } from "../../../../market/orderbook/watcher/MarketOrderBooksWatcher.js";
import { Coin } from "../../../../market/coins.js";
import { ORDER_WALLET_FRACTION, OrderWalletParams, OrderWalletState } from "../../../../market/orders/OrderWallet.js";
import { MultiOrderWallet } from "../../../../market/orders/MultiOrderWallet.js";
import { LiveOrdersWatcherRTDS } from "../../../../market/orders/watcher/LiveOrdersWatcherRTDS.js";
import { LiveOrderWallet } from "../../../../market/orders/LiveOrderWallet.js";
import { VirtualTakerLiveOrderWallet } from "../../../../market/orders/VirtualTakerLiveOrderWallet.js";
import { PriceWatcher } from "../../../../market/price/PriceWatcher.js";
import { CoinPriceWatcher } from "../../../../market/price/CoinPriceWatcher.js";
import { PriceWatcherFactory } from "../../../../market/price/PriceWatcherFactory.js";

/** Start/end timestamps of the current trading frame (in seconds). */
interface FrameTime { startTime: number; endTime: number; }

/**
 * Trend-line strategy.
 *
 * - Entry line (mirror off): _PRICE_BUY_START -> _PRICE_BUY_END over the frame (progress-driven).
 * - Entry line (mirror on): _PRICE_BUY_START_MIRROR -> _PRICE_BUY_END over the frame (progress-driven).
 * - Mirror line: _MIRROR_LINE_START -> 0.0 over the frame (progress-driven).
 * - Entry: ask crosses above the entry line, position < order volume, buy price <= _MAX_BUY_PRICE.
 * - Exit A: mirror off and bid below _PRICE_SELL_LEVEL (horizontal level).
 * - Exit B: mirror on and bid below _MIRROR_EXIT_LEVEL (horizontal level).
 * - Exit C: bid above _MAX_BUY_PRICE and frame progress < _EXIT_C_TIME_FACTOR -> taker sell at _MAX_BUY_PRICE (profit).
 *
 * Trades a single side ('up' or 'down'), selected at creation time.
 */
export class CoinTrendLineStrategyV2 implements EventStrategy<CoinFrameEventMarketData> {
    private readonly _eventId: string;
    private readonly _coin: Coin;
    private readonly _side: MarketSide;

    // ====================== STRATEGY PARAMETERS ========================
    private readonly _ORDER_VOLUME: number = 5;             /** Position size in tokens (per trade). */
    private readonly _INITIAL_BALANCE: number = 6;          /** Virtual USD balance. */

    private readonly _PRICE_BUY_START: number = 0.55;        /** Standard entry line start (mirror off); interpolates to _PRICE_BUY_END. */
    private readonly _PRICE_BUY_START_MIRROR: number = 0.51; /** Mirror-mode entry line start; interpolates to _PRICE_BUY_END. */
    private readonly _PRICE_BUY_END: number = 1.0;           /** Entry line end (shared for both mirror states). */

    private readonly _MIRROR_LINE_START: number = 0.45;   /** Mirror line start; interpolates to 0.0 by frame progress. */

    private readonly _PRICE_SELL_LEVEL: number = 0.46;    /** Normal exit level (horizontal). */
    private readonly _MIRROR_EXIT_LEVEL: number = 0.295;  /** Mirror-mode exit level (horizontal). BASE: 0.1 */

    private readonly _MAX_BUY_PRICE: number = 0.725;      /** Max buy price cap; entry blocked above it. */
    private readonly _EXIT_C_TIME_FACTOR: number = 0.75;  /** Frame fraction until which Exit C is allowed (0..1). */

    private readonly _START_INTERVAL_FACTOR: number = 0.025;  /** Fraction of the frame duration before which we do not enter new positions. */
    private readonly _START_DIFF_PRICE_FACTOR: number = 5.1;  /** Coin price deviation needed to start (configured for BTC). */

    private readonly _END_INTERVAL_FACTOR: number = 0.9725;  /** Fraction of the frame duration at which we stop entering new positions. */
    // ===================================================================

    // ========================= TRADING STATE ===========================
    private _mirror: boolean = false;
    private _hasStarted: boolean = false;
    private _hasExited: boolean = false;
    private _wasInPosition: boolean = false;
    private _didAction: boolean = false;

    private _buyOrder: OrderWalletState | undefined = undefined;
    private _sellOrder: OrderWalletState | undefined = undefined;

    private _wallet: MultiOrderWallet | undefined = undefined;
    private _isDebug: boolean;
    private _event: EventWatcher<CoinFrameEventMarketData> | undefined = undefined;
    private _market: MarketOrderBooksWatcher | undefined = undefined;
    private _coinWatcher: CoinPriceWatcher | undefined = undefined;
    private _frameTime: FrameTime | undefined = undefined;
    // ================================================================

    private constructor(eventId: string, coin: Coin, side: MarketSide, isDebug: boolean) {
        this._eventId = eventId;
        this._coin = coin;
        this._side = side;
        this._isDebug = isDebug;
        this._coinWatcher = PriceWatcherFactory.getCoinWatcher(this._coin, 'chainlink');
    }

    public static async create(eventId: string, coin: Coin, side: MarketSide, isDebug: boolean = false): Promise<CoinTrendLineStrategyV2> {
        return new CoinTrendLineStrategyV2(eventId, coin, side, isDebug);
    }

    /**
     * Factory: creates the strategy wallet.
     * - isDebug=true  -> virtual emulation (instant fills from the order book, no real orders).
     * - isDebug=false -> live wallet (real orders + user-channel orders watcher).
     */
    private async createWallet(client: ClobClient, params: OrderWalletParams, conditionId: string): Promise<MultiOrderWallet> {
        if (this._isDebug) {
            return VirtualTakerLiveOrderWallet.create(params, this._market!);
        }
        const watcher = await LiveOrdersWatcherRTDS.create(conditionId, client, client!.creds);
        return LiveOrderWallet.create(client, params, watcher);
    }

    private log(msg: string): void {
        logger.info(`[CoinTrendLine][${this._eventId}][${this._coin}][${this._side}] ${msg}`);
    }

    // ---------------------------- HELPERS ----------------------------
    private findMyEventWatcher(watchers: readonly EventWatcher<CoinFrameEventMarketData>[]): EventWatcher<CoinFrameEventMarketData> | undefined {
        return watchers.find(w => w.getEventId() === this._eventId);
    }

    private findMyMarketOrderBookWatcher(watchers: readonly EventWatcher<CoinFrameEventMarketData>[]): MarketOrderBooksWatcher | undefined {
        return this.findMyEventWatcher(watchers)?.getMarketOrderBooksWatchers()?.[0];
    }

    private getFrameTimes(watchers: readonly EventWatcher<CoinFrameEventMarketData>[]): FrameTime | undefined {
        const watcher = this.findMyEventWatcher(watchers);
        if (!watcher) return undefined;
        const history = this._side === 'up' ? watcher.getWatcherHistoryUp() : watcher.getWatcherHistoryDown();
        const first = history?.[0];
        return first ? { startTime: first.start_time, endTime: first.end_time } : undefined;
    }

    /** Frame progress in [0,1]; drives the entry and mirror lines. */
    private getFrameProgress(currentTime: number): number {
        if (!this._frameTime) return 0;
        const total = this._frameTime.endTime - this._frameTime.startTime;
        if (total <= 0) return 0;
        const progress = (currentTime - this._frameTime.startTime) / total;
        return Math.min(Math.max(progress, 0), 1);
    }

    /** Whether the current time is within the entry window (start factor passed). */
    private isStartOfFrame(currentTime: number): boolean {
        if (!this._frameTime) return false;
        const timeFromStart = currentTime - this._frameTime.startTime;
        const starttime = (this._frameTime.endTime - this._frameTime.startTime) * this._START_INTERVAL_FACTOR;
        return timeFromStart >= starttime;
    }

    /** Whether the current time is past the entry cutoff (no new positions allowed). */
    private isEndOfFrame(currentTime: number): boolean {
        if (!this._frameTime) return false;
        const timeFromStart = currentTime - this._frameTime.startTime;
        const lasttime = (this._frameTime.endTime - this._frameTime.startTime) * this._END_INTERVAL_FACTOR;
        return timeFromStart >= lasttime;
    }

    // ---------------------------- MAIN EXECUTION ----------------------------
    public async execute(client: ClobClient, watchers: readonly EventWatcher<CoinFrameEventMarketData>[]): Promise<boolean> {
        if (!this._event) {
            this._event = this.findMyEventWatcher(watchers);
            if (!this._event) return false;
        }
        if (!this._market) {
            this._market = this.findMyMarketOrderBookWatcher(watchers);
            if (!this._market) return false;
        }
        if (!this._frameTime) {
            const timing = this.getFrameTimes(watchers);
            if (timing) this._frameTime = timing;
        }
        if (!this._frameTime) return false;

        const marketData = this._market.getMarketData();
        const sideMarketData = this._side === 'up' ? this._market.getUpMarketData() : this._market.getDownMarketData();

        if (!this._wallet) {
            try {
                const params: OrderWalletParams = {
                    token_id: sideMarketData.tokenId,
                    balance: this._INITIAL_BALANCE,
                    tick_size: marketData.tick_size,
                    min_order_size: marketData.min_order_size,
                    min_buy_order_value: DEFAULT_BUY_ORDER_MIN_VALUE
                };
                this._wallet = await this.createWallet(client, params, marketData.conditionId);

                this.log(`Wallet created, token=${this._wallet.getTokenId()}, balance=${this._INITIAL_BALANCE}`);
            } catch (error) {
                logger.error(`[CoinTrendLine][${this._eventId}] Wallet creation failed: ${error_str(error)}`);
                return false;
            }
        }

        const nowSec = Date.now() / 1000;

        // Entries only inside the window [start factor, end factor]; exits still allowed.
        const isStartPeriod = this.isStartOfFrame(nowSec);
        const isEndPeriod = this.isEndOfFrame(nowSec);

        const progress = this.getFrameProgress(nowSec);

        const history = this._side === 'up'? this._event.getWatcherHistoryUp()[0]: this._event.getWatcherHistoryDown()[0];
        if (!history || !history?.coin_frame_start_price || !this._coinWatcher?.getCoinPrice()) return false;

        // Signed deviation: positive when the coin price rose above the frame start price.
        const coinPriceDeviation = Math.abs((this._coinWatcher!.getCoinPrice() ?? 0) - (history.coin_frame_start_price ?? 0));

        if (!this._hasStarted) {
            if (!isStartPeriod) return false; 
            const started = (coinPriceDeviation >= this._START_DIFF_PRICE_FACTOR);
            if (!started) return false;                                        // deviation too small - keep waiting
            this._hasStarted = true;                                           // latched for the rest of the frame
        }

        // Mirror line: _MIRROR_LINE_START -> 0.0 over the frame
        const mirrorLine = safeFloat(
            this._MIRROR_LINE_START * (1 - progress),
            ORDER_WALLET_FRACTION
        );

        const ask = this._market.getBestAsk(this._side);
        const bid = this._market.getBestBid(this._side);
        if (ask === undefined || bid === undefined) return false;

        // Per-tick action flag: true only when an order was actually placed.
        this._didAction = false;

        // Mirror flag (latch): bid fell below the mirror line (_MIRROR_LINE_START -> 0.0)
        if (bid < mirrorLine) this._mirror = true;

        // Entry line depends on mirror state: interpolates start -> _PRICE_BUY_END
        const buyStart = this._mirror ? this._PRICE_BUY_START_MIRROR : this._PRICE_BUY_START;
        const priceBuyCurr = safeFloat(
            buyStart + (this._PRICE_BUY_END - buyStart) * progress,
            ORDER_WALLET_FRACTION
        );

        // Clean up stale order references
        if (this._buyOrder && !this._wallet.isLive(this._buyOrder.id)) this._buyOrder = undefined;
        if (this._sellOrder && !this._wallet.isLive(this._sellOrder.id)) this._sellOrder = undefined;

        const positionSize = this._wallet.getTokensQuantity();

        // Entry: no open orders, position below target, ask crossed above the line, buy price under cap.
        // Taker entry: cross the ask by one tick so the buy fills instantly.
        if (this._hasStarted && isStartPeriod && !isEndPeriod && !this._hasExited && !this._wasInPosition &&
            !this._buyOrder && !this._sellOrder && positionSize < this._ORDER_VOLUME && ask > priceBuyCurr) {

            const tick = this._wallet.getTick();
            const buyPrice = safeFloat(ask + tick, ORDER_WALLET_FRACTION);

            // The _MAX_BUY_PRICE cap applies only within the Exit C window (progress < _EXIT_C_TIME_FACTOR);
            // after that interval the cap is lifted.

            // TODO: IN BASE OLD PRIFIT VERSION ONLY - "buyPrice <= this._MAX_BUY_PRICE"
            if (progress >= this._EXIT_C_TIME_FACTOR || buyPrice <= this._MAX_BUY_PRICE) {
                const state = await this._wallet.buy(buyPrice, this._ORDER_VOLUME);
                if (state) {
                    this._buyOrder = state;
                    this._wasInPosition = true;
                    this._didAction = true;
                    this.log(`BUY ${this._ORDER_VOLUME} @ ${buyPrice} (ask=${ask}, line1=${priceBuyCurr})`);
                } else {
                    this.log(`BUY failed: ask=${ask} line1=${priceBuyCurr}`);
                }
            }
        }

        // Exits are mutually exclusive per tick (else-if): A (normal low) -> B (mirror low) -> C (spike high).
        // Exit A: flag off, bid below _PRICE_SELL_LEVEL
        if (positionSize >= this._ORDER_VOLUME && !this._sellOrder && bid < this._PRICE_SELL_LEVEL && !this._mirror) {
            await this.exitAtBid(bid, positionSize, `exitA bid=${bid}<${this._PRICE_SELL_LEVEL}`);
        }
        // Exit B: flag on, bid below _MIRROR_EXIT_LEVEL
        else if (positionSize >= this._ORDER_VOLUME && !this._sellOrder && bid < this._MIRROR_EXIT_LEVEL && this._mirror) {
            await this.exitAtBid(bid, positionSize, `exitB bid=${bid}<${this._MIRROR_EXIT_LEVEL}`);
        }
        // Exit C: real sell price (bid) above buy cap -> sell at _MAX_BUY_PRICE for profit,
        // only before the time factor; blocks further entries (volatility signal).
        else if (positionSize >= this._ORDER_VOLUME && !this._sellOrder && bid > this._MAX_BUY_PRICE && progress < this._EXIT_C_TIME_FACTOR) {
            await this.exitC(bid, positionSize, `exitC bid=${bid}>${this._MAX_BUY_PRICE}`);
        }

        return this._didAction;
    }

    /** Market-sells the given tokens at the minimum price (tick), walking the book. */
    private async exitAtBid(bid: number, tokens: number, reason: string): Promise<void> {
        const wallet = this._wallet;
        if (!wallet) return;
        // Market sell at the minimum price: crosses every bid level, walks the book
        // top-to-bottom and always fills as a taker. The wallet computes the average
        // fill price from the real trades.
        const sellPrice = wallet.getTick();
        const state = await wallet.sell(sellPrice, tokens);
        if (state) {
            this._sellOrder = state;
            this._hasExited = true;
            this._didAction = true;
            this.log(`SELL ${tokens} @ ${sellPrice} (bid=${bid}) -> ${reason}`);
        } else {
            this.log(`SELL failed: ${reason}`);
        }
    }

    /** Sells at the buy-cap price; crosses the book when bid > cap, filling at ~bid for a profit. */
    private async exitC(bid: number, tokens: number, reason: string): Promise<void> {
        const wallet = this._wallet;
        if (!wallet) return;
        const state = await wallet.sell(this._MAX_BUY_PRICE, tokens);
        if (state) {
            this._sellOrder = state;
            this._hasExited = true;
            this._didAction = true;
            this.log(`SELL ${tokens} @ ${this._MAX_BUY_PRICE} (bid=${bid}) -> ${reason}`);
        } else {
            this.log(`SELL failed: ${reason}`);
        }
    }

    // ---------------------------- CANCEL ----------------------------
    public async cancel(client: ClobClient, watchers: readonly EventWatcher<CoinFrameEventMarketData>[], isSignal: boolean): Promise<boolean> {
        // ===================== WALLET CLOSE =====================
        // isSignal=true (keyboard/SIGINT/SIGTERM/error): liquidate remaining
        // tokens — dispose(true) sells them at the tick floor (taker).
        // isSignal=false (natural frame end by time): just cancel orders and
        // keep the position — dispose(false) does not sell tokens.
        if (this._wallet) {
            await this._wallet.dispose(isSignal || this._isDebug);
        }
        // =========================================================

        const finalBalance = this._wallet?.getBalance() ?? this._INITIAL_BALANCE;
        this.log(`Strategy cancelled. Final balance: ${finalBalance.toFixed(2)}`);

        this._mirror = false;
        this._hasStarted = false;
        this._hasExited = false;
        this._wasInPosition = false;
        this._didAction = false;
        this._buyOrder = undefined;
        this._sellOrder = undefined;
        this._frameTime = undefined;
        this._wallet = undefined;
        this._event = undefined;
        this._market = undefined;

        return true;
    }
}
