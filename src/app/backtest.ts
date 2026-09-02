import { readHistoryFrames } from './core/history/HistoryFrameReader.js';
import { NoTradeReplayStrategy, ReplayExecutionConfig, runReplay, writeReplayReport } from './core/backtest/replay.js';
import { safeToNum } from '../utils.js';

function readArgument(name: string): string | undefined {
    const prefix = `--${name}=`;
    const inline = process.argv.find(argument => argument.startsWith(prefix));
    if (inline) return inline.slice(prefix.length);
    const index = process.argv.indexOf(`--${name}`);
    return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
    const input = readArgument('history') ?? 'history/frames';
    const output = readArgument('output') ?? 'history/reports/latest';
    const latency = safeToNum(readArgument('latency') ?? '0', Number.NaN);
    if (latency !== 0 && latency !== 1) throw new Error(`latency must be 0 or 1, got ${latency}`);
    const config: ReplayExecutionConfig = {
        initial_balance: safeToNum(readArgument('balance') ?? '100'),
        latency_snapshots: latency,
        minimum_order_value: safeToNum(readArgument('minimum-order-value') ?? '1'),
    };
    const frames = [];
    for await (const frame of readHistoryFrames(input)) frames.push(frame);
    const result = runReplay(frames, new NoTradeReplayStrategy(), config);
    await writeReplayReport(result, output);
    console.log(JSON.stringify(result.metrics, undefined, 2));
}

main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
