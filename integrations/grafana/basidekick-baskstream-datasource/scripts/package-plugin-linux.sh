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

if ! command -v zip >/dev/null 2>&1; then
  echo "zip is required to package the plugin." >&2
  exit 1
fi

artifact_dir="${ARTIFACT_DIR:-$repo_root/artifacts}"
work_dir="${WORK_DIR:-$repo_root/work/package}"
zip_path="$artifact_dir/${plugin_id}-${version}-unsigned-linux.zip"

npm run build
go run github.com/magefile/mage -v build:linux
go run github.com/magefile/mage -v build:linuxARM64

dist_plugin_id="$(node -e "process.stdout.write(require('./dist/plugin.json').id)")"
if [[ "$dist_plugin_id" != "$expected_plugin_id" ]]; then
  echo "Built plugin id mismatch: $dist_plugin_id" >&2
  exit 1
fi
rm -f dist/MANIFEST.txt
cp INSTALL.md dist/INSTALL.md

shopt -s nullglob
backend_binaries=(dist/gpx_*)
if (( ${#backend_binaries[@]} == 0 )); then
  echo "No backend binary was found in dist/." >&2
  exit 1
fi
chmod 0755 "${backend_binaries[@]}"

rm -rf "$work_dir"
mkdir -p "$artifact_dir" "$work_dir"
cp -R dist "$work_dir/$plugin_id"

rm -f "$zip_path"
(
  cd "$work_dir"
  zip -qr "$zip_path" "$plugin_id"
)

echo "Created unsigned internal Linux package: $zip_path"
