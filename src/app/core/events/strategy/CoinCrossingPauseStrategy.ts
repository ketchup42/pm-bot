import { ClobClient } from "@polymarket/clob-client-v2";
import { EventStrategy } from "./EventStrategy.js";
import { CoinFrameEventMarketData } from "../../history/coin_frame.js";
import { EventWatcher } from "../EventWatcher.js";
import { logger } from "../../../../log.js";
import { CoinPriceWatcher } from "../../../../market/price/CoinPriceWatcher.js";
import { PriceWatcherFactory } from "../../../../market/price/PriceWatcherFactory.js";
import { PriceSource, PS_CHAINLINK_TWAP_60 } from "../../../../market/price/price_source.js";
import { Coin } from "../../../../market/coins.js";
import { ExecScheduler } from "../../ExecScheduler.js";

/** Side of the coin price relative to the frame start price (within the deviation band logic). */
type CrossingSide = 'above' | 'below';

interface AbsoluteCrossingDeviation {
    kind: 'absolute';
    amount: number;
}

interface RelativeCrossingDeviation {
    kind: 'relative';
    factor: number;
}

type CrossingDeviation = AbsoluteCrossingDeviation | RelativeCrossingDeviation;

/**
 * Non-trading strategy for a shadow scheduler. It observes a selected coin price relative
 * to its frame-start price, counts transitions between the sides of the `deviation` band,
 * and temporarily pauses the referenced master scheduler when crossings exceed
 * `maxCrossings`. Coin, source, deviation, and threshold are provided by the caller.
 * On a signal-driven cancel the pause decision is skipped.
 */
export class CoinCrossingPauseStrategy implements EventStrategy<CoinFrameEventMarketData> {
    private readonly _eventId: string;
    private readonly _coin: Coin;
    private readonly _scheduler: ExecScheduler;
    private readonly _maxCrossings: number;
    private readonly _deviation: CrossingDeviation;
    private readonly _coinWatcher: CoinPriceWatcher;

    private _event: EventWatcher<CoinFrameEventMarketData> | undefined = undefined;
    private _crossings: number = 0;
    private _lastSide: CrossingSide | undefined = undefined;

    private constructor(
        eventId: string,
        coin: Coin,
        scheduler: ExecScheduler,
        maxCrossings: number,
        deviation: CrossingDeviation,
        source: PriceSource,
    ) {
        const deviationValue = deviation.kind === 'absolute' ? deviation.amount : deviation.factor;
        if (deviationValue <= 0) {
            throw new Error(`[CoinCrossingPause] deviation must be > 0, got ${deviationValue}`);
        }
        if (maxCrossings < 0) {
            throw new Error(`[CoinCrossingPause] maxCrossings must be >= 0, got ${maxCrossings}`);
        }

        this._eventId = eventId;
        this._coin = coin;
        this._scheduler = scheduler;
        this._maxCrossings = maxCrossings;
        this._deviation = deviation;
        this._coinWatcher = PriceWatcherFactory.getCoinWatcher(coin, source);
    }

    public static async create(
        eventId: string,
        coin: Coin,
        scheduler: ExecScheduler,
        maxCrossings: number,
        deviation: number
    ): Promise<CoinCrossingPauseStrategy> {
        return new CoinCrossingPauseStrategy(
            eventId, coin, scheduler, maxCrossings,
            { kind: 'absolute', amount: deviation }, PS_CHAINLINK_TWAP_60,
        );
    }

    public static async createRelative(
        eventId: string,
        coin: Coin,
        scheduler: ExecScheduler,
        maxCrossings: number,
        deviationFactor: number,
        source: PriceSource,
    ): Promise<CoinCrossingPauseStrategy> {
        return new CoinCrossingPauseStrategy(
            eventId, coin, scheduler, maxCrossings,
            { kind: 'relative', factor: deviationFactor }, source,
        );
    }

    private log(msg: string): void {
        logger.info(`[CoinCrossingPause][${this._eventId}][${this._coin}] ${msg}`);
    }

    public async execute(client: ClobClient, watchers: readonly EventWatcher<CoinFrameEventMarketData>[]): Promise<boolean> {
        if (!this._event) {
            this._event = watchers.find(w => w.getEventId() === this._eventId);
            if (!this._event) return false;
        }

        const history = this._event.getWatcherHistoryUp()[0]; // coin_frame_start_price is the same for up/down
        if (!history?.coin_frame_start_price) return false;

        const price = this._coinWatcher.getCoinPrice();
        if (price === undefined) return false;

        const start = history.coin_frame_start_price;
        const deviation = this._deviation.kind === 'relative'
            ? start * this._deviation.factor
            : this._deviation.amount;

        // Hysteresis band around the start price: a crossing is counted only when the price
        // moves from above (start + deviation) to below (start - deviation) or the reverse.
        let side: CrossingSide | undefined;
        if (price >= start + deviation) {
            side = 'above';
        } else if (price <= start - deviation) {
            side = 'below';
        } else {
            side = undefined;
        }

        if (side && this._lastSide && side !== this._lastSide) {
            this._crossings++;
            this.log(`Crossing #${this._crossings} (${this._lastSide} -> ${side})`);
        }
        if (side) this._lastSide = side;

        return false; // this strategy does not trade
    }

    public async cancel(client: ClobClient, watchers: readonly EventWatcher<CoinFrameEventMarketData>[], isSignal: boolean): Promise<boolean> {
        if (!isSignal) {
            if (this._crossings > this._maxCrossings) {
                this._scheduler.pause();
                this.log(`Crossings ${this._crossings} > ${this._maxCrossings} -> scheduler PAUSED`);
            } else {
                this._scheduler.unpause();
                this.log(`Crossings ${this._crossings} <= ${this._maxCrossings} -> scheduler UNPAUSED`);
            }
        }

        this._crossings = 0;
        this._lastSide = undefined;
        this._event = undefined;

        return true;
    }
}
