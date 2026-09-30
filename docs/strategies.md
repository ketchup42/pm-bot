# Strategy guide

This guide explains the strategy and replay contracts used by PM-BOT. Historical
replay measures a hypothesis under recorded assumptions; it is not evidence of
future profitability. Validate every change on settled history and begin live-data
operation with `--debug`.

| Read this section for | Topic |
| --- | --- |
| Runtime composition | Live lifecycle and safe order decisions |
| DOGE baseline | Model, entry/exit settings, replay, and refresh |
| New hypotheses | Replay presets and matrix comparison |

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
or an abnormal stop. Strategies must make their position-handling decision
explicitly for that case.

## Add a live strategy

1. Implement `EventStrategy<CoinFrameEventMarketData>` in the appropriate strategy
   directory. Keep per-frame state in the instance.
2. In `execute`, find the matching event watcher by `eventId`, then read the market
   watcher and current best bid/ask. Treat unavailable data as `undefined`, not as
   zero.
3. Create a wallet only after market metadata is available. Use the supplied token
   ID, tick size and minimum order constraints. See [wallets.md](wallets.md).
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

`--balance`, `--latency-ms` (a non-negative execution delay in milliseconds) and `--minimum-order-value` apply
to both commands. Matrix replay includes only complete frames with a confirmed
settlement and records excluded frames in its manifest.

The maintained comparison set is deliberately small: `no-trade`, basic trend-line
`v1` and basic trend-line `v2`. New hypotheses must be added as separate, tested
presets rather than changing those reference implementations.

## DOGE baseline

The DOGE contour deliberately separates research from execution:

```text
complete frames → confirmed settlement → model/config research → replay → refresh gate → strategy
```

The refresh gate can pause an otherwise valid strategy when the current replay
window does not satisfy its PnL-regime policy. A pause is a protective state, not
an application failure. Configure the Docker contour through the menu described in
[Deployment](deployment.md); use [Environment](env.md) for local settings.

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
Each mode may additionally require a minimum predicted-side probability (default `0.50`)
and an absolute DOGE movement from the frame start (default `0 bps`).
Entry value is capped at $10 from a $100
strategy balance.

An emergency exit is available during the final 60 seconds. It requires DOGE
to remain at least 0.05% beyond the frame start price against the held
side for five continuous seconds. The strategy then sells against the available bid
depth, retries any unsold remainder no more than once per second without duplicating active orders.
A separate relative crossing observer retains its ±0.05% band
for frame-level volatility. A calm following frame resumes the scheduler.

This taker execution applies only to an exit made before the frame ends. At a
natural frame end, the virtual wallet does not sell at the final bid: remaining
winning tokens settle at $1 each and losing tokens at $0, with no exit trade fee.
If the process is stopped before the outcome is known, it still attempts to
liquidate the open position against the visible bid depth.

Training requires an explicit history size and never publishes a partial model. Its
output includes classification accuracy, probability errors, a confusion matrix,
the continuation baseline, outcomes grouped by signed DOGE displacement, and a
confidence-calibration table. Each 5% confidence range reports its frame count,
mean predicted confidence and actual directional accuracy:

```bash
npm run research:doge-baseline-model -- --count 500
npm run research:doge-baseline-config -- --count 500
npm run replay:doge-baseline -- --history history/frames \
  --count 100 \
  --balance 100 \
  --trade-value 10 \
  --latency-ms 250 \
  --output history/reports/doge-baseline/latest
```

The replay loads the published model without fitting it and uses the normal replay
engine for depth, spread, slippage, fees, minimum order value and balance limits.
It reads only the newest `--count N` eligible frames. The default is 100. Its
`entry-decisions.json` and the matching table in `summary.md` split each mode's
evaluated decisions into accepted entries and precise rejection reasons.
Pass `--model models/doge-baseline/candidate.json --config <matching-file>` to
replay a stored model. A model is never replayed with an unverified configuration.
`--latency-ms` is a non-negative artificial delay between a replay decision and
execution. DOGE commands default to `250`, so execution uses the first saved
snapshot at or after the decision time plus 250 ms. The same value is used by
`research:doge-baseline-config` and `refresh:doge-baseline`. Pass the flag to
either command to evaluate another latency assumption.

Both `replay:doge-baseline` and `strategy:doge-baseline` require a positive
`--balance` and `--trade-value` in USDC. `--trade-value` is the maximum value of one
entry and must not exceed the balance. The replay report records both values.

Use exactly one mode when starting the live scheduler:

```bash
# Virtual orders
npm run strategy:doge-baseline -- --debug --balance 100 --trade-value 10

# Virtual orders without legacy scheduler dumps
npm run strategy:doge-baseline -- --debug --no-dumps --balance 100 --trade-value 10

# Real orders
npm run strategy:doge-baseline -- --live --balance 100 --trade-value 10
```

`--live` uses `TakerLiveOrderWallet`: each DOGE order is submitted as a marketable
GTC limit order and any unfilled remainder is cancelled immediately. The strategy
records only the resulting full or partial execution. If the connection fails after
an order ID is received, its order watcher retains the order until reconciliation.

`--debug` and `--live` are flags. An omitted mode, duplicate mode, or a value passed
to either flag is rejected before the scheduler starts.

`--no-dumps` is accepted in both modes. In `--debug` it disables legacy scheduler
dumps. In `--live` dumps are already disabled, so the flag is a safe no-op. It does
not change order execution, model decisions, or the strategy scheduler.

`research:doge-baseline-config -- --count N` evaluates 80 coarse natural entry
configurations for each mode: five edge values, four probability thresholds and four
minimum absolute-deviation thresholds. Around each eligible coarse winner it then
tests a local 3×3 grid: edge ±$0.01 and confidence ±0.03, clamped to the supported
ranges. The winning deviation filter stays fixed. It retains the strongest three
early and late settings, tests their nine joint combinations, then advances three
drawdown-safe finalists to 12 emergency-exit variants each. Natural settlement remains
in the final comparison. Every configuration admitted to the next stage must make at
least the dynamic minimum trade count: 10% of the supplied frames, normally bounded
from 5 to 20 and clamped for a smaller sample. The final choice is constrained to
drawdown no worse than the baseline and ordered by net PnL, then lower total execution
costs, then fewer trades. It atomically writes `models/doge-baseline/config.json`
without generating a report.

Published configuration V5 contains a global trading switch, a PnL-regime profile and independent entry
settings for each mode: an enable switch, minimum edge, probability threshold and
DOGE-deviation threshold:

```json
{
  "version": 5,
  "tradingEnabled": true,
  "regime": {
    "minimumNetPnlPerReplayFrame": 0.50,
    "trendStepPerReplayFrame": 0.10,
    "minimumConsecutiveRises": 2
  },
  "entry": {
    "modes": {
      "early-60": {
        "enabled": true,
        "minimumEdge": 0.04,
        "minimumConfidence": 0.50,
        "minimumAbsoluteDeviationBps": 0
      },
      "late-120": {
        "enabled": true,
        "minimumEdge": 0.04,
        "minimumConfidence": 0.50,
        "minimumAbsoluteDeviationBps": 0
      }
    }
  }
}
```

At least one mode must be enabled. `tradingEnabled=false` makes the live strategy
skip entries and log `Trading paused by config` once per trading frame. Replay and
configuration research deliberately ignore this live guard, so they can continue
evaluating the model and find a configuration that may resume trading.

V4 artifacts are upgraded in memory with the default regime and are rewritten as V5
by the next successful refresh or regime application. Older versions are rejected.

`refresh:doge-baseline -- --frame 5m --count 100 --train-count 500 --replay 100`
uses 500 frames to train a candidate and tune both the working and candidate model.
It then compares working/current, working/tuned, candidate/current and
candidate/tuned pairs on 100 later frames. The selected pair must pass the existing
trade and PnL safeguards. A model replacement also requires accuracy at least 55%
and Brier score below 0.25 in both modes. The four-way decision is retained in
`latest-evaluation.json`. The replay window is split chronologically into adaptive
25–50-frame segments: 100 frames become four segments of 25, while 400 become eight
segments of 50. A candidate needs positive PnL and at least 10% active frames in
each qualifying segment, with a floor of two trades. Before the replay reaches four
full 50-frame segments, at least 50% of segments must be profitable. The requirement
then rises with the number of full segments to 75% at eight segments.
The same evaluation file records the segments, entry-rejection statistics and
confidence calibration for every combination.

If every one of the four evaluated working/candidate model-and-configuration pairs
has non-positive net PnL on the replay window, refresh writes
`"tradingEnabled": false` to the current `config.json`. This stops new live entries
without stopping research or refresh. Refresh also uses the selected pair's replay
PnL as a regime trend. For 100 replay frames, entries require at least `$50` selected
net PnL. The stored `regime` thresholds scale linearly with the replay-frame count.
A paused strategy resumes only after its configured number of consecutive significant
PnL rises. The recovery sequence may begin below the minimum PnL, but a falling or
incomparable evaluation resets it. Evaluations are comparable only when replay frames,
initial balance and execution latency match.

`research:doge-baseline-regime` evaluates 18 regime profiles with a chronological
walk-forward simulation. It accepts `--frame`, `--count`, `--train-count`, `--replay`,
`--balance` and `--trade-value`. Without `--apply` it writes `summary.md` and
`result.json` under `history/reports/doge-baseline-regime/latest`. With `--apply` it
requires 24 future windows and atomically updates only the `regime` block of the
published config. The report mode requires 12 future windows, so `500/100/25` needs
at least 900 eligible frames.

`refresh:doge-baseline` uses the same required `--balance` and `--trade-value`
arguments. A change to either value makes the next refresh PnL point incomparable
with the previous point, so it cannot incorrectly confirm a recovery or decline.

## Before changing live behaviour

- Add or update replay tests for the rule and its rejected-order edge cases.
- Run the preset matrix on the same confirmed frame set before comparing results.
- Inspect net PnL together with fees, spread, slippage, drawdown and rejected-order
  reasons. A positive gross PnL is not enough.
- Keep strategy identifiers and defaults in their central registries. Do not copy
  names or instrument lists into a new caller.
