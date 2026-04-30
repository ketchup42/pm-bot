import { ClobClient, Side } from "@polymarket/clob-client-v2";
import { OrderWallet, OrderWalletParams, OrderWalletState } from "./OrderWallet.js";
import { DEFAULT_BUY_ORDER_MIN_VALUE, cancelOrder, getUSDBalance, placeMakerOrder } from "../../rest/orders.js";
import { OrderUpdateHandler, OrdersWatcher } from "./watcher/OrdersWatcher.js";
import { tick_price, valid_quantity_unsafe } from "../../rest/orders-price.js";
import { logger } from "../../log.js";
import { error_str, safeToNum } from "../../utils.js";
import { isBidsEmpty } from "../../rest/price.js";

/**
 * Virtual wallet for a single pair of orders - one buy and one sell.
 *
 * Manages a virtual USD balance and token position, places maker orders,
 * and automatically tracks their execution via an {@link OrdersWatcher}.
 * Enforces tick size, minimum order size, and minimum buy value.
 */
export class PairOrderWallet implements OrderWallet {
    private _tokenId: string;
    private _client: ClobClient;
    private _watcher: OrdersWatcher;

    private _walletBalance: number;
    private _walletInitBalance: number;
    private _tokenQuantity: number = 0;

    private _tickSize: number;
    private _minOrderSize: number;
    private _minBuyOrderValue: number;

    private _buyOrderId: string | undefined = undefined;
    private _buyOrderState: OrderWalletState | undefined = undefined;
    private _buyLastMatchedSize: number = 0;

    private _sellOrderId: string | undefined = undefined;
    private _sellOrderState: OrderWalletState | undefined = undefined;
    private _sellLastMatchedSize = 0;

    private readonly _buyHandler: OrderUpdateHandler = (state) => {
        if (state.id !== this._buyOrderId) return;
        logger.debug(`[PairOrderWallet] buyHandler called for ${state.id}, size_matched=${state.size_matched}`);

        const newMatched = safeToNum(state.size_matched);
        const delta = newMatched - this._buyLastMatchedSize;

        if (delta > 0) {
            const price = safeToNum(state.price);
            logger.debug(`[PairOrderWallet] buyHandler delta=${delta} price=${price}, updating balance/tokens`);
            this._walletBalance -= price * delta;
            this._tokenQuantity += delta;
        }

        this._buyLastMatchedSize = newMatched;

        if (state.has_size_matched || state.has_canceled) {
            logger.debug(`[PairOrderWallet] buyHandler order ${state.id} finished (matched or canceled), resetting state`);
            this._watcher.resetUpdateHandler(state.id);
            this._buyOrderId = undefined;
            this._buyOrderState = undefined;
            this._buyLastMatchedSize = 0;
        }
    };

    private readonly _sellHandler: OrderUpdateHandler = (state) => {
        if (state.id !== this._sellOrderId) return;
        logger.debug(`[PairOrderWallet] sellHandler called for ${state.id}, size_matched=${state.size_matched}`);

        const newMatched = safeToNum(state.size_matched);
        const delta = newMatched - this._sellLastMatchedSize;

        if (delta > 0) {
            const price = safeToNum(state.price);
            logger.debug(`[PairOrderWallet] sellHandler delta=${delta} price=${price}, updating balance/tokens`);
            this._walletBalance += price * delta;
            this._tokenQuantity -= delta;
        }

        this._sellLastMatchedSize = newMatched;

        if (state.has_size_matched || state.has_canceled) {
            logger.debug(`[PairOrderWallet] sellHandler order ${state.id} finished (matched or canceled), resetting state`);
            this._watcher.resetUpdateHandler(state.id);
            this._sellOrderId = undefined;
            this._sellOrderState = undefined;
            this._sellLastMatchedSize = 0;
        }
    };

    private constructor(client: ClobClient, params: OrderWalletParams, watcher: OrdersWatcher) {
        if (params.balance < 0) throw new Error(`[PairOrderWallet] Insufficient USD balance: ${params.balance}, required > 0`);
        if (!watcher.isActive()) throw new Error(`[PairOrderWallet] Orders watcher is not active!`);

        this._tokenId = params.token_id;
        this._client = client;
        this._walletBalance = params.balance;
        this._walletInitBalance = this._walletBalance;
        this._watcher = watcher;

        this._tickSize = params.tick_size;
        this._minOrderSize = params.min_order_size;
        this._minBuyOrderValue = params.min_buy_order_value;
    }

    private async init(): Promise<void> {
       const balance_client = await getUSDBalance(this._client);
        if (balance_client < this._walletBalance) {
            throw new Error(`[PairOrderWallet] Insufficient USD balance: ${balance_client}, required ${this._walletBalance}`);
        }
    }

    public static async create(client: ClobClient, params: OrderWalletParams, watcher: OrdersWatcher) : Promise<PairOrderWallet> {
        const wallet = new PairOrderWallet(client, params, watcher);
        await wallet.init();
        return wallet;
    }

    public getTokenId(): string {
        return this._tokenId;
    }

    public async buy(price: number, quantity: number): Promise<OrderWalletState | undefined> {
        if (this._buyOrderId) return undefined;
        if (quantity <= 0) return undefined;

        const orderPrice = tick_price(price, this._tickSize, Side.BUY);
        let orderQuantity = valid_quantity_unsafe(quantity, this._minOrderSize, this._tickSize, Side.BUY);

        if (orderQuantity === 0) {
            logger.warn(`[PairOrderWallet] Token quantity is not enough: ${orderQuantity} for token ${this._tokenId}`);
            return undefined;
        }
            
        let orderValue =  orderPrice * orderQuantity;

        if (orderValue < this._minBuyOrderValue) {
            const desiredQuantity = Math.ceil(this._minBuyOrderValue / orderPrice);
            orderQuantity = valid_quantity_unsafe(desiredQuantity, this._minOrderSize, this._tickSize, Side.BUY);
            if (orderQuantity === 0) {
                logger.warn(`[PairOrderWallet] Cannot meet minimum buy value for token ${this._tokenId}`);
                return undefined;
            }
            orderValue = orderPrice * orderQuantity;
            logger.warn(`[PairOrderWallet] Adjusted quantity to ${orderQuantity} to meet minimum buy value`);
        }

        if (orderValue > this._walletBalance) {
            logger.warn(`[PairOrderWallet] Not enough balance ${this._walletBalance} for buy order for ${orderQuantity} tokens and ${orderPrice} price for token ${this._tokenId}`);
            return undefined;
        }

        if (!this._watcher.isActive()) {
            logger.warn(`[PairOrderWallet] Order watcher is not active!`);
            return undefined;
        } 

        const result = await placeMakerOrder(this._client, this._tokenId, Side.BUY, orderPrice, orderQuantity);
        if (!result || !result.success || !result.orderID) {
            logger.error(`[PairOrderWallet] Placing buy order error!`)
            return undefined;
        }
        logger.info(`[PairOrderWallet] BUY order post: ${result.orderID} price=${orderPrice} qty=${orderQuantity}`);
        let orderSetPrice = orderPrice;
        let orderSetQuantity = orderQuantity;

        if (result.status === 'matched') {
            const filledQty = result.executed_size || 0;
            const avgPrice = result.average_price || orderSetPrice;

            if (filledQty > 0) {
                this._walletBalance -= avgPrice * filledQty;
                this._tokenQuantity += filledQty;
            }

            if (filledQty >= orderSetQuantity) {
                logger.info(`[PairOrderWallet] BUY order ${result.orderID} fully matched: filled=${filledQty} avgPrice=${avgPrice}`);
                this._buyOrderId = undefined;
                this._buyOrderState = undefined;
                this._buyLastMatchedSize = 0;
                return {
                    id: result.orderID,
                    value: { price: avgPrice, quantity: filledQty },
                    fast_full_trade: true
                };
            }

            logger.info(`[PairOrderWallet] BUY order ${result.orderID} partially matched: filled=${filledQty}/${orderSetQuantity} avgPrice=${avgPrice}, remaining will be placed as limit`);
            const remainingQty = orderSetQuantity - filledQty;
            this._buyLastMatchedSize = filledQty;
            const buyOrderState: OrderWalletState = {
                id: result.orderID,
                value: { price: orderSetPrice, quantity: remainingQty },
                fast_full_trade: false
            };
            this._buyOrderId = buyOrderState.id;
            this._buyOrderState = buyOrderState;
            this._watcher.setUpdateHandler(this._buyOrderId, this._buyHandler);
            return buyOrderState;
        }

        logger.info(`[PairOrderWallet] BUY order ${result.orderID} placed as limit (${orderSetQuantity} @ ${orderSetPrice})`);
        let buyOrderState: OrderWalletState = {
            id: result.orderID,
            value: {
                price: orderSetPrice,
                quantity: orderSetQuantity
            },
            fast_full_trade: false
        };

        this._buyOrderId = buyOrderState.id;
        this._buyOrderState = buyOrderState;
        this._watcher.setUpdateHandler(this._buyOrderId, this._buyHandler);
        return buyOrderState;
    }

    public async sell(price: number, quantity: number): Promise<OrderWalletState | undefined> {
        if (this._sellOrderId) return undefined;
        if (quantity <= 0) return undefined;

        const orderPrice = tick_price(price, this._tickSize, Side.SELL);
        let orderQuantity = valid_quantity_unsafe(quantity, this._minOrderSize, this._tickSize, Side.SELL);

        if (orderQuantity === 0) {
            logger.warn(`[PairOrderWallet] Token quantity is not enough: ${orderQuantity} for token ${this._tokenId}`);
            return undefined;
        }

        if (orderQuantity > this._tokenQuantity) {
            logger.warn(`[PairOrderWallet] Not enough tokens to sell: have ${this._tokenQuantity}, need ${orderQuantity} for token ${this._tokenId}`);
            return undefined;
        }

        if (!this._watcher.isActive()) {
            logger.warn(`[PairOrderWallet] Order watcher is not active!`);
            return undefined;
        }

        const result = await placeMakerOrder(this._client, this._tokenId, Side.SELL, orderPrice, orderQuantity);
        if (!result || !result.success || !result.orderID) {
            logger.error(`[PairOrderWallet] Placing sell order error!`);
            return undefined;
        }

        logger.info(`[PairOrderWallet] SELL order post: ${result.orderID} price=${orderPrice} qty=${orderQuantity}`);
        let orderSetPrice = orderPrice;
        let orderSetQuantity = orderQuantity;

        if (result.status === 'matched') {
            const filledQty = result.executed_size || 0;
            const avgPrice = result.average_price || orderSetPrice;

            if (filledQty > 0) {
                this._walletBalance += avgPrice * filledQty;
                this._tokenQuantity -= filledQty;
            }

            if (filledQty >= orderSetQuantity) {
                logger.info(`[PairOrderWallet] SELL order ${result.orderID} fully matched: filled=${filledQty} avgPrice=${avgPrice}`);
                this._sellOrderId = undefined;
                this._sellOrderState = undefined;
                this._sellLastMatchedSize = 0;
                return {
                    id: result.orderID,
                    value: { price: avgPrice, quantity: filledQty },
                    fast_full_trade: true
                };
            }

            logger.info(`[PairOrderWallet] SELL order ${result.orderID} partially matched: filled=${filledQty}/${orderSetQuantity} avgPrice=${avgPrice}, remaining will be placed as limit`);
            const remainingQty = orderSetQuantity - filledQty;
            this._sellLastMatchedSize = filledQty;
            const sellOrderState: OrderWalletState = {
                id: result.orderID,
                value: { price: orderSetPrice, quantity: remainingQty },
                fast_full_trade: false
            };

            this._sellOrderId = sellOrderState.id;
            this._sellOrderState = sellOrderState;
            this._watcher.setUpdateHandler(this._sellOrderId, this._sellHandler);
            return sellOrderState;
        }

        logger.info(`[PairOrderWallet] SELL order ${result.orderID} placed as limit (${orderSetQuantity} @ ${orderSetPrice})`);
        const sellOrderState: OrderWalletState = {
            id: result.orderID,
            value: { price: orderSetPrice, quantity: orderSetQuantity },
            fast_full_trade: false
        };
        this._sellOrderId = sellOrderState.id;
        this._sellOrderState = sellOrderState;
        this._watcher.setUpdateHandler(this._sellOrderId, this._sellHandler);
        return sellOrderState;
    }


    public async cancel_order(orderId: string): Promise<boolean> {
        if (orderId !== this._buyOrderId && orderId !== this._sellOrderId) return false;
        try {
            if (orderId === this._buyOrderId) {
                await cancelOrder(this._client, this._buyOrderId!);
                this._watcher.resetUpdateHandler(this._buyOrderId!);
                this._buyOrderId = undefined;
                this._buyOrderState = undefined;
                this._buyLastMatchedSize = 0;
                logger.info(`[PairOrderWallet] Cancelled buy order ${orderId} for token ${this._tokenId}`);
            } else {
                await cancelOrder(this._client, this._sellOrderId!);
                this._watcher.resetUpdateHandler(this._sellOrderId!);
                this._sellOrderId = undefined;
                this._sellOrderState = undefined;
                this._sellLastMatchedSize = 0;
                logger.info(`[PairOrderWallet] Cancelled sell order ${orderId} for token ${this._tokenId}`);
            }
            return true;
        } catch (error) {
            logger.error(`[PairOrderWallet] Failed to cancel order ${orderId}: ${error_str(error)}`);
            return false;
        }
    }

    public async cancel_all(): Promise<boolean> {
        let fullCanceled = true;
        if (this._buyOrderId) {
            const success = await this.cancel_order(this._buyOrderId);
            if (!success) fullCanceled = false;
        }
        if (this._sellOrderId) {
            const success = await this.cancel_order(this._sellOrderId);
            if (!success) fullCanceled = false;
        }
        return fullCanceled;
    }

    public isFilled(orderId: string): boolean {
        return this._watcher.isFullMatched(orderId);
    }

    public isLive(orderId: string): boolean {
        if (orderId === this._buyOrderId) {
            return this._buyOrderState?.fast_full_trade !== true;
        }
        if (orderId === this._sellOrderId) {
            return this._sellOrderState?.fast_full_trade !== true;
        }
        return this._watcher.isLive(orderId);
    }

    public hasCanceled(orderId: string): boolean {
        return this._watcher.hasCanceled(orderId);
    }

    public getBalance(): number {
        return this._walletBalance;
    }

    public getBalanceChange(): number {
        return (this._walletBalance - this._walletInitBalance);
    }

    public getTokensQuantity(): number {
        return this._tokenQuantity;
    }

    public getBuyOrdersCount(): number {
        return (this._buyOrderId)? 1: 0;
    }

    public getSellOrdersCount(): number {
        return (this._sellOrderId)? 1: 0;
    }

    public setTick(tickSize: number): void {
        if (tickSize <= 0) return;         
        this._tickSize = tickSize;
    }

    public setMinOrderSize(orderSize: number): void {
        if (orderSize <= 0) return;
        this._minOrderSize = orderSize;
    }

    public setMinBuyOrderValue(orderValue: number): void {
        if (orderValue < DEFAULT_BUY_ORDER_MIN_VALUE) return;
        this._minBuyOrderValue = orderValue;
    }

    public async dispose(sellAll: boolean): Promise<void> {
        /**
        * When `sellAll` is `true` and the order book has existing bids, we immediately
        * place a marketable limit‑sell order at the minimum price (`_tickSize`). Because
        * this price crosses the best bid, the order is filled as a taker instantly. In the
        * vast majority of cases the API response will report `status: "matched"`, which
        * updates the virtual balance synchronously – no reliance events.
        *
        * If, against all odds, the order is only **partially** filled and the subsequent
        * cancellation event is delayed or lost (e.g., due to network
        * latency or an early watcher disconnection), **the already‑filled portion has
        * already been accounted for** by the incremental fills delivered through the
        * order‑update handler. The final cancellation event merely marks the order as
        * done and does not carry additional financial impact. Thus the virtual balance
        * stays correct even without that last event.
        */
        let allCancelled = await this.cancel_all();
        if (!allCancelled) {
            logger.warn(`[PairOrderWallet] Some orders could not be cancelled before dispose!`);
        }
        if (sellAll && this._tokenQuantity > 0) {
            logger.info(`[PairOrderWallet] Sell all flag set, trying to sell all tokens before dispose...`);

            const isAbleToSell = !(await isBidsEmpty(this._client, this._tokenId));
            if (isAbleToSell) {
                await this.sell(this._tickSize, this._tokenQuantity);
                allCancelled = await this.cancel_all();
                if (!allCancelled) {
                    logger.warn(`[PairOrderWallet] Some orders could not be cancelled before dispose!`);
                }
            } else {
                logger.info(`[PairOrderWallet] Selling all tokens before dispose failed, no liquidity...`);
            }        }
        this._watcher.disconnect();
    }
}