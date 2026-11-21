import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));

// 路径、权限和内容共同标识工作树，包括尚未提交的改动。
const paths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' });
const hash = createHash('sha256');
for (const name of [...new Set(paths.split('\0').filter(Boolean))].sort()) {
  const stat = lstatSync(name, { throwIfNoEntry: false });
  if (!stat || !(stat.isFile() || stat.isSymbolicLink())) continue;
  const content = stat.isSymbolicLink() ? readlinkSync(name) : readFileSync(name);
  hash.update(name).update('\0').update(String(stat.mode)).update('\0');
  hash.update(createHash('sha256').update(content).digest());
}
console.log(hash.digest('hex'));
