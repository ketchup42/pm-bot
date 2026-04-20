## How to start?

```typescript
// 1. Create CLOB client
const client = initTradingClientRest();

const scheduler = new ExecScheduler([
    async () => 
        new ExecManager(
            client,
            [
                await CoinFrameEventTimerWatcher.create_me(
                    'doge',        // asset coin
                    '5m',          // timeframe
                    TIMER_FAST,    // fast tick
                    PS_CHAINLINK   // price source
                )
            ],
            [
                new LogCoinStrategy()  // simple logging strategy
            ]
        )
]);

// 3. Start the scheduler
//    - align to 5‑minute boundaries (FRAME_5M_MS)
//    - each ExecManager will 'execute' every TIMER_NORM MS
await scheduler.start(FRAME_5M_MS, TIMER_NORM);