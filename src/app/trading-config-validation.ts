import { writeOutput } from '../log.js';
import { isTradingEnvironmentConfigured } from '../rest/client-env.js';

export function formatTradingConfigValidation(valid: boolean): string {
    return JSON.stringify({ valid }, undefined, 2);
}

export async function runTradingConfigValidation(): Promise<void> {
    const arguments_ = process.argv.slice(3);
    if (arguments_.length !== 1 || arguments_[0] !== '--json') {
        throw new Error('Usage: pm-bot validate:trading-config --json');
    }
    writeOutput(formatTradingConfigValidation(isTradingEnvironmentConfigured()));
}
