#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

# Keep caches outside the checkout; the Cloud user's home may be read-only.
cloud_cache="${HEISEI_CLOUD_CACHE_DIR:-/workspace/.heisei-cloud}"
export COREPACK_HOME="${COREPACK_HOME:-$cloud_cache/corepack}"
export XDG_DATA_HOME="${XDG_DATA_HOME:-$cloud_cache/data}"
export npm_config_cache="${npm_config_cache:-$cloud_cache/npm}"
mkdir -p "$COREPACK_HOME" "$XDG_DATA_HOME" "$npm_config_cache"

node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 13)) { console.error("HEISEI requires Node.js >=22.13.0"); process.exit(1); }'
node --version
corepack --version
expected_pnpm="$(node -p 'require("./package.json").packageManager.split("@")[1]')"
actual_pnpm="$(corepack pnpm --version)"
if [[ "$actual_pnpm" != "$expected_pnpm" ]]; then
  echo "pnpm version mismatch: expected $expected_pnpm, got $actual_pnpm" >&2
  exit 1
fi
echo "pnpm $actual_pnpm"

CI=true corepack pnpm install --frozen-lockfile --store-dir "$cloud_cache/store"
