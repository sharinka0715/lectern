#!/usr/bin/env bash
# 日常功能改动只替换本机可运行的 .app，不改动上次发行的五个安装包。
set -euo pipefail
cd "$(dirname "$0")/.."
[[ $(uname -s) == Darwin && $(uname -m) == arm64 ]] || { printf '请在 arm64 Mac 上运行。\n' >&2; exit 1; }
app=$(node -p 'require("./package.json").productName')
destination="release/workbench/mac/mac-arm64/$app.app"
mkdir -p test-results "$(dirname "$destination")"
stage=$(mktemp -d "$PWD/test-results/.mac-app.XXXXXX")
cleanup() {
  if [[ -e "$stage/previous.app" && ! -e "$destination" ]]; then mv "$stage/previous.app" "$destination" || return 1; fi
  trash "$stage"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
npm run build
# Without a real identity, scripts/mac-sign.cjs signs with the local identity
# (scripts/setup-mac-signing.sh) or ad hoc, the same as a full release.
identity=()
if [[ -z ${CSC_LINK:-} && -z ${CSC_NAME:-} && -z ${CSC_KEYCHAIN:-} ]] &&
   [[ $(security find-identity -v -p codesigning) == *'0 valid identities found'* ]]; then
  identity=('-c.mac.identity=-')
fi
node scripts/package-desktop.mjs --mac --arm64 --dir --publish never "-c.directories.output=$stage/build" ${identity[@]+"${identity[@]}"}
bundle="$stage/build/mac-arm64/$app.app"
[[ -x "$bundle/Contents/MacOS/$app" && -s "$bundle/Contents/Resources/app.asar" ]]
# 可以传入专项检查命令；最后一个参数是待交付的可执行文件，检查失败则保留旧应用。
if (( $# )); then "$@" "$bundle/Contents/MacOS/$app"; fi
if [[ -e "$destination" ]]; then mv "$destination" "$stage/previous.app"; fi
mv "$bundle" "$destination"
printf '已更新 %s，版本号和各平台安装包保持不变。\n' "$destination"
