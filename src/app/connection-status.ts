import { lookup } from 'node:dns/promises';
import { writeOutput } from '../log.js';
import { REST_DEFAULT_HOST_CLOB } from '../rest/hosts.js';

export interface ConnectionStatusValue {
    available: boolean;
    value?: string;
    reason?: 'timeout' | 'dns' | 'network' | 'http' | 'invalid_response';
}

export interface ConnectionStatus {
    ipv4: ConnectionStatusValue;
    dns: { available: boolean };
    refreshedAt: number;
}

export interface ConnectionStatusSources {
    getExternalIpv4(): Promise<string>;
    checkApiDns(): Promise<void>;
    now(): number;
}

const CONNECTION_TIMEOUT_MS = 5_000;
const EXTERNAL_IP_URL = 'https://api.ipify.org';
const API_HOST = new URL(REST_DEFAULT_HOST_CLOB).hostname;

function isIpv4(value: string): boolean {
    const octets = value.split('.');
    return octets.length === 4 && octets.every(octet => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
}

function unavailable(error: unknown): ConnectionStatusValue {
    const message = error instanceof Error ? error.message : String(error);
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : '';
    const details = `${message} ${cause}`.toLowerCase();
    if (details.includes('connection_timeout') || details.includes('abort') || details.includes('timeout')) {
        return { available: false, reason: 'timeout' };
    }
    if (details.includes('enotfound') || details.includes('eai_again') || details.includes('dns')) {
        return { available: false, reason: 'dns' };
    }
    if (details.includes('_http_')) return { available: false, reason: 'http' };
    if (details.includes('invalid_response')) return { available: false, reason: 'invalid_response' };
    return { available: false, reason: 'network' };
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
        async checkApiDns(): Promise<void> {
            await lookup(API_HOST, { family: 4 });
        },
        now: Date.now,
    };
}

export async function getConnectionStatus(
    sources: ConnectionStatusSources = defaultSources(),
    timeoutMs: number = CONNECTION_TIMEOUT_MS,
): Promise<ConnectionStatus> {
    const [ipv4, dns] = await Promise.allSettled([
        withTimeout(sources.getExternalIpv4(), timeoutMs),
        withTimeout(sources.checkApiDns(), timeoutMs),
    ]);
    return {
        ipv4: ipv4.status === 'fulfilled' ? available(ipv4.value) : unavailable(ipv4.reason),
        dns: { available: dns.status === 'fulfilled' },
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
