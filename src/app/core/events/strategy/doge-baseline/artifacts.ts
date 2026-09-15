import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isFileMissingError } from '../../../../../file_lock.js';
import { delay } from '../../../../../utils.js';
import {
    DOGE_BASELINE_CONFIG_FILE,
    DOGE_BASELINE_EMERGENCY_EXIT_CONFIRMATION_MS,
    DOGE_BASELINE_EMERGENCY_EXIT_DEVIATION_FACTOR,
    DOGE_BASELINE_EMERGENCY_EXIT_RETRY_MS,
    DOGE_BASELINE_EMERGENCY_EXIT_WINDOW_MS,
    DOGE_BASELINE_MODEL_FILE,
    DOGE_BASELINE_STRATEGY,
    DOGE_BASELINE_MODES,
    createDogeBaselineEntrySettings,
    isDogeBaselineModeName,
    type DogeBaselineEntrySettings,
} from './DogeBaselineConfig.js';
import {
    DogeBaselineModel,
    getDogeBaselineArtifactPath,
    getDogeBaselineModelPath,
    readDogeBaselineModel,
    validateDogeBaselineModel,
    writeDogeBaselineModel,
} from './DogeBaselineModel.js';
import type { DogeBaselineEmergencyExitConfig } from './DogeBaselineDecision.js';

const DOGE_BASELINE_STRATEGY_CONFIG_VERSION = 4 as const;
const DOGE_BASELINE_PUBLISH_BACKUP_DIRECTORY = '.publish-backup';
const DOGE_BASELINE_ARTIFACT_READ_RETRIES = 3;
const DOGE_BASELINE_ARTIFACT_READ_RETRY_MS = 10;

export interface DogeBaselineModelReference {
    trainedAt: number;
    requestedFrames: number;
    actualFrames: number;
    firstFrameStart: number;
    lastFrameStart: number;
}

export interface DogeBaselineStrategyConfig {
    version: typeof DOGE_BASELINE_STRATEGY_CONFIG_VERSION;
    strategy: typeof DOGE_BASELINE_STRATEGY;
    model: DogeBaselineModelReference;
    tradingEnabled: boolean;
    entry: DogeBaselineEntrySettings;
    exit: DogeBaselineEmergencyExitSettings;
}

export interface DogeBaselineEmergencyExitSettings extends DogeBaselineEmergencyExitConfig {
    enabled: boolean;
}

export interface DogeBaselineArtifacts {
    model: DogeBaselineModel;
    config: DogeBaselineStrategyConfig;
}

export interface DogeBaselineRuntimeConfig {
    entry: Readonly<DogeBaselineEntrySettings>;
    emergencyExitEnabled: boolean;
    emergencyExitConfig: Readonly<DogeBaselineEmergencyExitConfig>;
}

interface DogeBaselinePublishBackup {
    pid: number;
    modelExists: boolean;
    configExists: boolean;
}

function getModelReference(model: Readonly<DogeBaselineModel>): DogeBaselineModelReference {
    return {
        trainedAt: model.trainedAt,
        requestedFrames: model.requestedFrames,
        actualFrames: model.actualFrames,
        firstFrameStart: model.firstFrameStart,
        lastFrameStart: model.lastFrameStart,
    };
}

function hasSameModelReference(
    left: Readonly<DogeBaselineModelReference>,
    right: Readonly<DogeBaselineModelReference>,
): boolean {
    return left.trainedAt === right.trainedAt && left.requestedFrames === right.requestedFrames &&
        left.actualFrames === right.actualFrames && left.firstFrameStart === right.firstFrameStart &&
        left.lastFrameStart === right.lastFrameStart;
}

function validateEmergencyExit(config: Readonly<DogeBaselineStrategyConfig['exit']>): void {
    if (typeof config.enabled !== 'boolean' || !Number.isInteger(config.windowMs) || config.windowMs <= 0 ||
        !Number.isFinite(config.deviationFactor) || config.deviationFactor <= 0 ||
        !Number.isInteger(config.confirmationMs) || config.confirmationMs < 0 ||
        !Number.isInteger(config.retryMs) || config.retryMs <= 0) {
        throw new Error('invalid_doge_baseline_strategy_config_emergency_exit');
    }
}

function validateEntry(config: Readonly<DogeBaselineEntrySettings>): void {
    if (!config || !config.modes || typeof config.modes !== 'object') {
        throw new Error('invalid_doge_baseline_strategy_config_entry');
    }
    let enabledCount = 0;
    for (const mode of Object.keys(config.modes)) {
        if (!isDogeBaselineModeName(mode)) throw new Error('invalid_doge_baseline_strategy_config_entry');
    }
    for (const mode of DOGE_BASELINE_MODES) {
        const settings = config.modes[mode.name];
        if (!settings || typeof settings.enabled !== 'boolean' || !Number.isFinite(settings.minimumEdge) ||
            settings.minimumEdge < 0 || !Number.isFinite(settings.minimumConfidence) ||
            settings.minimumConfidence < 0.5 || settings.minimumConfidence > 1 ||
            !Number.isFinite(settings.minimumAbsoluteDeviationBps) ||
            settings.minimumAbsoluteDeviationBps < 0) {
            throw new Error('invalid_doge_baseline_strategy_config_entry');
        }
        if (settings.enabled) enabledCount++;
    }
    if (enabledCount === 0) throw new Error('invalid_doge_baseline_strategy_config_entry');
}

export function createDogeBaselineStrategyConfig(
    model: Readonly<DogeBaselineModel>,
    values: Partial<Omit<DogeBaselineStrategyConfig, 'version' | 'strategy' | 'model'>> = {},
): DogeBaselineStrategyConfig {
    validateDogeBaselineModel(model);
    const exit = values.exit ?? {
        enabled: true,
        windowMs: DOGE_BASELINE_EMERGENCY_EXIT_WINDOW_MS,
        deviationFactor: DOGE_BASELINE_EMERGENCY_EXIT_DEVIATION_FACTOR,
        confirmationMs: DOGE_BASELINE_EMERGENCY_EXIT_CONFIRMATION_MS,
        retryMs: DOGE_BASELINE_EMERGENCY_EXIT_RETRY_MS,
    };
    const config: DogeBaselineStrategyConfig = {
        version: DOGE_BASELINE_STRATEGY_CONFIG_VERSION,
        strategy: DOGE_BASELINE_STRATEGY,
        model: getModelReference(model),
        tradingEnabled: values.tradingEnabled ?? true,
        entry: values.entry ?? createDogeBaselineEntrySettings(),
        exit: { ...exit },
    };
    return validateDogeBaselineStrategyConfig(config, model);
}

export function rebindDogeBaselineStrategyConfig(
    model: Readonly<DogeBaselineModel>,
    config: Readonly<DogeBaselineStrategyConfig>,
): DogeBaselineStrategyConfig {
    return createDogeBaselineStrategyConfig(model, {
        tradingEnabled: config.tradingEnabled,
        entry: config.entry,
        exit: config.exit,
    });
}

export function validateDogeBaselineStrategyConfig(
    value: unknown,
    model: Readonly<DogeBaselineModel>,
): DogeBaselineStrategyConfig {
    validateDogeBaselineModel(model);
    if (!value || typeof value !== 'object') throw new Error('invalid_doge_baseline_strategy_config');
    const config = value as DogeBaselineStrategyConfig;
    if (config.version !== DOGE_BASELINE_STRATEGY_CONFIG_VERSION || config.strategy !== DOGE_BASELINE_STRATEGY ||
        !config.model || !hasSameModelReference(config.model, getModelReference(model))) {
        throw new Error('incompatible_doge_baseline_strategy_config');
    }
    if (typeof config.tradingEnabled !== 'boolean') throw new Error('invalid_doge_baseline_strategy_config_trading_enabled');
    validateEntry(config.entry);
    validateEmergencyExit(config.exit);
    return config;
}

export function getDogeBaselineConfigPath(): string {
    return getDogeBaselineArtifactPath(DOGE_BASELINE_CONFIG_FILE);
}

export function toDogeBaselineRuntimeConfig(
    config: Readonly<DogeBaselineStrategyConfig>,
): DogeBaselineRuntimeConfig {
    return {
        entry: config.entry,
        emergencyExitEnabled: config.exit.enabled,
        emergencyExitConfig: config.exit,
    };
}

function getDogeBaselinePublishBackupPath(): string {
    return path.join(path.dirname(getDogeBaselineModelPath()), DOGE_BASELINE_PUBLISH_BACKUP_DIRECTORY);
}

function getDogeBaselinePublishBackupFilePath(fileName: string): string {
    return path.join(getDogeBaselinePublishBackupPath(), fileName);
}

function isProcessRunning(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return !(error instanceof Error && 'code' in error && error.code === 'ESRCH');
    }
}

async function readPublishBackup(): Promise<DogeBaselinePublishBackup | undefined> {
    try {
        const value: unknown = JSON.parse(await fs.readFile(getDogeBaselinePublishBackupFilePath('state.json'), 'utf8'));
        if (!value || typeof value !== 'object') throw new Error('invalid_doge_baseline_publish_backup');
        const backup = value as Partial<DogeBaselinePublishBackup>;
        const { pid, modelExists, configExists } = backup;
        if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0 || typeof modelExists !== 'boolean' ||
            typeof configExists !== 'boolean') {
            throw new Error('invalid_doge_baseline_publish_backup');
        }
        return {
            pid,
            modelExists,
            configExists,
        };
    } catch (error) {
        if (isFileMissingError(error)) return undefined;
        throw error;
    }
}

async function removePublishBackup(): Promise<void> {
    await fs.rm(getDogeBaselinePublishBackupPath(), { recursive: true, force: true });
}

async function restorePublishBackup(backup: Readonly<DogeBaselinePublishBackup>): Promise<void> {
    const files: Array<[string, boolean]> = [
        [DOGE_BASELINE_MODEL_FILE, backup.modelExists],
        [DOGE_BASELINE_CONFIG_FILE, backup.configExists],
    ];
    for (const [fileName, existed] of files) {
        const target = getDogeBaselineArtifactPath(fileName as typeof DOGE_BASELINE_MODEL_FILE | typeof DOGE_BASELINE_CONFIG_FILE);
        if (existed) await fs.copyFile(getDogeBaselinePublishBackupFilePath(fileName), target);
        else await fs.unlink(target).catch(error => {
            if (!isFileMissingError(error)) throw error;
        });
    }
    await removePublishBackup();
}

async function recoverStalePublishBackup(): Promise<void> {
    const backup = await readPublishBackup();
    if (backup === undefined || isProcessRunning(backup.pid)) return;
    await restorePublishBackup(backup);
}

async function createPublishBackup(): Promise<DogeBaselinePublishBackup> {
    await recoverStalePublishBackup();
    const directory = getDogeBaselinePublishBackupPath();
    await fs.mkdir(path.dirname(directory), { recursive: true });
    try {
        await fs.mkdir(directory);
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
            if (await readPublishBackup() !== undefined) throw new Error('doge_baseline_publish_already_running');
            await removePublishBackup();
            return createPublishBackup();
        }
        throw error;
    }
    const targets: Array<[string, string]> = [
        [DOGE_BASELINE_MODEL_FILE, getDogeBaselineModelPath()],
        [DOGE_BASELINE_CONFIG_FILE, getDogeBaselineConfigPath()],
    ];
    const backup: DogeBaselinePublishBackup = { pid: process.pid, modelExists: false, configExists: false };
    try {
        for (const [fileName, target] of targets) {
            try {
                await fs.copyFile(target, getDogeBaselinePublishBackupFilePath(fileName));
                if (fileName === DOGE_BASELINE_MODEL_FILE) backup.modelExists = true;
                else backup.configExists = true;
            } catch (error) {
                if (!isFileMissingError(error)) throw error;
            }
        }
        await fs.writeFile(getDogeBaselinePublishBackupFilePath('state.json'), `${JSON.stringify(backup)}\n`, { flag: 'wx' });
        return backup;
    } catch (error) {
        await removePublishBackup();
        throw error;
    }
}

async function writeAtomic(filePath: string, value: unknown): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}-${Date.now()}.tmp`;
    try {
        await fs.writeFile(temporary, `${JSON.stringify(value, undefined, 2)}\n`, { flag: 'wx' });
        await fs.rename(temporary, filePath);
    } catch (error) {
        await fs.unlink(temporary).catch(() => {});
        throw error;
    }
}

export async function readDogeBaselineStrategyConfig(
    model: Readonly<DogeBaselineModel>,
    filePath: string = getDogeBaselineConfigPath(),
): Promise<DogeBaselineStrategyConfig> {
    return validateDogeBaselineStrategyConfig(JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown, model);
}

export async function readDogeBaselineStrategyConfigOrDefault(
    model: Readonly<DogeBaselineModel>,
): Promise<DogeBaselineStrategyConfig> {
    try {
        return await readDogeBaselineStrategyConfig(model);
    } catch (error) {
        if (!isFileMissingError(error)) throw error;
        return createDogeBaselineStrategyConfig(model);
    }
}

export async function writeDogeBaselineStrategyConfig(
    config: Readonly<DogeBaselineStrategyConfig>,
    model: Readonly<DogeBaselineModel>,
    filePath: string = getDogeBaselineConfigPath(),
): Promise<void> {
    await writeAtomic(filePath, validateDogeBaselineStrategyConfig(config, model));
}

export async function readDogeBaselineArtifacts(
    modelPath: string = getDogeBaselineModelPath(),
    configPath: string = getDogeBaselineConfigPath(),
): Promise<DogeBaselineArtifacts> {
    await recoverStalePublishBackup();
    let lastError: unknown;
    for (let attempt = 0; attempt < DOGE_BASELINE_ARTIFACT_READ_RETRIES; attempt++) {
        try {
            const model = await readDogeBaselineModel(modelPath);
            const config = await readDogeBaselineStrategyConfig(model, configPath);
            const confirmed = await readDogeBaselineModel(modelPath);
            if (hasSameModelReference(getModelReference(model), getModelReference(confirmed))) {
                return { model, config };
            }
        } catch (error) {
            lastError = error;
        }
        if (attempt + 1 < DOGE_BASELINE_ARTIFACT_READ_RETRIES) {
            await delay(DOGE_BASELINE_ARTIFACT_READ_RETRY_MS);
        }
    }
    if (lastError !== undefined) throw lastError;
    throw new Error('doge_baseline_artifacts_changed_during_read');
}

export async function writeDogeBaselineArtifacts(
    model: Readonly<DogeBaselineModel>,
    config: Readonly<DogeBaselineStrategyConfig>,
): Promise<void> {
    const normalized = validateDogeBaselineStrategyConfig(config, model);
    const backup = await createPublishBackup();
    try {
        await writeDogeBaselineModel(model, getDogeBaselineArtifactPath(DOGE_BASELINE_MODEL_FILE));
        await writeDogeBaselineStrategyConfig(normalized, model);
    } catch (error) {
        await restorePublishBackup(backup);
        throw error;
    }
    await removePublishBackup();
}
