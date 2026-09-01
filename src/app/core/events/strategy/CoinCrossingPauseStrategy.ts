import { ClobClient } from "@polymarket/clob-client-v2";
import { EventStrategy } from "./EventStrategy.js";
import { CoinFrameEventMarketData } from "../../history/coin_frame.js";
import { EventWatcher } from "../EventWatcher.js";
import { logger } from "../../../../log.js";
import { CoinPriceWatcher } from "../../../../market/price/CoinPriceWatcher.js";
import { PriceWatcherFactory } from "../../../../market/price/PriceWatcherFactory.js";
import { PS_CHAINLINK_TWAP_60 } from "../../../../market/price/price_source.js";
import { Coin } from "../../../../market/coins.js";
import { ExecScheduler } from "../../ExecScheduler.js";

/** Side of the coin price relative to the frame start price (within the deviation band logic). */
type CrossingSide = 'above' | 'below';

/**
 * Non-trading strategy that counts how many times the coin price crossed the frame start
 * price (with a hysteresis band of `deviation` around it). On the end of the frame it
 * pauses the referenced scheduler if the crossing count exceeds `maxCrossings`, otherwise
 * it unpauses it. On a signal-driven cancel the pause decision is skipped.
 */
export class CoinCrossingPauseStrategy implements EventStrategy<CoinFrameEventMarketData> {
    private readonly _eventId: string;
    private readonly _coin: Coin;
    private readonly _scheduler: ExecScheduler;
    private readonly _maxCrossings: number;
    private readonly _deviation: number;
    private readonly _coinWatcher: CoinPriceWatcher;

    private _event: EventWatcher<CoinFrameEventMarketData> | undefined = undefined;
    private _crossings: number = 0;
    private _lastSide: CrossingSide | undefined = undefined;

    private constructor(
        eventId: string,
        coin: Coin,
        scheduler: ExecScheduler,
        maxCrossings: number,
        deviation: number
    ) {
        if (deviation <= 0) {
            throw new Error(`[CoinCrossingPause] deviation must be > 0, got ${deviation}`);
        }
        if (maxCrossings < 0) {
            throw new Error(`[CoinCrossingPause] maxCrossings must be >= 0, got ${maxCrossings}`);
        }

        this._eventId = eventId;
        this._coin = coin;
        this._scheduler = scheduler;
        this._maxCrossings = maxCrossings;
        this._deviation = deviation;
        this._coinWatcher = PriceWatcherFactory.getCoinWatcher(coin, PS_CHAINLINK_TWAP_60);
    }

    public static async create(
        eventId: string,
        coin: Coin,
        scheduler: ExecScheduler,
        maxCrossings: number,
        deviation: number
    ): Promise<CoinCrossingPauseStrategy> {
        return new CoinCrossingPauseStrategy(eventId, coin, scheduler, maxCrossings, deviation);
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

        // Hysteresis band around the start price: a crossing is counted only when the price
        // moves from above (start + deviation) to below (start - deviation) or the reverse.
        let side: CrossingSide | undefined;
        if (price >= start + this._deviation) {
            side = 'above';
        } else if (price <= start - this._deviation) {
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