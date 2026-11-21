// node scripts/cc-matrix/install.mjs <version...>
// Install Claude Code versions into a private cache (never globally, never over the
// user's own `claude`): CC_MATRIX_CACHE, default ~/.cache/cc-matrix/claude-code/<version>.
// Recent releases are a stub package whose postinstall copies a native binary from
// a platform optionalDependency. npm may skip install scripts (ignore-scripts, or a
// CI policy), so the install always passes --ignore-scripts and then places the
// binary explicitly: through the package's own install.cjs, else by extracting the
// platform package. The result is checked with `claude --version`.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { PACKAGE } from './versions.mjs';

const run = promisify(execFile);
export const cacheRoot = () => path.resolve((process.env.CC_MATRIX_CACHE || path.join(os.homedir(), '.cache', 'cc-matrix', 'claude-code')).replace(/^~(?=\/|$)/, os.homedir()));

function platformKey() {
  const cpu = os.arch();
  if (process.platform === 'linux') {
    const musl = process.report?.getReport?.().header?.glibcVersionRuntime === undefined;
    return `linux-${cpu}${musl ? '-musl' : ''}`;
  }
  return `${process.platform}-${cpu}`;
}

/** The absolute path of a working `claude` for this version, installing it if needed. */
export async function ensureVersion(version, { log = () => {} } = {}) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Not a release version: ${version}`);
  const prefix = path.join(cacheRoot(), version);
  const pkg = path.join(prefix, 'node_modules', '@anthropic-ai', 'claude-code');
  const marker = path.join(prefix, '.ready');
  const binary = await installedBinary(pkg);
  if (existsSync(marker) && binary && await reports(binary, version)) return binary;
  const started = Date.now();
  log(`installing Claude Code ${version} into ${prefix}`);
  await rm(prefix, { recursive: true, force: true });
  await mkdir(prefix, { recursive: true });
  await writeFile(path.join(prefix, 'package.json'), JSON.stringify({ name: 'cc-matrix-install', private: true }));
  await run('npm', ['install', '--prefix', prefix, '--no-save', '--no-package-lock', '--no-audit', '--no-fund', '--ignore-scripts', '--include=optional', `${PACKAGE}@${version}`],
    { maxBuffer: 16 * 1024 * 1024, timeout: 15 * 60_000 });
  if (!(await installedBinary(pkg))) {
    // The postinstall step npm skipped: copy the platform binary over bin/claude.exe.
    if (existsSync(path.join(pkg, 'install.cjs'))) {
      try { await run(process.execPath, [path.join(pkg, 'install.cjs')], { cwd: pkg, timeout: 5 * 60_000, maxBuffer: 4 * 1024 * 1024 }); }
      catch (error) { log(`install.cjs failed: ${String(error.stderr || error.message).trim().split('\n')[0]}`); }
    }
  }
  if (!(await installedBinary(pkg))) await extractPlatformPackage(version, pkg, log);
  const result = await installedBinary(pkg);
  if (!result) throw new Error(`Claude Code ${version}: no runnable binary after install`);
  if (!(await reports(result, version))) throw new Error(`Claude Code ${version}: binary does not report its version`);
  await writeFile(marker, new Date().toISOString());
  log(`Claude Code ${version} ready in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return result;
}

/** bin/claude.exe once it is the native binary (the placeholder stub is a short
 * shell script), or a JavaScript entry point for releases that still ship cli.js. */
async function installedBinary(pkg) {
  const native = path.join(pkg, 'bin', 'claude.exe');
  try { if ((await stat(native)).size > 1024 * 1024) return native; } catch {}
  const js = path.join(pkg, 'cli.js');
  if (existsSync(js)) return js;
  return undefined;
}

async function extractPlatformPackage(version, pkg, log) {
  const name = `${PACKAGE}-${platformKey()}`;
  log(`extracting ${name}@${version}`);
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'cc-matrix-pack-'));
  try {
    const { stdout } = await run('npm', ['pack', `${name}@${version}`, '--pack-destination', scratch, '--silent'], { cwd: scratch, timeout: 15 * 60_000, maxBuffer: 4 * 1024 * 1024 });
    const tarball = path.join(scratch, stdout.trim().split('\n').at(-1));
    await run('tar', ['xzf', tarball, '-C', scratch], { timeout: 5 * 60_000 });
    const files = await readdir(path.join(scratch, 'package'));
    const binary = files.find(file => file === 'claude' || file === 'claude.exe');
    if (!binary) throw new Error(`${name}@${version} has no claude binary`);
    await mkdir(path.join(pkg, 'bin'), { recursive: true });
    const target = path.join(pkg, 'bin', 'claude.exe');
    await rm(target, { force: true });
    await copyFile(path.join(scratch, 'package', binary), target);
    await chmod(target, 0o755);
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

async function reports(binary, version) {
  try {
    const command = binary.endsWith('.js') ? [process.execPath, binary] : [binary];
    const { stdout } = await run(command[0], [...command.slice(1), '--version'], { timeout: 60_000,
      env: { PATH: process.env.PATH, HOME: os.tmpdir(), DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } });
    return stdout.trim().startsWith(version);
  } catch { return false; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const versions = process.argv.slice(2);
  if (!versions.length) { console.error('usage: install.mjs <version...>'); process.exit(2); }
  for (const version of versions) console.log(`${version} ${await ensureVersion(version, { log: line => console.error(line) })}`);
}
