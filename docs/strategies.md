# Strategy guide

Strategies have two separate homes:

| Kind                   | Location                                      | Purpose                                      |
| ---------------------- | --------------------------------------------- | -------------------------------------------- |
| Live event strategy    | `src/app/core/events/strategy/`               | Observes live watchers and may place orders. |
| Trend-line strategy    | `src/app/core/events/strategy/trend-line/`    | The grouped V1/V2 live implementation.       |
| DOGE baseline strategy | `src/app/core/events/strategy/doge-baseline/` | Model, training and live implementation.     |
| Replay strategy        | `src/app/core/backtest/strategy/`             | Makes deterministic offline decisions.       |
| Replay preset registry | `src/app/core/backtest/replay_presets.ts`     | Exposes presets to CLI and matrix replay.    |

Do not use a live strategy as evidence of profitability without replaying it on
settled data. The replay adapter and the live implementation may share decision
rules, but order submission remains outside the pure replay strategy.

## Live lifecycle

An `EventStrategy` implements `execute()` and `cancel()`.

1. `ExecScheduler` waits for the selected frame boundary.
2. The scheduler creates an `ExecManager`, its event watcher and its strategies.
3. While the frame is active, `ExecManager` calls `execute(client, watchers)` on
   each strategy at its configured tick interval.
4. At natural frame end, shutdown, or an error, it calls
   `cancel(client, watchers, isSignal)` and disposes the watchers.

`isSignal=false` means a natural frame completion. `isSignal=true` means shutdown
or an abnormal stop; strategies must make their position-handling decision
explicitly for that case.

## Add a live strategy

1. Implement `EventStrategy<CoinFrameEventMarketData>` in the appropriate strategy
   directory. Keep per-frame state in the instance.
2. In `execute`, find the matching event watcher by `eventId`, then read the market
   watcher and current best bid/ask. Treat unavailable data as `undefined`, not as
   zero.
3. Create a wallet only after market metadata is available. Use the supplied token
   ID, tick size and minimum order constraints; see [wallets.md](wallets.md).
4. Add the strategy explicitly to the `ExecManager` in `src/app/index.ts` or the
   relevant scheduler composition.
5. In `cancel`, release orders, dispose the wallet and reset every per-frame field.

## Safe order decisions

| Condition                                | Required behaviour                                     |
| ---------------------------------------- | ------------------------------------------------------ |
| No best bid or ask yet                   | Return without trading.                                |
| Stale/missing price or disconnected book | Return without trading.                                |
| Order below size or value minimum        | Do not submit it.                                      |
| Insufficient virtual balance/tokens      | Do not submit it.                                      |
| Frame nearly over                        | Apply an explicit entry cutoff or avoid new positions. |
| Shutdown                                 | Use a deliberate `dispose(true/false)` policy.         |

## Replay presets and matrix

The replay contract receives only information available at the current snapshot and
returns `hold`, `skip`, `buy`, or `sell` with a reason code. It must not read future
snapshots or settlement before making a decision.

Register a new preset once in `REPLAY_STRATEGY_PRESETS`. Both commands then see it:

```bash
# Run one named preset. `no-trade` is the neutral default.
npm run backtest -- --history history/frames --strategy your-preset

# Run every registered preset under identical execution assumptions.
npm run backtest:matrix -- --history history/frames
```

`--balance`, `--latency` (`0` or `1` snapshots) and `--minimum-order-value` apply
to both commands. Matrix replay includes only complete frames with a confirmed
settlement and records excluded frames in its manifest.

The maintained comparison set is deliberately small: `no-trade`, basic trend-line
`v1` and basic trend-line `v2`. New hypotheses must be added as separate, tested
presets rather than changing those reference implementations.

## DOGE baseline

The published model contains two independent logistic regressions. Training reads
only complete, confirmed DOGE 5m frames from the Chainlink 60-second TWAP source.

| Mode        | Decision time | Return windows          | Used when                         |
| ----------- | ------------- | ----------------------- | --------------------------------- |
| `early-60`  | 60 seconds    | 15, 30 and 60 seconds   | No position has been opened yet.  |
| `late-120`  | 120 seconds   | 75, 90 and 120 seconds  | Early mode did not enter.         |

The model first selects the predicted outcome: probabilities above 0.5 select `up`,
and probabilities below 0.5 select `down`. Only that side is checked against its
visible ask and taker fee. The strategy never buys the opposite side merely because
its token is cheaper. Both modes require at least $0.02 expected edge per token,
and entry value is capped at $10 from a $100 strategy balance.

An emergency exit is available only during the final 30 seconds. It requires DOGE
to remain at least one basis point beyond the frame start price against the held
side for five continuous seconds. The strategy then sells at market and pauses the
main scheduler. A separate relative crossing observer retains its ±0.5% band for
frame-level volatility; a calm following frame resumes the scheduler.

Training requires an explicit history size and never publishes a partial model. Its
output includes classification accuracy, probability errors, a confusion matrix,
the continuation baseline, and outcomes grouped by signed DOGE displacement:

```bash
npm run research:doge-baseline -- --count 500
npm run replay:doge-baseline -- --history history/frames \
  --output history/reports/doge-baseline/latest
```

The replay loads the published model without fitting it and uses the normal replay
engine for depth, spread, slippage, fees, minimum order value and balance limits.

## Before changing live behaviour

- Add or update replay tests for the rule and its rejected-order edge cases.
- Run the preset matrix on the same confirmed frame set before comparing results.
- Inspect net PnL together with fees, spread, slippage, drawdown and rejected-order
  reasons. A positive gross PnL is not enough.
- Keep strategy identifiers and defaults in their central registries; do not copy
  names or instrument lists into a new caller.
