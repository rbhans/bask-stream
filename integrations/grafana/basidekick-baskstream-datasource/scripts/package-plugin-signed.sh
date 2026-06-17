#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

plugin_id="$(node -e "process.stdout.write(require('./src/plugin.json').id)")"
version="$(node -e "process.stdout.write(require('./package.json').version)")"
expected_plugin_id="basidekick-baskstream-datasource"

if [[ "$plugin_id" != "$expected_plugin_id" ]]; then
  echo "Refusing to package unexpected plugin id: $plugin_id" >&2
  exit 1
fi

if [[ -z "${GRAFANA_ACCESS_POLICY_TOKEN:-}" ]]; then
  echo "GRAFANA_ACCESS_POLICY_TOKEN is required to sign the plugin." >&2
  exit 1
fi

root_urls="${GRAFANA_ROOT_URLS:-${1:-}}"
if [[ -z "$root_urls" ]]; then
  echo "Set GRAFANA_ROOT_URLS to the exact Grafana root URL list, for example:" >&2
  echo "  GRAFANA_ROOT_URLS=http://127.0.0.1:3000 npm run package:signed" >&2
  exit 1
fi

if ! command -v zip >/dev/null 2>&1; then
  echo "zip is required to package the plugin." >&2
  exit 1
fi

artifact_dir="${ARTIFACT_DIR:-$repo_root/artifacts}"
work_dir="${WORK_DIR:-$repo_root/work/package-signed}"
zip_path="$artifact_dir/${plugin_id}-${version}-signed.zip"

npm run package:all

rm -f dist/MANIFEST.txt
npm run sign -- --rootUrls "$root_urls"

test -f dist/plugin.json
test -f dist/MANIFEST.txt

rm -rf "$work_dir"
mkdir -p "$artifact_dir" "$work_dir"
cp -R dist "$work_dir/$plugin_id"

rm -f "$zip_path"
(
  cd "$work_dir"
  zip -qr "$zip_path" "$plugin_id"
)

echo "Created signed private package: $zip_path"
