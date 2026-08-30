import { Side } from "@polymarket/clob-client-v2";
import { ORDER_WALLET_FRACTION, OrderWalletParams, OrderWalletState } from "./OrderWallet.js";
import { MultiOrderWallet } from "./MultiOrderWallet.js";
import { tick_price, valid_quantity_unsafe } from "../../rest/orders-price.js";
import { logger } from "../../log.js";
import { safeFloat } from "../../utils.js";
import { v4 as uuidv4 } from "uuid";
import { MarketOrderBooksWatcher } from "../orderbook/watcher/MarketOrderBooksWatcher.js";
import { MarketSide } from "../side.js";

/**
 * Emulation of {@link LiveOrderWallet} that does not place real orders.
 *
 * Orders are executed instantly at the real market price read from a
 * {@link MarketOrderBooksWatcher}: buys fill at the best ask, sells at the best bid.
 * Balance and token accounting match the live wallet, but no exchange requests are
 * made and no balance check is performed on creation.
 */
export class VirtualTakerLiveOrderWallet implements MultiOrderWallet {
    private _tokenId: string;
    private _book: MarketOrderBooksWatcher;
    private _side: MarketSide;

    private _walletBalance: number;
    private _walletInitBalance: number;
    private _tokenQuantity: number = 0;

    private _tickSize: number;
    private _minOrderSize: number;
    private _minBuyOrderValue: number;

    // History of instantly-executed orders (used for fill/live status queries).
    private _filledOrders = new Map<string, OrderWalletState>();

    private constructor(params: OrderWalletParams, book: MarketOrderBooksWatcher) {
        const upToken = book.getUpMarketData().tokenId;
        const downToken = book.getDownMarketData().tokenId;
        if (params.token_id === upToken) {
            this._side = 'up';
        } else if (params.token_id === downToken) {
            this._side = 'down';
        } else {
            throw new Error(`[VirtualTakerLiveOrderWallet] Token ${params.token_id} does not belong to the given order book watcher`);
        }

        this._tokenId = params.token_id;
        this._book = book;
        this._walletBalance = params.balance;
        this._walletInitBalance = this._walletBalance;
        this._tickSize = params.tick_size;
        this._minOrderSize = params.min_order_size;
        this._minBuyOrderValue = params.min_buy_order_value;
    }

    /** Creates the wallet without any balance check — always succeeds. */
    public static create(params: OrderWalletParams, book: MarketOrderBooksWatcher): VirtualTakerLiveOrderWallet {
        return new VirtualTakerLiveOrderWallet(params, book);
    }

    public getTokenId(): string {
        return this._tokenId;
    }

    public async buy(price: number, quantity: number): Promise<OrderWalletState | undefined> {
        if (quantity <= 0) return undefined;

        const orderPrice = tick_price(price, this._tickSize, Side.BUY);
        let orderQuantity = valid_quantity_unsafe(quantity, this._minOrderSize, this._tickSize, Side.BUY);

        if (orderQuantity === 0) {
            logger.warn(`[VirtualTakerLiveOrderWallet] Token quantity is not enough: ${orderQuantity} for token ${this._tokenId}`);
            return undefined;
        }

        let orderValue = safeFloat(orderPrice * orderQuantity, ORDER_WALLET_FRACTION);

        if (orderValue < this._minBuyOrderValue) {
            const desiredQuantity = Math.ceil(this._minBuyOrderValue / orderPrice);
            orderQuantity = valid_quantity_unsafe(desiredQuantity, this._minOrderSize, this._tickSize, Side.BUY);
            if (orderQuantity === 0) {
                logger.warn(`[VirtualTakerLiveOrderWallet] Cannot meet minimum buy value for token ${this._tokenId}`);
                return undefined;
            }
            orderValue = safeFloat(orderPrice * orderQuantity, ORDER_WALLET_FRACTION);
            logger.warn(`[VirtualTakerLiveOrderWallet] Adjusted quantity to ${orderQuantity} to meet minimum buy value`);
        }

        if (orderValue > this._walletBalance) {
            logger.warn(`[VirtualTakerLiveOrderWallet] Not enough balance. Available: ${this._walletBalance}, required: ${orderValue}`);
            return undefined;
        }

        const ask = this._book.getBestAsk(this._side);
        if (ask === undefined) return undefined;

        // Only a crossing order executes instantly; a maker price would rest.
        if (orderPrice < ask) return undefined;

        this._walletBalance = safeFloat(this._walletBalance - ask * orderQuantity, ORDER_WALLET_FRACTION);
        this._tokenQuantity = safeFloat(this._tokenQuantity + orderQuantity, ORDER_WALLET_FRACTION);

        const state: OrderWalletState = {
            id: uuidv4(),
            value: { price: ask, quantity: orderQuantity },
            fast_full_trade: true
        };
        this._filledOrders.set(state.id, state);

        logger.info(`[VirtualTakerLiveOrderWallet] BUY filled: id=${state.id} price=${ask} qty=${orderQuantity}`);
        return state;
    }

    public async sell(price: number, quantity: number): Promise<OrderWalletState | undefined> {
        if (quantity <= 0) return undefined;

        const orderPrice = tick_price(price, this._tickSize, Side.SELL);
        const orderQuantity = valid_quantity_unsafe(quantity, this._minOrderSize, this._tickSize, Side.SELL);

        if (orderQuantity === 0) {
            logger.warn(`[VirtualTakerLiveOrderWallet] Token quantity is not enough: ${orderQuantity} for token ${this._tokenId}`);
            return undefined;
        }

        if (orderQuantity > this._tokenQuantity) {
            logger.warn(`[VirtualTakerLiveOrderWallet] Not enough tokens to sell. Available: ${this._tokenQuantity}, required: ${orderQuantity}`);
            return undefined;
        }

        const bid = this._book.getBestBid(this._side);
        if (bid === undefined) return undefined;

        // Only a crossing order executes instantly; a maker price would rest.
        if (orderPrice > bid) return undefined;

        this._walletBalance = safeFloat(this._walletBalance + bid * orderQuantity, ORDER_WALLET_FRACTION);
        this._tokenQuantity = safeFloat(this._tokenQuantity - orderQuantity, ORDER_WALLET_FRACTION);

        const state: OrderWalletState = {
            id: uuidv4(),
            value: { price: bid, quantity: orderQuantity },
            fast_full_trade: true
        };
        this._filledOrders.set(state.id, state);

        logger.info(`[VirtualTakerLiveOrderWallet] SELL filled: id=${state.id} price=${bid} qty=${orderQuantity}`);
        return state;
    }

    public async cancel_order(orderId: string): Promise<boolean> {
        return true;
    }

    public async cancel_all(): Promise<boolean> {
        return true;
    }

    public isFullFilled(orderId: string): boolean {
        return this._filledOrders.has(orderId);
    }

    public isPartialFilled(orderId: string): boolean {
        return false;
    }

    public isLive(orderId: string): boolean {
        return false;
    }

    public hasCanceled(orderId: string): boolean {
        return false;
    }

    public getBalance(): number {
        return safeFloat(this._walletBalance, ORDER_WALLET_FRACTION);
    }

    public getBalanceChange(): number {
        return safeFloat((this.getBalance() - this._walletInitBalance), ORDER_WALLET_FRACTION);
    }

    public getTokensQuantity(): number {
        return safeFloat(this._tokenQuantity, ORDER_WALLET_FRACTION);
    }

    public getAvailableBalance(): number {
        return safeFloat(this._walletBalance, ORDER_WALLET_FRACTION);
    }

    public getAvailableTokens(): number {
        return safeFloat(this._tokenQuantity, ORDER_WALLET_FRACTION);
    }

    public getBuyOrdersCount(): number {
        return 0;
    }

    public getSellOrdersCount(): number {
        return 0;
    }

    public getTick(): number {
        return this._tickSize;
    }

    public getMinOrderSize(): number {
        return this._minOrderSize;
    }

    public getMinBuyOrderValue(): number {
        return this._minBuyOrderValue;
    }

    public async dispose(sellAll: boolean): Promise<void> {
        if (sellAll && this._tokenQuantity > 0) {
            const bid = this._book.getBestBid(this._side);
            if (bid !== undefined) {
                logger.info(`[VirtualTakerLiveOrderWallet] Sell all: ${this._tokenQuantity} tokens at market (bid=${bid})`);
                this._walletBalance = safeFloat(this._walletBalance + bid * this._tokenQuantity, ORDER_WALLET_FRACTION);
                this._tokenQuantity = 0;
            } else {
                logger.warn(`[VirtualTakerLiveOrderWallet] Sell all failed: no bids in the book`);
            }
        }
        this._filledOrders.clear();
    }
}
