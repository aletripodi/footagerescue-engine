#!/usr/bin/env bash
# Publishes this folder, as committed, to the public source repository
# (https://github.com/aletripodi/footagerescue-engine): one commit per publication,
# naming the site commit it comes from. Run it after every engine change that goes online.
#
# Usage: publish-source.sh [repository URL]   (needs push access to that repository)
set -euo pipefail

ENGINE="$(cd "$(dirname "$0")/.." && pwd)"
REPO_URL="${1:-https://github.com/aletripodi/footagerescue-engine.git}"
ROOT="$(git -C "$ENGINE" rev-parse --show-toplevel)"
PREFIX="$(git -C "$ENGINE" rev-parse --show-prefix)"   # "engine/"
COMMIT="$(git -C "$ROOT" rev-parse HEAD)"

if ! git -C "$ROOT" diff --quiet HEAD -- "$PREFIX"; then
	echo "engine/ has uncommitted changes: commit them first" >&2
	exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
git clone -q "$REPO_URL" "$TMP/repo" 2>/dev/null
git -C "$TMP/repo" checkout -q -B main
find "$TMP/repo" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
git -C "$ROOT" archive "HEAD:${PREFIX%/}" | tar -x -C "$TMP/repo"
git -C "$TMP/repo" add -A
if git -C "$TMP/repo" diff --cached --quiet; then
	echo "nothing to publish: the public repository already matches $COMMIT"
	exit 0
fi
git -C "$TMP/repo" -c user.name="$(git -C "$ROOT" config user.name)" -c user.email="$(git -C "$ROOT" config user.email)" \
	commit -q -m "Engine source from footagerescue commit $COMMIT"
git -C "$TMP/repo" push -q origin main
echo "published $COMMIT to $REPO_URL"
