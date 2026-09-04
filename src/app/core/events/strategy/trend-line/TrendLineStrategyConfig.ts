/** Immutable signal parameters shared by live V1/V2 and their offline baselines. */
export interface TrendLineStrategyConfig {
    orderVolume: number;
    initialBalance: number;
    priceBuyStart: number;
    priceBuyStartMirror: number;
    priceBuyEnd: number;
    mirrorLineStart: number;
    priceSellLevel: number;
    mirrorExitLevel: number;
    maxBuyPrice: number | undefined;
    mirrorMaxBuyPrice: number | undefined;
    exitCTimeFactor: number | undefined;
    startIntervalFactor: number;
    startDiffPriceFactor: number | undefined;
    endIntervalFactor: number;
}

export const COIN_TREND_LINE_V1_CONFIG: Readonly<TrendLineStrategyConfig> = Object.freeze({
    orderVolume: 5,
    initialBalance: 6,
    priceBuyStart: 0.55,
    priceBuyStartMirror: 0.51,
    priceBuyEnd: 1,
    mirrorLineStart: 0.45,
    priceSellLevel: 0.46,
    mirrorExitLevel: 0.1,
    maxBuyPrice: undefined,
    mirrorMaxBuyPrice: undefined,
    exitCTimeFactor: undefined,
    startIntervalFactor: 0.015,
    startDiffPriceFactor: undefined,
    endIntervalFactor: 0.9725,
});

export const COIN_TREND_LINE_V2_CONFIG: Readonly<TrendLineStrategyConfig> = Object.freeze({
    orderVolume: 5,
    initialBalance: 6,
    priceBuyStart: 0.55,
    priceBuyStartMirror: 0.51,
    priceBuyEnd: 1,
    mirrorLineStart: 0.45,
    priceSellLevel: 0.46,
    mirrorExitLevel: 0.295,
    maxBuyPrice: 0.71,
    mirrorMaxBuyPrice: 0.635,
    exitCTimeFactor: 0.75,
    startIntervalFactor: 0.01,
    startDiffPriceFactor: 5.1,
    endIntervalFactor: 0.9725,
});
