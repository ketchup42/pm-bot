import { ClobClient, Side } from "@polymarket/clob-client-v2";
import { EventStrategy } from "./EventStrategy.js";
import { CoinFrameEventMarketData } from "../../history/coin_frame.js";
import { EventWatcher } from "../EventWatcher.js";
import { logger } from "../../../../log.js";
import { CoinPriceWatcher } from "../../../../market/price/CoinPriceWatcher.js";
import { PriceWatcherFactory } from "../../../../market/price/PriceWatcherFactory.js";
import { error_str, safeFloat, safeToNum } from "../../../../utils.js";
import {
    DEFAULT_ORDER_MIN_SIZE,
    DEFAULT_BUY_ORDER_MIN_VALUE,
} from "../../../../rest/orders.js";
import { MarketSide } from "../../../../market/side.js";
import { MarketOrderBooksWatcher, OrderBookLevel } from "../../../../market/orderbook/watcher/MarketOrderBooksWatcher.js";
import { Coin, DEFAULT_COIN_PRICE_TICK_SIZE, coin_precis } from "../../../../market/coins.js";
import { TIMER_FAST } from "../../../../timer.js";
import { ORDER_WALLET_FRACTION, OrderWalletState } from "../../../../market/orders/OrderWallet.js";
import { LiveOrdersWatcherRTDS } from "../../../../market/orders/watcher/LiveOrdersWatcherRTDS.js";
import { LiveOrderWallet } from "../../../../market/orders/LiveOrderWallet.js";
import { tick_price } from "../../../../rest/orders-price.js";

// ====================== SIMPLE INTERFACES FOR PRICES ======================
interface AskBidPrices { ask: number; bid: number; }
interface AdjustedPrices { askUnderWall: number; bidOverWall: number; }
interface FullPrices extends AskBidPrices, AdjustedPrices { btcPrice: number; }

/** Start/end timestamps of the current trading frame (in seconds). */
interface FrameTime { startTime: number; endTime: number; }
// ==========================================================================

/**
 * Trading strategy based on order book analysis and BTC price impulses.
 * Operates on a single direction (up or down) of a given event.
 *
 * The strategy delegates all order placement, balance management, and
 * fill tracking to a virtual wallet ({@link LiveOrderWallet}).
 * It only makes decisions about desired prices and quantities; the wallet enforces
 * tick size, minimum order size, and minimum buy value, and automatically
 * updates the virtual balance when orders are executed.
 */
export class CoinWallStrategyDoge implements EventStrategy<CoinFrameEventMarketData> {
    private readonly _eventId: string;
    private readonly _side: MarketSide;
    private readonly _btcPriceWatcher: CoinPriceWatcher | undefined;
    private readonly _coinPriceWatcher: CoinPriceWatcher | undefined;
    private static readonly _STRATEGY_COIN: Coin = 'doge';

    // ====================== STRATEGY PARAMETERS ========================
    private readonly _INITIAL_BALANCE: number = 9;      /** Initial balance in USD (virtual, for internal tracking). */
    private readonly _WALL_SIZE: number = 5;            /** Size threshold for wall detection in the order book. */
    private readonly _MIN_BUY_VALUE_USD: number = 1;    /** Default USD sum that uses to buy tokens. */
    private readonly _TARGET_PROFIT: number = 0.45;     /** Desired profit above which sell may be triggered. */
    private readonly _MIN_SPREAD: number = 0.04;        /** Minimum acceptable spread between ask and buy order price. */
    private readonly _MAX_POSITION_SIZE: number = DEFAULT_ORDER_MIN_SIZE * 2 - 1;  /** Maximum allowed position size (in tokens) before buying is blocked. */
    private readonly _BTC_IMPULSE_THRESHOLD: number = 5;                           /** BTC price change (in USD) required to trigger order adjustment. */
    private readonly _MARKET_SELL_MARGIN: number = 0.02;                           /** Margin above which selling at market is considered favorable. */
    private readonly _PRICE_TOLERANCE: number = DEFAULT_COIN_PRICE_TICK_SIZE;      /** Tolerance added/subtracted when placing orders near the wall price. */
    private readonly _START_INTERVAL_FACTOR: number = 0.05;                        /** Fraction of the frame duration at which we consider we are start. */
    private readonly _END_INTERVAL_FACTOR: number = 0.8;                           /** Fraction of the frame duration at which we consider we are at the end. */
    private readonly _MIN_ABS_PRICE_DEVIATION_TRADING_START: number = 0.000005;    /** Minimum absolute coin price deviation from the event start price required to begin normal trading. */
    private readonly _FORCED_ABS_PRICE_DEVIATION_TRADING_START: number = 0.000015; /** Larger absolute deviation threshold used to force an aggressive trading start. */
    private readonly _COIN_PRICE_HISTORY_LENGTH: number = 20;                      /** Minimum coin price history length to start check trading conditions. */
    // ===================================================================

    // ========================= TRADING STATE ===========================
    private _maxBuyPrice: number = 0;
    private _currentBuyOrder: OrderWalletState | undefined = undefined;
    private _currentSellOrder: OrderWalletState | undefined = undefined;

    private _isVeryFirstInitBuy = true;
    private _isStartBuyTickNeedState: boolean = true;
    private _inBuyAndSellMaxState: boolean = false;
    private _inMarketSellState: boolean = false;

    private _previousAsk: number | undefined = undefined;
    private _previousBid: number | undefined = undefined;
    private _previousBtcPrice: number | undefined = undefined;

    /** Timing boundaries of the current frame. */
    private _frameTime: FrameTime | undefined = undefined;

    /** Per‑tick period flags – refreshed in {@link execute} before calling {@link master_tick}. */
    private _isEndPeriod: boolean = false;
    private _isHalfPeriod: boolean = false;

    private _wallet: LiveOrderWallet | undefined = undefined;   // virtual wallet
    private _event: EventWatcher<CoinFrameEventMarketData> | undefined = undefined;
    private _market: MarketOrderBooksWatcher | undefined = undefined;

    private _coinPricesHistory: number[] = [];
    private _isTradingStarted = false;
    // ================================================================

    private constructor(eventId: string, side: MarketSide) {
        this._eventId = eventId;
        this._side = side;
        this._btcPriceWatcher = PriceWatcherFactory.getCoinWatcher('btc', 'chainlink');
        this._coinPriceWatcher = PriceWatcherFactory.getCoinWatcher(CoinWallStrategyDoge._STRATEGY_COIN, 'chainlink');
    }

    public static async create(eventId: string, side: MarketSide): Promise<CoinWallStrategyDoge> {
        await PriceWatcherFactory.getCoinWatcher('btc', 'chainlink')?.warmUp(TIMER_FAST);
        await PriceWatcherFactory.getCoinWatcher(CoinWallStrategyDoge._STRATEGY_COIN, 'chainlink')?.warmUp(TIMER_FAST);
        return new CoinWallStrategyDoge(eventId, side);
    }

    // ---------------------------- LOGGING ----------------------------
    private log(msg: string): void {
        logger.info(`[CoinWallStrategy][${this._eventId}] ${msg}`);
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

    private isStartOfTick(currentTime: number): boolean {
        if (!this._frameTime) return false;
        const timeFromStart = currentTime - this._frameTime.startTime;
        const startTime = (this._frameTime.endTime - this._frameTime.startTime) * this._START_INTERVAL_FACTOR;
        return timeFromStart >= startTime;
    }

    private isEndOfFrame(currentTime: number): boolean {
        if (!this._frameTime) return false;
        const timeFromStart = currentTime - this._frameTime.startTime;
        const lasttime = (this._frameTime.endTime - this._frameTime.startTime) * this._END_INTERVAL_FACTOR;
        return timeFromStart >= lasttime;
    }

    private isHalfOfFrame(currentTime: number): boolean {
        if (!this._frameTime) return false;
        const halfTime = this._frameTime.startTime + (this._frameTime.endTime - this._frameTime.startTime) / 2;
        return currentTime >= halfTime;
    }

    private getPriceFromOrderBook(orders: OrderBookLevel[], fallbackPrice: number | undefined): number | undefined {
        if (orders.length === 0) return fallbackPrice;
        let cumulativeSize = 0;
        for (let i = orders.length - 1; i > 0; i--) {
            cumulativeSize += safeToNum(orders[i]!.size);
            if (cumulativeSize > this._WALL_SIZE) return safeToNum(orders[i]!.price);
        }
        return safeToNum(orders[orders.length - 1]!.price);
    }

    private hasPricesChanged(prices: FullPrices): boolean {
        return this._previousAsk !== prices.ask ||
               this._previousBid !== prices.bid ||
               this._previousBtcPrice !== prices.btcPrice;
    }

    private getOrderState(order: OrderWalletState | undefined): string {
        if (!this._wallet) return "-UNKNOWN-";
        if (!order) return "-UNSET-";

        if (this._wallet.hasCanceled(order.id)) return "-CANCELED-";
        if (this._wallet.isPartialFilled(order.id)) return "-PARTIAL-MATCHED-";
        if (this._wallet.isFullFilled(order.id)) return "-MATCHED-";
        if (this._wallet.isLive(order.id)) return "-LIVE-";
        return "-UNKNOWN-";
    }

    private getBuyQuantity(buyPrice: number): number { return this._MIN_BUY_VALUE_USD / buyPrice; }

    /**
     * Generic helper that evaluates whether the coin price has deviated from the event
     * start price by at least the given `threshold` in the direction determined by side.
     *
     * - **up**   -> deviation >=  threshold
     * - **down** -> deviation <= -threshold
     *
     * @param threshold - The minimum absolute deviation required to start trading.
     * @returns true if the condition is met, false otherwise.
     */
    private checkTradingStartCondition(threshold: number): boolean { 
        if (this._coinPricesHistory.length === 0) return false;

        const fraction = coin_precis(CoinWallStrategyDoge._STRATEGY_COIN);
        const sum = this._coinPricesHistory.reduce((a, b) => a + b, 0);
        const averagePrice = safeFloat(sum / this._coinPricesHistory.length, fraction);

        const eventData = this._side === 'up'
            ? this._event?.getWatcherHistoryUp()[0]
            : this._event?.getWatcherHistoryDown()[0];
        const eventStartPrice = eventData?.coin_frame_start_price;
        if (!eventStartPrice) return false;

        const deviation = safeFloat(averagePrice - eventStartPrice, fraction);

        if (this._side === 'up') {
            return deviation >= threshold;
        } else {
            return deviation <= -threshold;
        }
    }
    /**
     * Checks whether the coin price has moved sufficiently from the event start price
     * to trigger **forced** trading start (larger threshold).
     */
    private isForcedTradingStartCondition(): boolean {
        return this.checkTradingStartCondition(this._FORCED_ABS_PRICE_DEVIATION_TRADING_START);
    }

    /**
     * Checks whether the coin price has moved sufficiently from the event start price
     * to trigger **minimum** trading start (smaller threshold).
     */
    private isMinTradingStartCondition(): boolean {
        return this.checkTradingStartCondition(this._MIN_ABS_PRICE_DEVIATION_TRADING_START);
    }

    /**
     * Resets the trading‑start state so that the strategy will once again collect
     * coin prices and wait for the price‑deviation conditions before resuming.
     */
    private resetTradingStartState(): void {
        this._isTradingStarted = false;
        this._coinPricesHistory = [];

        this._isStartBuyTickNeedState = true;
        this._inBuyAndSellMaxState = false;
        this._inMarketSellState = false;

        if (!this._wallet) return;
        if (this._wallet.getTokensQuantity() === 0)
            this._maxBuyPrice = 0;
    }

    // ---------------------------- QUANTITY HELPERS ----------------------------
    /**
     * Computes the desired quantity for a sell limit order based on the original algorithm.
     */
    private calculateSellQuantity(): number {
        if (!this._wallet) return 0;

        const tokens = this._wallet.getTokensQuantity();
        if (tokens <= 0) return 0;
        if (tokens < this._wallet.getMinOrderSize()) return 0;

        const sellPrice = this._currentSellOrder?.value.price ?? 0;
        const balance = this._wallet.getBalance();
        const targetProfitReached = (balance + sellPrice * tokens) >= (this._INITIAL_BALANCE + this._TARGET_PROFIT);
        if (targetProfitReached) {
            return tokens;   // sell everything
        }
        const half = tokens / 2;
        return half < this._wallet.getMinOrderSize() ? tokens : half;
    }

    /**
     * Computes the desired quantity for a buy limit order.
     * Returns 0 if buying is blocked, otherwise the quantity that results in
     * spending {@link getBuyQuantity} at the given buyPribidOverWallce.
     * Blocking conditions mirror the original:
     * end of period, position too large, spread too small, profit reached.
     */
    private calculateBuyQuantity(buyPrice: number, ask: number): number {
        if (!this._wallet) return 0;

        const tokens = this._wallet.getTokensQuantity();
        const balance = this._wallet.getBalance();
        const positionTooLarge = tokens >= this._MAX_POSITION_SIZE;
        const spreadTooSmall = (ask - buyPrice) < this._MIN_SPREAD;
        const profitReached = balance >= this._INITIAL_BALANCE + this._TARGET_PROFIT;

        if (this._isEndPeriod || positionTooLarge || spreadTooSmall || profitReached) return 0;

        return this.getBuyQuantity(buyPrice);
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

        const marketData = this._market.getMarketData();
        const sideMarketData = this._side === 'up' ? this._market.getUpMarketData() : this._market.getDownMarketData();

        if (!this._wallet) {
            try {
                this._wallet = await LiveOrderWallet.create(client,
                {   
                    token_id: sideMarketData.tokenId,
                    balance: this._INITIAL_BALANCE,
                    tick_size: marketData.tick_size,
                    min_order_size: marketData.min_order_size,
                    min_buy_order_value: DEFAULT_BUY_ORDER_MIN_VALUE
                },
                await LiveOrdersWatcherRTDS.create(marketData.conditionId, client, client!.creds));
    
                this.log(`Wallet created, token=${this._wallet.getTokenId()}, balance=${this._INITIAL_BALANCE}, tick_size=${this._wallet.getTick()}, min_order_size=${this._wallet.getMinOrderSize()}, min_buy_order_value=${this._wallet.getMinBuyOrderValue()}`);
            } catch (error) {
                logger.error(`[CoinWallStrategy][${this._eventId}] Wallet creation failed: ${error_str(error)}`);
                return false;
            }
        }

        const currentBtcPrice = this._btcPriceWatcher?.getCurrentPrice();
        if (this._btcPriceWatcher && !currentBtcPrice) return false;

        let bids: OrderBookLevel[] = [];
        let asks: OrderBookLevel[] = [];
        let fallbackTokenPrice: number | undefined;

        if (this._side === 'up') {
            bids = this._market.getBidsUp();
            asks = this._market.getAsksUp();
            fallbackTokenPrice = this._market.getUpPrice();
        } else {
            bids = this._market.getBidsDown();
            asks = this._market.getAsksDown();
            fallbackTokenPrice = this._market.getDownPrice();
        }

        // ---------------------------- wall detection block ----------------------------
        const ask = this.getPriceFromOrderBook(asks, fallbackTokenPrice);
        const bid = this.getPriceFromOrderBook(bids, fallbackTokenPrice);
        if (!ask || !bid) return false;

        const prices: FullPrices = {
            ask, bid,
            askUnderWall: ask - this._PRICE_TOLERANCE,
            bidOverWall: bid + this._PRICE_TOLERANCE,
            btcPrice: currentBtcPrice ?? 0
        };

        const nowSec = Date.now() / 1000;
        this._isEndPeriod = this.isEndOfFrame(nowSec);
        this._isHalfPeriod = this.isHalfOfFrame(nowSec);

        const currentCoinPrice = this._coinPriceWatcher?.getCurrentPrice();

        // ---------- Pre‑trading: accumulate prices until conditions are met ----------
        if (!this._isTradingStarted) {

            if (this._coinPricesHistory.length > this._COIN_PRICE_HISTORY_LENGTH) {
                this._coinPricesHistory = [];
                return false;
            }

            if (currentCoinPrice !== undefined) {
                this._coinPricesHistory.push(currentCoinPrice);
            }

            // Do not evaluate start conditions until the start time has passed
            if (!this.isStartOfTick(nowSec)) {
                return false;
            }

            if (this._coinPricesHistory.length < this._COIN_PRICE_HISTORY_LENGTH) {
                this.log(`Insufficient price history for trading start: ${this._coinPricesHistory.length}/${this._COIN_PRICE_HISTORY_LENGTH}`);
                return false;
            }

            // Start time reached — evaluate thresholds against the accumulated average
            const minCondition = this.isMinTradingStartCondition();
            const forcedCondition = this.isForcedTradingStartCondition();

            if (minCondition || forcedCondition) {
                this._isTradingStarted = true;
                this.log(`Trading start condition reached. min=${minCondition}, forced=${forcedCondition}`);
            } else {
                this.log(`Start conditions not met. min=${minCondition}, forced=${forcedCondition}`);
                return false;
            }
        }

        if (!this.isStartOfTick(nowSec)) return false;
        if (!this.hasPricesChanged(prices)) return false;

        this.log(`${this._side.toUpperCase()} tick: ask=${prices.ask} bid=${prices.bid} btc=${prices.btcPrice} buy_order=${this.getOrderState(this._currentBuyOrder)} sell_order=${this.getOrderState(this._currentSellOrder)} maxbuy=${this._maxBuyPrice} balance=${this._wallet.getBalance()} tokens=${this._wallet.getTokensQuantity()} end=${this._isEndPeriod}`);
        await this.master_tick(prices);

        this._previousAsk = prices.ask;
        this._previousBid = prices.bid;
        this._previousBtcPrice = prices.btcPrice;
        return true;
    }

    // ---------------------------- TICK PROCESSING ----------------------------
    private async master_tick(prices: FullPrices): Promise<void> {
        if (!this._isTradingStarted) return;

        if (this._inBuyAndSellMaxState) {
            const highSellPlaced = await this.buyAndSellAllStateHandler();
            if (highSellPlaced) { this._inBuyAndSellMaxState = false; return; }

            await this.adjustOrdersByBtcImpulse(prices);
            return;
        }

        this._inBuyAndSellMaxState = await this.checkAndHandleMarketBuy(prices);
        if (this._inBuyAndSellMaxState) { this._isStartBuyTickNeedState = false; return; }
    
        if (this._isStartBuyTickNeedState)
            await this.generalInitialBuyTick(prices);

        await this.handleSellExecution(prices);
        await this.handleBuyExecution(prices);

        await this.handleMarketSell(prices);

        await this.adjustOrdersByBtcImpulse(prices);
    }

    /**
     * First tick: place the initial buy order unconditionally.
     */
    private async generalInitialBuyTick(prices: FullPrices): Promise<void> {
        if (!this._wallet) return;

        const forcedCondition = this.isForcedTradingStartCondition();
        let buyPrice;
        let buyQty;


        // TODO: modify prices for more agressive trading
        if (this._isVeryFirstInitBuy) {
            buyPrice = Math.min(prices.bidOverWall * 0.9, prices.askUnderWall * 0.8);
            buyQty = this.getBuyQuantity(buyPrice);

            if (forcedCondition) {
                buyPrice = prices.bidOverWall; // TODO: may be set as taker price to fast buy and sell
                buyQty = this.getBuyQuantity(buyPrice);
            }
        } else {
            buyPrice = prices.bidOverWall * 0.8;
            buyQty = this.calculateBuyQuantity(buyPrice, prices.ask);

            if (forcedCondition) {
                buyPrice = Math.min(prices.bidOverWall * 0.9, prices.askUnderWall * 0.8); // TODO: may be set as taker price to fast buy and sell
                buyQty = this.calculateBuyQuantity(buyPrice, prices.ask);
            } 
        }
        if (buyQty <= 0) return;

        const buyState = await this._wallet.buy(buyPrice, buyQty);
        if (!buyState) {
            if (this._isVeryFirstInitBuy)
                this.log('First tick buy failed');
            else
                this.log('Trading start tick buy failed');
            return;
        }
        this._currentBuyOrder = buyState;
        this._isStartBuyTickNeedState = false;
        this._isVeryFirstInitBuy = false;

        this.log(`Trading start tick buy placed: id=${buyState.id} price=${buyState.value.price} qty=${buyState.value.quantity}`);
    }

    /**
     * Forced market buy in the middle of the period, if no position and favorable conditions.
     */
    private async checkAndHandleMarketBuy(prices: FullPrices): Promise<boolean> {
        if (!this._wallet || !this._previousAsk) return false;

        const balance = this._wallet.getBalance();
        const tokens = this._wallet.getTokensQuantity();

        const noPosition = balance === this._INITIAL_BALANCE && tokens === 0;
        const positiveTrend = this._previousAsk > prices.ask;
        const priceCondition = prices.ask > 0.77 && prices.bid < 0.6;

        if (this._isHalfPeriod && noPosition && positiveTrend && priceCondition) {
            this.log('Forced market buy triggered (half period, positive trend)');

            // More than need for total safe
            if (this._currentSellOrder) {
                // tokens === 0 => we can not have any not full matched sell orders
                // await this._wallet.cancel_order(this._currentSellOrder.id);
                this._currentSellOrder = undefined;
            }

            if (this._currentBuyOrder) {
                await this._wallet.cancel_order(this._currentBuyOrder.id);
                this._currentBuyOrder = undefined;
            }

            const buyState = await this._wallet.buy(prices.bidOverWall, this.getBuyQuantity(prices.bidOverWall));
            if (!buyState) {
                this.log('Forced market buy failed to place order');
                return false;
            }
            this.log(`Forced market buy placed: id=${buyState.id} price=${buyState.value.price} qty=${buyState.value.quantity}`);
            this._currentBuyOrder = buyState;

            return true;
        }
        return false;
    }

    /**
     * When the forced buy is filled, immediately place a sell order for the whole position.
     */
    private async buyAndSellAllStateHandler(): Promise<boolean> {
        if (!this._wallet || !this._currentBuyOrder) return false;
        if (!this._wallet.isFullFilled(this._currentBuyOrder.id)) return false;
        this.log('Forced buy filled, placing forced sell');

        const buyPriceUsed = this._currentBuyOrder.value.price;

        // Update highest buy price
        if (buyPriceUsed > this._maxBuyPrice) {
            this._maxBuyPrice = buyPriceUsed;
        }

        const tokens = this._wallet.getTokensQuantity();
        if (tokens > 0) {
            const sellState = await this._wallet.sell(0.90, tokens);
            if (!sellState) {
                this.log('Forced sell after market buy failed, trying again...');
                return false;
            }
            this.log(`Forced sell after market buy placed: id=${sellState.id} price=${sellState.value.price} qty=${sellState.value.quantity}`);

            this._currentSellOrder = sellState;
            this._currentBuyOrder = undefined;

            return true;
        }
        return false;
    }

    /**
     * Forced market sell of the entire position.
     */
    private async handleMarketSell(prices: FullPrices): Promise<void> {
        if (!this._wallet) return;
        if (!this._market) return;

        const tokens = this._wallet.getTokensQuantity();
        if (tokens <= 0 || !this._previousAsk || !this._previousBid) return;

        const balance = this._wallet.getBalance();

        const endPeriodCondition = this._isEndPeriod &&
            this._previousBid > prices.bid &&
            prices.ask > 0.1 &&
            (this._previousAsk - prices.ask) >= (this._previousBid - prices.bid) &&
            prices.ask < prices.bid * 2;

        const profitCondition = (balance + prices.bid * tokens) >= (this._INITIAL_BALANCE + this._TARGET_PROFIT);
        const favorableCondition = this._maxBuyPrice > 0 &&
            prices.bid >= 0.5 &&
            (this._maxBuyPrice + this._MARKET_SELL_MARGIN) < prices.bid;


        if (endPeriodCondition || profitCondition || favorableCondition || this._inMarketSellState) {
            this.log(`Market sell triggered: endPeriod=${endPeriodCondition} profit=${profitCondition} favorable=${favorableCondition}`);

            if (this._currentSellOrder) {
                await this._wallet.cancel_order(this._currentSellOrder.id);
                this._currentSellOrder = undefined;
            }

            if (this._currentBuyOrder) {
                await this._wallet.cancel_order(this._currentBuyOrder.id);
                this._currentBuyOrder = undefined;
            }

            {
                let actual_tokens = this._wallet.getTokensQuantity();
                this.log(`Market sell triggered: balance=${this._wallet.getBalance()} tokens=${actual_tokens}`);

                const liquidity_ask = this._side === 'up'? this._market.getUpAskLiquidity(): this._market.getDownAskLiquidity();
                const liquidity_bid = this._side === 'up'? this._market.getUpBidLiquidity(): this._market.getDownBidLiquidity();

                if (liquidity_bid.total_size < actual_tokens) {
                    this.log('Market sell failed - too small bid liquidity');
                    return;
                }

                if (actual_tokens < this._wallet.getMinOrderSize()) {
                    this.log(`Market sell triggered: actual-tokens=${actual_tokens} < ${this._wallet.getMinOrderSize()} - DUST clean up triggered!`);

                    let buyQty = this._wallet.getMinOrderSize();
                    let afterBuyQty = actual_tokens + buyQty;

                    if (liquidity_ask.total_size < buyQty) {
                        buyQty = liquidity_ask.total_size;
                        afterBuyQty = actual_tokens + buyQty;
                        if (afterBuyQty < this._wallet.getMinOrderSize()) {
                           this.log('Dust clean up failed - too small ask liquidity');
                        }
                    }
                    
                    if (liquidity_bid.total_size < afterBuyQty) {
                        this.log('Dust clean up failed - too small bid liquidity');
                        return;
                    }

                    const bestAsk = this._market.getBestAsk(this._side);
                    if (!bestAsk) {
                        this.log('Dust clean up failed - too small ask liquidity');
                        return;
                    }

                    const bestBid = this._market.getBestBid(this._side);
                    if (!bestBid) {
                        this.log('Dust clean up failed - too small bid liquidity');
                        return;
                    }

                    {
                        const qtyCost = safeFloat(bestAsk * buyQty, ORDER_WALLET_FRACTION);
                        const qtyRevenue = safeFloat(bestBid * afterBuyQty, ORDER_WALLET_FRACTION);
                        const actualTokensValue = safeFloat(bestBid * actual_tokens, ORDER_WALLET_FRACTION);

                        if (qtyCost - qtyRevenue > actualTokensValue) {
                            this.log('Dust clean up stopped – loss exceeds dust value');
                            return;
                        }
                    }

                    const buyState = await this._wallet.buy(1 - this._wallet.getTick(), this._wallet.getMinOrderSize());
                    if (buyState && !buyState?.fast_full_trade) {
                        await this._wallet.cancel_order(buyState.id);
                        this.log('Dust top-up attempt failed fast full buy');
                        
                        actual_tokens = actual_tokens + (this._wallet.getMinOrderSize() - buyState.value.quantity);
                        if (actual_tokens < this._wallet.getMinOrderSize()) {
                            this.log(`Can not sell, actual-tokens=${actual_tokens} < ${this._wallet.getMinOrderSize()} - DUST left!`);
                            return;
                        }
                    }
                    this._inMarketSellState = true;

                    // Do not write new max buy price to avoid taker overbuy and not market sell state.

                    //if (buyState) {
                    //    const takerBuyPrice = buyState.value.price;
                    //    // Update highest buy price
                    //   if (takerBuyPrice > this._maxBuyPrice) {
                    //        this._maxBuyPrice = takerBuyPrice;
                    //    }
                    //}
                }
            }

           // Reset position‑related state
            const sellState = await this._wallet.sell(this._wallet.getTick(), this._wallet.getTokensQuantity());
            if (!sellState) {
                this.log('Market sell order failed to place, trying again...');
                return;
            }
            if (sellState.fast_full_trade)
                this.log(`Market fast sell executed: id=${sellState.id} price=${sellState.value.price} qty=${sellState.value.quantity}`);
            else
                this.log(`Market sell placed: id=${sellState.id} price=${sellState.value.price} qty=${sellState.value.quantity}`);


            this.resetTradingStartState();

            // Saves sell order state to avoid both orders undefined state - general handleSellExecution will handle if not available balance yet
            // this._currentSellOrder = sellState;
            // this._maxBuyPrice = 0;
            // this._inMarketSellState = false;

            // Place new buy order
            // const newBuyPrice = prices.bidOverWall * 0.8;
            // const newBuyQty = this.calculateBuyQuantity(newBuyPrice, prices.ask);
            // if (newBuyQty > 0) {
            //    let buyState = await this._wallet.buy(newBuyPrice, newBuyQty);
            //    if (!buyState) {
            //        this.log('Failed to place new buy order, trying again in general handlers...');
            //        return;
            //    }
            //    this._currentBuyOrder = buyState;
            // }
        }
    }

    /**
     * Handle sell order execution.
     */
    private async handleSellExecution(prices: FullPrices): Promise<void> {
        if (!this._wallet || !this._currentSellOrder) return;
        if (!this._wallet.isFullFilled(this._currentSellOrder.id)) return;

        this.log(`Sell order filled: id=${this._currentSellOrder.id} price=${this._currentSellOrder.value.price}`);

        const prevSellPrice = this._currentSellOrder.value.price;

        if (this._currentBuyOrder) {
            await this._wallet.cancel_order(this._currentBuyOrder.id);
            this._currentBuyOrder = undefined;
        }

        const buyPrice = Math.min(prevSellPrice * 0.8, prices.bidOverWall, 0.6);
        const buyQty = this.calculateBuyQuantity(buyPrice, prices.ask);
        if (buyQty > 0) {

            const buyState = await this._wallet.buy(buyPrice, buyQty);
            if (buyState) {
                this._currentBuyOrder = buyState;
                this._currentSellOrder = undefined;
            } else {
                this.log('Failed to place new buy order, trying again...');
                return;
            }
        }

        const sellPrice = prices.ask * 1.1;
        const sellQty = this.calculateSellQuantity();
        if (sellQty > 0) {
            const sellState = await this._wallet.sell(sellPrice, sellQty);
            if (sellState) {
                this._currentSellOrder = sellState;
            } else {
                this.log('Failed to place new sell order');
            }
        }
    }

    /**
     * Handle buy order execution.
     */
    private async handleBuyExecution(prices: FullPrices): Promise<void> {
        if (!this._wallet || !this._currentBuyOrder) return;
        if (!this._wallet.isFullFilled(this._currentBuyOrder.id)) return;

        this.log(`Buy order filled: id=${this._currentBuyOrder.id} price=${this._currentBuyOrder.value.price}`);

        const buyPriceUsed = this._currentBuyOrder.value.price;

        // Update highest buy price
        if (buyPriceUsed > this._maxBuyPrice) {
            this._maxBuyPrice = buyPriceUsed;
        }

        if (this._currentSellOrder) { 
            await this._wallet.cancel_order(this._currentSellOrder.id); 
            this._currentSellOrder = undefined;
        }
        {
            // Determine sell price
            let sellPrice = Math.max(buyPriceUsed * 1.20, Math.min(prices.askUnderWall, buyPriceUsed * 1.4));
            const tokens = this._wallet.getTokensQuantity();
            if (tokens >= this._MAX_POSITION_SIZE) {
                sellPrice = Math.min(buyPriceUsed * 1.20, prices.askUnderWall);
            }

            // Determine sell quantity
            const balance = this._wallet.getBalance();
            const targetProfitReached = (balance + sellPrice * tokens) >= (this._INITIAL_BALANCE + this._TARGET_PROFIT);
            const oversize = tokens >= this._MAX_POSITION_SIZE;
            const maxBuyFavorable = this._maxBuyPrice > 0 && this._maxBuyPrice < sellPrice;
            let sellQty: number;
            if (targetProfitReached || oversize || maxBuyFavorable) {
                sellQty = tokens;   // sell all
            } else {
                const half = tokens / 2;
                sellQty = half < this._wallet.getMinOrderSize() ? tokens : half;
            }

            if (sellQty > 0) {
                const sellState = await this._wallet.sell(sellPrice, sellQty);
                if (sellState) {
                    this._currentSellOrder = sellState;
                    this._currentBuyOrder = undefined;
                } else {
                    this.log('Failed to place new sell order, trying again...');
                    return;
                }
            }
        }
        // New buy order
        const newBuyPrice = prices.bidOverWall * 0.8;
        const newBuyQty = this.calculateBuyQuantity(newBuyPrice, prices.ask);
        if (newBuyQty > 0) {
            const buyState = await this._wallet.buy(newBuyPrice, newBuyQty);
            if (buyState) {
                this._currentBuyOrder = buyState;
            } else {
                this.log('Failed to place new buy order');
            }
        }
    }

    // ---------------------------- BTC IMPULSE ADJUSTMENTS ----------------------------
    private async adjustOrdersByBtcImpulse(prices: FullPrices): Promise<void> {
        if (!this._wallet || !this._previousBtcPrice) return;
        const delta = prices.btcPrice - this._previousBtcPrice;
        if (Math.abs(delta) <= this._BTC_IMPULSE_THRESHOLD) return;

        // Original direction‑dependent mapping:
        // side == 'down':   btc down -> raise sell / raise buy
        //                  btc up   -> lower buy  / lower sell
        // side == 'up':     btc up   -> raise sell / raise buy
        //                  btc down -> lower buy  / lower sell
        if (this._side === 'down') {
            if (delta < 0) await this.adjustForBtcDownImpulse(prices);
            else await this.adjustForBtcUpImpulse(prices);
        } else {
            if (delta > 0) await this.adjustForBtcDownImpulse(prices);
            else await this.adjustForBtcUpImpulse(prices);
        }
    }

    /** BTC down impulse correction: raises sell price, adjusts buy price upward. */
    private async adjustForBtcDownImpulse(prices: FullPrices): Promise<void> {
        const wallet = this._wallet!;

        // Raise sell price
        const sellOrderPrice = this._currentSellOrder?.value.price ?? 0;
        const newSellPrice = tick_price(Math.max(
            Math.min(prices.askUnderWall * 1.1, prices.bidOverWall * 1.2),
            sellOrderPrice,
            wallet.getTick()
        ), wallet.getTick(), Side.SELL);

        if (this._currentSellOrder && wallet.isLive(this._currentSellOrder.id) /** && !wallet.isPartialFilled(this._currentSellOrder.id)*/ && newSellPrice !== sellOrderPrice) {

            // MAY LEAVE DUST
            if (wallet.getTokensQuantity() >= wallet.getMinOrderSize()) {
                this.log(`BTC down: adjusting sell price from ${this._currentSellOrder.value.price} to ${newSellPrice}`);
                await wallet.cancel_order(this._currentSellOrder.id);
                this._currentSellOrder = undefined;

                const sellQty = this.calculateSellQuantity();
                const sellState = await wallet.sell(newSellPrice, sellQty);

                this._currentSellOrder = sellState? sellState: this._currentSellOrder;
            }
        }

        // Raise buy price
        const buyOrderPrice = this._currentBuyOrder?.value.price ?? 0;
        const newBuyPrice = tick_price(Math.min(
            Math.max(buyOrderPrice * 1.05, prices.bidOverWall),
            prices.bidOverWall
        ), wallet.getTick(), Side.BUY);

        if (this._currentBuyOrder && wallet.isLive(this._currentBuyOrder.id) /** && !wallet.isPartialFilled(this._currentBuyOrder.id)*/ && newBuyPrice !== buyOrderPrice) {

            const buyQty = this.calculateBuyQuantity(newBuyPrice, prices.ask);

            if (buyQty > 0) {
                this.log(`BTC down: adjusting buy price from ${this._currentBuyOrder.value.price} to ${newBuyPrice}`);
                let buyState = await wallet.buy(newBuyPrice, buyQty);

                if (this._currentBuyOrder) {
                    if (!buyState) {
                        await wallet.cancel_order(this._currentBuyOrder.id);
                        buyState = await wallet.buy(newBuyPrice, buyQty);
                    }
                    if (!buyState) { this._currentBuyOrder = undefined; return; }
                    await wallet.cancel_order(this._currentBuyOrder.id);   
                }
                this._currentBuyOrder = buyState;
            }
        }
    }

    /** BTC up impulse correction: lowers buy price, adjusts sell price downward. */
    private async adjustForBtcUpImpulse(prices: FullPrices): Promise<void> {
        const wallet = this._wallet!;
        // Lower buy price
        const buyOrderPrice = this._currentBuyOrder?.value.price ?? 0;
        const newBuyPrice = tick_price(prices.bidOverWall * 0.9, wallet.getTick(), Side.BUY);

        if (this._currentBuyOrder && wallet.isLive(this._currentBuyOrder.id) /** && !wallet.isPartialFilled(this._currentBuyOrder.id)*/ && newBuyPrice !== buyOrderPrice) {

            const buyQty = this.calculateBuyQuantity(newBuyPrice, prices.ask);

            if (buyQty > 0) {
                this.log(`BTC up: adjusting buy price from ${this._currentBuyOrder.value.price} to ${newBuyPrice}`);
                let buyState = await wallet.buy(newBuyPrice, buyQty);

                if (this._currentBuyOrder) {
                    if (!buyState) {
                        await wallet.cancel_order(this._currentBuyOrder.id);
                        buyState = await wallet.buy(newBuyPrice, buyQty);
                    }
                    if (!buyState) { this._currentBuyOrder = undefined; return; }
                    await wallet.cancel_order(this._currentBuyOrder.id);   
                }
                this._currentBuyOrder = buyState;
            }
        }

        // Lower sell price
        const sellOrderPrice = this._currentSellOrder?.value.price ?? 0;
        const newSellPrice = tick_price(Math.max(
            Math.min(sellOrderPrice * 0.95, prices.askUnderWall),
            prices.askUnderWall,
            wallet.getTick()
        ), wallet.getTick(), Side.SELL);

        if (this._currentSellOrder && wallet.isLive(this._currentSellOrder.id) /** && !wallet.isPartialFilled(this._currentSellOrder.id)*/ && newSellPrice !== sellOrderPrice) {

            // MAY LEAVE DUST
            if (wallet.getTokensQuantity() >= wallet.getMinOrderSize()) {
                this.log(`BTC up: adjusting sell price from ${this._currentSellOrder.value.price} to ${newSellPrice}`);
                await wallet.cancel_order(this._currentSellOrder.id);
                this._currentSellOrder = undefined;

                const sellQty = this.calculateSellQuantity();
                const sellState = await wallet.sell(newSellPrice, sellQty);

                this._currentSellOrder = sellState? sellState: this._currentSellOrder;
            }
        }
    }

    // ---------------------------- CANCEL ----------------------------
    public async cancel(client: ClobClient, watchers: readonly EventWatcher<CoinFrameEventMarketData>[]): Promise<boolean> {
        if (this._wallet) {
            await this._wallet.dispose(true);   // cancels orders and sells tokens
        }

        const finalBalance = this._wallet?.getBalance() ?? this._INITIAL_BALANCE;
        const profit = finalBalance - this._INITIAL_BALANCE;
        this.log(`Strategy cancelled. Final balance: ${finalBalance.toFixed(2)}, profit: ${profit.toFixed(2)}`);

        // Reset state
        this.resetTradingStartState();

        this._currentBuyOrder = undefined;
        this._currentSellOrder = undefined;

        this._previousAsk = undefined;
        this._previousBid = undefined;
        this._previousBtcPrice = undefined;

        this._frameTime = undefined;

        this._isEndPeriod = false;
        this._isHalfPeriod = false;

        this._wallet = undefined;
        this._event = undefined;
        this._market = undefined;

        return true;
    }
}