import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { setImmediate as flush } from 'node:timers/promises';
import { EndpointBillingCache, endpointBillingProbe } from '../src/backend/endpoint-billing';
import { quoteShell } from '../src/backend/transport';
import type { Workspace } from '../src/shared/types';

// A shell function in an isolated environment, never the user's CLI or account.
function probe(extra: Record<string, unknown>, help = '  --json      Output as JSON (default)', route = '') {
  const fixture = JSON.stringify({ loggedIn: true, apiProvider: 'firstParty', authMethod: 'none',
    email: 'do-not-export@example.invalid', orgName: 'private-fixture', ...extra }, null, 2);
  const shell = `claude() { case "$*" in 'auth status --help') printf '%s\\n' ${quoteShell(help)};; '--setting-sources user auth status --json') printf '%s\\n' ${quoteShell(fixture)};; *) exit 1;; esac; };\n${endpointBillingProbe()}`;
  return execFileSync('/bin/sh', ['-c', shell], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: '/', ANTHROPIC_BASE_URL: route } }).trim();
}

test('native auth status probe filters at source and never guesses a subscription from a token', { skip: process.platform === 'win32' }, () => {
  assert.equal(probe({ authMethod: 'claude.ai', subscriptionType: 'max' }), 'subscription');
  assert.equal(probe({ authMethod: 'claude.ai', subscriptionType: null }), 'unknown');
  assert.equal(probe({ authMethod: 'oauth_token' }), 'unknown');
  assert.equal(probe({ authMethod: 'api_key_helper', subscriptionType: 'max' }), 'api');
  assert.equal(probe({ authMethod: 'api_key', apiProvider: 'foundry' }), 'third-party');
  assert.equal(probe({ authMethod: 'api_key' }, undefined, 'https://example.invalid'), 'third-party');
  assert.equal(probe({ loggedIn: false }), 'signed-out');
  assert.equal(probe({ authMethod: 'api_key' }, 'unknown command'), '');
});

test('auth probes are lazy, coalesced per endpoint/config, expire and fail closed', async () => {
  let calls = 0;
  const cache = new EndpointBillingCache({ run: async () => {
    calls++; return { stdout: Buffer.from(calls === 1 ? 'api\n' : 'not-a-category'), stderr: '' };
  } });
  const project: Workspace = { id: 'one', kind: 'ssh', name: 'fixture', host: 'host', cwd: '/one' };
  assert.equal(calls, 0);
  assert.equal(cache.observe(project, '/config'), undefined);
  assert.equal(cache.observe({ ...project, cwd: '/two' }, '/config'), undefined);
  assert.equal(calls, 1);
  await flush();
  assert.equal(cache.observe(project, '/config'), 'api');
  cache.observe(project, '/other');
  cache.observe({ ...project, port: 9999 }, '/config');
  cache.observe({ ...project, kind: 'ssh', host: 'a' }, '/config');
  cache.observe({ ...project, kind: 'ssh', host: 'b' }, '/config');
  assert.equal(calls, 5);
  assert.equal(cache.observe(project, '/config', Date.now() + 6 * 60_000), undefined);
  await flush();
  assert.equal(cache.observe(project, '/config'), 'unknown');
});

test('the conversation file contributes the endpoint without exposing its URL in the auth command', async () => {
  let command = '';
  const cache = new EndpointBillingCache({ run: async (_workspace, script, options) => {
    if (options?.tag === 'settings.file.read') return { stdout: Buffer.from('o{"env":{"ANTHROPIC_BASE_URL":"https://service.example.invalid"}}'), stderr: '' };
    command = script;
    return { stdout: Buffer.from('third-party\n'), stderr: '' };
  } });
  const project: Workspace = { id: 'sample', kind: 'local', name: 'Fixture', cwd: '/sample' };
  cache.observe(project, '/sample/config', Date.now(), '~/chat.json');
  await flush();
  assert.match(command, /custom=1/);
  assert.match(command, /--settings "\$HOME"\/'chat\.json'/);
  assert.doesNotMatch(command, /service\.example\.invalid/);
  assert.equal(cache.observe(project, '/sample/config', Date.now(), '~/chat.json'), 'third-party');
});
