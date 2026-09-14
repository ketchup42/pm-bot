import { ClobClient, Side } from "@polymarket/clob-client-v2";
import { EventStrategy } from "./EventStrategy.js";
import { CoinFrameEventMarketData } from "../../history/coin_frame.js";
import { EventWatcher } from "../EventWatcher.js";
import { logger } from "../../../../log.js";
import { error_str, safeFloat } from "../../../../utils.js";
import {
    DEFAULT_BUY_ORDER_MIN_VALUE, DEFAULT_ORDER_MIN_SIZE, getUSDBalance
} from "../../../../rest/orders.js";
import { MarketOrderBooksWatcher } from "../../../../market/orderbook/watcher/MarketOrderBooksWatcher.js";
import { Coin, coin_precis } from "../../../../market/coins.js";
import { ORDER_WALLET_FRACTION, OrderWalletState } from "../../../../market/orders/OrderWallet.js";
import { LiveOrdersWatcherRTDS } from "../../../../market/orders/watcher/LiveOrdersWatcherRTDS.js";
import { LiveOrderWallet } from "../../../../market/orders/LiveOrderWallet.js";
import { CoinPriceWatcher } from "../../../../market/price/CoinPriceWatcher.js";
import { PriceWatcherFactory } from "../../../../market/price/PriceWatcherFactory.js";
import { PS_CHAINLINK_TWAP_60 } from "../../../../market/price/price_source.js";
import { TIMER_FAST } from "../../../../timer.js";

/** Start/end timestamps of the current trading frame (in seconds). */
interface FrameTime { startTime: number; endTime: number; }

export class CoinLiquidityMakerStrategy implements EventStrategy<CoinFrameEventMarketData> {
    private readonly _eventId: string;
    private readonly _coin: Coin;
    private readonly _coinPriceWatcher: CoinPriceWatcher;

    // ====================== STRATEGY PARAMETERS ========================
    private _INITIAL_BALANCE: number = 0;                             /** Total USDC needed for both up + down orders (2 × order size × price). */
    private _BUY_POSITION_PRICE: number = 0.5;                        /** Fixed maker limit price for initial buys. Must be within `rewards_max_spread` and tick‑aligned. */
    private _BUY_POSITION_SIZE: number = 0;                            /** Order size in outcome tokens. Computed from `rewards_min_size × _REWARD_SIZE_FACTOR`, rounded up to `min_order_size`. */
    private readonly _REWARD_SIZE_FACTOR: number = 0.1;               /** Multiplier for `rewards_min_size` to compute actual order size. Use 1.0 for exactly the minimum, or larger (e.g., 1.5) to increase size (and potential rewards). */
    private readonly _START_INTERVAL_FACTOR: number = 0.02;           /** Fraction of the frame duration at which we consider we are start. */
    private readonly _END_INTERVAL_FACTOR: number = 0.7;              /** Fraction of the frame duration at which we consider we are at the end. */
    /** Coin price deviation from the event start price required to begin normal trading. */
    private readonly _PRICE_DEVIATION_TRADING_START: number = 0.00003;
    private readonly _COIN_PRICE_HISTORY_LENGTH: number = 25;         /** Minimum coin price history length to start check trading conditions. */
    private readonly _REWARDS_SPREAD_IS_PERCENT: boolean = false;
    // ===================================================================

    // ========================= TRADING STATE ===========================
    private _upBuyOrder: OrderWalletState | undefined = undefined;
    private _downBuyOrder: OrderWalletState | undefined = undefined;
    private _isVeryFirstInitBuy = true;

    private _walletUp: LiveOrderWallet | undefined = undefined;
    private _walletDown: LiveOrderWallet | undefined = undefined;

    private _event: EventWatcher<CoinFrameEventMarketData> | undefined = undefined;
    private _market: MarketOrderBooksWatcher | undefined = undefined;

    /** Timing boundaries of the current frame. */
    private _frameTime: FrameTime | undefined = undefined;
    private _isEndPeriod: boolean = false;

    private _coinPricesBuffer: number[] = [];
    private _bufferIndex: number = 0;
    private _bufferFilled: boolean = false;

    private _isTradingStarted = false;
    // ================================================================

    private constructor(eventId: string, coin: Coin) {
        this._eventId = eventId;
        this._coin = coin;
        this._coinPriceWatcher = PriceWatcherFactory.getCoinWatcher(coin, PS_CHAINLINK_TWAP_60);
    }

    public static async create(eventId: string, coin: Coin): Promise<CoinLiquidityMakerStrategy> {
        PriceWatcherFactory.getCoinWatcher(coin, PS_CHAINLINK_TWAP_60).warmUp(TIMER_FAST);
        return new CoinLiquidityMakerStrategy(eventId, coin);
    }

    // ---------------------------- LOGGING ----------------------------
    private log(msg: string): void {
        logger.info(`[CoinLiquidityMakerStrategy][${this._eventId}][${this._coin}] ${msg}`);
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
        const history = watcher.getWatcherHistoryUp();
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

    private getOrderState(wallet: LiveOrderWallet, order: OrderWalletState | undefined): string {
        if (!order) return "-UNSET-";
        if (wallet.hasCanceled(order.id)) return "-CANCELED-";
        if (wallet.isPartialFilled(order.id)) return "-PARTIAL-MATCHED-";
        if (wallet.isFullFilled(order.id)) return "-MATCHED-";
        if (wallet.isLive(order.id)) return "-LIVE-";
        return "-UNKNOWN-";
    }

    private _getBufferAsArray(): number[] {
        if (!this._bufferFilled) {
            return this._coinPricesBuffer.slice(0, this._bufferIndex);
        }
        return [
            ...this._coinPricesBuffer.slice(this._bufferIndex),
            ...this._coinPricesBuffer.slice(0, this._bufferIndex)
        ];
    }

    /**
     * Trading starts if the price stays within ±threshold% of the starting price.
     * (i.e., the deviation in either direction does not exceed the threshold)
     */
    private isTradingStartCondition(): boolean {
        const fraction = coin_precis(this._coin);
        const prices = this._getBufferAsArray();
        if (prices.length === 0) return false;

        const sum = prices.reduce((a, b) => a + b, 0);
        const averagePrice = safeFloat(sum / prices.length, fraction);

        const eventStartPrice = this._event?.getWatcherHistoryUp()[0]?.coin_frame_start_price;
        if (!eventStartPrice) return false;

        const deviation = Math.abs(percentChange(averagePrice, eventStartPrice));

        return deviation <= this._PRICE_DEVIATION_TRADING_START;
    }

    private initSizesFromRewards(): boolean {
        const marketData = this._market?.getMarketData();
        const rewardsMinSize = marketData?.rewards_min_size;
        if (!rewardsMinSize || rewardsMinSize <= 0) {
            this.log(`rewards_min_size not available or invalid (${rewardsMinSize}), exiting..`);
            return false;
        }
        const minOrderSize = marketData.min_order_size ?? DEFAULT_ORDER_MIN_SIZE;
        let rawSize = rewardsMinSize * this._REWARD_SIZE_FACTOR;
        this._BUY_POSITION_SIZE = safeFloat(
            Math.ceil(rawSize / minOrderSize) * minOrderSize,
            ORDER_WALLET_FRACTION
        );
        this._INITIAL_BALANCE = safeFloat(2 * (this._BUY_POSITION_SIZE * this._BUY_POSITION_PRICE), ORDER_WALLET_FRACTION);
        
        this.log(`Sizes initialized: rewards_min_size=${rewardsMinSize}, factor=${this._REWARD_SIZE_FACTOR} -> order_size=${this._BUY_POSITION_SIZE}, initial_balance=${this._INITIAL_BALANCE}`);
        return true;
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
            if (!this.initSizesFromRewards()) {
                this.log(`Failed to initialize sizes from rewards, aborting.`);
                return false;
            }
        }

        const usdBalance = await getUSDBalance(client);
        if (usdBalance < this._INITIAL_BALANCE) {
            this.log(`Insufficient balance: ${usdBalance} < ${this._INITIAL_BALANCE}`);
            return false;
        }

        // Race condition fix code
        if (!this._market) {
            this.log(`Market watcher lost after balance check, re-initializing...`);
            this._market = this.findMyMarketOrderBookWatcher(watchers);
            if (!this._market) return false;
            if (!this.initSizesFromRewards()) {
                this.log(`Failed to re-initialize sizes.`);
                return false;
            }
        }

        if (!this._frameTime) {
            const timing = this.getFrameTimes(watchers);
            if (timing) this._frameTime = timing;
        }

        const marketData = this._market.getMarketData();
        const sideMarketDataUp = this._market.getUpMarketData();

        if (!this._walletUp) {
            try {
                this._walletUp = await LiveOrderWallet.create(client,
                {
                    token_id: sideMarketDataUp.tokenId,
                    balance: safeFloat(this._INITIAL_BALANCE / 2, ORDER_WALLET_FRACTION),
                    tick_size: marketData.tick_size,
                    min_order_size: marketData.min_order_size,
                    min_buy_order_value: DEFAULT_BUY_ORDER_MIN_VALUE,
                    fees_enabled: marketData.fees_enabled,
                    taker_base_fee: marketData.taker_base_fee,
                },
                await LiveOrdersWatcherRTDS.create(marketData.conditionId, client, client!.creds));

                this.log(`Up wallet created, token=${this._walletUp.getTokenId()}, balance=${this._walletUp.getBalance()}, tick_size=${this._walletUp.getTick()}, ...`);
            } catch (error) {
                logger.error(`[CoinLiquidityMakerStrategy][${this._eventId}][${this._coin}] Up wallet creation failed: ${error_str(error)}`);
                return false;
            }
        }

        const sideMarketDataDown = this._market.getDownMarketData();

        if (!this._walletDown) {
            try {
                this._walletDown = await LiveOrderWallet.create(client,
                {
                    token_id: sideMarketDataDown.tokenId,
                    balance: safeFloat(this._INITIAL_BALANCE / 2, ORDER_WALLET_FRACTION),
                    tick_size: marketData.tick_size,
                    min_order_size: marketData.min_order_size,
                    min_buy_order_value: DEFAULT_BUY_ORDER_MIN_VALUE,
                    fees_enabled: marketData.fees_enabled,
                    taker_base_fee: marketData.taker_base_fee,
                },
                await LiveOrdersWatcherRTDS.create(marketData.conditionId, client, client!.creds));

                this.log(`Down wallet created, token=${this._walletDown.getTokenId()}, balance=${this._walletDown.getBalance()}, tick_size=${this._walletDown.getTick()}, ...`);
            } catch (error) {
                logger.error(`[CoinLiquidityMakerStrategy][${this._eventId}] Down wallet creation failed: ${error_str(error)}`);
                return false;
            }
        }

        const nowSeconds = Date.now() / 1000;
        this._isEndPeriod = this.isEndOfFrame(nowSeconds);
        if (this._isEndPeriod) {
            this.log(`Frame end period reached, skipping all trading activity.`);
            return false;
        }

        const currentCoinPrice = this._coinPriceWatcher.getCurrentPrice();

        // ---------- Pre‑trading: accumulate prices until conditions are met ----------
        if (!this._isTradingStarted) {
            if (currentCoinPrice !== undefined) {
                this._coinPricesBuffer[this._bufferIndex] = currentCoinPrice;
                this._bufferIndex = (this._bufferIndex + 1) % this._COIN_PRICE_HISTORY_LENGTH;
                if (!this._bufferFilled && this._bufferIndex === 0) {
                    this._bufferFilled = true;
                    this.log(`Price buffer filled with ${this._COIN_PRICE_HISTORY_LENGTH} elements.`);
                }
            }

            if (!this.isStartOfTick(nowSeconds)) {
                return false;
            }

            if (!this._bufferFilled) {
                this.log(`Waiting for buffer to fill: ${this._bufferIndex}/${this._COIN_PRICE_HISTORY_LENGTH}`);
                return false;
            }

            const isTradingStartCondition = this.isTradingStartCondition();

            if (isTradingStartCondition) {
                this._isTradingStarted = true;
                this.log(`Trading started.`);
            } else {
                this.log(`Start conditions not met yet.`);
                return false;
            }
        }
        if (!this.isStartOfTick(nowSeconds)) return false;

        this.log(`Tick: buy_order_up=${this.getOrderState(this._walletUp, this._upBuyOrder)} buy_order_down=${this.getOrderState(this._walletDown, this._downBuyOrder)} balance_up=${this._walletUp.getBalance()} tokens_up=${this._walletUp.getTokensQuantity()} balance_down=${this._walletDown.getBalance()} tokens_down=${this._walletDown.getTokensQuantity()}`);
        await this.master_tick();
        return true;
    }

    // ---------------------------- TICK PROCESSING ----------------------------
    private async master_tick(): Promise<void> {
        if (!this._isTradingStarted) return;
        await this.initialBuyTick();
    }

    /**
     * First tick: place the initial buy order unconditionally (only if not in end period).
     */
    private async initialBuyTick(): Promise<void> {
        if (!this._walletUp || !this._walletDown) return;
        if (!this._isVeryFirstInitBuy) return;
        if (this._isEndPeriod) {
            this.log(`End period reached, skipping order placement.`);
            return;
        }

        const marketData = this._market?.getMarketData();
        if (!marketData) {
            this.log(`Market data not available, delaying`);
            return;
        }
        const targetPrice = this._BUY_POSITION_PRICE;
        const buyQty = this._BUY_POSITION_SIZE;

        const orderBook = this._event?.getMarketOrderBooksWatchers()[0];
        if (!orderBook) {
            this.log(`Order book not available, delaying order placement`);
            return;
        }

        const upAsk = orderBook.getBestAsk('up');
        const downAsk = orderBook.getBestAsk('down');
        const upBid = orderBook.getBestBid('up');
        const downBid = orderBook.getBestBid('down');

        const canPlaceUp = upAsk !== undefined && upAsk > targetPrice && upBid !== undefined && upBid < targetPrice;
        const canPlaceDown = downAsk !== undefined && downAsk > targetPrice && downBid !== undefined && downBid < targetPrice;

        if (!canPlaceUp) {
            this.log(`Cannot place up order: current ask=${upAsk}, current bid=${upBid} target=${targetPrice} (needs maker price in spread). Waiting...`);
        }
        if (!canPlaceDown) {
            this.log(`Cannot place down order: current ask=${downAsk}, current bid=${downBid} target=${targetPrice} (needs maker price in spread). Waiting...`);
        }

        if (!canPlaceUp || !canPlaceDown) return;

        const rewardsMaxSpread = marketData.rewards_max_spread;
        if (rewardsMaxSpread !== undefined && rewardsMaxSpread > 0) {
            const upMid = (upAsk! + upBid!) / 2;
            const downMid = (downAsk! + downBid!) / 2;

            let maxAbsSpreadUp: number;
            let maxAbsSpreadDown: number;
            if (this._REWARDS_SPREAD_IS_PERCENT) {
                // percentage: convert to absolute deviation from mid
                maxAbsSpreadUp = (rewardsMaxSpread / 100) * upMid;
                maxAbsSpreadDown = (rewardsMaxSpread / 100) * downMid;
            } else {
                // absolute value in cents: convert to dollars (1 cent = 0.01)
                maxAbsSpreadUp = rewardsMaxSpread / 100;
                maxAbsSpreadDown = rewardsMaxSpread / 100;
            }

            if (Math.abs(targetPrice - upMid) > maxAbsSpreadUp || Math.abs(targetPrice - downMid) > maxAbsSpreadDown) {
                this.log(`Spread exceeds limit. Skipping.`);
                return;
            }
        }

        if (buyQty < (marketData.rewards_min_size ?? 0)) {
            this.log(`Order size ${buyQty} < rewards_min_size=${marketData.rewards_min_size}, would not earn rewards. Skipping.`);
            // return; // TODO: test balance saving for log time work
        }

        if (this._upBuyOrder && this._downBuyOrder) {
            this._isVeryFirstInitBuy = false;
            return;
        }

        if (this._upBuyOrder && !this._downBuyOrder) {
            this.log(`Inconsistent state: only up order exists. Cancelling it.`);
            await this._walletUp.cancel_order(this._upBuyOrder.id).catch(e => this.log(`Cancel up error: ${e}`));
            this._upBuyOrder = undefined;
        }

        if (this._downBuyOrder && !this._upBuyOrder) {
            this.log(`Inconsistent state: only down order exists. Cancelling it.`);
            await this._walletDown.cancel_order(this._downBuyOrder.id).catch(e => this.log(`Cancel down error: ${e}`));
            this._downBuyOrder = undefined;
        }

        const upPromise = this._walletUp.buy(targetPrice, buyQty);
        const downPromise = this._walletDown.buy(targetPrice, buyQty);
        const results = await Promise.allSettled([upPromise, downPromise]);

        const upResult = results[0];
        const downResult = results[1];

        const isUpOk = upResult.status === 'fulfilled' && upResult.value !== undefined && upResult.value !== null;
        const isDownOk = downResult.status === 'fulfilled' && downResult.value !== undefined && downResult.value !== null;

        if (isUpOk && isDownOk) {
            this._upBuyOrder = upResult.value;
            this._downBuyOrder = downResult.value;
            this.log(`Up buy order placed at ${targetPrice} (ask=${upAsk} bid=${upBid}) -> maker`);
            this.log(`Down buy order placed at ${targetPrice} (ask=${downAsk} bid=${downBid}) -> maker`);
            this._isVeryFirstInitBuy = false;
            return;
        }

        if (isUpOk) {
            this.log(`Up order succeeded but down failed. Cancelling up order.`);
            await this._walletUp.cancel_order(upResult.value!.id).catch(e => this.log(`Cancel up error: ${e}`));
        }
        if (isDownOk) {
            this.log(`Down order succeeded but up failed. Cancelling down order.`);
            await this._walletDown.cancel_order(downResult.value!.id).catch(e => this.log(`Cancel down error: ${e}`));
        }
        if (!isUpOk && !isDownOk) {
            this.log(`Both orders failed to place.`);
        }

        this._upBuyOrder = undefined;
        this._downBuyOrder = undefined;
    }

    // ---------------------------- CANCEL ----------------------------
    public async cancel(client: ClobClient, watchers: readonly EventWatcher<CoinFrameEventMarketData>[], isSignal: boolean): Promise<boolean> {
        if (this._walletUp) {
            await this._walletUp.dispose(false);
        }
        if (this._walletDown) {
            await this._walletDown.dispose(false);
        }

        const finalBalance = (this._walletUp?.getBalance() ?? 0) + (this._walletDown?.getBalance() ?? 0);
        if ((finalBalance === 0) && this._upBuyOrder && this._downBuyOrder)
            this.log(`Strategy executed success!`);
        else
            this.log(`Strategy executed unsuccess!`);

        // Reset state
        this._upBuyOrder = undefined;
        this._downBuyOrder = undefined;
        this._isVeryFirstInitBuy = true;

        this._frameTime = undefined;

        this._walletUp = undefined;
        this._walletDown = undefined;

        this._event = undefined;
        this._market = undefined;

        this._coinPricesBuffer = [];
        this._bufferIndex = 0;
        this._bufferFilled = false;

        this._isTradingStarted = false;

        return true;
    }
}

/**
 * Calculates the percentage change from a reference price to a current price.
 * @param currentPrice - The new price
 * @param referencePrice - The base price (e.g., event start price)
 * @returns Percentage change, e.g., 0.05 = 5%. Returns 0 if referencePrice is 0 or undefined.
 */
export function percentChange(currentPrice: number | undefined, referencePrice: number | undefined): number {
if (currentPrice === undefined || currentPrice === null || referencePrice === undefined || referencePrice === 0) return 0;
    return safeFloat((currentPrice - referencePrice) / referencePrice, 6);
}

/**
 * Checks if the current price is within a certain percentage of the reference price.
 * @param currentPrice - Current price
 * @param referencePrice - Reference price (e.g., frame start price)
 * @param thresholdPercent - Allowed deviation as fraction (e.g., 0.01 = 1%)
 * @returns true if |percentChange| <= thresholdPercent
 */
export function isPriceNearReference(
    currentPrice: number | undefined,
    referencePrice: number | undefined,
    thresholdPercent: number
): boolean {
    const change = percentChange(currentPrice, referencePrice);
    return Math.abs(change) <= thresholdPercent;
}
