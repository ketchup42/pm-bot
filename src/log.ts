import winston from 'winston';
import fs from 'fs';
import path from 'path';
import 'dotenv/config';

/**
 * Environment variables for logging configuration.
 * - No default values are assigned; transports are enabled only when the respective level is explicitly set.
 *
 * @constant {string|undefined} LOG_LEVEL - Enables console logging when set to a valid level.
 * @constant {string|undefined} LOG_FILE - Path to the log file. Required for file logging.
 * @constant {string|undefined} LOG_FILE_LEVEL - Enables file logging when set to a valid level.
 * @constant {string} LOG_FILE_MAX_SIZE - Maximum file size in bytes before rotation (default: 5MB).
 * @constant {string} LOG_FILE_MAX_FILES - Number of rotated files to keep (default: 5).
 * @constant {boolean} NO_COLOR - Disables console colors when set to 'true' or '1'.
 */
const LOG_LEVEL = process.env.LOG_LEVEL;
const LOG_FILE = process.env.LOG_FILE;
const LOG_FILE_LEVEL = process.env.LOG_FILE_LEVEL;
const LOG_FILE_MAX_SIZE = process.env.LOG_FILE_MAX_SIZE || '5242880';
const LOG_FILE_MAX_FILES = process.env.LOG_FILE_MAX_FILES || '5';
const NO_COLOR = process.env.NO_COLOR === 'true' || process.env.NO_COLOR === '1';

/**
 * Valid Winston log levels.
 * @constant {string[]}
 */
const validLevels = ['error', 'warn', 'info', 'debug'];

/**
 * Parses a string size value into an integer.
 * Falls back to a default value if parsing fails.
 *
 * @param value - The size string to parse (e.g., '5242880').
 * @param defaultValue - Fallback value if parsing fails.
 * @returns Parsed integer or default.
 */
const parseSize = (value: string, defaultValue: number): number => {
    // parseInt with base 10 ensures integer conversion
    const parsed = parseInt(value, 10);
    // Also reject zero or negative values (invalid file size)
    return isNaN(parsed) || parsed <= 0 ? defaultValue : parsed;
};

const maxSize = parseSize(LOG_FILE_MAX_SIZE, 5242880);
const maxFiles = parseSize(LOG_FILE_MAX_FILES, 5);

/**
 * Base Winston log format without colors.
 * Includes timestamp, error stack, and a custom printf for metadata.
 */
const baseFormat = winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ level, message, timestamp, stack, ...rest }) => {
        const restString = Object.keys(rest)
            .filter(key => key !== 'service')
            .sort()
            .map(key => `${key}: ${JSON.stringify(rest[key])}`)
            .join(', ');
        let log = `${timestamp} ${level}: ${message}`;
        if (restString) log += ` (${restString})`;
        if (stack) log += `\n${stack}`;
        return log;
    })
);

/**
 * Array of Winston transports.
 * Populated only when the corresponding environment variables are set.
 */
const transports: winston.transport[] = [];

// ----------------------------------------------------------------------
// Console transport – enabled only if LOG_LEVEL is explicitly set
// ----------------------------------------------------------------------
if (LOG_LEVEL !== undefined) {
    if (!validLevels.includes(LOG_LEVEL)) {
        console.warn(`Invalid LOG_LEVEL "${LOG_LEVEL}", console logging disabled`);
    } else {
        let consoleFormat = baseFormat;
        if (!NO_COLOR) {
            consoleFormat = winston.format.combine(
                winston.format.colorize({
                    all: true,
                    colors: { error: 'red', warn: 'yellow', info: 'cyan', debug: 'green' }
                }),
                baseFormat
            );
        }
        transports.push(new winston.transports.Console({
            level: LOG_LEVEL,
            format: consoleFormat
        }));
    }
}

// ----------------------------------------------------------------------
// File transport – enabled only if LOG_FILE_LEVEL is explicitly set and LOG_FILE is provided
// ----------------------------------------------------------------------
if (LOG_FILE && LOG_FILE_LEVEL !== undefined) {
    if (!validLevels.includes(LOG_FILE_LEVEL)) {
        console.warn(`Invalid LOG_FILE_LEVEL "${LOG_FILE_LEVEL}", file logging disabled`);
    } else {
        try {
            const logDir = path.dirname(LOG_FILE);
            if (!fs.existsSync(logDir)) {
                fs.mkdirSync(logDir, { recursive: true });
            }
            transports.push(new winston.transports.File({
                filename: LOG_FILE,
                level: LOG_FILE_LEVEL,
                maxsize: maxSize,
                maxFiles: maxFiles,
                format: winston.format.combine(
                    winston.format.uncolorize(),
                    baseFormat
                )
            }));
        } catch (err) {
            console.error(`Failed to create file transport for ${LOG_FILE}:`, err);
        }
    }
}

/**
 * The Winston logger instance.
 *
 * - Console logs only when `LOG_LEVEL` is explicitly set (and valid).
 * - File logs only when `LOG_FILE_LEVEL` is explicitly set (and `LOG_FILE` is provided).
 * - No default levels – if a variable is missing, the corresponding transport is disabled.
 * - Exception and rejection handlers are added only if at least one transport exists.
 */
export const logger = winston.createLogger({
    format: baseFormat,
    transports,
    exceptionHandlers: transports.length ? transports : undefined,
    rejectionHandlers: transports.length ? transports : undefined
});