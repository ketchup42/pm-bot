import { calculateTakerFee, feeRateBpsToDecimal, TAKER_FEE_DECIMAL_PLACES } from '../../rest/fees.js';
import { safeFloat, safeToNum } from '../../utils.js';

export type TakerExecutionAction = 'buy' | 'sell';
export type TakerExecutionFillStatus = 'none' | 'partial' | 'full';
export type TakerExecutionFilledStatus = Exclude<TakerExecutionFillStatus, 'none'>;

export interface TakerExecutionLevel {
    price: string;
    size: string;
}

export interface TakerExecutionParams {
    action: TakerExecutionAction;
    levels: readonly TakerExecutionLevel[];
    quantity: number;
    limitPrice: number;
    tickSize: number;
    feesEnabled: boolean;
    takerBaseFeeBps: number;
}

interface TakerExecutionCommonResult {
    requestedQuantity: number;
    filledQuantity: number;
    remainingQuantity: number;
    grossValue: number;
    fee: number;
}

export interface TakerExecutionNoneResult extends TakerExecutionCommonResult {
    fillStatus: 'none';
    averagePrice: undefined;
    bestPrice: undefined;
}

export interface TakerExecutionFilledResult extends TakerExecutionCommonResult {
    fillStatus: TakerExecutionFilledStatus;
    averagePrice: number;
    bestPrice: number;
}

export type TakerExecutionResult = TakerExecutionNoneResult | TakerExecutionFilledResult;

function roundLimit(price: number, tick: number, action: TakerExecutionAction): number {
    const units = price / tick;
    const rounded = action === 'buy' ? Math.floor(units + 1e-9) : Math.ceil(units - 1e-9);
    return Math.round(rounded * tick * 1e8) / 1e8;
}

/** Calculates an immediate taker fill by walking executable order-book levels. */
export function calculateTakerExecution(params: Readonly<TakerExecutionParams>): TakerExecutionResult {
    const limit = roundLimit(params.limitPrice, params.tickSize, params.action);
    const levels = params.levels
        .map(level => ({ price: safeToNum(level.price, Number.NaN), size: safeToNum(level.size, Number.NaN) }))
        .filter(level => Number.isFinite(level.price) && Number.isFinite(level.size) && level.size > 0)
        .sort((left, right) => params.action === 'buy' ? left.price - right.price : right.price - left.price);

    let remainingQuantity = params.quantity;
    let grossValue = 0;
    let fee = 0;
    let bestPrice: number | undefined;
    const feeRate = feeRateBpsToDecimal(params.takerBaseFeeBps);
    for (const level of levels) {
        const executable = params.action === 'buy' ? level.price <= limit : level.price >= limit;
        if (!executable) break;
        const quantity = Math.min(remainingQuantity, level.size);
        if (quantity <= 0) continue;
        bestPrice ??= level.price;
        grossValue += quantity * level.price;
        if (params.feesEnabled) {
            fee = safeFloat(fee + calculateTakerFee(quantity, level.price, feeRate), TAKER_FEE_DECIMAL_PLACES);
        }
        remainingQuantity -= quantity;
        if (remainingQuantity <= 1e-9) {
            remainingQuantity = 0;
            break;
        }
    }

    const filledQuantity = params.quantity - remainingQuantity;
    const common: TakerExecutionCommonResult = {
        requestedQuantity: params.quantity,
        filledQuantity,
        remainingQuantity,
        grossValue,
        fee,
    };
    if (filledQuantity <= 1e-9) {
        return { ...common, fillStatus: 'none', averagePrice: undefined, bestPrice: undefined };
    }
    if (bestPrice === undefined) throw new Error('taker_execution_missing_best_price');
    const filled = { ...common, averagePrice: grossValue / filledQuantity, bestPrice };
    return remainingQuantity <= 1e-9
        ? { ...filled, fillStatus: 'full' }
        : { ...filled, fillStatus: 'partial' };
}
