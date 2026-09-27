import { ClobClient, Chain, AssetType } from "@polymarket/clob-client-v2";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import "dotenv/config";

import { error_str, safeToNum } from "../utils.js";
import { REST_DEFAULT_HOST_CLOB, REST_CHAIN_ID } from "./hosts.js";
import { isMeBlocked } from "./block.js";
import { ClobApiKeyCreds } from "@polymarket/real-time-data-client";

/** RPC URL for Polygon network – uses environment variable or public default. */
const POLYGON_RPC_URL = process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com';

/**
 * Configuration required for authenticated trading operations.
 */
interface TradingEnvConfig {
    /** Ethereum private key (with or without 0x prefix). */
    privateKey: string;
    /** Polymarket API key. */
    apiKey: string;
    /** Polymarket API secret. */
    apiSecret: string;
    /** Polymarket API passphrase. */
    apiPassphrase: string;
    /** Signature type: 0=EOA, 1=POLY_PROXY, 2=GNOSIS_SAFE, 3=Deposit wallet. */
    signatureType: number;
    /** Address that will pay gas fees (proxy address for type 2/3, or EOA address for type 0). */
    funderAddress: string;
}

/** Safe account identity for read-only status views. It never includes credentials. */
export interface TradingAccountIdentity {
    funderAddress: string;
    signatureType: number;
}

/**
 * Normalizes a private key: ensures it has a 0x prefix and is a valid 64‑character hex string.
 * @param key - Raw private key (with or without 0x)
 * @returns Normalized private key with 0x prefix
 * @throws Error if key is not a valid 64‑character hex string
 */
function normalizePrivateKey(key: string): string {
    const trimmed = key.trim();
    const withPrefix = trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
    const hexPattern = /^0x[0-9a-fA-F]{64}$/;
    if (!hexPattern.test(withPrefix)) {
        throw new Error('PRIVATE_KEY must be a 64-character hex string (with or without 0x prefix)');
    }
    return withPrefix;
}

/**
 * Checks if a string is a valid Ethereum address.
 * @param address - Address to validate
 * @returns True if address matches 0x followed by 40 hex characters
 */
function isValidEthereumAddress(address: string): boolean {
    return /^0x[0-9a-fA-F]{40}$/.test(address);
}

/**
 * Reads and validates all required environment variables for trading.
 * Supports signature types 0, 1, 2, 3.
 * @returns Validated trading configuration object.
 * @throws Error if any required variable is missing or invalid.
 */
function getTradingEnvConfig(): TradingEnvConfig {
    const rawPrivateKey = process.env.PRIVATE_KEY;
    const apiKey = process.env.API_KEY;
    const apiSecret = process.env.API_SECRET;
    const apiPassphrase = process.env.API_PASSPHRASE;
    const rawFunderAddress = process.env.FUNDER_ADDRESS;

    const errors: string[] = [];
    if (!rawPrivateKey) errors.push('PRIVATE_KEY is not set');
    if (!apiKey) errors.push('API_KEY is not set');
    if (!apiSecret) errors.push('API_SECRET is not set');
    if (!apiPassphrase) errors.push('API_PASSPHRASE is not set');
    if (!rawFunderAddress) errors.push('FUNDER_ADDRESS is not set');

    if (errors.length > 0) {
        throw new Error(`Missing environment variables:\n${errors.join('\n')}`);
    }

    let privateKey: string;
    try {
        privateKey = normalizePrivateKey(rawPrivateKey!);
    } catch (error) {
        throw new Error(`Invalid PRIVATE_KEY: ${error_str(error)}`);
    }

    const funderAddress = rawFunderAddress!;
    if (!isValidEthereumAddress(funderAddress)) {
        throw new Error('FUNDER_ADDRESS must be a valid ERC-20 address (0x followed by 40 hex chars)');
    }

    const signatureTypeRaw = safeToNum(process.env.SIGNATURE_TYPE, 2);
    let signatureType = 2;
    if (signatureTypeRaw >= 0) {
        signatureType = signatureTypeRaw;
    }
    if (!Number.isInteger(signatureType)) {
        throw new Error(`SIGNATURE_TYPE must be an integer (0-3). Got: ${signatureType}`);
    }
    if (signatureType > 3) {
        throw new Error(`SIGNATURE_TYPE is set to ${signatureType}, expected 0-3.`);
    }
    if (signatureType !== 2 && signatureType !== 3) {
        console.warn(`SIGNATURE_TYPE is set to ${signatureType}. Make sure your funder address matches this type.`);
    }

    return {
        privateKey,
        apiKey: apiKey!,
        apiSecret: apiSecret!,
        apiPassphrase: apiPassphrase!,
        signatureType,
        funderAddress,
    };
}

/**
 * Reads the public account identity needed by balance and portfolio status.
 * Unlike authenticated client creation, it does not require private API credentials.
 */
export function getTradingAccountIdentity(): TradingAccountIdentity {
    const funderAddress = process.env.FUNDER_ADDRESS;
    if (!funderAddress) throw new Error('FUNDER_ADDRESS is not set');
    if (!isValidEthereumAddress(funderAddress)) {
        throw new Error('FUNDER_ADDRESS must be a valid ERC-20 address (0x followed by 40 hex chars)');
    }
    const signatureType = safeToNum(process.env.SIGNATURE_TYPE, 2);
    if (!Number.isInteger(signatureType) || signatureType < 0 || signatureType > 3) {
        throw new Error(`SIGNATURE_TYPE must be an integer from 0 to 3. Got: ${signatureType}`);
    }
    return { funderAddress, signatureType };
}

/**
 * Returns API credentials (key, secret, passphrase) from environment variables.
 * @returns ClobApiKeyCreds object.
 */
export function getEnvApiKeyCreds(): ClobApiKeyCreds {
    const config = getTradingEnvConfig();
    return {
        key: config.apiKey,
        secret: config.apiSecret,
        passphrase: config.apiPassphrase,
    };
}

/**
 * Creates a public (unauthenticated) CLOB client for read‑only operations.
 * @returns Unauthenticated ClobClient instance.
 * @throws Error if host or chain configuration is missing.
 */
export function getPublicClient(): ClobClient {
    if (!REST_DEFAULT_HOST_CLOB || !REST_CHAIN_ID) {
        throw new Error('Missing REST_DEFAULT_HOST_CLOB or REST_CHAIN_ID configuration!');
    }
    const chain = safeToNum(REST_CHAIN_ID) === 137 ? Chain.POLYGON : Chain.AMOY;
    return new ClobClient({
        host: REST_DEFAULT_HOST_CLOB,
        chain: chain,
    });
}

/**
 * Creates an authenticated trading client using environment variables.
 * Supports signature types 0, 1, 2, and 3 via the SIGNATURE_TYPE env variable.
 * @returns Authenticated ClobClient instance ready for trading.
 * @throws Error if IP is geo‑blocked or environment validation fails.
 */
function createAuthenticatedTradingClient(config: Readonly<TradingEnvConfig>): ClobClient {

    const account = privateKeyToAccount(config.privateKey as `0x${string}`);
    const walletClient = createWalletClient({
        account,
        transport: http(POLYGON_RPC_URL),
    });

    const creds = {
        key: config.apiKey,
        secret: config.apiSecret,
        passphrase: config.apiPassphrase,
    };

    const chain = safeToNum(REST_CHAIN_ID) === 137 ? Chain.POLYGON : Chain.AMOY;
    return new ClobClient({
        host: REST_DEFAULT_HOST_CLOB,
        chain: chain,
        signer: walletClient,
        creds: creds,
        signatureType: config.signatureType,
        funderAddress: config.funderAddress,
        throwOnError: false,
    });
}

/**
 * Creates an authenticated CLOB client for read-only account requests.
 * It deliberately avoids geo-block preflight and allowance synchronization, both
 * of which are trading-path behaviours rather than status reads.
 */
export function getReadOnlyTradingClient(): ClobClient {
    return createAuthenticatedTradingClient(getTradingEnvConfig());
}

/** Returns collateral currently available to the authenticated CLOB account. */
export async function getReadOnlyCollateralBalance(): Promise<number> {
    const response = await getReadOnlyTradingClient().getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    const balance = Number(response.balance);
    if (!Number.isFinite(balance) || balance < 0) throw new Error('CLOB collateral balance is invalid');
    return balance / 1e6;
}

export async function getTradingClient(): Promise<ClobClient> {
    const block = await isMeBlocked();
    if (block) throw new Error("TRADING CLIENT INIT FAILED: IP GEO BLOCKED!");

    const config = getTradingEnvConfig();
    const client = createAuthenticatedTradingClient(config);
    if (config.signatureType === 3) {
        try {
            await client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
        } catch (error) {
            console.warn(`Balance sync failed for type 3 wallet: ${error_str(error)}`);
        }
    }
    return client;
}

/**
 * Derives API credentials (key, secret, passphrase) from a wallet private key.
 * Run this once and store the output in your .env file.
 * @param privateKey - Wallet private key (with or without 0x prefix)
 * @returns Object containing apiKey, secret, and passphrase.
 * @throws Error if derivation fails or credentials are incomplete.
 */
export async function fstInitDeriveApiCredentials(privateKey: string): Promise<ClobApiKeyCreds> {
    if (!privateKey) throw new Error('Private key is required!');
    const normalizedKey = normalizePrivateKey(privateKey);
    const account = privateKeyToAccount(normalizedKey as `0x${string}`);
    const walletClient = createWalletClient({
        account,
        transport: http(POLYGON_RPC_URL),
    });
    const tempClient = new ClobClient({
        host: REST_DEFAULT_HOST_CLOB,
        chain: safeToNum(REST_CHAIN_ID) === 137 ? Chain.POLYGON : Chain.AMOY,
        signer: walletClient,
    });
    const creds = await tempClient.createOrDeriveApiKey();
    if (!creds.key || !creds.secret || !creds.passphrase) {
        throw new Error('Derived credentials are incomplete!');
    }
    return creds;
}
