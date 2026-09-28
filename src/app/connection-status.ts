import { lookup } from 'node:dns/promises';
import { writeOutput } from '../log.js';
import { REST_DEFAULT_HOST_CLOB } from '../rest/hosts.js';

export interface ConnectionStatusValue {
    available: boolean;
    value?: string;
}

export interface ConnectionStatus {
    externalIpv4: ConnectionStatusValue;
    polymarketDns: ConnectionStatusValue;
    refreshedAt: number;
}

export interface ConnectionStatusSources {
    getExternalIpv4(): Promise<string>;
    resolvePolymarketHost(): Promise<string>;
    now(): number;
}

const CONNECTION_TIMEOUT_MS = 5_000;
const EXTERNAL_IP_URL = 'https://api.ipify.org';
const POLYMARKET_HOST = new URL(REST_DEFAULT_HOST_CLOB).hostname;

function isIpv4(value: string): boolean {
    const octets = value.split('.');
    return octets.length === 4 && octets.every(octet => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
}

function unavailable(): ConnectionStatusValue {
    return { available: false };
}

function available(value: string): ConnectionStatusValue {
    return { available: true, value };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('connection_timeout')), timeoutMs);
        void promise.then(
            value => {
                clearTimeout(timeout);
                resolve(value);
            },
            error => {
                clearTimeout(timeout);
                reject(error);
            },
        );
    });
}

function defaultSources(): ConnectionStatusSources {
    return {
        async getExternalIpv4(): Promise<string> {
            const response = await fetch(EXTERNAL_IP_URL, { signal: AbortSignal.timeout(CONNECTION_TIMEOUT_MS) });
            if (!response.ok) throw new Error(`external_ip_http_${response.status}`);
            const value = (await response.text()).trim();
            if (!isIpv4(value)) throw new Error('external_ip_invalid_response');
            return value;
        },
        async resolvePolymarketHost(): Promise<string> {
            return (await lookup(POLYMARKET_HOST, { family: 4 })).address;
        },
        now: Date.now,
    };
}

export async function getConnectionStatus(
    sources: ConnectionStatusSources = defaultSources(),
    timeoutMs: number = CONNECTION_TIMEOUT_MS,
): Promise<ConnectionStatus> {
    const [externalIpv4, polymarketDns] = await Promise.allSettled([
        withTimeout(sources.getExternalIpv4(), timeoutMs),
        withTimeout(sources.resolvePolymarketHost(), timeoutMs),
    ]);
    return {
        externalIpv4: externalIpv4.status === 'fulfilled' ? available(externalIpv4.value) : unavailable(),
        polymarketDns: polymarketDns.status === 'fulfilled' ? available(polymarketDns.value) : unavailable(),
        refreshedAt: sources.now(),
    };
}

export async function runConnectionStatus(): Promise<void> {
    const arguments_ = process.argv.slice(3);
    if (arguments_.length !== 1 || arguments_[0] !== '--json') {
        throw new Error('Usage: pm-bot status:connection --json');
    }
    writeOutput(JSON.stringify(await getConnectionStatus(), undefined, 2));
}
