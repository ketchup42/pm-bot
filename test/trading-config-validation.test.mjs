import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

import { formatTradingConfigValidation } from '../dist/app/trading-config-validation.js';
import { isTradingEnvironmentConfigured } from '../dist/rest/client-env.js';

function environment(overrides = {}) {
    return {
        PRIVATE_KEY: `0x${'1'.repeat(64)}`,
        API_KEY: 'test-api-key',
        API_SECRET: 'test-api-secret',
        API_PASSPHRASE: 'test-api-passphrase',
        FUNDER_ADDRESS: `0x${'2'.repeat(40)}`,
        SIGNATURE_TYPE: '2',
        ...overrides,
    };
}

test('trading configuration rejects empty and template credentials', () => {
    assert.equal(isTradingEnvironmentConfigured(environment({ API_KEY: '' })), false);
    assert.equal(isTradingEnvironmentConfigured(environment({ API_SECRET: 'REPLACE_WITH_CLOB_API_SECRET' })), false);
    assert.equal(isTradingEnvironmentConfigured(environment({ PRIVATE_KEY: 'REPLACE_WITH_PRIVATE_KEY' })), false);
});

test('trading configuration accepts syntactically valid local settings', () => {
    assert.equal(isTradingEnvironmentConfigured(environment()), true);
});

test('trading configuration rejects invalid key, address and signature type', () => {
    assert.equal(isTradingEnvironmentConfigured(environment({ PRIVATE_KEY: 'invalid' })), false);
    assert.equal(isTradingEnvironmentConfigured(environment({ FUNDER_ADDRESS: 'invalid' })), false);
    assert.equal(isTradingEnvironmentConfigured(environment({ SIGNATURE_TYPE: '9' })), false);
});

test('trading configuration JSON is compatible with the menu status parser', () => {
    const output = formatTradingConfigValidation(true);
    assert.match(output, /^  "valid": true$/m);
    const menuStatusValueProgram = String.raw`index($0, "\"" key "\"") { value=$2; gsub(/[, "]/, "", value); print value; exit }`;
    const parsed = spawnSync('awk', [
        '-F:',
        '-v', 'key=valid',
        menuStatusValueProgram,
    ], { input: output, encoding: 'utf8' });
    assert.equal(parsed.status, 0);
    assert.equal(parsed.stdout.trim(), 'true');
});
