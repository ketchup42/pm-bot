import { ClobClient } from "@polymarket/clob-client-v2";
import { Wallet } from "ethers";
import "dotenv/config";

import { error_str, safeToNum } from "../utils.js";
import { REST_DEFAULT_HOST_CLOB, REST_CHAIN_ID } from "./hosts.js";
import { isMeBlocked } from "./block.js";
import { ClobApiKeyCreds } from "@polymarket/real-time-data-client";

/**
 *  Environment Variables Configuration Block
 */
interface TradingEnvConfig {
    privateKey: string;
    apiKey: string;
    apiSecret: string;
    apiPassphrase: string;
    signatureType: number;
    funderAddress: string;
}

/**
 * Normalizes a private key: ensures it has a 0x prefix and is valid hex.
 * @param key - Raw private key (with or without 0x)
 * @returns Normalized private key with 0x prefix
 * @throws Error if key is not a valid 64-character hex string
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
 * Basic validation for an Ethereum address.
 * @param address - Address to validate
 * @returns True if address matches pattern 0x + 40 hex chars
 */
function isValidEthereumAddress(address: string): boolean {
    return /^0x[0-9a-fA-F]{40}$/.test(address);
}

/**
 * Reads and validates all required environment variables for trading.
 * Throws clear errors if any required variable is missing or invalid.
 */
function getTradingEnvConfig(): TradingEnvConfig {
    // Read raw values

    /////////////////////////////////////////////////////////////////
    const rawPrivateKey = process.env.PRIVATE_KEY;
    const apiKey = process.env.API_KEY;
    const apiSecret = process.env.API_SECRET;
    const apiPassphrase = process.env.API_PASSPHRASE;
    const rawFunderAddress = process.env.FUNDER_ADDRESS;
    /////////////////////////////////////////////////////////////////

    // Collect validation errors
    const errors: string[] = [];

    if (!rawPrivateKey) errors.push('PRIVATE_KEY is not set');
    if (!apiKey) errors.push('API_KEY is not set');
    if (!apiSecret) errors.push('API_SECRET is not set');
    if (!apiPassphrase) errors.push('API_PASSPHRASE is not set');
    if (!rawFunderAddress) errors.push('FUNDER_ADDRESS is not set');

    if (errors.length > 0) {
        throw new Error(`Missing environment variables:\n${errors.join('\n')}`);
    }

    // Normalize and validate private key
    let privateKey: string;
    try {
        privateKey = normalizePrivateKey(rawPrivateKey!);
    } catch (error) {
        throw new Error(`Invalid PRIVATE_KEY: ${error_str(error)}`);
    }

    // Validate funder address format
    const funderAddress = rawFunderAddress!;
    if (!isValidEthereumAddress(funderAddress)) {
        throw new Error('FUNDER_ADDRESS must be a valid Ethereum address (0x followed by 40 hex chars)');
    }

    // Parse signature type (optional, default = 2)
    const signatureTypeRaw = safeToNum(process.env.SIGNATURE_TYPE, 2);
    let signatureType = 2;
    if (signatureTypeRaw >= 0) {
        signatureType = signatureTypeRaw;
    }

    // Enforce integer
    if (!Number.isInteger(signatureType)) {
        throw new Error(`SIGNATURE_TYPE must be an integer (0-2). Got: ${signatureType}`);
    }
    if (signatureType > 2) {
        throw new Error(`SIGNATURE_TYPE is set to ${signatureType}, expected 0-2.`);
    }
    if (signatureType !== 2) {
        console.warn(`SIGNATURE_TYPE is set to ${signatureType}, expected 2 (EIP-712). Trading may fail.`);
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

export function getEnvApiKeyCreds(): ClobApiKeyCreds {
    const config = getTradingEnvConfig();
    return {
        key: config.apiKey,
        secret: config.apiSecret,
        passphrase: config.apiPassphrase
    };
}

/**
 * Public Client (Unauthenticated)
 * Returns a public (unauthenticated) CLOB client.
 * Use this for read‑only operations like fetching order books or market data.
 */
export function getPublicClient(): ClobClient {
    if (!REST_DEFAULT_HOST_CLOB || !REST_CHAIN_ID) {
        throw new Error('Missing REST_DEFAULT_HOST_CLOB or REST_CHAIN_ID configuration!');
    }
    return new ClobClient({
        host: REST_DEFAULT_HOST_CLOB,
        chain: REST_CHAIN_ID,
    });
}

/**
 * Trading Client (Authenticated)
 * Returns an authenticated CLOB client for trading.
 * Requires environment variables to be set (see .env.example).
 */
export async function getTradingClient(): Promise<ClobClient> {
    const block = await isMeBlocked();
    if (block) throw new Error("TRADING CLIENT INIT FAILED: IP GEO BLOCKED!");

    const config = getTradingEnvConfig();

    const signer = new Wallet(config.privateKey);
    const creds = {
        key: config.apiKey,
        secret: config.apiSecret,
        passphrase: config.apiPassphrase,
    };

    return new ClobClient({
        host: REST_DEFAULT_HOST_CLOB,
        chain: REST_CHAIN_ID,
        signer,
        creds,
        signatureType: config.signatureType,
        funderAddress: config.funderAddress,
        throwOnError: false,
    });
}

/**
 * Helper: Derive API Credentials from Private Key
 *
 * Derives API credentials (key, secret, passphrase) from a wallet private key.
 * Run this once and store the output in your .env file.
 *
 * @param privateKey - Wallet private key (with or without 0x prefix)
 * @returns Object containing apiKey, secret, and passphrase
 */
export async function fstInitDeriveApiCredentials(privateKey: string): Promise<ClobApiKeyCreds> {
    if (!privateKey) {
        throw new Error('Private key is required!');
    }

    const normalizedKey = normalizePrivateKey(privateKey);

    try {
        const signer = new Wallet(normalizedKey);

        const tempClient = new ClobClient({
            host: REST_DEFAULT_HOST_CLOB,
            chain: REST_CHAIN_ID,
            signer,
        });
        const creds = await tempClient.createOrDeriveApiKey();

        if (!creds.key || !creds.secret || !creds.passphrase) {
            throw new Error('Derived credentials are incomplete!');
        }

        return creds;
    } catch (error) {
        throw new Error(`Failed to derive API credentials: ${error_str(error)}`);
    }
}