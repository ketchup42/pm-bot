import { ClobClient, Side } from '@polymarket/clob-client-v2';
import { logger } from '../../log.js';
import { tick_price, valid_quantity_unsafe } from '../../rest/orders-price.js';
import {
    cancelOrder,
    DEFAULT_TAKER_ORDER_RECOVERY_RETRY_MS,
    getUSDBalance,
    placeGtcTakerOrder,
    recoverGtcTakerOrder,
    type GtcTakerFilledOrderResult,
    type GtcTakerFillStatus,
    type GtcTakerOrderRecoveryRequiredResult,
} from '../../rest/orders.js';
import { calculateBuyTakerFeeReserve } from '../../rest/fees.js';
import { error_str, safeFloat } from '../../utils.js';
import { MultiOrderWallet } from './MultiOrderWallet.js';
import { ORDER_WALLET_FRACTION, OrderWalletParams, OrderWalletState } from './OrderWallet.js';
import { type OrderUpdateHandler, type OrdersWatcher } from './watcher/OrdersWatcher.js';

type TakerOrderAction = 'buy' | 'sell';

interface ActiveTakerOrder {
    action: TakerOrderAction;
    state: OrderWalletState;
    requestedQuantity: number;
    limitPrice: number;
    isRecoveryRunning: boolean;
    retryTimer: ReturnType<typeof setTimeout> | undefined;
}

/** Real immediate-execution wallet with watcher-backed recovery for known order IDs. */
export class TakerLiveOrderWallet implements MultiOrderWallet {
    private readonly client: ClobClient;
    private readonly tokenId: string;
    private readonly tickSize: number;
    private readonly minOrderSize: number;
    private readonly minBuyOrderValue: number;
    private readonly feesEnabled: boolean;
    private readonly takerBaseFee: number;
    private readonly watcher: OrdersWatcher;
    private walletBalance: number;
    private readonly walletInitBalance: number;
    private tokenQuantity = 0;
    private readonly closedOrders = new Map<string, GtcTakerFillStatus>();
    private readonly activeOrders = new Map<string, ActiveTakerOrder>();

    private constructor(client: ClobClient, params: OrderWalletParams, watcher: OrdersWatcher) {
        if (params.balance < 0) throw new Error(`[TakerLiveOrderWallet] Insufficient USD balance: ${params.balance}, required > 0`);
        if (!watcher.isActive()) throw new Error('[TakerLiveOrderWallet] Orders watcher is not active');
        this.client = client;
        this.tokenId = params.token_id;
        this.walletBalance = params.balance;
        this.walletInitBalance = params.balance;
        this.tickSize = params.tick_size;
        this.minOrderSize = params.min_order_size;
        this.minBuyOrderValue = params.min_buy_order_value;
        this.feesEnabled = params.fees_enabled;
        this.takerBaseFee = params.taker_base_fee;
        this.watcher = watcher;
    }

    public static async create(client: ClobClient, params: OrderWalletParams, watcher: OrdersWatcher): Promise<TakerLiveOrderWallet> {
        const wallet = new TakerLiveOrderWallet(client, params, watcher);
        const clientBalance = await getUSDBalance(client);
        if (clientBalance < params.balance) throw new Error(`[TakerLiveOrderWallet] Insufficient USD balance: ${clientBalance}, required ${params.balance}`);
        return wallet;
    }

    public getTokenId(): string { return this.tokenId; }

    public async buy(price: number, quantity: number): Promise<OrderWalletState | undefined> {
        if (quantity <= 0 || !this.watcher.isActive()) return undefined;
        const orderPrice = tick_price(price, this.tickSize, Side.BUY);
        let orderQuantity = valid_quantity_unsafe(quantity, this.minOrderSize, this.tickSize, Side.BUY);
        if (orderQuantity === 0) return undefined;
        let orderValue = safeFloat(orderPrice * orderQuantity, ORDER_WALLET_FRACTION);
        if (orderValue < this.minBuyOrderValue) {
            orderQuantity = valid_quantity_unsafe(Math.ceil(this.minBuyOrderValue / orderPrice), this.minOrderSize, this.tickSize, Side.BUY);
            if (orderQuantity === 0) return undefined;
            orderValue = safeFloat(orderPrice * orderQuantity, ORDER_WALLET_FRACTION);
        }
        const required = safeFloat(
            orderValue + calculateBuyTakerFeeReserve(this.feesEnabled, this.takerBaseFee, orderPrice, orderQuantity),
            ORDER_WALLET_FRACTION,
        );
        if (required > this.getAvailableBalance()) return undefined;
        return this.submit('buy', orderPrice, orderQuantity);
    }

    public async sell(price: number, quantity: number): Promise<OrderWalletState | undefined> {
        if (quantity <= 0 || !this.watcher.isActive()) return undefined;
        const orderPrice = tick_price(price, this.tickSize, Side.SELL);
        const orderQuantity = valid_quantity_unsafe(quantity, this.minOrderSize, this.tickSize, Side.SELL);
        if (orderQuantity === 0 || orderQuantity > this.getAvailableTokens()) return undefined;
        return this.submit('sell', orderPrice, orderQuantity);
    }

    public async cancel_order(orderId: string): Promise<boolean> {
        if (!this.activeOrders.has(orderId)) return true;
        try {
            await cancelOrder(this.client, orderId);
            this.resolveActiveOrder(orderId);
            return true;
        } catch (error) {
            logger.warn(`[TakerLiveOrderWallet] Cancel retry failed: id=${orderId} error=${error_str(error)}`);
            return false;
        }
    }

    public async cancel_all(): Promise<boolean> {
        const results = await Promise.all([...this.activeOrders.keys()].map(orderId => this.cancel_order(orderId)));
        return results.every(Boolean);
    }

    public isFullFilled(orderId: string): boolean { return this.closedOrders.get(orderId) === 'full' || this.watcher.isFullMatched(orderId); }
    public isPartialFilled(orderId: string): boolean { return this.closedOrders.get(orderId) === 'partial' || this.watcher.isPartialMatched(orderId); }
    public isLive(orderId: string): boolean { return this.activeOrders.has(orderId) || this.watcher.isLive(orderId); }
    public hasCanceled(orderId: string): boolean {
        const status = this.closedOrders.get(orderId);
        return (status !== undefined && status !== 'full') || this.watcher.hasCanceled(orderId);
    }
    public getBalance(): number { return safeFloat(this.walletBalance, ORDER_WALLET_FRACTION); }
    public getBalanceChange(): number { return safeFloat(this.getBalance() - this.walletInitBalance, ORDER_WALLET_FRACTION); }
    public getTokensQuantity(): number { return safeFloat(this.tokenQuantity, ORDER_WALLET_FRACTION); }
    public getAvailableBalance(): number {
        const reserved = [...this.activeOrders.values()].filter(order => order.action === 'buy')
            .reduce(
                (total, order) => total + order.state.value.price * order.state.value.quantity +
                    calculateBuyTakerFeeReserve(
                        this.feesEnabled,
                        this.takerBaseFee,
                        order.state.value.price,
                        order.state.value.quantity,
                    ),
                0,
            );
        return safeFloat(this.walletBalance - reserved, ORDER_WALLET_FRACTION);
    }
    public getAvailableTokens(): number {
        const reserved = [...this.activeOrders.values()].filter(order => order.action === 'sell')
            .reduce((total, order) => total + order.state.value.quantity, 0);
        return safeFloat(this.tokenQuantity - reserved, ORDER_WALLET_FRACTION);
    }
    public getBuyOrdersCount(): number { return [...this.activeOrders.values()].filter(order => order.action === 'buy').length; }
    public getSellOrdersCount(): number { return [...this.activeOrders.values()].filter(order => order.action === 'sell').length; }
    public getTick(): number { return this.tickSize; }
    public getMinOrderSize(): number { return this.minOrderSize; }
    public getMinBuyOrderValue(): number { return this.minBuyOrderValue; }

    public async dispose(sellAll: boolean): Promise<void> {
        const allCancelled = await this.cancel_all();
        if (!allCancelled) logger.warn('[TakerLiveOrderWallet] Some recovery orders could not be cancelled before dispose');
        if (sellAll && this.tokenQuantity > 0) await this.sell(this.tickSize, this.tokenQuantity);
        for (const order of this.activeOrders.values()) if (order.retryTimer !== undefined) clearTimeout(order.retryTimer);
        this.activeOrders.clear();
        this.closedOrders.clear();
        this.watcher.disconnect();
    }

    private async submit(action: TakerOrderAction, price: number, quantity: number): Promise<OrderWalletState | undefined> {
        const execution = await placeGtcTakerOrder(this.client, this.tokenId, action === 'buy' ? Side.BUY : Side.SELL, price, quantity, this.feesEnabled, this.takerBaseFee);
        if (execution.fillStatus === 'recovery_required') return this.trackRecovery(action, price, quantity, execution);
        if (execution.fillStatus === 'none') {
            this.closedOrders.set(execution.orderID, execution.fillStatus);
            return undefined;
        }
        return this.applyExecution(action, execution);
    }

    private trackRecovery(action: TakerOrderAction, price: number, quantity: number, recovery: GtcTakerOrderRecoveryRequiredResult): OrderWalletState {
        const state: OrderWalletState = { id: recovery.orderID, value: { price, quantity }, fast_full_trade: false };
        this.activeOrders.set(recovery.orderID, { action, state, requestedQuantity: quantity, limitPrice: price, isRecoveryRunning: false, retryTimer: undefined });
        this.watcher.setUpdateHandler(recovery.orderID, this.createRecoveryHandler(recovery.orderID));
        logger.warn(`[TakerLiveOrderWallet] Recovering order: id=${recovery.orderID} stage=${recovery.recoveryStage} error=${recovery.error}`);
        void this.cancel_order(recovery.orderID);
        this.resolveActiveOrder(recovery.orderID);
        return state;
    }

    private createRecoveryHandler(orderId: string): OrderUpdateHandler {
        return () => this.resolveActiveOrder(orderId);
    }

    private resolveActiveOrder(orderId: string): void {
        const activeOrder = this.activeOrders.get(orderId);
        if (activeOrder === undefined || activeOrder.isRecoveryRunning) return;
        activeOrder.isRecoveryRunning = true;
        void this.recoverActiveOrder(orderId, activeOrder);
    }

    private async recoverActiveOrder(orderId: string, activeOrder: ActiveTakerOrder): Promise<void> {
        try {
            const execution = await recoverGtcTakerOrder(this.client, orderId, activeOrder.requestedQuantity, activeOrder.limitPrice, this.feesEnabled, this.takerBaseFee);
            this.activeOrders.delete(orderId);
            this.watcher.resetUpdateHandler(orderId);
            if (execution.fillStatus === 'none') this.closedOrders.set(orderId, execution.fillStatus);
            else this.applyExecution(activeOrder.action, execution);
            logger.info(`[TakerLiveOrderWallet] Recovery completed: id=${orderId} status=${execution.fillStatus}`);
        } catch (error) {
            activeOrder.isRecoveryRunning = false;
            logger.warn(`[TakerLiveOrderWallet] Recovery pending: id=${orderId} error=${error_str(error)}`);
            activeOrder.retryTimer = setTimeout(() => this.resolveActiveOrder(orderId), DEFAULT_TAKER_ORDER_RECOVERY_RETRY_MS);
        }
    }

    private applyExecution(action: TakerOrderAction, execution: Readonly<GtcTakerFilledOrderResult>): OrderWalletState {
        const netValue = safeFloat(action === 'buy' ? execution.grossValue + execution.fee : execution.grossValue - execution.fee, ORDER_WALLET_FRACTION);
        this.walletBalance = safeFloat(action === 'buy' ? this.walletBalance - netValue : this.walletBalance + netValue, ORDER_WALLET_FRACTION);
        this.tokenQuantity = safeFloat(action === 'buy' ? this.tokenQuantity + execution.filledSize : this.tokenQuantity - execution.filledSize, ORDER_WALLET_FRACTION);
        this.closedOrders.set(execution.orderID, execution.fillStatus);
        logger.info(`[TakerLiveOrderWallet] ${action.toUpperCase()} ${execution.fillStatus}: id=${execution.orderID} averagePrice=${execution.averagePrice} filled=${execution.filledSize} fee=${execution.fee} netValue=${netValue} remaining=${execution.remainingSize}`);
        return { id: execution.orderID, value: { price: execution.averagePrice, quantity: execution.filledSize }, fast_full_trade: execution.fillStatus === 'full' };
    }
}
