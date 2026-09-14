import { ClobClient, Side, OrderType, AssetType, Trade, type OpenOrder } from "@polymarket/clob-client-v2"
import { error_str, safeFloat, safeToNum } from "../utils.js";
import { calculateTakerFee, feeRateBpsToDecimal, TAKER_FEE_DECIMAL_PLACES } from "./fees.js";

/**
 * The most common values by public api.
 */
export const DEFAULT_ORDER_MIN_SIZE = 5.0;
export const DEFAULT_BUY_ORDER_MIN_VALUE = 1.0;
export const DEFAULT_TOKEN_MAX_PRICE = 1.0
export const DEFAULT_ORDER_AMOUNT_FRACTION = 6;

export interface OrderStatusRaw {
    success: boolean;
    /** Unique identifier of the placed order */
    orderID: string;
    status?: "live" | "matched" | "delayed" | "unmatched";

    /** For taker orders: total shares executed immediately. */
    executed_size?: number;

    /** For taker order: average price per share of the executed fills, exists if maker order had "matched" status. */
    average_price?: number;

    /** Taker fee for the part filled immediately when the GTC order was posted. */
    taker_fee?: number;

    /** For GTC taker orders: amount of shares that were filled before cancellation. */
    filled_size?: number;
}

export type GtcTakerFillStatus = 'none' | 'partial' | 'full';

interface GtcTakerOrderResultCommon {
    orderID: string;
    filledSize: number;
    remainingSize: number;
    grossValue: number;
    fee: number;
}

/** Final accounting for a GTC order cancelled immediately after submission. */
export interface GtcTakerOrderNoneResult extends GtcTakerOrderResultCommon {
    fillStatus: 'none';
    averagePrice: undefined;
}

export interface GtcTakerOrderPartialResult extends GtcTakerOrderResultCommon {
    fillStatus: 'partial';
    averagePrice: number;
}

export interface GtcTakerOrderFullResult extends GtcTakerOrderResultCommon {
    fillStatus: 'full';
    averagePrice: number;
}

export type GtcTakerOrderResult =
    | GtcTakerOrderNoneResult
    | GtcTakerOrderPartialResult
    | GtcTakerOrderFullResult;

export type GtcTakerFilledOrderResult = GtcTakerOrderPartialResult | GtcTakerOrderFullResult;

export type GtcTakerRecoveryStage = 'read_status' | 'cancel_remainder' | 'read_trades';

export interface GtcTakerOrderRecoveryRequiredResult {
    orderID: string;
    fillStatus: 'recovery_required';
    recoveryStage: GtcTakerRecoveryStage;
    error: string;
}

export type GtcTakerOrderAttemptResult = GtcTakerOrderResult | GtcTakerOrderRecoveryRequiredResult;

export const DEFAULT_TAKER_ORDER_RECOVERY_RETRY_MS = 1_000;

/**
 * Fetches multiple trades by their IDs.
 * @param client - CLOB client
 * @param tradeIds - Array of trade IDs
 * @returns Flat array of trade objects
 */
async function fetchTradesByIds(client: ClobClient, tradeIds: string[]): Promise<Trade[]> {
    if (!tradeIds.length) return [];
    const tradePromises = tradeIds.map(id => client.getTrades({ id }));
    const results = await Promise.all(tradePromises);
    return results.flat();
}

/**
 * Computes the total executed size and volume‑weighted average price from a list of trades.
 */
interface ImmediateExecution {
    filledSize: number;
    averagePrice: number;
    takerFee: number;
}

type TradeIdList = readonly string[] | undefined;

function computeImmediateOrderExecution(
    trades: Trade[],
    feesEnabled: boolean,
): ImmediateExecution {
    let totalSize = 0;
    let totalCost = 0;
    let takerFee = 0;
    for (const trade of trades) {
        const size = safeToNum(trade.size);
        const price = safeToNum(trade.price);
        totalSize += size;
        totalCost += size * price;
        if (feesEnabled && trade.trader_side === 'TAKER') {
            takerFee = safeFloat(
                takerFee + calculateTakerFee(size, price, feeRateBpsToDecimal(safeToNum(trade.fee_rate_bps))),
                TAKER_FEE_DECIMAL_PLACES,
            );
        }
    }
    const averagePrice = totalSize > 0 ? totalCost / totalSize : 0;
    return { filledSize: totalSize, averagePrice, takerFee };
}

function getUniqueTradeIds(...tradeIdLists: TradeIdList[]): string[] {
    return [...new Set(tradeIdLists.flatMap(tradeIds => tradeIds ?? []))];
}

function getTakerFillStatus(filledSize: number, requestedSize: number): GtcTakerFillStatus {
    if (filledSize <= 0) return 'none';
    return filledSize >= requestedSize ? 'full' : 'partial';
}

function createGtcTakerOrderResult(
    orderID: string,
    requestedSize: number,
    limitPrice: number,
    filledSize: number,
    execution: ImmediateExecution | undefined,
    feesEnabled: boolean,
    takerBaseFeeBps: number,
): GtcTakerOrderResult {
    const normalizedFilledSize = safeFloat(Math.min(requestedSize, Math.max(0, filledSize)), DEFAULT_ORDER_AMOUNT_FRACTION);
    const knownFilledSize = Math.min(normalizedFilledSize, execution?.filledSize ?? 0);
    const missingFilledSize = safeFloat(normalizedFilledSize - knownFilledSize, DEFAULT_ORDER_AMOUNT_FRACTION);
    const knownGrossValue = execution ? execution.averagePrice * knownFilledSize : 0;
    const fallbackFee = feesEnabled
        ? calculateTakerFee(missingFilledSize, limitPrice, feeRateBpsToDecimal(takerBaseFeeBps))
        : 0;
    const grossValue = safeFloat(knownGrossValue + missingFilledSize * limitPrice, DEFAULT_ORDER_AMOUNT_FRACTION);
    const fee = safeFloat((execution?.takerFee ?? 0) + fallbackFee, TAKER_FEE_DECIMAL_PLACES);
    const remainingSize = safeFloat(requestedSize - normalizedFilledSize, DEFAULT_ORDER_AMOUNT_FRACTION);
    const fillStatus = getTakerFillStatus(normalizedFilledSize, requestedSize);
    const common = {
        orderID,
        filledSize: normalizedFilledSize,
        remainingSize,
        grossValue,
        fee,
    };
    if (fillStatus === 'none') return { ...common, fillStatus, averagePrice: undefined };

    const averagePrice = safeFloat(grossValue / normalizedFilledSize, DEFAULT_ORDER_AMOUNT_FRACTION);
    return { ...common, fillStatus, averagePrice };
}

/**
 * Places a maker (limit) order on Polymarket.
 *
 * If the order is instantly filled (`status === "matched"`), the function fetches
 * the actual trades associated with the execution and returns the **real** filled
 * size (`exec_size`) and volume‑weighted average price (`average_price`). This
 * allows the wallet to correctly update the virtual balance even when the
 * execution price differs from the requested limit price.
 *
 * @param client - Initialized and authenticated CLOB client.
 * @param tokenId    - The ERC‑1155 token ID (asset_id) of the outcome.
 * @param side       - {@link Side.BUY} or {@link Side.SELL}.
 * @param price      - Desired limit price per token (will be honoured if the
 *                     order rests in the book; may be bettered if it crosses
 *                     the spread).
 * @param size       - Number of tokens to buy/sell.
 * @param feesEnabled - Whether this market charges taker fees.
 * @param takerBaseFeeBps - Market taker fee rate in basis points.
 *
 * @returns An {@link OrderStatusRaw} object. For `matched` orders the fields
 *          `exec_size` and `average_price` are populated from real trades;
 *          otherwise they are left `undefined`.
 *
 * @throws If the request fails, the exchange returns an error, or the response
 *         does not contain an `orderID`.
 */
export async function placeMakerOrder(
    client: ClobClient,
    tokenId: string,
    side: Side,
    price: number,
    size: number,
    feesEnabled: boolean,
    takerBaseFeeBps: number,
): Promise<OrderStatusRaw> {
    try {
        const order = await client.createOrder({
            tokenID: tokenId,
            price,
            size,
            side,
        });

        const response = await client.postOrder(order, OrderType.GTC, false, true);
        if (!response.success) throw new Error(response.errorMsg);
        if (response.error) throw new Error(response.error);
        if (!response.orderID) throw new Error('OrderID missing!');

        if (response.status === "matched") {
            const tradeIds: string[] = response.tradeIDs ?? [];
            let execSize = size;      // fallback
            let avgPrice = price;     // fallback
            let takerFee = feesEnabled
                ? calculateTakerFee(execSize, avgPrice, feeRateBpsToDecimal(takerBaseFeeBps))
                : 0;

            if (tradeIds.length > 0) {
                const trades = await fetchTradesByIds(client, tradeIds);
                if (trades.length > 0) {
                    const result = computeImmediateOrderExecution(trades, feesEnabled);

                    execSize = safeFloat(result.filledSize, DEFAULT_ORDER_AMOUNT_FRACTION);
                    // VWAP across tick-sized trades can have more decimal places than one trade price.
                    avgPrice = safeFloat(result.averagePrice, DEFAULT_ORDER_AMOUNT_FRACTION);
                    takerFee = result.takerFee;
                }
            }

            return {
                success: true,
                orderID: response.orderID,
                status: "matched",
                executed_size: execSize,
                average_price: avgPrice,
                taker_fee: takerFee,
            };
        }

        return { success: true, orderID: response.orderID, status: response.status };
    } catch (error) {
        throw new Error(`Failed to place maker order: ${error_str(error)}`);
    }
}

/**
 * Cancels a single order by its order ID.
 * @param client - Initialized and authenticated CLOB client.
 * @param orderId - The order ID (string) returned when the order was placed.
 * @returns Promise that resolves when cancelled (no value), rejects on error.
 */
export async function cancelOrder(client: ClobClient, orderId: string): Promise<void> {
    try {
        const response = await client.cancelOrder({orderID: orderId});
        // Code do not checks "not_canceled": {} in response to multiple cancel strategy
        if (response.error) throw new Error(response.error);
    } catch (error) {
        throw new Error(`Failed to cancel order ${orderId}: ${error_str(error)}`);
    }
}

/**
 * Cancels all open orders for a specific token.
 * @param client - Initialized CLOB client.
 * @param tokenId - The token ID for which to cancel orders.
 */
export async function cancelAllOrdersForToken(client: ClobClient, tokenId: string): Promise<void> {
    try {
        const openOrders = await client.getOpenOrders({asset_id: tokenId});
        // If the client supports batch cancellation
        const orderIds = openOrders.map(order => order.id);
       
        const cancelPromises = orderIds.map(orderid => cancelOrder(client, orderid));
        const results = await Promise.allSettled(cancelPromises);
        let isError = false;
        let errorMsg = ''

        results.forEach(value => {
            if (value.status === 'rejected') {
                isError = true;
                errorMsg += `${error_str(value.reason)}: `
            }});
        if (isError) throw new Error(errorMsg);

    } catch (error) {
        throw new Error(`Failed to cancel orders for token ${tokenId}: ${error_str(error)}`);
    }
}

/**
 * Cancels all open orders for the authenticated user (across all tokens).
 * Use with caution.
 * @param client - Initialized CLOB client.
 */
export async function cancelAllOrders(client: ClobClient): Promise<void> {
    try {
        const allOrders = await client.getOpenOrders();
        const cancelPromises = allOrders.map(order => cancelOrder(client, order.id));

        const results = await Promise.allSettled(cancelPromises);
        let isError = false;
        let errorMsg = ''

        results.forEach(value => {
            if (value.status === 'rejected') {
                isError = true;
                errorMsg += `${error_str(value.reason)}: `
            }});
        if (isError) throw new Error(errorMsg);
    } catch (error) {
        throw new Error(`Failed to cancel all orders: ${error_str(error)}`);
    }
}

/**
 * Places a marketable GTC limit order, reads its immediate execution, and cancels
 * any remaining quantity without waiting for the order to rest in the book.
 */
export async function placeGtcTakerOrder(
    client: ClobClient,
    tokenId: string,
    side: Side,
    price: number,
    size: number,
    feesEnabled: boolean,
    takerBaseFeeBps: number,
): Promise<GtcTakerOrderAttemptResult> {
    let orderID: string | undefined;
    try {
        const order = await client.createOrder({
            tokenID: tokenId,
            price,
            size,
            side,
        });
        const response = await client.postOrder(order, OrderType.GTC, false, false);
        if (!response.success) throw new Error(response.errorMsg);
        if (response.error) throw new Error(response.error);
        if (!response.orderID) throw new Error('OrderID missing!');

        const postedOrderID = response.orderID;
        orderID = postedOrderID;
        return await recoverGtcTakerOrder(
            client, postedOrderID, size, price, feesEnabled, takerBaseFeeBps, response.tradeIDs,
        );
    } catch (error) {
        if (orderID !== undefined) {
            return {
                orderID,
                fillStatus: 'recovery_required',
                recoveryStage: 'read_status',
                error: error_str(error),
            };
        }
        throw new Error(`Failed to place GTC taker order: ${error_str(error)}`);
    }
}

/**
 * Reads the final state of a known GTC taker order and cancels its unfilled remainder.
 */
export async function recoverGtcTakerOrder(
    client: ClobClient,
    orderID: string,
    size: number,
    price: number,
    feesEnabled: boolean,
    takerBaseFeeBps: number,
    responseTradeIds: TradeIdList = undefined,
): Promise<GtcTakerOrderResult> {
    const beforeCancel = await client.getOrder(orderID);
    let finalStatus: OpenOrder = beforeCancel;
    if (safeToNum(beforeCancel.size_matched) < size) {
        await cancelOrder(client, orderID);
        finalStatus = await client.getOrder(orderID);
    }

    const tradeIds = getUniqueTradeIds(responseTradeIds, beforeCancel.associate_trades, finalStatus.associate_trades);
    const trades = await fetchTradesByIds(client, tradeIds);
    const execution = trades.length > 0
        ? computeImmediateOrderExecution(trades, feesEnabled)
        : undefined;
    const filledSize = Math.max(safeToNum(finalStatus.size_matched), execution?.filledSize ?? 0);
    return createGtcTakerOrderResult(orderID, size, price, filledSize, execution, feesEnabled, takerBaseFeeBps);
}

/**
 * Places an immediate FOK (Fill-Or-Kill) market order to buy a specified dollar amount.
 * The order will either be filled completely at the best available price or canceled.
 *
 * @param client - An initialized and authenticated CLOB client.
 * @param tokenId - The token ID for the specific outcome (e.g., "Yes" token).
 * @param amount - The dollar amount you want to spend.
 * @param maxPrice - Your slippage protection: the worst price per share you are willing to pay.
 * @returns Promise resolving to an object containing the order ID.
 */
export async function placeFokMarketOrderBuy(
    client: ClobClient,
    tokenId: string,
    amount: number,
    maxPrice: number
): Promise<OrderStatusRaw> {
    try {
        const tickSize = await client.getTickSize(tokenId);

        const order = await client.createMarketOrder(
            {
                tokenID: tokenId,
                side: Side.BUY,
                amount: amount,
                price: maxPrice,
            },
            { tickSize, negRisk: false }
        );

        const response = await client.postOrder(order, OrderType.FOK);

        if (!response.success) throw new Error(response.errorMsg);
        if (response.error) throw new Error(response.error);
        
        if (!response.orderID) {
            throw new Error('Order placed but orderID is missing in response!');
        }
        return { success: response.success, orderID: response.orderID, status: response.status };

    } catch (error) {
        throw new Error(`FOK order failed: ${error_str(error)}`);
    }
}

/**
 * Retrieves the USD balance (collateral) for the authenticated CLOB client.
 * @param client - Authenticated ClobClient instance
 * @returns Promise resolving to the balance as a number (may be 0 on conversion failure)
 * @throws If the API call fails (network, auth, etc.)
 */
export async function getUSDBalance(client: ClobClient): Promise<number> {
        const balanceInfo = await client.getBalanceAllowance({ 
        asset_type: AssetType.COLLATERAL 
    });
    return safeToNum(balanceInfo.balance) / 1e6;
}
