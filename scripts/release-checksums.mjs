// Writes <directory>/SHA256SUMS for every release asset in <directory> (not
// recursive), in `sha256sum` format, then re-reads each file to verify it.
//   node scripts/release-checksums.mjs release-out/assets
// Users check downloads with `sha256sum -c SHA256SUMS --ignore-missing` (Linux)
// or `shasum -a 256 -c SHA256SUMS --ignore-missing` (macOS); the in-app update
// check verifies the installer it downloads against the same file.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const directory = process.argv[2];
if (!directory) {
  console.error('Usage: node scripts/release-checksums.mjs <directory>');
  process.exit(2);
}
const digest = file => new Promise((resolve, reject) => {
  const hash = createHash('sha256');
  createReadStream(file).on('data', chunk => hash.update(chunk)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
});
const names = [];
for (const name of (await readdir(directory)).sort()) {
  if (name === 'SHA256SUMS' || name.startsWith('.') || !(await stat(path.join(directory, name))).isFile()) continue;
  if (/\s/.test(name)) throw new Error(`Asset names must not contain spaces (GitHub renames them): ${name}`);
  names.push(name);
}
if (!names.length) throw new Error(`No files to list in ${directory}`);
const lines = [];
for (const name of names) lines.push(`${await digest(path.join(directory, name))}  ${name}`);
const sums = path.join(directory, 'SHA256SUMS');
await writeFile(sums, lines.join('\n') + '\n');
// Verify from disk, as a user would.
for (const line of (await readFile(sums, 'utf8')).trim().split('\n')) {
  const [expected, name] = line.split(/ {2}/);
  if (await digest(path.join(directory, name)) !== expected) throw new Error(`Checksum mismatch: ${name}`);
}
console.log(lines.join('\n'));
console.log(`SHA256SUMS: ${names.length} files verified`);
