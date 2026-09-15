import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseDirectory = path.join(root, 'release');
const packageName = 'pm-bot-linux-x64';
const stagingDirectory = path.join(releaseDirectory, '.staging');
const packageDirectory = path.join(stagingDirectory, packageName);
const bundlePath = path.join(stagingDirectory, 'pm-bot.cjs');
const seaConfigPath = path.join(stagingDirectory, 'sea-config.json');
const binaryPath = path.join(packageDirectory, packageName);

/** @typedef {'tiny' | 'full'} DeploymentMode */

/** @returns {DeploymentMode} */
function readMode() {
    const [argument] = process.argv.slice(2);
    if (process.argv.length !== 3 || (argument !== '--tiny' && argument !== '--full')) {
        throw new Error('Usage: npm run deploy -- --tiny|--full');
    }
    return argument === '--full' ? 'full' : 'tiny';
}

function run(command, arguments_, options = {}) {
    execFileSync(command, arguments_, { cwd: root, stdio: 'inherit', ...options });
}

async function copyMatchingFiles(sourceDirectory, destinationDirectory, matches) {
    let entries;
    try {
        entries = await fs.readdir(sourceDirectory, { withFileTypes: true });
    } catch (error) {
        if (error?.code === 'ENOENT') return;
        throw error;
    }
    for (const entry of entries) {
        const source = path.join(sourceDirectory, entry.name);
        const destination = path.join(destinationDirectory, entry.name);
        if (entry.isDirectory()) {
            await copyMatchingFiles(source, destination, matches);
        } else if (entry.isFile() && matches(entry.name)) {
            await fs.mkdir(destinationDirectory, { recursive: true });
            await fs.copyFile(source, destination);
        }
    }
}

async function build(mode) {
    const archivePath = path.join(releaseDirectory, `${packageName}-${mode}.7z`);
    await fs.mkdir(releaseDirectory, { recursive: true });
    await fs.rm(stagingDirectory, { recursive: true, force: true });
    await fs.rm(archivePath, { force: true });

    try {
        run('npm', ['run', 'check']);
        await fs.mkdir(packageDirectory, { recursive: true });
        run(path.join(root, 'node_modules', '.bin', 'esbuild'), [
            'src/app/pm-bot.ts',
            '--bundle',
            '--platform=node',
            '--format=cjs',
            '--target=node26',
            `--outfile=${bundlePath}`,
        ]);
        await fs.writeFile(seaConfigPath, `${JSON.stringify({
            main: bundlePath,
            mainFormat: 'commonjs',
            output: binaryPath,
            disableExperimentalSEAWarning: true,
            useCodeCache: false,
            execArgv: ['--max-old-space-size=8192'],
        }, undefined, 2)}\n`);
        run(process.execPath, ['--build-sea', seaConfigPath]);
        await fs.chmod(binaryPath, 0o755);
        await fs.copyFile(path.join(root, 'README.md'), path.join(packageDirectory, 'README.md'));

        if (mode === 'full') {
            await copyMatchingFiles(
                path.join(root, 'models', 'doge-baseline'),
                path.join(packageDirectory, 'models', 'doge-baseline'),
                name => name.endsWith('.json'),
            );
            await copyMatchingFiles(
                path.join(root, 'history', 'frames'),
                path.join(packageDirectory, 'history', 'frames'),
                name => !name.includes('.partial.') && (name.endsWith('.json') || name.endsWith('.json.gz')),
            );
        }

        run('7z', ['a', '-t7z', archivePath, packageName], { cwd: stagingDirectory });
        process.stdout.write(`Created ${archivePath}\n`);
    } finally {
        await fs.rm(stagingDirectory, { recursive: true, force: true });
    }
}

await build(readMode());
