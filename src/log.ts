import winston from 'winston';
import fs from 'fs';
import path from 'path';

/**
 * Environment variables with defaults
 */
const LOG_LEVEL = process.env.LOG_LEVEL || 'warn';
const LOG_FILE = process.env.LOG_FILE;
// File level: if not set, default to 'info' (not to LOG_LEVEL)
const LOG_FILE_LEVEL = process.env.LOG_FILE_LEVEL || 'info';
const LOG_FILE_MAX_SIZE = process.env.LOG_FILE_MAX_SIZE || '5242880';  // 5MB default
const LOG_FILE_MAX_FILES = process.env.LOG_FILE_MAX_FILES || '5';
const NO_COLOR = process.env.NO_COLOR === 'true' || process.env.NO_COLOR === '1';

// Validate log levels
const validLevels = ['error', 'warn', 'info', 'debug'];
if (!validLevels.includes(LOG_LEVEL)) {
    console.warn(`Invalid LOG_LEVEL "${LOG_LEVEL}", using "warn"`);
}
if (!validLevels.includes(LOG_FILE_LEVEL)) {
    console.warn(`Invalid LOG_FILE_LEVEL "${LOG_FILE_LEVEL}", using "info"`);
}

// Parse numeric values with validation
const parseSize = (value: string, defaultValue: number): number => {
    const parsed = parseInt(value, 10);
    return isNaN(parsed) || parsed <= 0 ? defaultValue : parsed;
};
const maxSize = parseSize(LOG_FILE_MAX_SIZE, 5242880);  // 5MB default
const maxFiles = parseSize(LOG_FILE_MAX_FILES, 5);

/**
 * Common log format (no colors)
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
 * Console transport (with optional colors)
 */
let consoleFormat = baseFormat;
if (!NO_COLOR) {
    consoleFormat = winston.format.combine(
        winston.format.colorize({
            all: true,
            colors: {
                error: 'red',
                warn: 'yellow',
                info: 'cyan',
                debug: 'green'
            }
        }),
        baseFormat
    );
}

const consoleTransport = new winston.transports.Console({
    level: LOG_LEVEL,
    format: consoleFormat
});

const transports: winston.transport[] = [consoleTransport];

/**
 * File transport
 */
if (LOG_FILE) {
    try {
        // Ensure log directory exists (synchronous, but only once at startup)
        const logDir = path.dirname(LOG_FILE);
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }

        transports.push(new winston.transports.File({
            filename: LOG_FILE,
            level: LOG_FILE_LEVEL,
            maxsize: maxSize,
            maxFiles: maxFiles,
            // tailable: true,   // not needed for size-based rotation
            format: winston.format.combine(
                winston.format.uncolorize(), // remove ANSI codes for file
                baseFormat
            )
        }));
    } catch (err) {
        console.error(`Failed to create file transport for ${LOG_FILE}:`, err);
        // Continue without file transport
    }
}

/**
 * Logger instance – NO global `level` to allow transports to filter independently.
 * Exception/rejection handlers use the same transports (safe enough).
 */
export const logger = winston.createLogger({
    format: baseFormat,
    transports,
    exceptionHandlers: transports,
    rejectionHandlers: transports
});

/**
 * Logging levels (most verbose to least):
 * - debug: Detailed debugging information
 * - info: General application progress
 * - warn: Warning messages
 * - error: Error messages
 *
 * Environment variables:
 *   LOG_LEVEL          - Console log level (default: 'warn')
 *   LOG_FILE           - Path to log file (optional, enables file logging)
 *   LOG_FILE_LEVEL     - File log level (default: 'info', independent of LOG_LEVEL)
 *   LOG_FILE_MAX_SIZE  - Max file size in bytes before rotation (default: 5242880 / 5MB)
 *   LOG_FILE_MAX_FILES - Number of rotated files to keep (default: 5)
 *   NO_COLOR           - Set to 'true' to disable console colors (default: false)
 */