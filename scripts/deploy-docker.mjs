import { execFileSync } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseDirectory = path.join(root, 'release');
const stagingDirectory = path.join(releaseDirectory, '.docker-staging');
const packageName = 'pm-bot-docker-linux-amd64';
const imageName = 'pm-bot:linux-amd64';
const wireguardImageName = 'lscr.io/linuxserver/wireguard:latest';

/** @typedef {'tiny' | 'full'} DeploymentMode */

/** @returns {{ mode: DeploymentMode, useSudo: boolean }} */
function readArguments() {
    const arguments_ = process.argv.slice(2);
    const modeArgument = arguments_.find(argument => argument === '--tiny' || argument === '--full');
    const useSudo = arguments_.includes('--sudo');
    if (modeArgument === undefined || arguments_.length !== (useSudo ? 2 : 1)) {
        throw new Error('Usage: npm run deploy:docker -- --tiny|--full [--sudo]');
    }
    return { mode: modeArgument === '--full' ? 'full' : 'tiny', useSudo };
}

function run(command, args, options = {}) {
    execFileSync(command, args, { cwd: root, stdio: 'inherit', ...options });
}

function runDocker(args, useSudo, options = {}) {
    const [command, commandArgs] = useSudo ? ['sudo', ['docker', ...args]] : ['docker', args];
    run(command, commandArgs, options);
}

function readDockerOutput(args, useSudo) {
    const [command, commandArgs] = useSudo ? ['sudo', ['docker', ...args]] : ['docker', args];
    return execFileSync(command, commandArgs, { cwd: root, encoding: 'utf8' }).trim();
}

function readGitRevision() {
    try {
        return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    } catch {
        return 'unknown';
    }
}

async function sha256(filePath) {
    return createHash('sha256').update(await fs.readFile(filePath)).digest('hex');
}

function saveDockerImages(imagePath, useSudo) {
    const descriptor = openSync(imagePath, 'w', 0o644);
    try {
        runDocker(['image', 'save', imageName, wireguardImageName], useSudo, { stdio: ['ignore', descriptor, 'inherit'] });
    } finally {
        closeSync(descriptor);
    }
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

async function build(mode, useSudo) {
    const archivePath = path.join(releaseDirectory, `${packageName}-${mode}.7z`);
    const packageDirectory = path.join(stagingDirectory, packageName);
    const imagePath = path.join(packageDirectory, 'image.tar');
    const runtimeDirectory = path.join(packageDirectory, 'runtime');

    await fs.mkdir(releaseDirectory, { recursive: true });
    await fs.rm(stagingDirectory, { recursive: true, force: true });
    await fs.rm(archivePath, { force: true });

    try {
        runDocker([
            'buildx', 'build', '--platform', 'linux/amd64', '--load',
            '--tag', imageName, '--file', 'Dockerfile', '.',
        ], useSudo);
        runDocker(['pull', '--platform', 'linux/amd64', wireguardImageName], useSudo);
        await fs.mkdir(runtimeDirectory, { recursive: true });
        await Promise.all([
            fs.mkdir(path.join(runtimeDirectory, 'history'), { recursive: true }),
            fs.mkdir(path.join(runtimeDirectory, 'models'), { recursive: true }),
            fs.mkdir(path.join(runtimeDirectory, 'logs'), { recursive: true }),
            fs.mkdir(path.join(runtimeDirectory, 'wireguard', 'wg_confs'), { recursive: true }),
        ]);
        saveDockerImages(imagePath, useSudo);
        const manifest = {
            gitRevision: readGitRevision(),
            builtAt: new Date().toISOString(),
            mode,
            imageSha256: await sha256(imagePath),
            imageName,
            imageId: readDockerOutput(['image', 'inspect', '--format', '{{.Id}}', imageName], useSudo),
            wireguardImageName,
            wireguardImageId: readDockerOutput(['image', 'inspect', '--format', '{{.Id}}', wireguardImageName], useSudo),
        };
        await fs.writeFile(path.join(packageDirectory, 'release-manifest.json'), `${JSON.stringify(manifest, undefined, 2)}\n`);
        await fs.copyFile(path.join(root, 'compose.yaml'), path.join(packageDirectory, 'compose.yaml'));
        await fs.copyFile(path.join(root, 'compose.wireguard.override.yaml.example'), path.join(packageDirectory, 'compose.wireguard.override.yaml.example'));
        await fs.copyFile(path.join(root, 'compose.env.example'), path.join(packageDirectory, 'compose.env.example'));
        await fs.copyFile(path.join(root, 'runtime.env.example'), path.join(packageDirectory, 'runtime.env.example'));
        await fs.copyFile(path.join(root, 'README.md'), path.join(packageDirectory, 'README.md'));
        await fs.copyFile(path.join(root, 'install.sh'), path.join(packageDirectory, 'install.sh'));
        await fs.copyFile(path.join(root, 'menu.sh'), path.join(packageDirectory, 'menu.sh'));
        await fs.chmod(path.join(packageDirectory, 'install.sh'), 0o755);
        await fs.chmod(path.join(packageDirectory, 'menu.sh'), 0o755);
        await fs.cp(path.join(root, 'docs'), path.join(packageDirectory, 'docs'), { recursive: true });
        await fs.cp(path.join(root, 'network'), path.join(packageDirectory, 'network'), { recursive: true });
        await fs.cp(path.join(root, 'systemd'), path.join(packageDirectory, 'systemd'), {
            recursive: true,
            filter: source => !['research.env', 'generated'].includes(path.basename(source)),
        });
        await fs.writeFile(path.join(runtimeDirectory, 'README.md'), [
            '# Runtime data',
            '',
            'The installer or Application settings creates `.env` here from runtime.env.example.',
            'Replace its live API placeholders before using live trading. It is never included in deployment archives.',
            'The `history`, `models`, and `logs` directories are included in this archive.',
            'Copy a WireGuard client config to `wireguard/wg_confs/wg0.conf` only when enabling the VPN override.',
            '',
        ].join('\n'));

        if (mode === 'full') {
            await copyMatchingFiles(
                path.join(root, 'models', 'doge-baseline'),
                path.join(runtimeDirectory, 'models', 'doge-baseline'),
                name => name.endsWith('.json'),
            );
            await copyMatchingFiles(
                path.join(root, 'history', 'frames'),
                path.join(runtimeDirectory, 'history', 'frames'),
                name => !name.includes('.partial.') && (name.endsWith('.json') || name.endsWith('.json.gz')),
            );
        }

        run('7z', ['a', '-t7z', archivePath, packageName], { cwd: stagingDirectory });
        process.stdout.write(`Created ${archivePath}\n`);
    } finally {
        await fs.rm(stagingDirectory, { recursive: true, force: true });
    }
}

const { mode, useSudo } = readArguments();
await build(mode, useSudo);
