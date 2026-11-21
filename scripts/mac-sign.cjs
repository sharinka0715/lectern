// electron-builder custom signer for macOS builds without a Developer ID.
//
// An ad hoc signature is a hash of this exact build, so macOS treats every new
// build as a new app and asks again for Desktop, Documents and other privacy
// folders. When the local identity from scripts/setup-mac-signing.sh exists,
// sign with it instead: its designated requirement (bundle ID + certificate)
// stays the same across builds, and consent given once is kept.
// A real signing identity (Developer ID, CSC_LINK, CSC_NAME) passes through unchanged.
const { execFileSync } = require('node:child_process');

const NAME = 'Lectern Local Signing';

function localIdentity() {
  if (process.env.LECTERN_ADHOC_SIGN === '1') return undefined;
  let listing = '';
  try { listing = execFileSync('security', ['find-identity', '-p', 'codesigning'], { encoding: 'utf8' }); }
  catch { return undefined; }
  // The self-signed certificate is not trusted for distribution, so it is listed
  // only under matching identities; codesign still signs with it by hash.
  for (const line of listing.split('\n')) {
    const match = line.match(/^\s*\d+\)\s+([0-9A-F]{40})\s+"([^"]+)"/);
    if (match && match[2] === NAME) return match[1];
  }
  return undefined;
}

module.exports = async function sign(options) {
  const { signAsync } = require('@electron/osx-sign');
  const local = options.identity === '-' ? localIdentity() : undefined;
  if (local) console.log(`  • signing with local identity "${NAME}" (${local.slice(0, 8)}…)`);
  if (!local) return signAsync(options);
  // A secure timestamp only matters for distribution. Asking Apple's server for one
  // makes local builds fail whenever it does not answer.
  const perFile = options.optionsForFile;
  await signAsync({ ...options, identity: local, identityValidation: false,
    optionsForFile: file => ({ ...(perFile ? perFile(file) : {}), timestamp: 'none' }) });
};
