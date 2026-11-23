// Packaged-app check for the SSH login's askpass relay (src/backend/ssh-login.ts).
// On macOS the relay runs as Node (ELECTRON_RUN_AS_NODE=1) in the app's base helper,
//   <App>.app/Contents/Frameworks/<exe> Helper.app/Contents/MacOS/<exe> Helper,
// because the app's own executable, run as Node, shows a second Dock icon for a
// moment. This starts the helper the way OpenSSH starts the relay (a /bin/sh wrapper
// with the prompt as its argument) with a script that does JIT-compiled work and
// answers over a Unix socket, and checks that:
//   - the helper exists and its Info.plist sets LSUIElement;
//   - it runs Node under the signature and entitlements the build gave it;
//   - LaunchServices never lists it as a foreground (Dock) app while it runs. The
//     app's own executable is run the same way for comparison; that is only printed.
// On Linux the relay runs in the executable itself, which is checked instead.
// Windows has no in-app SSH login.
//   node scripts/smoke-askpass-helper.mjs <app-executable | electron-builder output directory>
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { access, constants, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { packagedExecutable } from './package-executable.mjs';

const argument = process.argv[2];
if (!argument) throw new Error('Usage: node scripts/smoke-askpass-helper.mjs <app-executable | electron-builder output directory>');
if (process.platform === 'win32') {
  console.log('SKIP: Windows has no in-app SSH login, so no askpass relay.');
  process.exit(0);
}
const executable = await packagedExecutable(argument);
const mac = process.platform === 'darwin';
const prompt = "dev@lab's password: ";

// Work that V8 compiles with its optimizing tiers: under the hardened runtime that
// needs the JIT entitlement. The checker computes the same value.
function work() {
  let value = 1;
  for (let i = 0; i < 3_000_000; i++) value = (value * 1103515245 + 12345) % 2147483648;
  return value;
}
const probeSource = `const net = require('net');
${work.toString()}
const value = work();
const socket = net.connect(process.env.PROBE_SOCKET);
socket.setEncoding('utf8');
socket.on('connect', () => socket.write(JSON.stringify({ pid: process.pid, argv: process.argv.slice(2), value,
  runAsNode: process.env.ELECTRON_RUN_AS_NODE, node: process.versions.node, electron: process.versions.electron,
  user: /^(\\w+)@(\\w+)'s password: $/.exec(process.argv[2] || '')?.[1] }) + '\\n'));
// The checker answers once it has looked at the process.
socket.on('data', () => socket.end());
setTimeout(() => process.exit(3), 30000).unref();
`;

function plistValue(file, key) {
  const result = spawnSync('plutil', ['-extract', key, 'raw', '-o', '-', file], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

/** LaunchServices' type for a pid ("Foreground" has a Dock icon), or undefined if not listed. */
function launchServicesType(pid) {
  const result = spawnSync('lsappinfo', ['list'], { encoding: 'utf8', timeout: 10_000 });
  if (result.status !== 0) return { unavailable: (result.error?.message ?? result.stderr ?? '').trim() || `exit ${result.status}` };
  const block = result.stdout.split(/^\s*\d+\) /m).find(entry => new RegExp(`\\bpid = ${pid}\\b`).test(entry));
  return { type: block?.match(/\btype="([^"]+)"/)?.[1] };
}

const directory = await mkdtemp('/tmp/lectern-askpass-smoke-');
try {
  const wrapper = path.join(directory, 'askpass'), probe = path.join(directory, 'probe.cjs'), socketPath = path.join(directory, 'probe.sock');
  // The same wrapper ssh-login.ts writes.
  await writeFile(wrapper, '#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "$LECTERN_ASKPASS_NODE" "$LECTERN_ASKPASS_HELPER" "$@"\n', { mode: 0o700 });
  await writeFile(probe, probeSource, { mode: 0o600 });

  /** Run the probe in `node` the way OpenSSH runs askpass; resolves with its report and what LaunchServices saw. */
  async function relay(node) {
    const started = performance.now();
    const server = createServer();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    let child, timer;
    try {
      const env = { ...process.env, LECTERN_ASKPASS_NODE: node, LECTERN_ASKPASS_HELPER: probe, PROBE_SOCKET: socketPath };
      delete env.ELECTRON_RUN_AS_NODE;
      child = spawn(wrapper, [prompt], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk; });
      const exited = new Promise(resolve => child.on('close', (code, signal) => resolve(code ?? signal)));
      const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${node} did not finish within 60 s:\n${output.trim()}`)), 60_000); });
      const answered = new Promise((resolve, reject) => {
        child.on('error', reject);
        // Settling twice is a no-op: this only matters if the probe never answered.
        void exited.then(status => reject(new Error(`${node} exited (${status}) without answering:\n${output.trim()}`)));
        server.once('connection', socket => {
          let buffer = '';
          socket.setEncoding('utf8');
          socket.on('data', async chunk => {
            buffer += chunk;
            if (!buffer.includes('\n')) return;
            const report = JSON.parse(buffer.slice(0, buffer.indexOf('\n')));
            // Registration with LaunchServices happens at startup; look a few times while it runs.
            const seen = new Set();
            if (mac) for (let i = 0; i < 6; i++) {
              const { type, unavailable } = launchServicesType(report.pid);
              seen.add(unavailable ? `lsappinfo unavailable: ${unavailable}` : type ?? 'not listed');
              await new Promise(done => setTimeout(done, 250));
            }
            socket.end('done\n');
            resolve({ ...report, seen: [...seen] });
          });
        });
      });
      const report = await Promise.race([answered, deadline]);
      const status = await Promise.race([exited, deadline]);
      assert.equal(status, 0, `${node} exited with ${status}:\n${output.trim()}`);
      return { ...report, ms: Math.round(performance.now() - started) };
    } finally {
      clearTimeout(timer);
      if (child && child.exitCode === null && child.signalCode === null) child.kill();
      server.close();
      await rm(socketPath, { force: true });
    }
  }

  let node = executable;
  if (mac) {
    const bundle = /^(.+\.app)\/Contents\/MacOS\/([^/]+)$/.exec(executable);
    assert.ok(bundle, `Not inside an app bundle: ${executable}`);
    const helperApp = `${bundle[1]}/Contents/Frameworks/${bundle[2]} Helper.app`;
    node = `${helperApp}/Contents/MacOS/${bundle[2]} Helper`;
    await access(node, constants.X_OK);
    const uiElement = plistValue(`${helperApp}/Contents/Info.plist`, 'LSUIElement');
    console.log(`Helper: ${node}\n  LSUIElement=${uiElement ?? '(not set)'}; app's own LSUIElement=${plistValue(`${bundle[1]}/Contents/Info.plist`, 'LSUIElement') ?? '(not set)'}`);
    assert.ok(['true', '1', 'YES'].includes(uiElement ?? ''), `the helper must be LSUIElement (no Dock icon), got ${uiElement}`);
    const signature = spawnSync('codesign', ['-d', '--verbose=2', '--entitlements', '-', helperApp], { encoding: 'utf8' });
    const signatureText = `${signature.stdout}\n${signature.stderr}`;
    // e.g. "flags=0x10002(adhoc,runtime)" and "Signature=adhoc" or the first "Authority=".
    console.log(`  signature: ${signatureText.match(/flags=\S+/)?.[0] ?? '(no flags)'} ${signatureText.match(/^(?:Signature|Authority)=.*$/m)?.[0] ?? ''}; ` +
      `entitlements: ${[...signatureText.matchAll(/com\.apple\.security\.[\w.-]+/g)].map(match => match[0].replace('com.apple.security.', '')).join(', ') || '(none)'}`);
  }

  const expected = work();
  const report = await relay(node);
  console.log(`Relay through ${path.basename(node)}: Node ${report.node}, Electron ${report.electron}, ${report.ms} ms` +
    (mac ? `; LaunchServices: ${report.seen.join(', ')}` : ''));
  assert.deepEqual(report.argv, [prompt], 'the prompt arrives as the only argument');
  assert.equal(report.user, 'dev');
  assert.equal(report.runAsNode, '1');
  assert.ok(report.electron, 'Node inside Electron');
  assert.equal(report.value, expected, 'JIT-compiled code computes the right value');
  if (mac) {
    assert.ok(!report.seen.includes('Foreground'), `the helper must never be a foreground (Dock) app, LaunchServices saw: ${report.seen.join(', ')}`);
    // For comparison: the app's own executable, which the relay used before.
    const main = await relay(executable);
    console.log(`For comparison, ${path.basename(executable)} as Node: LaunchServices ${main.seen.join(', ')} (Foreground = Dock icon)`);
  }
  console.log(`PASS: the askpass relay runs as Node in ${mac ? 'the LSUIElement helper' : 'the packaged executable'}, with JIT, and answers over its socket.`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
