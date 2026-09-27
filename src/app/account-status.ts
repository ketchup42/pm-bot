import type { OpenOrder } from '@polymarket/clob-client-v2';
import { writeOutput } from '../log.js';
import { getReadOnlyCollateralBalance, getReadOnlyTradingClient, getTradingAccountIdentity, type TradingAccountIdentity } from '../rest/client-env.js';
import { getAccountPortfolioValue } from '../rest/account-data.js';

interface AccountStatusValue<T> {
    available: boolean;
    value?: T;
    error?: string;
}

export interface AccountStatus {
    account: AccountStatusValue<{ address: string }>;
    availableCollateral: AccountStatusValue<number>;
    portfolioValue: AccountStatusValue<number>;
    openOrders: AccountStatusValue<number>;
    refreshedAt: number;
}

export interface AccountStatusSources {
    getIdentity(): TradingAccountIdentity;
    getAvailableCollateral(): Promise<number>;
    getPortfolioValue(address: string): Promise<number>;
    getOpenOrders(): Promise<readonly OpenOrder[]>;
    now(): number;
}

function maskAddress(address: string): string {
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
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

function defaultSources(): AccountStatusSources {
    return {
        getIdentity: getTradingAccountIdentity,
        getAvailableCollateral: getReadOnlyCollateralBalance,
        getPortfolioValue: getAccountPortfolioValue,
        getOpenOrders: async () => getReadOnlyTradingClient().getOpenOrders(),
        now: Date.now,
    };
}

export async function getAccountStatus(sources: AccountStatusSources = defaultSources()): Promise<AccountStatus> {
    const status: AccountStatus = {
        account: { available: false },
        availableCollateral: { available: false },
        portfolioValue: { available: false },
        openOrders: { available: false },
        refreshedAt: sources.now(),
    };
    let identity: TradingAccountIdentity;
    try {
        identity = sources.getIdentity();
        status.account = available({ address: maskAddress(identity.funderAddress) });
    } catch (error) {
        status.account = unavailable(error);
        return status;
    }
    const [availableCollateral, portfolioValue, openOrders] = await Promise.allSettled([
        sources.getAvailableCollateral(),
        sources.getPortfolioValue(identity.funderAddress),
        sources.getOpenOrders(),
    ]);
    status.availableCollateral = availableCollateral.status === 'fulfilled'
        ? available(availableCollateral.value)
        : unavailable(availableCollateral.reason);
    status.portfolioValue = portfolioValue.status === 'fulfilled'
        ? available(portfolioValue.value)
        : unavailable(portfolioValue.reason);
    status.openOrders = openOrders.status === 'fulfilled' && Array.isArray(openOrders.value)
        ? available(openOrders.value.length)
        : unavailable(openOrders.status === 'rejected' ? openOrders.reason : new Error('CLOB open orders response is invalid'));
    return status;
}

function formatUsd(value: number | undefined): string {
    return value === undefined ? 'not available' : `$${value.toFixed(2)}`;
}

function formatUtcMinute(timestamp: number): string {
    return `${new Date(timestamp).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** Text mode is intentionally presentation-ready for the dependency-free Bash menu. */
export function formatAccountStatusText(status: Readonly<AccountStatus>): string {
    const lines = [
        `ADDRESS             ${status.account.value?.address ?? 'not available'}`,
        `AVAILABLE BALANCE   ${status.availableCollateral.available ? formatUsd(status.availableCollateral.value) : 'not available'}`,
        `POSITIONS VALUE     ${status.portfolioValue.available ? formatUsd(status.portfolioValue.value) : 'not available'}`,
        `OPEN ORDERS         ${status.openOrders.available ? status.openOrders.value : 'not available'}`,
    ];
    lines.push(`UPDATED             ${formatUtcMinute(status.refreshedAt)}`);
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
