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

export function readPositiveIntegerArgument(name: string): number {
    const value = safeToNum(readArgument(name), Number.NaN);
    if (!Number.isInteger(value) || value <= 0) throw new Error(`--${name} must be a positive integer`);
    return value;
}

export function readOptionalPositiveIntegerArgument(name: string): number | undefined {
    return readArgument(name) === undefined ? undefined : readPositiveIntegerArgument(name);
}

export interface TradeArguments {
    balance: number;
    tradeValue: number;
}

export function readFlag(name: string): boolean {
    const prefix = `--${name}=`;
    if (process.argv.some(argument => argument.startsWith(prefix))) {
        throw new Error(`--${name} does not accept a value`);
    }
    const index = process.argv.indexOf(`--${name}`);
    if (index < 0) return false;
    const value = process.argv[index + 1];
    if (value !== undefined && !value.startsWith('--')) {
        throw new Error(`--${name} does not accept a value`);
    }
    return true;
}

export function readRequiredTradeArguments(): TradeArguments {
    const balance = readPositiveNumberArgument('balance');
    const tradeValue = readPositiveNumberArgument('trade-value');
    if (tradeValue > balance) throw new Error('--trade-value must not exceed --balance');
    return { balance, tradeValue };
}

export function readPositiveNumberArgument(name: string): number {
    const value = safeToNum(readArgument(name), Number.NaN);
    if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} must be a positive number`);
    return value;
}

export function readReplayExecutionConfig(initialBalance: number | undefined = undefined): ReplayExecutionConfig {
    const latency = safeToNum(readArgument('latency') ?? String(DEFAULT_REPLAY_LATENCY_SNAPSHOTS), Number.NaN);
    if (latency !== 0 && latency !== 1) throw new Error(`latency must be 0 or 1, got ${latency}`);
    return {
        initial_balance: initialBalance ?? safeToNum(readArgument('balance') ?? String(DEFAULT_REPLAY_INITIAL_BALANCE)),
        latency_snapshots: latency,
        minimum_order_value: safeToNum(readArgument('minimum-order-value') ?? String(DEFAULT_REPLAY_MINIMUM_ORDER_VALUE)),
    };
}
