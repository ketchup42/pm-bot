import { ClobClient, Side } from "@polymarket/clob-client-v2";
import { OrderWalletParams, OrderWalletState } from "./OrderWallet.js";
import { DEFAULT_BUY_ORDER_MIN_VALUE, cancelOrder, getUSDBalance, placeMakerOrder } from "../../rest/orders.js";
import { OrderUpdateHandler, OrdersWatcher } from "./watcher/OrdersWatcher.js";
import { tick_price, valid_quantity_unsafe } from "../../rest/orders-price.js";
import { logger } from "../../log.js";
import { error_str, safeToNum } from "../../utils.js";
import { MultiOrderWallet } from "./MultiOrderWallet.js";
import { isBidsEmpty } from "../../rest/price.js";

/**
 * Information about an active order (buy or sell).
 */
interface ActiveOrder {
    state: OrderWalletState;
    lastMatchedSize: number;
}

/**
 * Virtual wallet for a strategy, supporting multiple simultaneous
 * buy and sell orders with virtual balance and token control.
 */
export class LiveOrderWallet implements MultiOrderWallet {
    private _tokenId: string;
    private _client: ClobClient;
    private _watcher: OrdersWatcher;

    private _walletBalance: number;
    private _walletInitBalance: number;
    private _tokenQuantity: number = 0;

    private _tickSize: number;
    private _minOrderSize: number;
    private _minBuyOrderValue: number;

    // Collections of active orders
    private _activeBuyOrders = new Map<string, ActiveOrder>();
    private _activeSellOrders = new Map<string, ActiveOrder>();

    /**
     * Handler for all active BUY orders.
     * Looks up the order by ID, computes the fill delta, and updates balance/tokens.
     * On full fill or cancellation, removes the order and resets the watcher handler.
     */
    private readonly _buyHandler: OrderUpdateHandler = (state) => {
        const order = this._activeBuyOrders.get(state.id);
        if (!order) return;
        if (state.id !== order.state.id) return;

        const newMatched = safeToNum(state.size_matched);
        const delta = newMatched - order.lastMatchedSize;

        logger.debug(`[LiveOrderWallet] BUY handler: order=${state.id} size_matched=${newMatched} delta=${delta}`);

        if (delta > 0) {
            const price = safeToNum(state.price);
            this._walletBalance -= price * delta;
            this._tokenQuantity += delta;

            order.state.value.quantity = Math.max(0, order.state.value.quantity - delta);
            logger.debug(`[LiveOrderWallet] BUY fill: delta=${delta} price=${price} newBalance=${this._walletBalance} newTokens=${this._tokenQuantity}`);
        }

        order.lastMatchedSize = newMatched;

        if (state.has_size_matched || state.has_canceled) {
            logger.debug(`[LiveOrderWallet] BUY order ${state.id} completed or cancelled, removing handler`);
            this._watcher.resetUpdateHandler(state.id);
            this._activeBuyOrders.delete(state.id);
        }
    };

    /**
     * Handler for all active SELL orders.
     * Analogous to BUY handler, but with reversed signs.
     */
    private readonly _sellHandler: OrderUpdateHandler = (state) => {
        const order = this._activeSellOrders.get(state.id);
        if (!order) return;
        if (state.id !== order.state.id) return;

        const newMatched = safeToNum(state.size_matched);
        const delta = newMatched - order.lastMatchedSize;

        logger.debug(`[LiveOrderWallet] SELL handler: order=${state.id} size_matched=${newMatched} delta=${delta}`);

        if (delta > 0) {
            const price = safeToNum(state.price);
            this._walletBalance += price * delta;
            this._tokenQuantity -= delta;

            order.state.value.quantity = Math.max(0, order.state.value.quantity - delta);
            logger.debug(`[LiveOrderWallet] SELL fill: delta=${delta} price=${price} newBalance=${this._walletBalance} newTokens=${this._tokenQuantity}`);
        }

        order.lastMatchedSize = newMatched;

        if (state.has_size_matched || state.has_canceled) {
            logger.debug(`[LiveOrderWallet] SELL order ${state.id} completed or cancelled, removing handler`);
            this._watcher.resetUpdateHandler(state.id);
            this._activeSellOrders.delete(state.id);
        }
    };

    private constructor(client: ClobClient, params: OrderWalletParams, watcher: OrdersWatcher) {
        if (params.balance < 0) throw new Error(`[LiveOrderWallet] Insufficient USD balance: ${params.balance}, required > 0`);
        if (!watcher.isActive()) throw new Error(`[LiveOrderWallet] Orders watcher is not active!`);

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
            throw new Error(`[LiveOrderWallet] Insufficient USD balance: ${balance_client}, required ${this._walletBalance}`);
        }
    }

    public static async create(client: ClobClient, params: OrderWalletParams, watcher: OrdersWatcher): Promise<LiveOrderWallet> {
        const wallet = new LiveOrderWallet(client, params, watcher);
        await wallet.init();
        return wallet;
    }

    public getTokenId(): string {
        return this._tokenId;
    }

    /**
     * Returns the total USD reserved by all active BUY orders.
     */
    private _getTotalBuyReserved(): number {
        let total = 0;
        for (const order of this._activeBuyOrders.values()) {
            total += order.state.value.price * Math.max(0, order.state.value.quantity);
        }
        return total;
    }

    /**
     * Returns the total tokens reserved by all active SELL orders.
     */
    private _getTotalSellReserved(): number {
        let total = 0;
        for (const order of this._activeSellOrders.values()) {
            total += Math.max(0, order.state.value.quantity);
        }
        return total;
    }
    /**
     * Places a maker BUY order. May be called multiple times as long as
     * sufficient virtual balance is available.
     */
    public async buy(price: number, quantity: number): Promise<OrderWalletState | undefined> {
        if (quantity <= 0) return undefined;

        const orderPrice = tick_price(price, this._tickSize, Side.BUY);
        let orderQuantity = valid_quantity_unsafe(quantity, this._minOrderSize, this._tickSize, Side.BUY);

        if (orderQuantity === 0) {
            logger.warn(`[LiveOrderWallet] Token quantity is not enough: ${orderQuantity} for token ${this._tokenId}`);
            return undefined;
        }

        let orderValue = orderPrice * orderQuantity;

        if (orderValue < this._minBuyOrderValue) {
            const desiredQuantity = Math.ceil(this._minBuyOrderValue / orderPrice);
            orderQuantity = valid_quantity_unsafe(desiredQuantity, this._minOrderSize, this._tickSize, Side.BUY);
            if (orderQuantity === 0) {
                logger.warn(`[LiveOrderWallet] Cannot meet minimum buy value for token ${this._tokenId}`);
                return undefined;
            }
            orderValue = orderPrice * orderQuantity;
            logger.warn(`[LiveOrderWallet] Adjusted quantity to ${orderQuantity} to meet minimum buy value`);
        }

        const availableBalance = this._walletBalance - this._getTotalBuyReserved();
        if (orderValue > availableBalance) {
            logger.warn(`[LiveOrderWallet] Not enough balance. Available: ${availableBalance}, required: ${orderValue}`);
            return undefined;
        }

        if (!this._watcher.isActive()) {
            logger.warn(`[LiveOrderWallet] Order watcher is not active!`);
            return undefined;
        }

        const result = await placeMakerOrder(this._client, this._tokenId, Side.BUY, orderPrice, orderQuantity);
        if (!result || !result.success || !result.orderID) {
            logger.error(`[LiveOrderWallet] Placing buy order error!`);
            return undefined;
        }

        logger.info(`[LiveOrderWallet] BUY order post: ${result.orderID} price=${orderPrice} qty=${orderQuantity}`);
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
                logger.info(`[LiveOrderWallet] BUY order ${result.orderID} fully matched: filled=${filledQty} avgPrice=${avgPrice}`);
                return {
                    id: result.orderID,
                    value: { price: avgPrice, quantity: filledQty },
                    fast_full_trade: true
                };
            }

            logger.info(`[LiveOrderWallet] BUY order ${result.orderID} partially matched: filled=${filledQty}/${orderSetQuantity} avgPrice=${avgPrice}, remaining will be placed as limit`);
            const remainingQty = orderSetQuantity - filledQty;
            const buyOrderState: OrderWalletState = {
                id: result.orderID,
                value: { price: orderSetPrice, quantity: remainingQty },
                fast_full_trade: false
            };

            this._activeBuyOrders.set(result.orderID, {
                state: buyOrderState,
                lastMatchedSize: filledQty
            });
            this._watcher.setUpdateHandler(result.orderID, this._buyHandler);
            return buyOrderState;
        }

        logger.info(`[LiveOrderWallet] BUY order ${result.orderID} placed as limit (${orderSetQuantity} @ ${orderSetPrice})`);
        const buyOrderState: OrderWalletState = {
            id: result.orderID,
            value: { price: orderSetPrice, quantity: orderSetQuantity },
            fast_full_trade: false
        };

        this._activeBuyOrders.set(result.orderID, {
            state: buyOrderState,
            lastMatchedSize: 0
        });
        this._watcher.setUpdateHandler(result.orderID, this._buyHandler);
        return buyOrderState;
    }

    public async sell(price: number, quantity: number): Promise<OrderWalletState | undefined> {
        if (quantity <= 0) return undefined;

        const orderPrice = tick_price(price, this._tickSize, Side.SELL);
        let orderQuantity = valid_quantity_unsafe(quantity, this._minOrderSize, this._tickSize, Side.SELL);

        if (orderQuantity === 0) {
            logger.warn(`[LiveOrderWallet] Token quantity is not enough: ${orderQuantity} for token ${this._tokenId}`);
            return undefined;
        }

        const availableTokens = this._tokenQuantity - this._getTotalSellReserved();
        if (orderQuantity > availableTokens) {
            logger.warn(`[LiveOrderWallet] Not enough tokens to sell. Available: ${availableTokens}, required: ${orderQuantity}`);
            return undefined;
        }

        if (!this._watcher.isActive()) {
            logger.warn(`[LiveOrderWallet] Order watcher is not active!`);
            return undefined;
        }

        const result = await placeMakerOrder(this._client, this._tokenId, Side.SELL, orderPrice, orderQuantity);
        if (!result || !result.success || !result.orderID) {
            logger.error(`[LiveOrderWallet] Placing sell order error!`);
            return undefined;
        }

        logger.info(`[LiveOrderWallet] SELL order post: ${result.orderID} price=${orderPrice} qty=${orderQuantity}`);
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
                logger.info(`[LiveOrderWallet] SELL order ${result.orderID} fully matched: filled=${filledQty} avgPrice=${avgPrice}`);
                return {
                    id: result.orderID,
                    value: { price: avgPrice, quantity: filledQty },
                    fast_full_trade: true
                };
            }

            logger.info(`[LiveOrderWallet] SELL order ${result.orderID} partially matched: filled=${filledQty}/${orderSetQuantity} avgPrice=${avgPrice}, remaining will be placed as limit`);
            const remainingQty = orderSetQuantity - filledQty;
            const sellOrderState: OrderWalletState = {
                id: result.orderID,
                value: { price: orderSetPrice, quantity: remainingQty },
                fast_full_trade: false
            };

            this._activeSellOrders.set(result.orderID, {
                state: sellOrderState,
                lastMatchedSize: filledQty
            });
            this._watcher.setUpdateHandler(result.orderID, this._sellHandler);
            return sellOrderState;
        }

        logger.info(`[LiveOrderWallet] SELL order ${result.orderID} placed as limit (${orderSetQuantity} @ ${orderSetPrice})`);
        const sellOrderState: OrderWalletState = {

            id: result.orderID,
            value: { price: orderSetPrice, quantity: orderSetQuantity },
            fast_full_trade: false
        };

        this._activeSellOrders.set(result.orderID, {
            state: sellOrderState,
            lastMatchedSize: 0
        });
        this._watcher.setUpdateHandler(result.orderID, this._sellHandler);
        return sellOrderState;
    }


    /**
     * Cancels a specific order by its exchange ID.
     * @returns true if the order was found and successfully cancelled, false otherwise.
     */
    public async cancel_order(orderId: string): Promise<boolean> {
        const isBuy = this._activeBuyOrders.has(orderId);
        const isSell = this._activeSellOrders.has(orderId);
        if (!isBuy && !isSell) return false;

        try {
            await cancelOrder(this._client, orderId);
            if (isBuy) this._activeBuyOrders.delete(orderId);
            if (isSell) this._activeSellOrders.delete(orderId);
            this._watcher.resetUpdateHandler(orderId);
            logger.info(`[LiveOrderWallet] Cancelled order ${orderId} for token ${this._tokenId}`);
            return true;
        } catch (error) {
            logger.error(`[LiveOrderWallet] Failed to cancel order ${orderId}: ${error_str(error)}`);
            return false;
        }
    }

    /**
     * Cancels all active orders. Returns true only if every cancellation succeeded.
     */
    public async cancel_all(): Promise<boolean> {
        let allCancelled = true;
        const allPromises: Promise<boolean>[] = [];
        for (const id of this._activeBuyOrders.keys()) allPromises.push(this.cancel_order(id));
        for (const id of this._activeSellOrders.keys()) allPromises.push(this.cancel_order(id));
        const results = await Promise.allSettled(allPromises);
        for (const r of results) {
            if (r.status === 'rejected' || (r.status === 'fulfilled' && !r.value)) allCancelled = false;
        }
        return allCancelled;
    }

    public isFilled(orderId: string): boolean {
        return this._watcher.isFullMatched(orderId);
    }

    public isLive(orderId: string): boolean {
        const buyOrder = this._activeBuyOrders.get(orderId);
        if (buyOrder) {
            return buyOrder.state.fast_full_trade !== true;
        }
        const sellOrder = this._activeSellOrders.get(orderId);
        if (sellOrder) {
            return sellOrder.state.fast_full_trade !== true;
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
        return this._walletBalance - this._walletInitBalance;
    }

    public getTokensQuantity(): number {
        return this._tokenQuantity;
    }

    /**
     * Free virtual balance (available for new buy orders).
     */
    public getAvailableBalance(): number {
        return this._walletBalance - this._getTotalBuyReserved();
    }

    /**
     * Free token quantity (available for new sell orders).
     */
    public getAvailableTokens(): number {
        return this._tokenQuantity - this._getTotalSellReserved();
    }

    /**
     * Number of currently active buy orders.
     */
    public getBuyOrdersCount(): number {
        return this._activeBuyOrders.size;
    }

    /**
     * Number of currently active sell orders.
     */
    public getSellOrdersCount(): number {
        return this._activeSellOrders.size;
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
            logger.warn(`[LiveOrderWallet] Some orders could not be cancelled before dispose!`);
        }
        if (sellAll && this._tokenQuantity > 0) {
            logger.info(`[LiveOrderWallet] Sell all flag set, trying to sell all tokens before dispose...`);

            const isAbleToSell = !(await isBidsEmpty(this._client, this._tokenId));
            if (isAbleToSell) {
                await this.sell(this._tickSize, this._tokenQuantity);
                allCancelled = await this.cancel_all();
                if (!allCancelled) {
                    logger.warn(`[LiveOrderWallet] Some orders could not be cancelled before dispose!`);
                }
            } else {
                logger.info(`[LiveOrderWallet] Selling all tokens before dispose failed, no liquidity...`);
            }        
        }
        this._watcher.disconnect();
    }
}