import type { OpenOrder } from '@polymarket/clob-client-v2';
import { writeOutput } from '../log.js';
import { getTradingAccountIdentity, getReadOnlyTradingClient, getUSDBalance, type TradingAccountIdentity } from '../rest/client-env.js';
import {
    getAccountOpenPositions,
    getAccountPortfolioValue,
    type AccountPosition,
    type AccountPositionsResult,
} from '../rest/account-data.js';

const ACCOUNT_STATUS_DISPLAY_ROWS = 5;
const ACCOUNT_STATUS_MAX_ORDERS = 50;

export interface AccountOpenOrder {
    side: string;
    outcome: string;
    remainingSize: number;
    price: number;
}

interface AccountStatusValue<T> {
    available: boolean;
    value?: T;
    error?: string;
}

export interface AccountStatus {
    account: AccountStatusValue<{ address: string; signatureType: number }>;
    polygonPusd: AccountStatusValue<number>;
    portfolioValue: AccountStatusValue<number>;
    positions: AccountStatusValue<AccountPositionsResult>;
    openOrders: AccountStatusValue<AccountOpenOrder[]>;
    refreshedAt: number;
}

export interface AccountStatusSources {
    getIdentity(): TradingAccountIdentity;
    getPolygonPusd(address: string): Promise<number>;
    getPortfolioValue(address: string): Promise<number>;
    getOpenPositions(address: string): Promise<AccountPositionsResult>;
    getOpenOrders(): Promise<readonly OpenOrder[]>;
    now(): number;
}

function maskAddress(address: string): string {
    return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function getSafeError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return /^(FUNDER_ADDRESS|SIGNATURE_TYPE|Missing environment variables|Invalid PRIVATE_KEY)/.test(message)
        ? message.replace(/\n.*/s, '')
        : 'request unavailable';
}

function unavailable<T>(error: unknown): AccountStatusValue<T> {
    return { available: false, error: getSafeError(error) };
}

function available<T>(value: T): AccountStatusValue<T> {
    return { available: true, value };
}

function asFiniteNumber(value: string): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function mapOpenOrder(order: Readonly<OpenOrder>): AccountOpenOrder {
    return {
        side: order.side || 'UNKNOWN',
        outcome: order.outcome || 'Unknown outcome',
        remainingSize: Math.max(0, asFiniteNumber(order.original_size) - asFiniteNumber(order.size_matched)),
        price: asFiniteNumber(order.price),
    };
}

function defaultSources(): AccountStatusSources {
    return {
        getIdentity: getTradingAccountIdentity,
        getPolygonPusd: getUSDBalance,
        getPortfolioValue: getAccountPortfolioValue,
        getOpenPositions: getAccountOpenPositions,
        getOpenOrders: async () => getReadOnlyTradingClient().getOpenOrders(undefined, true),
        now: Date.now,
    };
}

export async function getAccountStatus(sources: AccountStatusSources = defaultSources()): Promise<AccountStatus> {
    const status: AccountStatus = {
        account: { available: false },
        polygonPusd: { available: false },
        portfolioValue: { available: false },
        positions: { available: false },
        openOrders: { available: false },
        refreshedAt: sources.now(),
    };
    let identity: TradingAccountIdentity;
    try {
        identity = sources.getIdentity();
        status.account = available({ address: maskAddress(identity.funderAddress), signatureType: identity.signatureType });
    } catch (error) {
        status.account = unavailable(error);
        return status;
    }
    const [polygonPusd, portfolioValue, positions, openOrders] = await Promise.allSettled([
        sources.getPolygonPusd(identity.funderAddress),
        sources.getPortfolioValue(identity.funderAddress),
        sources.getOpenPositions(identity.funderAddress),
        sources.getOpenOrders(),
    ]);
    status.polygonPusd = polygonPusd.status === 'fulfilled' ? available(polygonPusd.value) : unavailable(polygonPusd.reason);
    status.portfolioValue = portfolioValue.status === 'fulfilled' ? available(portfolioValue.value) : unavailable(portfolioValue.reason);
    status.positions = positions.status === 'fulfilled' ? available(positions.value) : unavailable(positions.reason);
    status.openOrders = openOrders.status === 'fulfilled' && Array.isArray(openOrders.value)
        ? available(openOrders.value.slice(0, ACCOUNT_STATUS_MAX_ORDERS).map(mapOpenOrder))
        : unavailable(openOrders.status === 'rejected' ? openOrders.reason : new Error('CLOB open orders response is invalid'));
    return status;
}

function formatUsd(value: number | undefined): string {
    return value === undefined ? 'not available' : `$${value.toFixed(2)}`;
}

function formatNumber(value: number | undefined): string {
    return value === undefined ? 'not available' : value.toFixed(4).replace(/\.?(0+)$/, '');
}

function compactText(value: string): string {
    return value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Text mode is intentionally presentation-ready for the dependency-free Bash menu. */
export function formatAccountStatusText(status: Readonly<AccountStatus>): string {
    const lines = [
        `ADDRESS             ${status.account.value?.address ?? 'not available'}`,
        `SIGNATURE TYPE      ${status.account.value?.signatureType ?? 'not available'}`,
        `POLYGON pUSD        ${status.polygonPusd.available ? formatUsd(status.polygonPusd.value) : 'not available'}`,
        `POSITIONS VALUE     ${status.portfolioValue.available ? formatUsd(status.portfolioValue.value) : 'not available'}`,
        `OPEN POSITIONS      ${status.positions.available ? `${status.positions.value!.positions.length}${status.positions.value!.truncated ? '+' : ''}` : 'not available'}`,
        `OPEN ORDERS         ${status.openOrders.available ? status.openOrders.value!.length : 'not available'}`,
    ];
    if (status.positions.available) {
        for (const position of status.positions.value!.positions.slice(0, ACCOUNT_STATUS_DISPLAY_ROWS)) {
            lines.push(`POSITION ${position.outcome}: ${compactText(position.market)} | ${formatNumber(position.size)} tokens | ${formatUsd(position.currentValue)}`);
        }
    }
    if (status.openOrders.available) {
        for (const order of status.openOrders.value!.slice(0, ACCOUNT_STATUS_DISPLAY_ROWS)) {
            lines.push(`ORDER ${order.side} ${order.outcome}: ${formatNumber(order.remainingSize)} @ ${formatUsd(order.price)}`);
        }
    }
    lines.push(`UPDATED             ${new Date(status.refreshedAt).toISOString().replace('.000Z', 'Z')}`);
    return lines.join('\n');
}

export async function runAccountStatus(): Promise<void> {
    const arguments_ = process.argv.slice(3);
    if (arguments_.some(argument => argument !== '--json' && argument !== '--text') || arguments_.length > 1) {
        throw new Error('Usage: pm-bot status:account [--json|--text]');
    }
    const status = await getAccountStatus();
    writeOutput(arguments_[0] === '--json' ? JSON.stringify(status, undefined, 2) : formatAccountStatusText(status));
}
