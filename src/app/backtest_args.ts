import { ReplayExecutionConfig } from './core/backtest/replay.js';
import { safeToNum } from '../utils.js';
import {
    DEFAULT_REPLAY_INITIAL_BALANCE,
    DEFAULT_REPLAY_LATENCY_SNAPSHOTS,
    DEFAULT_REPLAY_MINIMUM_ORDER_VALUE,
} from './defaults.js';

export function readArgument(name: string): string | undefined {
    const prefix = `--${name}=`;
    const inline = process.argv.find(argument => argument.startsWith(prefix));
    if (inline) return inline.slice(prefix.length);
    const index = process.argv.indexOf(`--${name}`);
    return index >= 0 ? process.argv[index + 1] : undefined;
}

export function readReplayExecutionConfig(): ReplayExecutionConfig {
    const latency = safeToNum(readArgument('latency') ?? String(DEFAULT_REPLAY_LATENCY_SNAPSHOTS), Number.NaN);
    if (latency !== 0 && latency !== 1) throw new Error(`latency must be 0 or 1, got ${latency}`);
    return {
        initial_balance: safeToNum(readArgument('balance') ?? String(DEFAULT_REPLAY_INITIAL_BALANCE)),
        latency_snapshots: latency,
        minimum_order_value: safeToNum(readArgument('minimum-order-value') ?? String(DEFAULT_REPLAY_MINIMUM_ORDER_VALUE)),
    };
}
