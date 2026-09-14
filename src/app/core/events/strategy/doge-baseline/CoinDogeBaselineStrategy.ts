import { ClobClient } from '@polymarket/clob-client-v2';
import { logger } from '../../../../../log.js';
import { MarketOrderBooksWatcher } from '../../../../../market/orderbook/watcher/MarketOrderBooksWatcher.js';
import { MultiOrderWallet } from '../../../../../market/orders/MultiOrderWallet.js';
import { ORDER_WALLET_FRACTION, OrderWalletParams, OrderWalletState } from '../../../../../market/orders/OrderWallet.js';
import { TakerLiveOrderWallet } from '../../../../../market/orders/TakerLiveOrderWallet.js';
import { LiveOrdersWatcherRTDS } from '../../../../../market/orders/watcher/LiveOrdersWatcherRTDS.js';
import { VirtualTakerLiveOrderWallet } from '../../../../../market/orders/VirtualTakerLiveOrderWallet.js';
import { MarketSide } from '../../../../../market/side.js';
import { DEFAULT_BUY_ORDER_MIN_VALUE } from '../../../../../rest/orders.js';
import { error_str, safeFloat } from '../../../../../utils.js';
import { ExecScheduler } from '../../../ExecScheduler.js';
import { CoinFrameEventMarketData } from '../../../history/coin_frame.js';
import { EventWatcher } from '../../EventWatcher.js';
import { EventStrategy } from '../EventStrategy.js';
import {
    DOGE_BASELINE_DEFAULT_BALANCE,
    DOGE_BASELINE_DEFAULT_TRADE_VALUE,
    DOGE_BASELINE_MODES,
    type DogeBaselineModeName,
} from './DogeBaselineConfig.js';
import {
    DogeBaselineModel,
    makeDogeBaselineFeaturesFromPrices,
    predictDogeBaseline,
} from './DogeBaselineModel.js';
import {
    canRetryDogeBaselineEmergencyExit,
    type DogeBaselineExecutableEntry,
    evaluateDogeBaselineEmergencyExit,
    getDogeBaselinePredictedSide,
    selectDogeBaselineExecutableEntry,
} from './DogeBaselineDecision.js';
import {
    DogeBaselineStrategyConfig,
    readDogeBaselineArtifacts,
} from './artifacts.js';
import { createDogeBaselineSettlementReport, getDogeBaselineFrameOutcome } from './settlement_report.js';

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
    private emergencyExitNoLiquidityLogged = false;
    private emergencyExitSellFailureLogged = false;
    private emergencyExitMinimumSizeLogged = false;
    private emergencyExitCompletedLogged = false;
    private nextEmergencyExitAttemptTimestamp: number | undefined;
    private entered = false;
    private emergencyExitTriggered = false;
    private readonly evaluatedModes = new Set<DogeBaselineModeName>();

    private constructor(
        private readonly eventId: string,
        private readonly isDebug: boolean,
        private readonly scheduler: ExecScheduler,
        private readonly balance: number,
        private readonly tradeValue: number,
        private readonly model: Readonly<DogeBaselineModel> | undefined,
        private readonly strategyConfig: Readonly<DogeBaselineStrategyConfig> | undefined,
    ) {}

    public static async create(
        eventId: string,
        isDebug: boolean,
        scheduler: ExecScheduler,
        balance: number = DOGE_BASELINE_DEFAULT_BALANCE,
        tradeValue: number = DOGE_BASELINE_DEFAULT_TRADE_VALUE,
    ): Promise<CoinDogeBaselineStrategy> {
        let model: DogeBaselineModel | undefined;
        let strategyConfig: DogeBaselineStrategyConfig | undefined;
        try {
            const artifacts = await readDogeBaselineArtifacts();
            model = artifacts.model;
            strategyConfig = artifacts.config;
        } catch (error) {
            logger.error(`[DogeBaseline][${eventId}] Model or config unavailable; frame will be skipped: ${error_str(error)}`);
        }
        return new CoinDogeBaselineStrategy(eventId, isDebug, scheduler, balance, tradeValue, model, strategyConfig);
    }

    public async execute(
        client: ClobClient,
        watchers: readonly EventWatcher<CoinFrameEventMarketData>[],
    ): Promise<boolean> {
        if (!this.initialize(watchers)) return false;
        if (!this.model || !this.strategyConfig) return false;
        if (this.sellOrder && !this.wallet?.isLive(this.sellOrder.id)) this.sellOrder = undefined;

        const history = this.event!.getWatcherHistoryUp()[0];
        if (await this.applyEmergencyExit(history)) return true;
        if (this.entered || this.emergencyExitTriggered) return false;

        if (!history?.coin_frame_start_price) return false;
        const prices = history.side_token_market_snapshots
            .filter(value => value.coin_price !== undefined)
            .map(value => ({ price: value.coin_price!, timestamp: value.timestamp }));
        const elapsedMs = Date.now() - history.start_time * 1_000;
        for (const mode of DOGE_BASELINE_MODES) {
            const modeConfig = this.strategyConfig!.entry.modes[mode.name];
            if (!modeConfig.enabled) continue;
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
            const candidate = this.selectCandidate(mode.name, probability, deviationBps, modeConfig.minimumEdge);
            if (candidate && await this.enter(client, candidate, mode.name, probability, deviationBps)) return true;
        }
        return false;
    }

    public async cancel(
        client: ClobClient,
        watchers: readonly EventWatcher<CoinFrameEventMarketData>[],
        isSignal: boolean,
    ): Promise<boolean> {
        const history = this.event?.getWatcherHistoryUp()[0];
        if (this.wallet) {
            if (this.isDebug && !isSignal) this.settleVirtualPosition(history);
            await this.wallet.dispose(isSignal);
        }
        const finalBalance = this.wallet?.getBalance() ?? this.balance;
        if (!this.isDebug && !isSignal) {
            this.logLiveSettlementReport(history, finalBalance);
        } else if (!this.isDebug) {
            this.log(
                `Live strategy stopped: cash=${finalBalance.toFixed(6)} ` +
                `tokens=${this.wallet?.getTokensQuantity() ?? 0} side=${this.walletSide ?? 'undefined'}`,
            );
        } else {
            this.log(`Strategy cancelled. Final balance: ${finalBalance.toFixed(2)}`);
        }
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
        minimumEdge: number,
    ): DogeBaselineExecutableEntry | undefined {
        const market = this.market!;
        const marketData = market.getMarketData();
        const predictedSide = getDogeBaselinePredictedSide(upProbability);
        const candidate = selectDogeBaselineExecutableEntry(upProbability, {
            upAsk: market.getBestAsk('up'),
            downAsk: market.getBestAsk('down'),
            feesEnabled: marketData.fees_enabled,
            takerBaseFee: marketData.taker_base_fee,
        }, {
            upAsks: market.getAsksUp(),
            downAsks: market.getAsksDown(),
            tickSize: marketData.tick_size,
            minimumOrderValue: DEFAULT_BUY_ORDER_MIN_VALUE,
        }, minimumEdge, this.tradeValue);
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
        candidate: DogeBaselineExecutableEntry,
        mode: DogeBaselineModeName,
        upProbability: number,
        deviationBps: number,
    ): Promise<boolean> {
        let wallet: MultiOrderWallet | undefined;
        try {
            wallet = await this.createWallet(client, candidate.side);
            const price = safeFloat(candidate.limitPrice, ORDER_WALLET_FRACTION);
            const quantity = candidate.requestedQuantity;
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
        if (!this.wallet || !this.walletSide || !this.strategyConfig?.exit.enabled) return false;
        if (!this.emergencyExitTriggered) {
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
            }, this.strategyConfig.exit);
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
            this.emergencyExitTriggered = true;
            this.emergencyExitCoinPrice = snapshot.coin_price;
            this.emergencyExitFrameStartPrice = history.coin_frame_start_price;
            this.scheduler.pause();
            this.log(
                `Emergency exit triggered: side=${this.walletSide} ` +
                `coin=${snapshot.coin_price} start=${history.coin_frame_start_price} scheduler=PAUSED`,
            );
        }

        const tokens = this.wallet.getTokensQuantity();
        if (tokens <= 1e-9) {
            if (!this.emergencyExitCompletedLogged) {
                this.emergencyExitCompletedLogged = true;
                this.log(`Emergency exit completed: side=${this.walletSide} remaining=0`);
            }
            return false;
        }
        if (this.sellOrder) return false;
        const timestamp = history?.side_token_market_snapshots.at(-1)?.timestamp;
        if (timestamp === undefined || !canRetryDogeBaselineEmergencyExit(timestamp, this.nextEmergencyExitAttemptTimestamp)) {
            return false;
        }
        this.nextEmergencyExitAttemptTimestamp = timestamp + this.strategyConfig.exit.retryMs;
        if (tokens < this.wallet.getMinOrderSize()) {
            if (!this.emergencyExitMinimumSizeLogged) {
                this.emergencyExitMinimumSizeLogged = true;
                this.log(
                    `Emergency exit residual is below minimum order size: ` +
                    `remaining=${tokens} minimum=${this.wallet.getMinOrderSize()}`,
                );
            }
            return false;
        }
        const bid = this.market!.getBestBid(this.walletSide);
        if (bid === undefined) {
            if (!this.emergencyExitNoLiquidityLogged) {
                this.emergencyExitNoLiquidityLogged = true;
                this.log(`Emergency exit has no bids; scheduler remains paused, retrying`);
            }
            return false;
        }
        this.emergencyExitNoLiquidityLogged = false;
        const state = await this.wallet.sell(this.wallet.getTick(), tokens);
        if (!state) {
            if (!this.emergencyExitSellFailureLogged) {
                this.emergencyExitSellFailureLogged = true;
                this.log(`Emergency exit sell failed; scheduler remains paused, retrying`);
            }
            return false;
        }
        this.emergencyExitSellFailureLogged = false;
        this.sellOrder = state;
        const remaining = this.wallet.getTokensQuantity();
        const execution = state.fast_full_trade
            ? `filled=${state.value.quantity} average=${state.value.price}`
            : `submitted=${state.value.quantity} limit=${state.value.price}`;
        this.log(
            `Emergency exit ${this.walletSide}: ${execution} remaining=${remaining} ` +
            `bestBid=${bid} entry=${this.entryPrice}; ` +
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
            balance: this.balance,
            tick_size: marketData.tick_size,
            min_order_size: marketData.min_order_size,
            min_buy_order_value: DEFAULT_BUY_ORDER_MIN_VALUE,
            fees_enabled: marketData.fees_enabled,
            taker_base_fee: marketData.taker_base_fee,
        };
        if (this.isDebug) return VirtualTakerLiveOrderWallet.create(params, this.market!);
        const watcher = await LiveOrdersWatcherRTDS.create(marketData.conditionId, client, client.creds);
        return TakerLiveOrderWallet.create(client, params, watcher);
    }

    private settleVirtualPosition(history: CoinFrameEventMarketData | undefined): void {
        if (!(this.wallet instanceof VirtualTakerLiveOrderWallet) || !this.walletSide) return;
        const startPrice = history?.coin_frame_start_price;
        const endPrice = history?.coin_frame_end_price;
        const quantity = this.wallet.getTokensQuantity();
        if (quantity <= 0) return;
        const outcome = getDogeBaselineFrameOutcome(startPrice, endPrice);
        if (outcome === undefined) {
            this.log(
                `Virtual settlement unavailable: side=${this.walletSide} quantity=${quantity} ` +
                `start=${startPrice} end=${endPrice}`,
            );
            return;
        }
        const payout = this.wallet.settle(outcome);
        this.log(
            `Virtual settlement: position=${this.walletSide} outcome=${outcome} ` +
            `quantity=${quantity} payout=${payout} price=${payout > 0 ? 1 : 0} fee=0`,
        );
    }

    private logLiveSettlementReport(history: CoinFrameEventMarketData | undefined, cash: number): void {
        const marketData = this.market?.getMarketData();
        if (!this.wallet || !marketData) {
            this.log(`Live frame pending settlement: cash=${cash.toFixed(6)} tokens=0 side=undefined`);
            return;
        }
        const tokenQuantity = this.wallet.getTokensQuantity();
        const report = createDogeBaselineSettlementReport({
            cash,
            side: this.walletSide,
            tokenQuantity,
            frameStartPrice: history?.coin_frame_start_price,
            frameEndPrice: history?.coin_frame_end_price,
            bids: this.walletSide === 'up' ? this.market!.getBidsUp() : this.market!.getBidsDown(),
            tickSize: marketData.tick_size,
            feesEnabled: marketData.fees_enabled,
            takerBaseFeeBps: marketData.taker_base_fee,
        });
        this.log(
            `Live frame pending settlement: cash=${cash.toFixed(6)} tokens=${tokenQuantity} ` +
            `side=${this.walletSide ?? 'undefined'} sourceOutcome=${report.sourceOutcome ?? 'undefined'} ` +
            `expectedPayout=${report.expectedPayout ?? 'undefined'} expectedEquity=${report.expectedEquity ?? 'undefined'} ` +
            `executableQuantity=${report.executableQuantity} executableProceeds=${report.executableProceeds ?? 'undefined'} ` +
            `liquidationEquity=${report.liquidationEquity ?? 'undefined'}; Polymarket settlement is pending`,
        );
    }

    private log(message: string): void {
        logger.info(`[DogeBaseline][${this.eventId}] ${message}`);
    }
}
