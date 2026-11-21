#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# 完整发行包含 DMG，需要在可生成 macOS 安装包的 Mac 上执行。
if [[ $(uname -s) != Darwin ]]; then
  printf '%s\n' '请在 macOS 打包机上生成全套安装包。' >&2
  exit 1
fi

mkdir -p test-results
stage="$PWD/test-results/.dist-all"
if ! mkdir "$stage"; then
  printf '暂存目录已存在，请检查是否正在打包或有上次中断的产物：%s\n' "$stage" >&2
  exit 1
fi
next="$stage/next"
bundle="$next/workbench"
published=false
cleanup() {
  if [[ $published == false ]]; then
    if [[ -e "$stage/previous" && ! -e release ]]; then mv "$stage/previous" release || return 1; fi
    if [[ -d "$stage/previous-dist" ]]; then
      if [[ -e dist ]]; then mv dist "$stage/failed-dist" || return 1; fi
      mv "$stage/previous-dist" dist || return 1
    fi
  fi
  # 旧构建和失败的暂存文件均可从 macOS 废纸篓恢复。
  trash "$stage"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir -p "$bundle"
version=$(node -p 'require("./package.json").version')
product=$(node -p 'require("./package.json").productName')
name=$(node -p 'require("./package.json").name')
source_stamp=$(node scripts/release-state.mjs)
if [[ -e dist ]]; then mv dist "$stage/previous-dist"; fi
npm run build
package() {
  local platform=$1 arch=$2 directory=$3
  shift 3
  node scripts/package-desktop.mjs "--$platform" "--$arch" --publish never "-c.directories.output=$bundle/$directory" "$@"
}
# 无证书的本地发行也要在封装 DMG 和 ZIP 前签好完整应用资源。
if [[ -z ${CSC_LINK:-} && -z ${CSC_NAME:-} && -z ${CSC_KEYCHAIN:-} ]] &&
   [[ $(security find-identity -v -p codesigning) == *'0 valid identities found'* ]]; then
  package mac arm64 mac '-c.mac.identity=-'
else
  package mac arm64 mac
fi
codesign --verify --deep --strict "$bundle/mac/mac-arm64/$product.app"
package win x64 windows
package linux x64 linux

(
  cd "$bundle"
  # Asset names follow build.artifactName in package.json (the same as GitHub Releases).
  shasum -a 256 "mac/$name-$version-mac-arm64.dmg" "mac/$name-$version-mac-arm64.zip" \
    "windows/$name-$version-win-x64.exe" "linux/$name-$version-linux-x86_64.AppImage" "linux/$name-$version-linux-amd64.deb" > SHA256SUMS
  shasum -a 256 -c SHA256SUMS
)
node scripts/smoke-package.mjs "$bundle/mac/mac-arm64/$product.app/Contents/MacOS/$product"
if [[ $(node scripts/release-state.mjs) != "$source_stamp" ]]; then
  printf '%s\n' '打包期间项目文件已更改，请从最新源码重新打包。' >&2
  exit 1
fi
printf '%s\n' "$source_stamp" > "$bundle/SOURCE.sha256"
ln -s workbench "$next/$version"

# 新目录同时包含版本入口和全部平台；替换失败时由退出处理恢复旧目录。
if [[ -e release ]]; then mv release "$stage/previous"; fi
mv "$next" release
published=true
printf '已更新 release/workbench，版本 %s。\n' "$version"
