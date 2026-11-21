import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Developer-only, read-only fingerprint check. This never launches Claude,
// imports embedded code, reads user configuration, or establishes a connection.
const usage = 'Usage: node scripts/audit-native-contracts.mjs --binary PATH --manifest PATH [--out PATH]';
const options = {};
try {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log(usage);
    process.exit(0);
  }
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!['--binary', '--manifest', '--out'].includes(key) || !args[i + 1] || options[key]) throw new Error(usage);
    options[key] = resolve(args[i + 1]);
  }
  if (!options['--binary'] || !options['--manifest']) throw new Error(usage);
  if (options['--out'] && [options['--binary'], options['--manifest']].includes(options['--out'])) {
    throw new Error('Report output must not overwrite the binary or manifest');
  }
  const manifest = JSON.parse(await readFile(options['--manifest'], 'utf8'));
  const hashPattern = /^[a-f0-9]{64}$/;
  if (manifest.schemaVersion !== 1 || !hashPattern.test(manifest.binarySha256)
    || !Number.isSafeInteger(manifest.binaryBytes) || manifest.binaryBytes < 1
    || !Array.isArray(manifest.snippets) || !manifest.snippets.length || manifest.snippets.length > 500) {
    throw new Error('Invalid native contract manifest');
  }
  const labels = new Set();
  for (const snippet of manifest.snippets) {
    if (typeof snippet.id !== 'string' || labels.has(snippet.id)
      || !Number.isSafeInteger(snippet.start) || snippet.start < 0
      || !Number.isSafeInteger(snippet.bytes) || snippet.bytes < 1 || snippet.bytes > 65536
      || snippet.start + snippet.bytes > manifest.binaryBytes || !hashPattern.test(snippet.sha256)) {
      throw new Error('Invalid or duplicate snippet descriptor');
    }
    labels.add(snippet.id);
  }

  const handle = await open(options['--binary'], 'r');
  let result;
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error('Binary path must resolve to a regular file');
    const hash = createHash('sha256');
    // Reuse the open descriptor so an installer replacing the path cannot mix
    // one binary's whole-file fingerprint with another binary's snippets.
    for await (const chunk of createReadStream(options['--binary'], { fd: handle.fd, autoClose: false, start: 0 })) hash.update(chunk);
    const binarySha256 = hash.digest('hex');
    const snippets = [];
    for (const expected of manifest.snippets) {
      const buffer = Buffer.alloc(expected.bytes);
      let total = 0;
      while (total < buffer.length) {
        const { bytesRead } = await handle.read(buffer, total, buffer.length - total, expected.start + total);
        if (!bytesRead) break;
        total += bytesRead;
      }
      const sha256 = createHash('sha256').update(buffer.subarray(0, total)).digest('hex');
      snippets.push({ id: expected.id, feature: expected.feature, start: expected.start,
        bytesRead: total, sha256, matches: total === expected.bytes && sha256 === expected.sha256 });
    }
    const after = await handle.stat();
    const stableRead = before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
    const matches = stableRead && before.size === manifest.binaryBytes && binarySha256 === manifest.binarySha256
      && snippets.every(snippet => snippet.matches);
    result = { schemaVersion: 1, checkedAt: new Date().toISOString(), binary: options['--binary'],
      manifest: options['--manifest'], expectedVersion: manifest.claudeVersion, expectedPlatform: manifest.platform,
      binaryBytes: before.size, binarySha256, stableRead, status: matches ? 'known-build' : 'review-required',
      meaning: 'Byte identity with the audited build only. This does not prove runtime coverage or compatibility with other builds.', snippets };
  } finally {
    await handle.close();
  }
  const json = JSON.stringify(result, null, 2) + '\n';
  // Never overwrite existing files or follow an existing report symlink.
  if (options['--out']) await writeFile(options['--out'], json, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ status: result.status, expectedVersion: result.expectedVersion,
    matchingSnippets: result.snippets.filter(snippet => snippet.matches).length, totalSnippets: result.snippets.length,
    ...(options['--out'] ? { report: options['--out'] } : {}), meaning: result.meaning }, null, 2));
  if (result.status !== 'known-build') process.exitCode = 2;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
