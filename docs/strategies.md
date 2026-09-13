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
4. Add the strategy explicitly to the relevant scheduler composition and its
   dedicated application entry point.
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
and probabilities below 0.5 select `down`. The opposite side is never bought merely
because its token is cheaper. Before entry, the selected side is simulated through
the visible ask depth. Its VWAP, taker fee and minimum order value must still leave
the mode-specific expected edge from `config.json` (the default is $0.04 per token).
Entry value is capped at $10 from a $100
strategy balance.

An emergency exit is available during the final 60 seconds. It requires DOGE
to remain at least 0.05% beyond the frame start price against the held
side for five continuous seconds. The strategy then sells against the available bid
depth, retries any unsold remainder no more than once per second without duplicating active orders, and pauses
the main scheduler. A separate relative crossing observer retains its ±0.05% band
for frame-level volatility; a calm following frame resumes the scheduler.

This taker execution applies only to an exit made before the frame ends. At a
natural frame end, the virtual wallet does not sell at the final bid: remaining
winning tokens settle at $1 each and losing tokens at $0, with no exit trade fee.
If the process is stopped before the outcome is known, it still attempts to
liquidate the open position against the visible bid depth.

Training requires an explicit history size and never publishes a partial model. Its
output includes classification accuracy, probability errors, a confusion matrix,
the continuation baseline, and outcomes grouped by signed DOGE displacement:

```bash
npm run research:doge-baseline-model -- --count 500
npm run research:doge-baseline-config -- --count 500
npm run replay:doge-baseline -- --history history/frames \
  --count 100 \
  --balance 100 \
  --trade-value 10 \
  --output history/reports/doge-baseline/latest
```

The replay loads the published model without fitting it and uses the normal replay
engine for depth, spread, slippage, fees, minimum order value and balance limits.
It reads only the newest `--count N` eligible frames; the default is 100.
Pass `--model models/doge-baseline/candidate.json --config <matching-file>` to
replay a stored model; a model is never replayed with an unverified configuration.

Both `replay:doge-baseline` and `strategy:doge-baseline` require a positive
`--balance` and `--trade-value` in USDC. `--trade-value` is the maximum value of one
entry and must not exceed the balance. The replay report records both values.

Use exactly one mode when starting the live scheduler:

```bash
# Virtual orders
npm run strategy:doge-baseline -- --debug --balance 100 --trade-value 10

# Real orders
npm run strategy:doge-baseline -- --live --balance 100 --trade-value 10
```

`--debug` and `--live` are flags. An omitted mode, duplicate mode, or a value passed
to either flag is rejected before the scheduler starts.

`research:doge-baseline-config -- --count N` evaluates 35 natural entry configurations:
five early-only, five late-only and 25 configurations with independent early and late edges.
It retains three finalists whose drawdown is no worse than the baseline, then evaluates
12 emergency-exit variants for each finalist.
The final choice is constrained to drawdown no worse than the baseline and ordered by
net PnL, then lower total execution costs, then fewer trades. It atomically writes
`models/doge-baseline/config.json` without generating a report.

The published V2 entry settings have an independent switch and minimum edge for each
mode:

```json
{
  "entry": {
    "modes": {
      "early-60": { "enabled": true, "minimumEdge": 0.04 },
      "late-120": { "enabled": true, "minimumEdge": 0.04 }
    }
  }
}
```

At least one mode must be enabled. Legacy configuration versions are rejected rather
than silently converted.

`refresh:doge-baseline -- --frame 5m --count 100 --train-count 500 --replay 100`
uses 500 frames to train a candidate and tune both the working and candidate model.
It then compares working/current, working/tuned, candidate/current and
candidate/tuned pairs on 100 later frames. The selected pair must pass the existing
trade and PnL safeguards; a model replacement also requires accuracy at least 55%
and Brier score below 0.25 in both modes. The four-way decision is retained in
`latest-evaluation.json`.

## Before changing live behaviour

- Add or update replay tests for the rule and its rejected-order edge cases.
- Run the preset matrix on the same confirmed frame set before comparing results.
- Inspect net PnL together with fees, spread, slippage, drawdown and rejected-order
  reasons. A positive gross PnL is not enough.
- Keep strategy identifiers and defaults in their central registries; do not copy
  names or instrument lists into a new caller.
