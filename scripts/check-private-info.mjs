#!/usr/bin/env node
// Guards the public repository against private information: internal IP
// addresses, personal e-mail addresses, personal home paths and macOS temporary
// folders, computer and internal host names, private package registries, keys
// and tokens. Binary files (icons, media) are checked through their readable
// strings and PNG text chunks. Generic patterns only; terms specific to one person
// or company go in the optional, git-ignored `.private-info-denylist` (one
// regular expression per line, `#` comments), never in the repository.
//
//   node scripts/check-private-info.mjs             tracked and new files
//   node scripts/check-private-info.mjs --history   also every blob and author in the git history
//   node scripts/check-private-info.mjs --verbose   print the matched text too
//
// A line containing `private-info: allow` is skipped (use sparingly, e.g. for
// this file's own patterns). Exit status 1 when anything is found.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const git = (...a) => execFileSync('git', a, { cwd: root, maxBuffer: 1 << 30 });

// Placeholders that are fine in docs and tests.
const allowedUsers = 'me|you|user|users|example|test|tester|dev|developer|runner|shared|Shared|name|someone|alice|bob|remote|u|x|demo|lectern|project|work|app|ubuntu|root|linuxbrew';
// Apple's documented example of a per-user temporary folder (/var/folders/zz/…/T/).
const placeholderTempFolder = 'zz/zyxvpxvq6csfxvn_n0000000000000';
// RFC 2606 names (example.com, *.test, *.invalid), vendor and GitHub no-reply addresses.
const allowedEmailDomains = /@(?:(?:[\w-]+\.)*example\.(?:com|org|net)|[\w.-]+\.(?:example|test|invalid|localhost)|anthropic\.com|users\.noreply\.github\.com|github\.com)$/i;
const octet = '(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)';
const rules = [
  // Real addresses, private or public. Tests use loopback and the documentation
  // ranges (RFC 5737): 192.0.2.x, 198.51.100.x, 203.0.113.x.
  { name: 'IPv4 address', pattern: new RegExp(`(?<![\\d.])${octet}\\.${octet}\\.${octet}\\.${octet}(?![\\d.]*\\d)`, 'g'),
    allow: match => /^(?:127\.|0\.0\.0\.0$|255\.255\.|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)/.test(match) }, // private-info: allow
  // The same private ranges written into host names: ip-10-1-2-3, 192_168_0_7.
  { name: 'IPv4 in a host name', pattern: /\b(?:ip-)?(?:10(?:[-_]\d{1,3}){3}|(?:192[-_]168|172[-_](?:1[6-9]|2\d|3[01]))(?:[-_]\d{1,3}){2})\b/g }, // private-info: allow
  { name: 'e-mail address', pattern: /(?<![\w.+-])[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}\b/g, allow: match => allowedEmailDomains.test(match) || /^git@/.test(match) }, // private-info: allow
  { name: 'personal home path', pattern: new RegExp(`(?:/Users/|/home/|[A-Z]:[\\\\/]Users[\\\\/])(?!(?:${allowedUsers})\\b)[A-Za-z][\\w.-]*`, 'g'), allow: match => /[<>{}$*]/.test(match) }, // private-info: allow
  // macOS per-user temporary folders identify one account on one computer.
  { name: 'macOS user temp folder', pattern: /\/var\/folders\/[\w+-]{2}\/[\w+-]{20,}/g, allow: match => match.endsWith(placeholderTempFolder) }, // private-info: allow
  { name: 'internal host name', pattern: /\b[\w-]+(?:\.[\w-]+)*\.(?:corp|intra|intranet|internal|lan|home\.arpa)\b(?![\w-])/gi }, // private-info: allow
  // Default computer names: alice-MacBook-Pro, alicesMacBook-Air.local, build-box-01.local.
  { name: 'computer name', pattern: /\b[A-Za-z0-9]+-?(?:MacBook-(?:Pro|Air)|iMac|Mac-mini|Mac-Studio)\b|\b\w+(?:-\w+)+\.local\b(?![\w-])/g }, // private-info: allow
  { name: 'package registry', pattern: /"resolved": "https?:\/\/(?!registry\.npmjs\.org\/)[^"/]+/g }, // private-info: allow
  { name: 'private key', pattern: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/g }, // private-info: allow
  { name: 'access token', pattern: /\b(?:sk-ant-[\w-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_\w{30,}|xox[abprs]-[\w-]{10,}|AKIA[0-9A-Z]{16})\b/g }, // private-info: allow
];

// Personal terms: names, machines, companies, internal tools. Never committed.
const denylistFile = process.env.LECTERN_PRIVATE_DENYLIST || path.join(root, '.private-info-denylist');
if (existsSync(denylistFile)) {
  for (const raw of readFileSync(denylistFile, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    rules.push({ name: 'local denylist', pattern: new RegExp(line, 'gi'), quiet: true });
  }
}
// This guard and the denylist's own name are not findings.
const skipFiles = new Set(['scripts/check-private-info.mjs']);
// The lockfile lists public package authors' addresses; its other rules still apply.
const lockfileRule = rule => rule.name !== 'e-mail address';
const isBinary = buffer => buffer.subarray(0, 8000).includes(0);
// Of a binary file (image, icon, media), only its readable strings: metadata and embedded paths.
// Short runs are random bytes; PNG text chunks (also inside .icns/.ico) are read whole.
const runs = (buffer, min) => buffer.toString('utf8').match(new RegExp(`[^\\x00-\\x1f\\x7f-\\x9f\\ufffd]{${min},}`, 'gu')) ?? [];
function pngText(buffer) {
  const out = [];
  for (const { index } of buffer.toString('latin1').matchAll(/tEXt|zTXt|iTXt|eXIf/g)) {
    if (index < 4) continue;
    const body = buffer.subarray(index + 4, index + 4 + buffer.readUInt32BE(index - 4));
    const type = buffer.toString('latin1', index, index + 4), key = body.indexOf(0);
    try {
      if (type === 'zTXt') out.push(...runs(body.subarray(0, key), 1), ...runs(inflateSync(body.subarray(key + 2)), 1));
      else if (type === 'iTXt' && body[key + 1] === 1) out.push(...runs(body.subarray(0, key), 1), ...runs(inflateSync(body.subarray(body.indexOf(0, body.indexOf(0, key + 3) + 1) + 1)), 1));
      else out.push(...runs(body, 2));
    } catch { /* not a chunk, just the same four letters */ }
  }
  return out;
}
const readableStrings = buffer => [...runs(buffer, 8), ...pngText(buffer)].join('\n');

function scan(name, buffer, report) {
  if (skipFiles.has(name)) return;
  const binary = isBinary(buffer);
  const lines = (binary ? readableStrings(buffer) : buffer.toString('utf8')).split('\n');
  const active = path.basename(name) === 'package-lock.json' ? rules.filter(lockfileRule) : rules;
  lines.forEach((line, index) => {
    if (line.includes('private-info: allow')) return;
    for (const rule of active) {
      for (const match of line.matchAll(rule.pattern)) {
        if (rule.allow?.(match[0])) continue;
        report({ file: name, line: binary ? 0 : index + 1, rule: binary ? `${rule.name} (binary)` : rule.name, text: rule.quiet ? '' : match[0] });
      }
    }
  });
}

const findings = [];
const add = finding => findings.push(finding);
const files = [...new Set([
  ...git('ls-files', '-z').toString().split('\0'),
  ...git('ls-files', '-z', '--others', '--exclude-standard').toString().split('\0'),
].filter(Boolean))];
for (const file of files) {
  const full = path.join(root, file);
  if (!existsSync(full)) continue;
  try { scan(file, readFileSync(full), add); } catch { /* a directory (submodule) or unreadable */ }
}

// --history: every blob of every commit, and every author/committer identity.
const history = [];
if (args.includes('--history')) {
  const identities = new Map();
  for (const row of git('log', '--all', '--format=%H%x09%an <%ae>%x09%cn <%ce>').toString().trim().split('\n').filter(Boolean)) {
    const [commit, author, committer] = row.split('\t');
    for (const who of [author, committer]) identities.set(who, (identities.get(who) ?? []).concat(commit.slice(0, 8)));
  }
  for (const [who, commits] of identities) {
    scan(`identity ${commits.length} commit(s)`, Buffer.from(who), finding => history.push({ ...finding, line: 0 }));
  }
  const blobs = new Map();
  for (const row of git('rev-list', '--all', '--objects').toString().split('\n')) {
    const [sha, ...name] = row.split(' ');
    if (sha && name.length && !blobs.has(sha)) blobs.set(sha, name.join(' '));
  }
  const types = git('cat-file', '--batch-check=%(objectname) %(objecttype)', '--batch-all-objects').toString().split('\n');
  const isBlob = new Set(types.filter(row => row.endsWith(' blob')).map(row => row.split(' ')[0]));
  const current = new Set(files);
  for (const [sha, name] of blobs) {
    if (!isBlob.has(sha)) continue;
    scan(name, git('cat-file', 'blob', sha), finding => history.push({ ...finding, file: `${finding.file}@${sha.slice(0, 8)}${current.has(name) ? '' : ' (removed)'}` }));
  }
}

function print(title, list) {
  if (!list.length) return;
  const byRule = new Map();
  for (const item of list) byRule.set(item.rule, (byRule.get(item.rule) ?? 0) + 1);
  console.log(`${title}: ${list.length} finding(s) (${[...byRule].map(([rule, n]) => `${rule} ×${n}`).join(', ')})`);
  for (const item of list) {
    const where = item.line ? `${item.file}:${item.line}` : item.file;
    console.log(`  ${where}  ${item.rule}${verbose && item.text ? `  ${item.text}` : ''}`);
  }
}
print('Working tree', findings);
print('Git history', history);
if (!findings.length && !history.length) {
  console.log(`No private information found in ${files.length} files${args.includes('--history') ? ' and the git history' : ''}${existsSync(denylistFile) ? ' (local denylist applied)' : ''}.`);
} else if (!verbose) {
  console.log('Run with --verbose to see the matched text. Replace private values with placeholders such as example.com, 192.0.2.x or /home/dev.');
}
process.exit(findings.length || history.length ? 1 : 0);
