#!/usr/bin/env bash
# Builds this platform's installers into $LECTERN_PACKAGE_OUT/assets (default
# release-out/assets); release.yml runs it on each runner after `npm run build`.
#   bash scripts/ci-package.sh --linux --x64
#   bash scripts/ci-package.sh --mac --arm64 --x64
#   bash scripts/ci-package.sh --win --x64
# Signing only when secrets are provided (see .github/workflows/release.yml):
# macOS falls back to an ad hoc signature, Windows stays unsigned.
set -euo pipefail
cd "$(dirname "$0")/.."
out=${LECTERN_PACKAGE_OUT:-release-out}
args=("$@")
# Never pick up a random identity from the runner's keychain.
export CSC_IDENTITY_AUTO_DISCOVERY=false
unset CSC_LINK CSC_KEY_PASSWORD WIN_CSC_LINK WIN_CSC_KEY_PASSWORD APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID
case " ${args[*]} " in
  *" --mac "*)
    if [[ -n ${MAC_CERTIFICATE:-} ]]; then
      export CSC_LINK=$MAC_CERTIFICATE CSC_KEY_PASSWORD=${MAC_CERTIFICATE_PASSWORD:-}
      echo 'macOS: signing with the Developer ID certificate'
      if [[ -n ${NOTARIZE_APPLE_ID:-} && -n ${NOTARIZE_PASSWORD:-} && -n ${NOTARIZE_TEAM_ID:-} ]]; then
        export APPLE_ID=$NOTARIZE_APPLE_ID APPLE_APP_SPECIFIC_PASSWORD=$NOTARIZE_PASSWORD APPLE_TEAM_ID=$NOTARIZE_TEAM_ID
        echo 'macOS: notarizing'
      fi
    else
      args+=(-c.mac.identity=-)
      echo 'macOS: no certificate secret, ad hoc signature'
    fi ;;
esac
case " ${args[*]} " in
  *" --win "*)
    if [[ -n ${WIN_CERTIFICATE:-} ]]; then
      export WIN_CSC_LINK=$WIN_CERTIFICATE WIN_CSC_KEY_PASSWORD=${WIN_CERTIFICATE_PASSWORD:-}
      echo 'Windows: signing with the Authenticode certificate'
    else
      echo 'Windows: no certificate secret, unsigned installer'
    fi ;;
esac
rm -rf "$out"
node scripts/package-desktop.mjs "${args[@]}" --publish never "-c.directories.output=$out"
# Only installers become release assets; the unpacked app stays for the smoke test.
mkdir -p "$out/assets"
find "$out" -maxdepth 1 -type f \( -name '*.dmg' -o -name '*.zip' -o -name '*.exe' -o -name '*.AppImage' -o -name '*.deb' \) \
  -exec mv {} "$out/assets/" \;
count=$(find "$out/assets" -type f | wc -l)
if (( count == 0 )); then echo "No installers in $out" >&2; exit 1; fi
for file in "$out"/assets/*; do
  # GitHub turns spaces in asset names into dots; SHA256SUMS must match the asset names.
  if [[ $(basename "$file") == *' '* ]]; then echo "Asset name contains a space: $file" >&2; exit 1; fi
done
ls -l "$out/assets"
