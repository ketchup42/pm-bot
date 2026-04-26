import { ClobClient, Side } from "@polymarket/clob-client";
import { EventStrategy } from "./EventStrategy.js";
import { CoinFrameEventMarketData } from "../../history/coin_frame.js";
import { EventWatcher } from "../EventWatcher.js";
import { logger } from "../../../../log.js";
import { CoinPriceWatcher } from "../../../../market/price/CoinPriceWatcher.js";
import { WARM_UP_FAST } from "../../../../market/price/PriceWatcher.js";
import { PriceWatcherFactory } from "../../../../market/price/PriceWatcherFactory.js";
import { error_str, safeToNum } from "../../../../utils.js";
import {
    placeMakerOrder,
    cancelOrder,
    cancelAllOrdersForToken,
    placeFakTakerOrder,
    getUSDCBalance,
} from "../../../../rest/orders.js";
import { MarketSide } from "../../../../market/side.js";
import { MarketOrderBooksWatcher, OrderBookLevel } from "../../../../market/orderbook/watcher/MarketOrderBooksWatcher.js";
import { OrdersWatcher } from "../../../../market/orders/watcher/OrdersWatcher.js";
import { DEFAULT_ORDER_MIN_PRICE, DEFAULT_PRICE_TICK_SIZE, tick_price, valid_quantity_safe, valid_quantity_unsafe } from "../../../../market/orders/order-price.js";

// ====================== SIMPLE INTERFACES FOR PRICES ======================
interface AskBidPrices {
    ask: number;
    bid: number;
}

interface AdjustedPrices {
    askUnderWall: number;   // price slightly below best ask (under the wall)
    bidOverWall: number;    // price slightly above best bid (over the wall)
}

interface FullPrices extends AskBidPrices, AdjustedPrices {
    btcPrice: number;
}

/** Data of the current limit order */
interface OrderInfo {
    price: number;
    quantity: number;
}
// ==========================================================================


/**
 * Trading strategy based on order book analysis and BTC price impulses.
 * Operates on a single direction (up or down) of a given event.
 *
 * The strategy maintains one buy and one sell limit order at all times,
 * adjusting them based on the current order book (wall detection), BTC price
 * changes, and interval timing. When market conditions are met, it may
 * execute market buys or sells as taker orders.
 *
 * All prices are rounded to the current tick size and quantities are
 * validated against the minimum order size.
 *
 * @remarks
 * This implementation is designed to run as an {@link EventStrategy} within
 * the Polymarket trading environment, receiving real-time order book data
 * and executing via the provided {@link ClobClient}.
 */
export class CoinWallStrategy implements EventStrategy<CoinFrameEventMarketData> {
    private readonly _eventId: string;
    private readonly _side: MarketSide;
    private readonly _ordersWatcher: OrdersWatcher;
    private readonly _btcPriceWatcher: CoinPriceWatcher | undefined;

    // ====================== STRATEGY PARAMETERS ========================
    private readonly _INITIAL_BALANCE: number = 5;      /** Initial balance in USDC (virtual, for internal tracking). */
    private readonly _WALL_SIZE: number = 7;            /** Size threshold for wall detection in the order book. */
    private readonly _MIN_BUY_VALUE_USDC = 3.5;         /** Target profit in USDC compared to initial balance. */
    private readonly _TARGET_PROFIT: number = 2;        /** Desired profit above which sell may be triggered. */
    private readonly _MIN_SPREAD: number = 0.04;        /** Minimum acceptable spread between ask and buy order price. */
    private readonly _MAX_POSITION_SIZE: number = DEFAULT_ORDER_MIN_PRICE * 1.4;  /** Maximum allowed position size (in tokens) before buying is blocked. */
    private readonly _BTC_IMPULSE_THRESHOLD: number = 5;                          /** BTC price change (in USD) required to trigger order adjustment. */
    private readonly _MARKET_SELL_MARGIN: number = 0.02;                          /** Margin above which selling at market is considered favorable. */
    private readonly _PRICE_TOLERANCE: number = DEFAULT_PRICE_TICK_SIZE;          /** Tolerance added/subtracted when placing orders near the wall price. */
    private readonly _END_INTERVAL_FACTOR: number = 0.8;                          /** Fraction of the frame duration at which we consider we are at the end. */
    // ===================================================================


    // ========================= TRADING STATE ===========================
    
    /** Current USDC balance (tracked internally, not synced with exchange). */
    private _balance: number;
    private readonly _initialBalance: number;     /** Initial balance at strategy start, used for profit calculation. */

    /** Number of tokens currently held (from executed buys). */
    private _positionSize: number = 0;
    /** Highest price ever paid for a buy order, used for market sell signal. */
    private _maxBuyPrice: number = 0;

    // Current orders (only one buy and one sell at any time)
    private _currentBuyOrder: OrderInfo = { price: 0, quantity: 0 };
    private _currentSellOrder: OrderInfo = { price: 0, quantity: 0 };

    /** Indicates we are in the first tick of the strategy. */
    private _firstTick: boolean = true;
    /** Special mode: we placed a forced market buy and are waiting for its fill before selling. */
    private _buyAndSellMax: boolean = false;

    // Previous price values from last tick, for change detection
    private _previousAsk: number | undefined = undefined;
    private _previousBid: number | undefined = undefined;
    private _previousBtcPrice: number | undefined = undefined;

    /** Exchange order ID for the current buy order. */
    private _buyOrderId: string | undefined = undefined;
    /** Exchange order ID for the current sell order. */
    private _sellOrderId: string | undefined = undefined;

    /** Token ID (asset_id) for the outcome we are trading (up or down). */
    private _tokenId: string | undefined = undefined;

    /** Frame start time (seconds), used to detect mid/end of interval. */
    private _frameStartTime: number | undefined = undefined;
    private _frameEndTime: number | undefined = undefined;

    /** Current tick size of the market. Updated on each execute. */
    private _tickSize: number = DEFAULT_PRICE_TICK_SIZE;
    /** Current minimum order size. Updated on each execute. */
    private _minOrderSize: number = DEFAULT_ORDER_MIN_PRICE;

    // ================================================================

    /**
     * Private constructor – use the static {@link create} method instead.
     *
     * @param coin - The coin we are trading.
     * @param side - Direction (up/down).
     * @param coinWatcher - Price watcher for the underlying coin.
     * @param ordersWatcher - Watcher tracking our own orders' fill status.
     */
    private constructor(eventId: string, side: MarketSide, ordersWatcher: OrdersWatcher) {
        this._eventId = eventId;
        this._side = side;
        this._ordersWatcher = ordersWatcher;

        this._btcPriceWatcher = PriceWatcherFactory.getCoinWatcher('btc', 'chainlink');

        this._balance = this._INITIAL_BALANCE;
        this._initialBalance = this._INITIAL_BALANCE;
    }

    /**
     * Performs initial warm‑up and balance check.
     *
     * @param client - Optional CLOB client for balance verification.
     */
    private async init(client?: ClobClient): Promise<void> {
        if (client) this.balanceCheck(client)

        await Promise.all([
            this._btcPriceWatcher?.warmUp(WARM_UP_FAST)
        ]);
    }

    /**
     * Verifies that the user's USDC balance meets the initial requirement.
     *
     * @param client - Authenticated CLOB client.
     */
    private async balanceCheck(client: ClobClient): Promise<void> {
       const balance = await getUSDCBalance(client);
        if (balance < this._balance) {
            throw new Error(`Insufficient USDC balance: ${balance}, required ${this._balance}`);
        }
    }

    /**
     * Factory method that creates and initializes a new instance of the strategy.
     *
     * @param eventId - The event id.
     * @param side - 'up' or 'down'.
     * @param ordersWatcher - Order status watcher.
     * @param client - Optional CLOB client for balance verification.
     * @returns A fully initialized strategy instance.
     */
    public static async create(
        eventId: string,
        side: MarketSide,
        ordersWatcher: OrdersWatcher,
        client?: ClobClient
    ): Promise<CoinWallStrategy> {
        const strategy = new CoinWallStrategy(eventId, side, ordersWatcher);
        await strategy.init(client);
        return strategy;
    }


    /**
     * Finds the event watcher for our event id among the given watchers.
     */
    private findMyEventWatcher(watchers: readonly EventWatcher<CoinFrameEventMarketData>[]): EventWatcher<CoinFrameEventMarketData> | undefined {
        for (const watcher of watchers) {
            if (watcher.getEventId() === this._eventId) {
                return watcher;
            }
        } 
        return undefined;
    }

    /**
     * Finds the order books watcher for our event id among the given watchers.
     */
    private findMyMarketOrderBookWatcher(watchers: readonly EventWatcher<CoinFrameEventMarketData>[]): MarketOrderBooksWatcher | undefined {
        const watcher = this.findMyEventWatcher(watchers);
        if (!watcher) return undefined;
        return watcher.getEventMarketOrderBooksWatcher()[0];
    }

    /**
     * Retrieves the start and end time of the current frame from the watchers' history.
     */
    private getFrameTimes(watchers: readonly EventWatcher<CoinFrameEventMarketData>[]): { start: number; end: number } | undefined {
        const watcher = this.findMyEventWatcher(watchers);
        if (!watcher) return undefined;

        const history = this._side === 'up' ? watcher.getWatcherHistoryUp() : watcher.getWatcherHistoryDown();
        const coin_market_history = history ? history[0]: undefined;
        if (!coin_market_history) return undefined;

        return { start: coin_market_history!.start_time, end: coin_market_history!.end_time };
    }

    /**
     * Checks whether the current time is past the end-of-interval threshold.
     */
    private isEndOfFrame(currentTime: number): boolean {
        if (this._frameEndTime === undefined) return false;
        return currentTime >= this._frameEndTime * this._END_INTERVAL_FACTOR;
    }

    /**
     * Checks whether the current time is past the half-interval mark.
     */
    private isHalfOfFrame(currentTime: number): boolean {
        if (this._frameStartTime === undefined || this._frameEndTime === undefined) return false;
        const halfTime = this._frameStartTime + (this._frameEndTime - this._frameStartTime) / 2;
        return currentTime >= halfTime;
    }

    /**
     * Queries the orders watcher to see if a specific order has been fully filled.
     */
    private isOrderMatched(orderId: string | undefined): boolean {
        if (!orderId) return false;
        return this._ordersWatcher.isFullMatched(orderId);
    }
    
    /**
     * Extracts a representative price from an order book side, considering wall size.
     */
    private getPriceFromOrderBook(orders: OrderBookLevel[], fallbackPrice: number | undefined): number | undefined {
        if (orders.length === 0) {
            return fallbackPrice;
        }

        const lastIndex = orders.length - 1;
        let cumulativeSize = 0;
        for (let i = lastIndex; i > 0; i--) {
            cumulativeSize += safeToNum(orders[i]!.size);
            if (cumulativeSize > this._WALL_SIZE) {
                return safeToNum(orders[i]!.price);
            }
        }
        return safeToNum(orders[lastIndex]!.price);
    }

    /**
     * Determines whether ask, bid, or BTC price changed since last tick.
     */
    private hasPricesChanged(prices: FullPrices): boolean {
        return this._previousAsk !== prices.ask ||
               this._previousBid !== prices.bid ||
               this._previousBtcPrice !== prices.btcPrice;
    }

    /**
     * Main entry point called on each tick. Fetches market data, computes prices,
     * detects interval state, and delegates to {@link processTick}.
     *
     * @param client - CLOB client for order operations.
     * @param watchers - Active watchers (must include one for our coin).
     * @returns `true` if a tick was processed, `false` otherwise.
     */
    public async execute(client: ClobClient, watchers: readonly EventWatcher<CoinFrameEventMarketData>[]): Promise<boolean> {
        const obWatcher = this.findMyMarketOrderBookWatcher(watchers);
        if (!obWatcher) {
            return false;
        }

        if (this._frameStartTime === undefined || this._frameEndTime === undefined) {
            const times = this.getFrameTimes(watchers);
            if (times) {
                this._frameStartTime = times.start;
                this._frameEndTime = times.end;
            }
        }

        const sideMarketData = (this._side === 'up') ? obWatcher.getUpMarketData() : obWatcher.getDownMarketData();
        if (!this._tokenId) {
            this._tokenId = sideMarketData.tokenId;
        }
        const marketData = obWatcher.getMarketData();
        // In real time update because of value update events
        this._tickSize = marketData.tick_size;
        this._minOrderSize = marketData.min_order_size;


        const currentBtcPrice = this._btcPriceWatcher?.getCurrentPrice();
        if (this._btcPriceWatcher && currentBtcPrice === undefined) return false;

        let bids: OrderBookLevel[] = [];
        let asks: OrderBookLevel[] = [];
        let fallbackTokenPrice: number | undefined;

        if (this._side === 'up') {
            bids = obWatcher.getBidsUp();
            asks = obWatcher.getAsksUp();
            fallbackTokenPrice = obWatcher.getUpPrice();
        } else {
            bids = obWatcher.getBidsDown();
            asks = obWatcher.getAsksDown();
            fallbackTokenPrice = obWatcher.getDownPrice();
        }

        const ask = this.getPriceFromOrderBook(asks, fallbackTokenPrice);
        const bid = this.getPriceFromOrderBook(bids, fallbackTokenPrice);
        if (ask === undefined || bid === undefined) return false;

        const prices: FullPrices = {
            ask,
            bid,
            askUnderWall: ask - this._PRICE_TOLERANCE,
            bidOverWall: bid + this._PRICE_TOLERANCE,
            btcPrice: currentBtcPrice ?? 0
        };

        if (!this.hasPricesChanged(prices)) {
            return false;
        }

        const currentTime = Date.now() / 1000;
        const isEndPeriod = this.isEndOfFrame(currentTime);
        const isHalfPeriod = this.isHalfOfFrame(currentTime);

        logger.info(`[${this._eventId}] ${this._side.toUpperCase()} tick: ask=${prices.ask} bid=${prices.bid} btc=${prices.btcPrice} endPeriod=${isEndPeriod}`);
        await this.processTick(client, prices, isEndPeriod, isHalfPeriod);

        this._previousAsk = prices.ask;
        this._previousBid = prices.bid;
        this._previousBtcPrice = prices.btcPrice;

        return true;
    }

    /**
     * Computes the quantity for a sell limit order based on current position and profit target.
     *
     * @returns The sell quantity, or 0 if position is too small.
     */
    private calculateSellQuantity(): number {
        if (this._positionSize < this._minOrderSize) {
            return 0;
        }
        const targetProfitReached = (this._balance + this._currentSellOrder.price * this._positionSize) > (this._initialBalance + this._TARGET_PROFIT);
        if (targetProfitReached) {
            return valid_quantity_unsafe(this._positionSize, this._minOrderSize, this._tickSize, Side.SELL);
        } else {
            // const rawQuantity = Math.min(Math.max(this._positionSize / 2, 1.0), this._positionSize);
            const positionHalf = this._positionSize / 2;
            const rawQuantity = (positionHalf < this._minOrderSize)? this._positionSize: positionHalf;

            return valid_quantity_unsafe(rawQuantity, this._minOrderSize, this._tickSize, Side.SELL);
        }
    }

    /**
     * Computes the quantity for a buy limit order, taking into account blocking conditions
     * (end of period, spread, position size, profit reached) and minimum order size.
     *
     * @param ask - Current ask price (for spread check).
     * @param isEndPeriod - Whether we are past the end-of-interval threshold.
     * @returns The buy quantity, or 0 if buying is blocked.
     */
    private calculateBuyQuantity(ask: number, isEndPeriod: boolean): number {
        const positionTooLarge = this._positionSize > this._MAX_POSITION_SIZE;
        const spreadTooSmall = (ask - this._currentBuyOrder.price) < this._MIN_SPREAD;
        const profitReached = this._balance >= this._initialBalance + this._TARGET_PROFIT;

        if (isEndPeriod || positionTooLarge || spreadTooSmall || profitReached) return 0;

        const rawQuantity = this._MIN_BUY_VALUE_USDC / this._currentBuyOrder.price;
        const minQuantity = this._minOrderSize;
        return valid_quantity_safe(rawQuantity, minQuantity, this._tickSize, Side.BUY);
    }

    /**
     * Processes a single tick: delegates to the appropriate handler based on internal state.
     */
    private async processTick(client: ClobClient, prices: FullPrices, isEndPeriod: boolean, isHalfPeriod: boolean): Promise<void> {
        if (this._firstTick) {
            await this.initializeFirstTick(client, prices);
            return;
        }

        if (this._buyAndSellMax) {
            this.buyAndSellAllHandler(client);

            await this.handleSellExecution(client, prices, isEndPeriod);
            await this.handleMarketSell(client, prices, isEndPeriod);
            await this.adjustOrdersByBtcImpulse(client, prices, isEndPeriod)
            return;
        }

        await this.handleSellExecution(client, prices, isEndPeriod);
        await this.handleBuyExecution(client, prices, isEndPeriod);
        
        await this.handleMarketSell(client, prices, isEndPeriod);
        
        this._buyAndSellMax = await this.handleMarketBuy(client, prices, isHalfPeriod);
        if (this._buyAndSellMax) return;
        
        await this.adjustOrdersByBtcImpulse(client, prices, isEndPeriod);
    }

    /**
     * Places the first buy order of the frame, ignoring any restrictions except minimum order size.
     */
    private async initializeFirstTick(client: ClobClient, prices: FullPrices): Promise<void> {
        await this.cancelBuyOrder(client);

        this._currentBuyOrder.price = tick_price(Math.min(prices.bidOverWall * 0.9, prices.askUnderWall * 0.8), this._tickSize, Side.BUY);
        this._currentBuyOrder.quantity = valid_quantity_unsafe(this._MIN_BUY_VALUE_USDC / this._currentBuyOrder.price, this._minOrderSize, this._tickSize, Side.BUY);
        this._buyOrderId = await this.placeBuyOrder(client, this._currentBuyOrder.price, this._currentBuyOrder.quantity);

        this._firstTick = false;
    }

    /**
     * Handles the special forced market buy (half-interval, no position, favorable trend).
     * Places a buy limit order and activates the `_buyAndSellMax` mode.
     *
     * @returns `true` if the mode was activated.
     */
    private async handleMarketBuy(client: ClobClient, prices: FullPrices, isHalfPeriod: boolean): Promise<boolean> {
        if (this._previousAsk === undefined) return false;

        const noPosition = (this._balance === this._initialBalance) && (this._positionSize === 0);
        const positiveTrend = this._previousAsk > prices.ask;
        const priceCondition = prices.ask > 0.77 && prices.bid < 0.6;

        if (isHalfPeriod && noPosition && positiveTrend && priceCondition) {
            await this.cancelBuyOrder(client);
            await this.cancelSellOrder(client);

            this._currentBuyOrder.price = tick_price(prices.bidOverWall, this._tickSize, Side.BUY);
            this._currentBuyOrder.quantity = valid_quantity_unsafe(this._MIN_BUY_VALUE_USDC / this._currentBuyOrder.price, this._minOrderSize, this._tickSize, Side.BUY);
            this._buyOrderId = await this.placeBuyOrder(client, this._currentBuyOrder.price, this._currentBuyOrder.quantity);
            
            return true;
        }
        return false;
    }

    /**
     * Called when `_buyAndSellMax` is active and the special buy order has been filled.
     * Places a sell limit order for the entire position.
     */
    private async buyAndSellAllHandler(client: ClobClient): Promise<void> {
        if (!this._buyAndSellMax) return;
        
        const orderTriggered = this.isOrderMatched(this._buyOrderId);

        if (!orderTriggered || this._currentBuyOrder.quantity <= 0) return

        // Execution of current buy order
        this._balance -= this._currentBuyOrder.price * this._currentBuyOrder.quantity;
        this._positionSize += this._currentBuyOrder.quantity;

        this._currentSellOrder.price = tick_price(0.90, this._tickSize, Side.SELL);
        this._currentSellOrder.quantity = this._positionSize > 0 ? this._positionSize : 0;
        this._sellOrderId = await this.placeSellOrder(client, this._currentSellOrder.price, this._currentSellOrder.quantity);

        // Only sell all
        this._buyOrderId = undefined;
        this._buyAndSellMax = false;
    }


    /**
     * Handles the execution of a sell limit order after it has been matched.
     * Updates balance and position size, then places new buy and sell orders.
     */
    private async handleSellExecution(client: ClobClient, prices: FullPrices, isEndPeriod: boolean): Promise<void> {
        if (this._previousAsk === undefined) return;

        // CHECK ORDER STATUS BY ORDER WATCHER
        const orderTriggered = this.isOrderMatched(this._sellOrderId);

        if (!orderTriggered || this._positionSize <= 0 || this._currentSellOrder.quantity === 0) return;

        // Updaitng out local data after order execution,
        this._positionSize -= this._currentSellOrder.quantity;
        this._balance += this._currentSellOrder.price * this._currentSellOrder.quantity;

        if (this._positionSize === 0) {
            this._maxBuyPrice = 0;
        }

        await this.cancelBuyOrder(client);
        await this.cancelSellOrder(client);

        // this._currentBuyOrder.quantity = valid_quantity_unsafe(this._MIN_BUY_VALUE / this._currentBuyOrder.price, this._minOrderSize);

        // New buy order
        this._currentBuyOrder.price = tick_price(Math.min(this._currentSellOrder.price * 0.8, prices.bidOverWall, 0.6), this._tickSize, Side.BUY);
        this._currentBuyOrder.quantity = this.calculateBuyQuantity(prices.ask, isEndPeriod);
        this._buyOrderId = await this.placeBuyOrder(client, this._currentBuyOrder.price, this._currentBuyOrder.quantity);

        // New sell order
        this._currentSellOrder.price = tick_price(prices.ask * 1.1, this._tickSize, Side.SELL);
        this._currentSellOrder.quantity = this.calculateSellQuantity();
        this._sellOrderId = await this.placeSellOrder(client, this._currentSellOrder.price, this._currentSellOrder.quantity);
    }

    /**
     * Handles the execution of a buy limit order after it has been matched.
     * Updates balance and position size, then places new sell and buy orders.
     */
    private async handleBuyExecution(client: ClobClient, prices: FullPrices, isEndPeriod: boolean): Promise<void> {
        if (this._previousBid === undefined) return;

        // CHECK ORDER STATUS BY ORDER WATCHER
        const orderTriggered = this.isOrderMatched(this._buyOrderId);

        if (!orderTriggered || this._currentBuyOrder.quantity <= 0) return;

        // Execution of current buy order
        this._balance -= this._currentBuyOrder.price * this._currentBuyOrder.quantity;
        this._positionSize += this._currentBuyOrder.quantity;

        if (this._maxBuyPrice < this._currentBuyOrder.price) {
            this._maxBuyPrice = this._currentBuyOrder.price;
        }

        await this.cancelBuyOrder(client);
        await this.cancelSellOrder(client);

        // Place sell order
        this._currentSellOrder.price = tick_price(Math.max(this._currentBuyOrder.price * 1.20, 
                                                        Math.min(prices.askUnderWall, this._currentBuyOrder.price * 1.4)),
                                                                this._tickSize, Side.SELL);
        if (this._positionSize > this._MAX_POSITION_SIZE) {
            this._currentSellOrder.price = tick_price(Math.min(this._currentBuyOrder.price * 1.20, prices.askUnderWall), this._tickSize, Side.SELL);
        }

        const targetProfitReached = (this._balance + this._currentSellOrder.price * this._positionSize) > (this._initialBalance + this._TARGET_PROFIT);
        if (targetProfitReached || this._positionSize > this._MAX_POSITION_SIZE || this._maxBuyPrice < this._currentSellOrder.price) {
            this._currentSellOrder.quantity = valid_quantity_unsafe(this._positionSize, this._minOrderSize, this._tickSize, Side.SELL);
        } else {
            // this._currentSellOrder.quantity = valid_quantity_unsafe(Math.min(Math.max(this._positionSize / 2, 1.0), this._positionSize), this._minOrderSize, this._tickSize, Side.SELL);  // CHECK - UNSAFE Math.max(this._positionSize / 2, 1.0)
            // Code like in calculate sell quantity function:
            const positionHalf = this._positionSize / 2;
            const rawQuantity = (positionHalf < this._minOrderSize)? this._positionSize: positionHalf;
            // I have - this._positionSize += this._currentBuyOrder.quantity; so this._currentBuyOrder.quantity can not be less than this._minOrderSize
            this._currentSellOrder.quantity = valid_quantity_unsafe(rawQuantity, this._minOrderSize, this._tickSize, Side.SELL);
        }

        this._sellOrderId = await this.placeSellOrder(client, this._currentSellOrder.price, this._currentSellOrder.quantity);

        // Place new buy order
        this._currentBuyOrder.price = tick_price(prices.bidOverWall * 0.8, this._tickSize, Side.BUY);
        this._currentBuyOrder.quantity = this.calculateBuyQuantity(prices.ask, isEndPeriod);
        this._buyOrderId = await this.placeBuyOrder(client, this._currentBuyOrder.price, this._currentBuyOrder.quantity);
    }


    /**
     * Checks conditions for forced market sell (end of period, profit, favorable price).
     * If triggered, cancels open orders and executes a FAK taker order to sell the full position,
     * then optionally places a new buy order.
     */
    private async handleMarketSell(client: ClobClient, prices: FullPrices, isEndPeriod: boolean): Promise<void> {
        if (this._positionSize <= 0 || this._previousAsk === undefined || this._previousBid === undefined) return;

        const endPeriodCondition = isEndPeriod &&
            this._previousBid > prices.bid &&
            prices.ask > 0.1 &&
            (this._previousAsk - prices.ask) >= (this._previousBid - prices.bid) &&
            prices.ask < prices.bid * 2;

        const profitCondition = (this._balance + prices.bid * this._positionSize) > (this._initialBalance + this._TARGET_PROFIT);
        const favorableCondition = this._maxBuyPrice > 0 &&
            prices.bid >= 0.5 &&
            (this._maxBuyPrice + this._MARKET_SELL_MARGIN) < prices.bid;

        if (endPeriodCondition || profitCondition || favorableCondition) {
            await this.cancelBuyOrder(client);
            await this.cancelSellOrder(client);

            const result = await placeFakTakerOrder(
                client,
                this._tokenId!,
                Side.SELL,
                this._positionSize, // CHECK TICK AND MIN ORDER SIZE
                prices.bid
            );
            const soldSize = result.execSize ?? 0;
            const avgPrice = result.averagePrice ?? prices.bid;
            this._balance += avgPrice * soldSize;
            logger.info(`[${this._eventId}] MARKET SELL: quantity=${soldSize} avg_price=${avgPrice}`);

            this._positionSize = 0;
            this._maxBuyPrice = 0;
            this._buyAndSellMax = false;   // CHECK

            this._currentBuyOrder.price = tick_price(prices.bidOverWall * 0.8, this._tickSize, Side.BUY);
            // this._currentBuyOrder.quantity = valid_quantity_unsafe(this._MIN_BUY_VALUE_USDC / this._currentBuyOrder.price, this._minOrderSize);
            this._currentBuyOrder.quantity = this.calculateBuyQuantity(prices.ask, isEndPeriod);

            this._buyOrderId = await this.placeBuyOrder(client, this._currentBuyOrder.price, this._currentBuyOrder.quantity);
        }
    }


    /**
     * Adjusts buy and sell orders based on a significant BTC price impulse.
     */
    private async adjustOrdersByBtcImpulse(client: ClobClient, prices: FullPrices, isEndPeriod: boolean): Promise<void> {
        if (this._previousBtcPrice === undefined) return;

        const btcDelta = prices.btcPrice - this._previousBtcPrice;
        const absDelta = Math.abs(btcDelta);
        if (absDelta <= this._BTC_IMPULSE_THRESHOLD) return;

        const isUpImpulse = btcDelta > 0;
        const isDownImpulse = btcDelta < 0;

        if (this._side === 'down') {
            if (isDownImpulse) {
                await this.adjustForBtcDownImpulse(client, prices, isEndPeriod);
            } else if (isUpImpulse) {
                await this.adjustForBtcUpImpulse(client, prices, isEndPeriod);
            }
        } else { // side === 'up'
            if (isUpImpulse) {
                await this.adjustForBtcDownImpulse(client, prices, isEndPeriod);
            } else if (isDownImpulse) {
                await this.adjustForBtcUpImpulse(client, prices, isEndPeriod);
            }
        }
    }

    /**
     * BTC down impulse correction: raises sell price, adjusts buy price upward.
     */
    private async adjustForBtcDownImpulse(client: ClobClient, prices: FullPrices, isEndPeriod: boolean): Promise<void> {
        const newSellPrice = tick_price(Math.max(Math.min(prices.askUnderWall * 1.1, prices.bidOverWall * 1.2), this._currentSellOrder.price, 0.1), this._tickSize, Side.SELL);
        
        if (newSellPrice !== this._currentSellOrder.price) {
            await this.cancelSellOrder(client);

            this._currentSellOrder.price = tick_price(newSellPrice, this._tickSize, Side.SELL);
            this._currentSellOrder.quantity = this.calculateSellQuantity();
            this._sellOrderId = await this.placeSellOrder(client, this._currentSellOrder.price, this._currentSellOrder.quantity);
        }

        const newBuyPrice = tick_price(Math.min(Math.max(this._currentBuyOrder.price * 1.05, prices.bidOverWall), prices.bidOverWall), this._tickSize, Side.BUY);

        if (newBuyPrice !== this._currentBuyOrder.price) {
            await this.cancelBuyOrder(client);

            this._currentBuyOrder.price = tick_price(newBuyPrice, this._tickSize, Side.BUY);
            this._currentBuyOrder.quantity = this.calculateBuyQuantity(prices.ask, isEndPeriod);
            //this._currentBuyOrder.quantity = valid_quantity_unsafe(this._MIN_BUY_VALUE_USDC / newBuyPrice, this._minOrderSize, this._tickSize, Side.BUY);
            this._buyOrderId = await this.placeBuyOrder(client, this._currentBuyOrder.price, this._currentBuyOrder.quantity);
        }
    }


    /**
     * BTC up impulse correction: lowers buy price, adjusts sell price downward.
     */
    private async adjustForBtcUpImpulse(client: ClobClient, prices: FullPrices, isEndPeriod: boolean): Promise<void> {
        const newBuyPrice = tick_price(prices.bidOverWall * 0.9, this._tickSize, Side.BUY);

        if (newBuyPrice !== this._currentBuyOrder.price) {
            await this.cancelBuyOrder(client);

            this._currentBuyOrder.price = tick_price(newBuyPrice, this._tickSize, Side.BUY);
            this._currentBuyOrder.quantity = this.calculateBuyQuantity(prices.ask, isEndPeriod);
            
            // this._currentBuyOrder.quantity = valid_quantity_unsafe(this._MIN_BUY_VALUE_USDC / newBuyPrice, this._minOrderSize, this._tickSize, Side.BUY);
            this._buyOrderId = await this.placeBuyOrder(client, this._currentBuyOrder.price, this._currentBuyOrder.quantity);
        }

        const newSellPrice = tick_price(Math.max(Math.min(this._currentSellOrder.price * 0.95, prices.askUnderWall), prices.askUnderWall, 0.1), this._tickSize, Side.SELL);

        if (newSellPrice !== this._currentSellOrder.price) {
            await this.cancelSellOrder(client);

            this._currentSellOrder.price = tick_price(newSellPrice, this._tickSize, Side.SELL);
            this._currentSellOrder.quantity = this.calculateSellQuantity();

            this._sellOrderId = await this.placeSellOrder(client, this._currentSellOrder.price, this._currentSellOrder.quantity);
        }
    }


    /**
     * Cancels all open orders, sells remaining position at market (if any),
     * and resets the strategy state.
     *
     * @param client - CLOB client.
     * @param watchers - Watchers (used to fetch current bid for market sell).
     * @returns Always `true`.
     */
    public async cancel(client: ClobClient, watchers: readonly EventWatcher<CoinFrameEventMarketData>[]): Promise<boolean> {
        // If there is a position and tokenId is known, sell it at market
        // Docs version: this._positionSize > this._minOrderSize
        if (this._positionSize > 0 && this._tokenId) {
            const obWatcher = this.findMyMarketOrderBookWatcher(watchers);
            let currentBid: number | undefined;

            if (obWatcher) {
                const bids = this._side === 'up'
                    ? obWatcher.getBidsUp() 
                    : obWatcher.getBidsDown();
                // Get bid price from order book WITHOUT fallback – returns undefined if book is empty
                currentBid = this.getPriceFromOrderBook(bids, undefined);
            }

            // If no valid bid price, use minimum price (0.01) to guarantee exit
            const sellPrice = tick_price((currentBid !== undefined && currentBid > 0) ? currentBid : this._tickSize, this._tickSize, Side.SELL);
            if (sellPrice === this._tickSize) {
                logger.warn(`[${this._eventId}] CANCEL: No valid bid in order book, selling at minimum price ${sellPrice} to exit position.`);
            }

            try {
                const result = await placeFakTakerOrder(
                    client,
                    this._tokenId,
                    Side.SELL,
                    this._positionSize, // Position size will always be > min order size
                    sellPrice
                );
                const soldSize = result.execSize ?? 0;
                const avgPrice = result.averagePrice ?? sellPrice;
                this._balance += avgPrice * soldSize;
                logger.info(`[${this._eventId}] CANCEL: Sold remaining position. size=${soldSize} avgPrice=${avgPrice}`);
            } catch (e) {
                logger.error(`[${this._eventId}] CANCEL: Failed to sell position: ${error_str(e)}`);
            }
        }

        // Final equity after sale (if any)
        const equity = this._balance;
        const profit = equity - this._initialBalance;

        logger.info(`[${this._eventId}] Strategy cancelled. Final balance: ${this._balance}, equity: ${equity}, profit: ${profit}`);

        // Cancel all remaining limit orders for the token
        if (this._tokenId) {
            try {
                await cancelAllOrdersForToken(client, this._tokenId);
                logger.info(`[${this._eventId}] Cancelled all orders for token ${this._tokenId}`);
            } catch (e) {
                logger.error(`[${this._eventId}] Failed to cancel all orders: ${error_str(e)}`);
            }
        }
        this._buyOrderId = undefined;
        this._sellOrderId = undefined;

        // Reset state
        this._positionSize = 0;
        this._currentBuyOrder = { price: 0, quantity: 0 };
        this._currentSellOrder = { price: 0, quantity: 0 };
        this._maxBuyPrice = 0;
        this._firstTick = true;
        this._previousAsk = undefined;
        this._previousBid = undefined;
        this._previousBtcPrice = undefined;
        this._frameStartTime = undefined;
        this._frameEndTime = undefined;

        return true;
    }

    /**
     * Places a maker buy order and returns its exchange ID.
     *
     * @returns The order ID, or `undefined` if quantity is ≤0.
     */
    private async placeBuyOrder(client: ClobClient, price: number, quantity: number): Promise<string | undefined> {
        if (quantity <= 0) return undefined;
        const result = await placeMakerOrder(client, this._tokenId!, Side.BUY, price, quantity);
        logger.info(`[${this._eventId}] PLACED BUY LIMIT: price=${price} quantity=${quantity} id=${result.id}`);
        return result.id;
    }

    /**
     * Places a maker sell order and returns its exchange ID.
     *
     * @returns The order ID, or `undefined` if quantity is ≤0.
     */
    private async placeSellOrder(client: ClobClient, price: number, quantity: number): Promise<string | undefined> {
        if (quantity <= 0) return undefined;
        const result = await placeMakerOrder(client, this._tokenId!, Side.SELL, price, quantity);
        logger.info(`[${this._eventId}] PLACED SELL LIMIT: price=${price} quantity=${quantity} id=${result.id}`);
        return result.id;
    }

    /**
     * Cancels the current buy order and clears its ID.
     */
    private async cancelBuyOrder(client: ClobClient): Promise<void> {
        if (this._buyOrderId) {
            try {
                await cancelOrder(client, this._buyOrderId);
                logger.info(`[${this._eventId}] Cancelled buy order ${this._buyOrderId}`);
            } catch (e) {
                logger.warn(`[${this._eventId}] Failed to cancel buy order ${this._buyOrderId}: ${error_str(e)}`);
            }
            this._buyOrderId = undefined;
        }
    }

    /**
     * Cancels the current sell order and clears its ID.
     */
    private async cancelSellOrder(client: ClobClient): Promise<void> {
        if (this._sellOrderId) {
            try {
                await cancelOrder(client, this._sellOrderId);
                logger.info(`[${this._eventId}] Cancelled sell order ${this._sellOrderId}`);
            } catch (e) {
                logger.warn(`[${this._eventId}] Failed to cancel sell order ${this._sellOrderId}: ${error_str(e)}`);
            }
            this._sellOrderId = undefined;
        }
    }
}