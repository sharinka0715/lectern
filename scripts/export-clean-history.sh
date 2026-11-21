#!/usr/bin/env bash
# Publishes the current source as a NEW repository with a single commit, so the
# public history carries neither earlier file contents nor the authors' private
# e-mail addresses. The source repository is not modified.
#
#   bash scripts/export-clean-history.sh <ref> <new-directory> "Public Name <id+name@users.noreply.github.com>"
#   cd <new-directory> && git remote add origin git@github.com:sharinka0715/lectern.git
#   git push -u origin main   (then push a v<version> tag to test and publish a release)
#
# Before running: the working tree of <ref> must pass the private-information
# guard (it is checked again on the exported files, with your local denylist).
#
# Alternative that keeps the commit history (all hashes change):
#   git clone --no-local --mirror . /tmp/lectern-rewrite && cd /tmp/lectern-rewrite
#   git filter-repo --mailmap ../mailmap.txt \
#     --replace-text ../replacements.txt \
#     --invert-paths --path <private-file> --path-glob '<private-dir>/*'
#   node <checkout>/scripts/check-private-info.mjs --history   (run inside a checkout of the result)
# mailmap.txt maps the old author to the public identity; replacements.txt lists
# every private string (from your denylist) with its placeholder. Every old blob
# is rewritten, so one missed string stays public forever: re-run the history
# audit on the rewritten clone before pushing anything.
set -euo pipefail
if (( $# != 3 )); then
  sed -n '2,11p' "$0" >&2
  exit 2
fi
ref=$1 target=$2 identity=$3
source=$(git -C "$(dirname "$0")/.." rev-parse --show-toplevel)
if [[ ! $identity =~ ^(.+)\ \<([^<>@\ ]+@[^<>\ ]+)\>$ ]]; then
  echo "Identity must look like: Name <email>" >&2
  exit 2
fi
name=${BASH_REMATCH[1]} email=${BASH_REMATCH[2]}
if [[ -e $target ]] && [[ -n $(ls -A "$target" 2>/dev/null) ]]; then
  echo "Target directory must be new or empty: $target" >&2
  exit 1
fi
commit=$(git -C "$source" rev-parse --verify "$ref^{commit}")
manifest=$(git -C "$source" show "$commit:package.json")
version=$(printf '%s' "$manifest" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).version))')
product=$(printf '%s' "$manifest" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).productName))')
mkdir -p "$target"
git -C "$source" archive --format=tar "$commit" | tar -x -C "$target"
# The denylist stays outside the export; the guard reads it from the source checkout.
export LECTERN_PRIVATE_DENYLIST=${LECTERN_PRIVATE_DENYLIST:-$source/.private-info-denylist}
cd "$target"
git init -q -b main
git add -A
# The guard scans tracked files of this new repository, i.e. exactly what would be pushed.
node scripts/check-private-info.mjs
GIT_AUTHOR_NAME=$name GIT_AUTHOR_EMAIL=$email GIT_COMMITTER_NAME=$name GIT_COMMITTER_EMAIL=$email \
  git -c commit.gpgsign=false commit -q -m "$product $version"
git log --format='%h %an <%ae> %s' -1
echo "Exported ${commit:0:12} as a single commit in $target (version $version)."
echo "Next: git remote add origin git@github.com:sharinka0715/lectern.git && git push -u origin main"
echo "Pushing tag v$version runs the tests and, if they pass, publishes the release."
