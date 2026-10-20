import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { appUrl, config } from '../config.ts';

export const containerName = (slug: string) => `hub-app-${slug}`;

/** Runs a command, streaming combined output into onLog. Rejects on non-zero exit. */
export function sh(cmd: string, args: string[], onLog: (s: string) => void = () => {}, timeoutMs = 15 * 60 * 1000): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const onData = (d: Buffer) => {
      out += d.toString();
      onLog(d.toString());
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('error', reject);
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out.trim());
      else reject(new Error(`${cmd} ${args[0]} exited with ${code}: ${out.slice(-2000)}`));
    });
  });
}

/** Writes a Dockerfile for common project shapes when the project has none. */
export function ensureDockerfile(dir: string, port: number): string {
  const df = path.join(dir, 'Dockerfile');
  if (existsSync(df)) return 'Using the project Dockerfile.';
  if (existsSync(path.join(dir, 'package.json'))) {
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    if (!pkg.scripts?.start) throw new Error('package.json has no "start" script, so the hub does not know how to run it. Add one or include a Dockerfile.');
    const lock = existsSync(path.join(dir, 'pnpm-lock.yaml')) ? 'pnpm' : existsSync(path.join(dir, 'yarn.lock')) ? 'yarn' : existsSync(path.join(dir, 'bun.lock')) || existsSync(path.join(dir, 'bun.lockb')) ? 'bun' : 'npm';
    const install = { pnpm: 'corepack enable && pnpm install --frozen-lockfile=false', yarn: 'corepack enable && yarn install', bun: 'npm i -g bun && bun install', npm: 'npm install' }[lock];
    const runCmd = { pnpm: 'pnpm', yarn: 'yarn', bun: 'bun run', npm: 'npm run' }[lock];
    writeFileSync(df, `FROM node:22-slim
WORKDIR /app
COPY . .
RUN ${install}
${pkg.scripts.build ? `RUN ${runCmd} build\n` : ''}ENV NODE_ENV=production PORT=${port} HOST=0.0.0.0
EXPOSE ${port}
CMD ["sh", "-c", "${lock === 'npm' ? 'npm start' : `${runCmd} start`}"]
`);
    return `No Dockerfile found; generated one for a ${lock} Node project.`;
  }
  if (existsSync(path.join(dir, 'requirements.txt')) || existsSync(path.join(dir, 'pyproject.toml'))) {
    const entry = ['main.py', 'app.py', 'server.py'].find((f) => existsSync(path.join(dir, f)));
    if (!entry) throw new Error('Python project without main.py/app.py/server.py. Include a Dockerfile.');
    writeFileSync(df, `FROM python:3.12-slim
WORKDIR /app
COPY . .
RUN ${existsSync(path.join(dir, 'requirements.txt')) ? 'pip install --no-cache-dir -r requirements.txt' : 'pip install --no-cache-dir .'}
ENV PORT=${port} HOST=0.0.0.0
EXPOSE ${port}
CMD ["python", "${entry}"]
`);
    return `No Dockerfile found; generated one for a Python project (${entry}).`;
  }
  throw new Error('Cannot tell how to run this project. Include a Dockerfile, or a package.json with a start script.');
}

export async function buildImage(slug: string, version: number, dir: string, onLog: (s: string) => void): Promise<string> {
  const tag = `${containerName(slug)}:v${version}`;
  await sh('docker', ['build', '--pull=false', '-t', tag, dir], onLog);
  return tag;
}

const candidateName = (slug: string) => `${containerName(slug)}--next`;

/**
 * Starts a new container next to the live one. Callers health-check it, then promoteCandidate() swaps it in,
 * so a release that fails to start never takes the running version down. Returns the candidate's upstream URL.
 */
export async function startCandidate(slug: string, image: string, port: number, env: Record<string, string>, onLog: (s: string) => void): Promise<string> {
  const name = candidateName(slug);
  await sh('docker', ['rm', '-f', name]).catch(() => {});
  const dataDir = path.join(config.docker.hostDataDir || config.dataDir, 'app-data', slug);
  const args = [
    'run', '-d', '--name', name, '--restart', 'unless-stopped',
    '--memory', config.docker.memory, '--cpus', config.docker.cpus, '--pids-limit', '512',
    '--security-opt', 'no-new-privileges', '--cap-drop', 'ALL',
    '--label', 'hub.app=' + slug,
    '-v', `${dataDir}:/data`,
    '-e', `PORT=${port}`, '-e', 'HOST=0.0.0.0', '-e', 'DATA_DIR=/data', '-e', `HUB_APP_URL=${appUrl(slug)}`,
  ];
  for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
  // A fixed host port (not `127.0.0.1::port`) so the mapping survives container and daemon restarts.
  const hostPort = config.docker.mode === 'port' ? await freePort() : 0;
  if (config.docker.mode === 'network') args.push('--network', await ensureAppNetwork(slug));
  else args.push('-p', `127.0.0.1:${hostPort}:${port}`);
  args.push(image);
  await sh('docker', args, onLog);
  return config.docker.mode === 'network' ? `http://${name}:${port}` : `http://127.0.0.1:${hostPort}`;
}

/** Replaces the live container with the healthy candidate and returns the upstream to store. */
export async function promoteCandidate(slug: string, port: number, candidateUpstream: string): Promise<string> {
  await sh('docker', ['rm', '-f', containerName(slug)]).catch(() => '');
  await sh('docker', ['rename', candidateName(slug), containerName(slug)]);
  return config.docker.mode === 'network' ? `http://${containerName(slug)}:${port}` : candidateUpstream;
}

export const removeCandidate = (slug: string) => sh('docker', ['rm', '-f', candidateName(slug)]).catch(() => '');
export const candidateLogs = (slug: string) => sh('docker', ['logs', '--tail', '80', candidateName(slug)]).catch((e: Error) => e.message);

const networkName = (slug: string) => `hub-net-${slug}`;

/**
 * Each app gets its own bridge network that only it and the hub are on, so an app cannot reach another app's
 * container directly (which would bypass the gateway and let it forge X-Hub-User-* headers).
 */
async function ensureAppNetwork(slug: string): Promise<string> {
  const net = networkName(slug);
  await sh('docker', ['network', 'create', '--label', 'hub.app=' + slug, net]).catch((e: Error) => {
    if (!/already exists/.test(e.message)) throw e;
  });
  const alreadyConnected = (e: Error) => {
    if (!/already exists|already attached|endpoint with name/i.test(e.message)) throw e;
  };
  // Negative gateway priority keeps the hub's default route on its own network. Without it Docker 28+ may pick the
  // new network as default gateway, which drops the hub's in-flight connections.
  await sh('docker', ['network', 'connect', '--gw-priority', '-1', net, config.docker.hubContainer]).catch((e: Error) => {
    if (/unknown flag/i.test(e.message)) {
      console.warn('[docker] CLI older than 28 has no --gw-priority; the hub may lose connections when apps are added. Upgrade the docker CLI.');
      return sh('docker', ['network', 'connect', net, config.docker.hubContainer]).catch(alreadyConnected);
    }
    alreadyConnected(e);
  });
  return net;
}

async function removeAppNetwork(slug: string) {
  if (config.docker.mode !== 'network') return;
  await sh('docker', ['network', 'disconnect', '-f', networkName(slug), config.docker.hubContainer]).catch(() => '');
  await sh('docker', ['network', 'rm', networkName(slug)]).catch(() => '');
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

/** Waits until the app answers HTTP (any status). A bare TCP check is not enough: docker-proxy accepts connections before the app listens. */
export async function waitForHttp(upstream: string, timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const req = http.get(upstream + '/', { timeout: 3000 }, (res) => {
        res.resume();
        resolve(true);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

export const stopContainer = (slug: string) => sh('docker', ['stop', containerName(slug)]);
export const startContainer = (slug: string) => sh('docker', ['start', containerName(slug)]);
export async function removeContainer(slug: string) {
  await sh('docker', ['rm', '-f', containerName(slug), candidateName(slug)]).catch(() => '');
  await removeAppNetwork(slug);
}
export const containerLogs = (slug: string, tail = 200) => sh('docker', ['logs', '--tail', String(tail), containerName(slug)]).catch((e: Error) => e.message);

/** Keeps the images of the current and previous release (for a quick rollback) and deletes older ones. */
export async function pruneImages(slug: string, currentVersion: number) {
  const tags = await sh('docker', ['images', containerName(slug), '--format', '{{.Tag}}']).catch(() => '');
  const old = tags.split('\n').filter((t) => /^v\d+$/.test(t) && Number(t.slice(1)) < currentVersion - 1);
  if (old.length) await sh('docker', ['rmi', ...old.map((t) => `${containerName(slug)}:${t}`)]).catch(() => '');
}

export async function removeImages(slug: string) {
  const ids = await sh('docker', ['images', '-q', containerName(slug)]).catch(() => '');
  if (ids) await sh('docker', ['rmi', '-f', ...ids.split('\n')]).catch(() => '');
}
