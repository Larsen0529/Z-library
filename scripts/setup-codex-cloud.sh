#!/bin/sh
set -eu

if [ "$#" -gt 1 ]; then
  printf 'Usage: %s [workspace-root]\n' "$0" >&2
  exit 2
fi

repo_dir=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)
zlib_version=v0.0.0-20261119133800-48d48668d515
go_version=go1.26.11
bin_dir=$HOME/.local/bin
binary=$bin_dir/zlib
stamp=$bin_dir/.zlib-codex-install
skills_dir=$HOME/.agents/skills
target=$skills_dir/zlibrary

if [ "$(uname -s)" != Linux ]; then
  printf 'This installer requires Linux.\n' >&2
  exit 1
fi
case "$(uname -m)" in
  x86_64) arch=amd64; go_sha=9849f4e04ee35303714e34fbc3ac8ab44ea3e448a95aa182f91e3b9b79c710ec ;;
  aarch64) arch=arm64; go_sha=6c2f29b458b5add0835f18b776f69c8881a6d88428f1484a6da55755e620757e ;;
  *) printf 'Unsupported Linux architecture.\n' >&2; exit 1 ;;
esac

workspace_dir=
if [ "$#" -eq 1 ]; then
  workspace_dir=$(CDPATH='' cd -- "$1" && pwd -P)
  if [ "$(dirname -- "$repo_dir")" != "$workspace_dir" ]; then
    printf 'The workspace root must be the parent of this checkout.\n' >&2
    exit 1
  fi
fi

case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *) printf 'The Codex runtime PATH must include %s\n' "$bin_dir" >&2; exit 1 ;;
esac

mkdir -p -- "$bin_dir" "$skills_dir"
staging=$(mktemp -d "$skills_dir/.zlibrary.XXXXXX")
build_dir=
trap 'rm -rf -- "$staging"; if [ -n "$build_dir" ]; then rm -rf -- "$build_dir"; fi' EXIT
trap 'exit 1' HUP INT TERM

for skill in zlib metadata kindle; do
  source_dir=$repo_dir/.agents/skills/$skill
  test -f "$source_dir/SKILL.md"
  cp -R -- "$source_dir" "$staging/$skill"
done
chmod 755 "$staging"

if [ -e "$target" ] || [ -L "$target" ]; then
  if [ -L "$target" ] || ! diff -qr -- "$staging" "$target"; then
    printf 'Existing skills at %s differ from this checkout. Review that directory before replacing it.\n' "$target" >&2
    exit 1
  fi
else
  mv -T --no-clobber -- "$staging" "$target"
  if [ -d "$staging" ]; then
    diff -qr -- "$staging" "$target"
  fi
fi

installation_record() {
  digest=$(sha256sum < "$1")
  printf '%s %s linux/%s %s\n' "$zlib_version" "$go_version" "$arch" "${digest%% *}"
}

if [ ! -x "$binary" ] || [ ! -f "$stamp" ] ||
  [ "$(cat -- "$stamp")" != "$(installation_record "$binary")" ]; then
  build_dir=$(mktemp -d "$bin_dir/.zlib-build.XXXXXX")
  archive=$go_version.linux-$arch.tar.gz
  curl -q -fLsS --retry 2 --connect-timeout 15 --max-time 180 \
    "https://go.dev/dl/$archive" -o "$build_dir/$archive"
  printf '%s  %s\n' "$go_sha" "$build_dir/$archive" | sha256sum -c -
  tar -xzf "$build_dir/$archive" -C "$build_dir"
  (
    cd "$build_dir"
    GOENV=off GOFLAGS= GOWORK=off GOTOOLCHAIN=local CGO_ENABLED=0 GOOS=linux GOARCH="$arch" \
      GOPROXY=https://proxy.golang.org GOSUMDB=sum.golang.org GOPRIVATE= GONOPROXY= GONOSUMDB= \
      GOPATH="$build_dir/gopath" GOMODCACHE="$build_dir/modules" GOCACHE="$build_dir/cache" \
      GOBIN="$build_dir" "$build_dir/go/bin/go" install -modcacherw -trimpath "github.com/heartleo/zlib/cmd/zlib@$zlib_version"
  )
  "$build_dir/go/bin/go" version -m "$build_dir/zlib" |
    awk -v version="$zlib_version" '$1 == "mod" && $2 == "github.com/heartleo/zlib" && $3 == version { found = 1 } END { exit !found }'
  installation_record "$build_dir/zlib" > "$build_dir/install-record"
  mv -fT -- "$build_dir/zlib" "$binary"
  mv -fT -- "$build_dir/install-record" "$stamp"
fi

if [ "$(command -v zlib)" != "$binary" ]; then
  printf 'The runtime PATH resolves another zlib before %s\n' "$binary" >&2
  exit 1
fi

# A cloud task may start in the workspace above the repository.
if [ -n "$workspace_dir" ] &&
  [ ! -e "$workspace_dir/AGENTS.md" ] && [ ! -L "$workspace_dir/AGENTS.md" ] &&
  [ ! -e "$workspace_dir/AGENTS.override.md" ] && [ ! -L "$workspace_dir/AGENTS.override.md" ]; then
  checkout=$(basename -- "$repo_dir")
  (
    set -C
    printf '# Workspace instructions\n\nFor Z-Library CLI, e-book metadata, or Kindle delivery tasks, read `%s/AGENTS.md` and follow its skill guidance.\n' "$checkout" > "$workspace_dir/AGENTS.md"
  )
fi

printf 'zlib: %s (%s)\nSkills: %s\n' "$binary" "$zlib_version" "$target"
