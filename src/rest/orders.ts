import { ClobClient, Side, OrderType } from "@polymarket/clob-client"
import { delay, error_str, safeToNum } from "../utils.js";

/**
 * Places a maker order on Polymarket. This order will never be charged a fee.
 * 
 * @param clobClient - An initialized and authenticated CLOB client.
 * @param tokenId - The token ID for the specific outcome (e.g., "Yes" token).
 * @param side - Side.BUY or Side.SELL.
 * @param price - The limit price per share (e.g., 0.65).
 * @param size - The number of shares to buy or sell.
 * @returns Promise that resolves when order is placed (no value), rejects on error.
 */
export async function placeMakerOrder(
    clobClient: ClobClient,
    tokenId: string,
    side: Side,
    price: number,
    size: number
): Promise<{orderId: string}> {
    try {
        const order = await clobClient.createOrder({
            tokenID: tokenId,
            price: price,
            size: size,
            side: side,
        });

        const response = await clobClient.postOrder(
            order,
            OrderType.GTC,
            false,
            true
        );
        return { orderId: response.orderId };
    } catch (error) {
        throw new Error(`Failed to place maker order: ${error_str(error)}`);
    }
}

/**
 * Cancels a single order by its order ID.
 * @param clobClient - Initialized and authenticated CLOB client.
 * @param orderId - The order ID (string) returned when the order was placed.
 * @returns Promise that resolves when cancelled (no value), rejects on error.
 */
export async function cancelOrder(clobClient: ClobClient, orderId: string): Promise<void> {
    try {
        await clobClient.cancelOrder({orderID: orderId});
    } catch (error) {
        throw new Error(`Failed to cancel order ${orderId}: ${error_str(error)}`);
    }
}

/**
 * Cancels all open orders for a specific token.
 * @param clobClient - Initialized CLOB client.
 * @param tokenId - The token ID for which to cancel orders.
 */
export async function cancelAllOrdersForToken(clobClient: ClobClient, tokenId: string): Promise<void> {
    try {
        const openOrders = await clobClient.getOpenOrders({asset_id: tokenId});
        // If the client supports batch cancellation
        const orderIds = openOrders.map(order => order.id);
        await clobClient.cancelOrders(orderIds);
    } catch (error) {
        throw new Error(`Failed to cancel orders for token ${tokenId}: ${error_str(error)}`);
    }
}

/**
 * Cancels all open orders for the authenticated user (across all tokens).
 * Use with caution.
 * @param clobClient - Initialized CLOB client.
 */
export async function cancelAllOrders(clobClient: ClobClient): Promise<void> {
    try {
        const allOrders = await clobClient.getOpenOrders();
        const cancelPromises = allOrders.map(order => cancelOrder(clobClient, order.id));
        await Promise.all(cancelPromises);
    } catch (error) {
        throw new Error(`Failed to cancel all orders: ${error_str(error)}`);
    }
}

export const GTC_TAKER_ORDER_CANCEL_TIME = 500;

/**
 * Places a GTC taker order with aggressive price.
 * Returns the order ID and the filled size.
 */
export async function placeGtcTakerOrder(
    clobClient: ClobClient,
    tokenId: string,
    side: Side,
    price: number,
    size: number,
    autoCancelAfterMs: number = GTC_TAKER_ORDER_CANCEL_TIME
): Promise<{ orderId: string; filledSize: number }> {
    const order = await clobClient.createOrder({
        tokenID: tokenId,
        price,
        size,
        side,
    });

    const response = await clobClient.postOrder(order, OrderType.GTC, false, false);
    const orderId = response.orderId;

    await delay(autoCancelAfterMs);

    const orderStatus = await clobClient.getOrder(orderId);
    const filledSize = safeToNum(orderStatus.size_matched);

    if (filledSize < size) {

        try {
            await clobClient.cancelOrder(orderId);
        } catch (error) {
            throw new Error(`Failed to cancel partial order ${orderId}: ${error_str(error)}`);
        }
    }
    return { orderId, filledSize };
}

/**
 * Places an FAK (Fill-And-Kill) order.
 * Executes as many shares as available immediately, cancels the rest.
 * 
 * @param clobClient - Initialized CLOB client
 * @param tokenId - Token ID for the outcome
 * @param side - Side.BUY or Side.SELL
 * @param amount - For BUY: USDC amount to spend; For SELL: number of shares to sell
 * @param maxPrice - For BUY: worst price per share (slippage protection); For SELL: minimum price per share
 * @returns Executed size (in shares) and average price
 */
export async function placeFakTakerOrder(
    clobClient: ClobClient,
    tokenId: string,
    side: Side,
    amount: number,      // BUY = USDC, SELL = shares
    maxPrice?: number    // BUY = max price per share, SELL = min price per share
): Promise<{ executedSize: number; avgPrice: number }> {
    const tickSize = await clobClient.getTickSize(tokenId);
    
    const order = await clobClient.createMarketOrder(
        {
            tokenID: tokenId,
            side,
            amount: amount,  // BUY = USDC, SELL = shares
            price: maxPrice ?? (side === Side.BUY ? Infinity : 0),
        },
        { tickSize: tickSize, negRisk: false }
    );
    
    const response = await clobClient.postOrder(order, OrderType.FAK);
    const fills = response.fills ?? response.result?.fills ?? [];
    
    const executedSize = fills.reduce((sum: any, f: { size: any; }) => sum + f.size, 0);
    const totalCost = fills.reduce((sum: number, f: { size: number; price: number; }) => sum + f.size * f.price, 0);
    const avgPrice = executedSize > 0 ? totalCost / executedSize : 0;
    
    return { executedSize, avgPrice };
}

/**
 * Places an immediate FOK (Fill-Or-Kill) market order to buy a specified dollar amount.
 * The order will either be filled completely at the best available price or canceled.
 *
 * @param clobClient - An initialized and authenticated CLOB client.
 * @param tokenId - The token ID for the specific outcome (e.g., "Yes" token).
 * @param amount - The dollar amount you want to spend.
 * @param maxPrice - Your slippage protection: the worst price per share you are willing to pay.
 * @returns Promise resolving to an object containing the order ID.
 */
export async function placeFokMarketOrderBuy(
    clobClient: ClobClient,
    tokenId: string,
    amount: number,
    maxPrice: number
): Promise<{ orderId: string }> {
    try {
        const tickSize = await clobClient.getTickSize(tokenId);

        const order = await clobClient.createMarketOrder(
            {
                tokenID: tokenId,
                side: Side.BUY,
                amount: amount,
                price: maxPrice,
            },
            { tickSize, negRisk: false }
        );

        const response = await clobClient.postOrder(order, OrderType.FOK);

        if (!response.orderId) {
            throw new Error('Order posted but no orderId returned');
        }

        return { orderId: response.orderId };
    } catch (error) {
        throw new Error(`"FOK order failed:": ${error_str(error)}`);
    }
}