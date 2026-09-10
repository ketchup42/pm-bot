import { ClobClient } from '@polymarket/clob-client-v2';
import { logger } from '../../../../../log.js';
import { MarketOrderBooksWatcher } from '../../../../../market/orderbook/watcher/MarketOrderBooksWatcher.js';
import { LiveOrderWallet } from '../../../../../market/orders/LiveOrderWallet.js';
import { MultiOrderWallet } from '../../../../../market/orders/MultiOrderWallet.js';
import { ORDER_WALLET_FRACTION, OrderWalletParams, OrderWalletState } from '../../../../../market/orders/OrderWallet.js';
import { VirtualTakerLiveOrderWallet } from '../../../../../market/orders/VirtualTakerLiveOrderWallet.js';
import { LiveOrdersWatcherRTDS } from '../../../../../market/orders/watcher/LiveOrdersWatcherRTDS.js';
import { MarketSide } from '../../../../../market/side.js';
import { DEFAULT_BUY_ORDER_MIN_VALUE } from '../../../../../rest/orders.js';
import { error_str, safeFloat } from '../../../../../utils.js';
import { ExecScheduler } from '../../../ExecScheduler.js';
import { CoinFrameEventMarketData } from '../../../history/coin_frame.js';
import { EventWatcher } from '../../EventWatcher.js';
import { EventStrategy } from '../EventStrategy.js';
import {
    DOGE_BASELINE_INITIAL_BALANCE,
    DOGE_BASELINE_MAX_ORDER_VALUE,
    DOGE_BASELINE_MODES,
    DogeBaselineModeName,
} from './DogeBaselineConfig.js';
import {
    DogeBaselineModel,
    makeDogeBaselineFeaturesFromPrices,
    predictDogeBaseline,
    readDogeBaselineModel,
} from './DogeBaselineModel.js';
import {
    calculateDogeBaselineEntryLimit,
    DogeBaselineEntry,
    evaluateDogeBaselineEmergencyExit,
    getDogeBaselinePredictedSide,
    selectDogeBaselineEntry,
} from './DogeBaselineDecision.js';

export class CoinDogeBaselineStrategy implements EventStrategy<CoinFrameEventMarketData> {
    private event: EventWatcher<CoinFrameEventMarketData> | undefined;
    private market: MarketOrderBooksWatcher | undefined;
    private wallet: MultiOrderWallet | undefined;
    private walletSide: MarketSide | undefined;
    private sellOrder: OrderWalletState | undefined;
    private entryPrice: number | undefined;
    private adverseSince: number | undefined;
    private emergencyExitCoinPrice: number | undefined;
    private emergencyExitFrameStartPrice: number | undefined;
    private entered = false;
    private stopped = false;
    private readonly evaluatedModes = new Set<DogeBaselineModeName>();

    private constructor(
        private readonly eventId: string,
        private readonly isDebug: boolean,
        private readonly scheduler: ExecScheduler,
        private readonly model: Readonly<DogeBaselineModel> | undefined,
    ) {}

    public static async create(
        eventId: string,
        isDebug: boolean,
        scheduler: ExecScheduler,
    ): Promise<CoinDogeBaselineStrategy> {
        let model: DogeBaselineModel | undefined;
        try {
            model = await readDogeBaselineModel();
        } catch (error) {
            logger.error(`[DogeBaseline][${eventId}] Model unavailable; frame will be skipped: ${error_str(error)}`);
        }
        return new CoinDogeBaselineStrategy(eventId, isDebug, scheduler, model);
    }

    public async execute(
        client: ClobClient,
        watchers: readonly EventWatcher<CoinFrameEventMarketData>[],
    ): Promise<boolean> {
        if (!this.initialize(watchers)) return false;
        if (!this.model) return false;
        if (this.sellOrder && !this.wallet?.isLive(this.sellOrder.id)) this.sellOrder = undefined;

        const history = this.event!.getWatcherHistoryUp()[0];
        if (await this.applyEmergencyExit(history)) return true;
        if (this.entered || this.stopped) return false;

        if (!history?.coin_frame_start_price) return false;
        const prices = history.side_token_market_snapshots
            .filter(value => value.coin_price !== undefined)
            .map(value => ({ price: value.coin_price!, timestamp: value.timestamp }));
        const elapsedMs = Date.now() - history.start_time * 1_000;
        for (const mode of DOGE_BASELINE_MODES) {
            if (elapsedMs < mode.offsetMs || this.evaluatedModes.has(mode.name)) continue;
            this.evaluatedModes.add(mode.name);
            const features = makeDogeBaselineFeaturesFromPrices(
                history.coin_frame_start_price,
                history.start_time * 1_000,
                prices,
                mode.offsetMs,
                mode.lookbacksMs,
            );
            if (!features) continue;
            const probability = predictDogeBaseline(this.model.modes[mode.name], features);
            const deviationBps = (Math.exp(features.at(-1)!) - 1) * 10_000;
            const candidate = this.selectCandidate(mode.name, probability, deviationBps);
            if (candidate && await this.enter(client, candidate, mode.name, probability, deviationBps)) return true;
        }
        return false;
    }

    public async cancel(
        client: ClobClient,
        watchers: readonly EventWatcher<CoinFrameEventMarketData>[],
        isSignal: boolean,
    ): Promise<boolean> {
        if (this.wallet) await this.wallet.dispose(isSignal || this.isDebug || this.stopped);
        const finalBalance = this.wallet?.getBalance() ?? DOGE_BASELINE_INITIAL_BALANCE;
        this.log(`Strategy cancelled. Final balance: ${finalBalance.toFixed(2)}`);
        return true;
    }

    private initialize(watchers: readonly EventWatcher<CoinFrameEventMarketData>[]): boolean {
        this.event ??= watchers.find(value => value.getEventId() === this.eventId);
        this.market ??= this.event?.getMarketOrderBooksWatchers()[0];
        return this.event !== undefined && this.market !== undefined;
    }

    private selectCandidate(
        mode: DogeBaselineModeName,
        upProbability: number,
        deviationBps: number,
    ): DogeBaselineEntry | undefined {
        const market = this.market!;
        const marketData = market.getMarketData();
        const predictedSide = getDogeBaselinePredictedSide(upProbability);
        const candidate = selectDogeBaselineEntry(upProbability, {
            upAsk: market.getBestAsk('up'),
            downAsk: market.getBestAsk('down'),
            feesEnabled: marketData.fees_enabled,
            takerBaseFee: marketData.taker_base_fee,
        });
        if (!candidate) {
            this.log(
                `${mode}: no entry predicted=${predictedSide ?? 'neutral'} pUp=${upProbability.toFixed(5)} ` +
                `deviationBps=${deviationBps.toFixed(3)} reason=predicted_side_unavailable_or_insufficient_edge`,
            );
        }
        return candidate;
    }

    private async enter(
        client: ClobClient,
        candidate: DogeBaselineEntry,
        mode: DogeBaselineModeName,
        upProbability: number,
        deviationBps: number,
    ): Promise<boolean> {
        let wallet: MultiOrderWallet | undefined;
        try {
            wallet = await this.createWallet(client, candidate.side);
            const price = safeFloat(
                calculateDogeBaselineEntryLimit(candidate.ask, wallet.getTick()),
                ORDER_WALLET_FRACTION,
            );
            const quantity = DOGE_BASELINE_MAX_ORDER_VALUE / price;
            const state = await wallet.buy(price, quantity);
            if (!state) return false;
            this.wallet = wallet;
            this.walletSide = candidate.side;
            this.entryPrice = state.value.price;
            this.entered = true;
            this.log(
                `${mode}: BUY ${candidate.side} ${state.value.quantity} @ ${state.value.price}, ` +
                `pUp=${upProbability.toFixed(5)} predicted=${candidate.side} ` +
                `deviationBps=${deviationBps.toFixed(3)} ask=${candidate.ask} ` +
                `fee=${candidate.fee.toFixed(5)} edge=${candidate.edge.toFixed(5)}`,
            );
            return true;
        } catch (error) {
            logger.error(`[DogeBaseline][${this.eventId}] Entry failed: ${error_str(error)}`);
            return false;
        } finally {
            if (this.wallet !== wallet && wallet) {
                try {
                    await wallet.dispose(false);
                } catch (error) {
                    logger.error(`[DogeBaseline][${this.eventId}] Failed to dispose rejected entry wallet: ${error_str(error)}`);
                }
            }
        }
    }

    private async applyEmergencyExit(history: CoinFrameEventMarketData | undefined): Promise<boolean> {
        if (!this.wallet || !this.walletSide) return false;
        if (!this.stopped) {
            const snapshot = history?.side_token_market_snapshots.at(-1);
            if (!history?.coin_frame_start_price || snapshot?.coin_price === undefined) return false;
            const previousAdverseSince = this.adverseSince;
            const state = evaluateDogeBaselineEmergencyExit({
                side: this.walletSide,
                frameStartPrice: history.coin_frame_start_price,
                currentPrice: snapshot.coin_price,
                timestamp: snapshot.timestamp,
                frameEndTimestamp: history.end_time * 1_000,
                adverseSince: this.adverseSince,
            });
            this.adverseSince = state.adverseSince;
            if (state.adverse && previousAdverseSince === undefined) {
                this.log(
                    `Emergency exit confirmation started: side=${this.walletSide} ` +
                    `coin=${snapshot.coin_price} start=${history.coin_frame_start_price}`,
                );
            } else if (!state.adverse && previousAdverseSince !== undefined) {
                this.log(`Emergency exit confirmation reset: side=${this.walletSide} coin=${snapshot.coin_price}`);
            }
            if (!state.triggered) return false;
            this.stopped = true;
            this.emergencyExitCoinPrice = snapshot.coin_price;
            this.emergencyExitFrameStartPrice = history.coin_frame_start_price;
            this.scheduler.pause();
        }

        const tokens = this.wallet.getTokensQuantity();
        const bid = this.market!.getBestBid(this.walletSide);
        if (tokens <= 0 || bid === undefined) return false;
        if (this.sellOrder) return false;
        const state = await this.wallet.sell(this.wallet.getTick(), tokens);
        if (!state) {
            this.log(`Emergency exit sell failed; scheduler remains paused, retrying`);
            return false;
        }
        this.sellOrder = state;
        this.log(
            `Emergency exit ${this.walletSide}: bid=${bid}, entry=${this.entryPrice}; ` +
            `coin=${this.emergencyExitCoinPrice} start=${this.emergencyExitFrameStartPrice} ` +
            `reason=adverse_coin_direction_exit scheduler=PAUSED`,
        );
        return true;
    }

    private async createWallet(client: ClobClient, side: MarketSide): Promise<MultiOrderWallet> {
        const marketData = this.market!.getMarketData();
        const tokenData = side === 'up' ? this.market!.getUpMarketData() : this.market!.getDownMarketData();
        const params: OrderWalletParams = {
            token_id: tokenData.tokenId,
            balance: DOGE_BASELINE_INITIAL_BALANCE,
            tick_size: marketData.tick_size,
            min_order_size: marketData.min_order_size,
            min_buy_order_value: DEFAULT_BUY_ORDER_MIN_VALUE,
        };
        if (this.isDebug) return VirtualTakerLiveOrderWallet.create(params, this.market!);
        const watcher = await LiveOrdersWatcherRTDS.create(marketData.conditionId, client, client.creds);
        return LiveOrderWallet.create(client, params, watcher);
    }

    private log(message: string): void {
        logger.info(`[DogeBaseline][${this.eventId}] ${message}`);
    }
}
