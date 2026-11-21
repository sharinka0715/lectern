// Use electron-builder's CLI parsing so architecture, output paths and target
// lists remain identical when packaging one or several platforms.
import { readFile } from 'node:fs/promises';
import { build, Platform } from 'electron-builder';
import { configureBuildCommand, createYargs, normalizeOptions } from 'electron-builder/out/builder.js';

const cli = configureBuildCommand(createYargs());
const options = normalizeOptions(await cli.parseAsync(process.argv.slice(2)));
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
// FPM requires a homepage: the GitHub repository once package.json names one,
// otherwise the guide the DEB installs.
const repository = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(manifest.repository?.url ?? '');
const homepage = repository && !/^owner$/i.test(repository[1]) && !/^repo$/i.test(repository[2])
  ? `https://github.com/${repository[1]}/${repository[2]}` : `file:///usr/share/doc/${manifest.name}/README.md`;

for (const [platform, architectures] of options.targets) {
  let config = options.config;
  if (platform === Platform.LINUX) {
    if (typeof config === 'string') config = { extends: config };
    config = { ...config, extraMetadata: { homepage, ...config?.extraMetadata } };
  }
  await build({ ...options, targets: new Map([[platform, architectures]]), config });
}
