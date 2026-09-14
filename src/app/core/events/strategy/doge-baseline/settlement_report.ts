import { calculateTakerExecution, type TakerExecutionLevel } from '../../../../../market/orders/TakerExecution.js';
import type { MarketSide } from '../../../../../market/side.js';
import { safeFloat } from '../../../../../utils.js';

export interface DogeBaselineSettlementReportInput {
    cash: number;
    side: MarketSide | undefined;
    tokenQuantity: number;
    frameStartPrice: number | undefined;
    frameEndPrice: number | undefined;
    bids: readonly TakerExecutionLevel[];
    tickSize: number;
    feesEnabled: boolean;
    takerBaseFeeBps: number;
}

export interface DogeBaselineSettlementReport {
    sourceOutcome: MarketSide | undefined;
    expectedPayout: number | undefined;
    expectedEquity: number | undefined;
    executableQuantity: number;
    executableProceeds: number | undefined;
    liquidationEquity: number | undefined;
}

export function getDogeBaselineFrameOutcome(
    startPrice: number | undefined,
    endPrice: number | undefined,
): MarketSide | undefined {
    if (startPrice === undefined || endPrice === undefined || startPrice === endPrice) return undefined;
    return endPrice > startPrice ? 'up' : 'down';
}

/** Builds a pre-settlement report without changing the wallet or placing an order. */
export function createDogeBaselineSettlementReport(
    input: Readonly<DogeBaselineSettlementReportInput>,
): DogeBaselineSettlementReport {
    const sourceOutcome = getDogeBaselineFrameOutcome(input.frameStartPrice, input.frameEndPrice);
    const expectedPayout = sourceOutcome === undefined || input.side === undefined
        ? undefined
        : input.side === sourceOutcome ? input.tokenQuantity : 0;
    const expectedEquity = expectedPayout === undefined
        ? undefined
        : safeFloat(input.cash + expectedPayout, 6);
    if (input.tokenQuantity <= 0) {
        return {
            sourceOutcome,
            expectedPayout,
            expectedEquity,
            executableQuantity: 0,
            executableProceeds: 0,
            liquidationEquity: input.cash,
        };
    }
    const execution = calculateTakerExecution({
        action: 'sell',
        levels: input.bids,
        quantity: input.tokenQuantity,
        limitPrice: input.tickSize,
        tickSize: input.tickSize,
        feesEnabled: input.feesEnabled,
        takerBaseFeeBps: input.takerBaseFeeBps,
    });
    if (execution.fillStatus === 'none') {
        return {
            sourceOutcome,
            expectedPayout,
            expectedEquity,
            executableQuantity: 0,
            executableProceeds: undefined,
            liquidationEquity: undefined,
        };
    }
    const executableProceeds = safeFloat(execution.grossValue - execution.fee, 6);
    return {
        sourceOutcome,
        expectedPayout,
        expectedEquity,
        executableQuantity: execution.filledQuantity,
        executableProceeds,
        liquidationEquity: execution.fillStatus === 'full'
            ? safeFloat(input.cash + executableProceeds, 6)
            : undefined,
    };
}
