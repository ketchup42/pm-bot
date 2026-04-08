import { ClobClient } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import "dotenv/config";

import { safeToNum } from "../utils.js";
import {REST_DEFAULT_HOST_CLOB, REST_CHAIN_ID} from "./hosts.js"

/**
 * Returns a public (unauthenticated) CLOB client.
 * Use this for read‑only operations like fetching order books or market data.
 */
export function initGetPublicClientRest(): ClobClient {
    return new ClobClient(REST_DEFAULT_HOST_CLOB, REST_CHAIN_ID);
}

/**
 * Returns an authenticated CLOB client for trading.
 * Requires environment variables:
 * - PRIVATE_KEY
 * - API_KEY, API_SECRET, API_PASSPHRASE (derived once and stored)
 * - SIGNATURE_TYPE (optional, defaults to 2)
 * - FUNDER_ADDRESS
 */
export function initGetTradingClientRest(): ClobClient {
    const privateKey = process.env.PRIVATE_KEY;

    if (!privateKey) {
        throw new Error('PRIVATE_KEY environment variable is not set');
    }

    const apiKey = process.env.API_KEY;
    const apiSecret = process.env.API_SECRET;
    const apiPassphrase = process.env.API_PASSPHRASE;

    if (!apiKey || !apiSecret || !apiPassphrase) {
        throw new Error('API_KEY, API_SECRET, and API_PASSPHRASE must be set');
    }

    const signatureType = safeToNum(process.env.SIGNATURE_TYPE) || 2;
    const funderAddress = process.env.FUNDER_ADDRESS;
    
    if (!funderAddress) {
        throw new Error('FUNDER_ADDRESS environment variable is not set');
    }

    const signer = new Wallet(privateKey);
    const apiCreds = {
        key: apiKey,
        secret: apiSecret,
        passphrase: apiPassphrase,
    };

    return new ClobClient(
        REST_DEFAULT_HOST_CLOB,
        REST_CHAIN_ID,
        signer,
        apiCreds,
        signatureType,
        funderAddress,
        undefined, // additionalConfig
        undefined, // orderConfig
        undefined, // orderbookConfig
        undefined, // marketConfig
        undefined, // metricsConfig
        undefined, // loggingConfig
        true       // throwOnError
    );
}

/**
 * Helper function to derive API credentials from a wallet private key.
 * Run this once and store the resulting key, secret, and passphrase in your .env file.
 * @param privateKey - Wallet private key (starts with 0x)
 * @returns Object containing apiKey, secret, and passphrase
 */
export async function fstInitDeriveApiCredentials(privateKey: string): Promise<{
    apiKey: string;
    secret: string;
    passphrase: string;
}> {
    const signer = new Wallet(privateKey);
    const tempClient = new ClobClient(REST_DEFAULT_HOST_CLOB, REST_CHAIN_ID, signer);
    const creds = await tempClient.createOrDeriveApiKey();
    return {
        apiKey: creds.key,
        secret: creds.secret,
        passphrase: creds.passphrase,
    };
}