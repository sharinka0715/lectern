// The packaged app's executable from an executable path, or from electron-builder's
// output directory (e.g. test-results/package, release-out) holding the unpacked
// app for this platform. Shared by the packaged-app checks.
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const manifestUrl = new URL('../package.json', import.meta.url);

async function executableIn(directory) {
  const { name, productName } = JSON.parse(await readFile(manifestUrl, 'utf8'));
  if (process.platform === 'linux') return path.join(directory, 'linux-unpacked', name);
  if (process.platform === 'win32') return path.join(directory, 'win-unpacked', `${productName}.exe`);
  const entries = await readdir(directory);
  const mac = entries.find(entry => /^mac(?:-arm64|-universal)?$/.test(entry) && (process.arch !== 'arm64' || entry !== 'mac'))
    ?? entries.find(entry => entry.startsWith('mac'));
  if (!mac) throw new Error(`No mac app directory in ${directory}`);
  return path.join(directory, mac, `${productName}.app`, 'Contents', 'MacOS', productName);
}

export async function packagedExecutable(argument) {
  const resolved = path.resolve(argument);
  return (await stat(resolved)).isDirectory() ? executableIn(resolved) : resolved;
}
