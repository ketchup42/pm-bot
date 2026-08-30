import { exit } from "process";
import { logger_shutdown } from "./log.js";

export async function globalDie(): Promise<void> {
    await logger_shutdown();
    process.stdout.write(`Dying...\n`);
    exit();
}