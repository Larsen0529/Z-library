#!/bin/sh
# Use the persisted CLI without changing the caller's environment or directory.
set -eu

repo_dir=$(CDPATH='' cd -- "${0%/*}/.." && pwd -P)
binary=${repo_dir%/*}/.zlib-tools/codex-install-home/.local/bin/zlib

if [ ! -f "$binary" ]; then
  printf 'zlib: persisted CLI is missing: %s\n' "$binary" >&2
  exit 127
fi
if [ ! -x "$binary" ]; then
  printf 'zlib: persisted CLI is not executable: %s\n' "$binary" >&2
  exit 126
fi

exec "$binary" "$@"
