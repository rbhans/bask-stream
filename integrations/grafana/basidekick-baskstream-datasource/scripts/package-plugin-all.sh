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
zip_path="$artifact_dir/${plugin_id}-${version}-unsigned-all.zip"

npm run build
go run github.com/magefile/mage -v build:linux
go run github.com/magefile/mage -v build:linuxARM64
go run github.com/magefile/mage -v build:windows
go run github.com/magefile/mage -v build:darwin
go run github.com/magefile/mage -v build:darwinARM64

dist_plugin_id="$(node -e "process.stdout.write(require('./dist/plugin.json').id)")"
if [[ "$dist_plugin_id" != "$expected_plugin_id" ]]; then
  echo "Built plugin id mismatch: $dist_plugin_id" >&2
  exit 1
fi
rm -f dist/MANIFEST.txt
cp INSTALL.md dist/INSTALL.md

required_binaries=(
  "dist/gpx_bask_stream_linux_amd64"
  "dist/gpx_bask_stream_linux_arm64"
  "dist/gpx_bask_stream_windows_amd64.exe"
  "dist/gpx_bask_stream_darwin_amd64"
  "dist/gpx_bask_stream_darwin_arm64"
)

for binary in "${required_binaries[@]}"; do
  if [[ ! -f "$binary" ]]; then
    echo "Missing expected backend binary: $binary" >&2
    exit 1
  fi
done

chmod 0755 dist/gpx_bask_stream_linux_* dist/gpx_bask_stream_darwin_*

rm -rf "$work_dir"
mkdir -p "$artifact_dir" "$work_dir"
cp -R dist "$work_dir/$plugin_id"

rm -f "$zip_path"
(
  cd "$work_dir"
  zip -qr "$zip_path" "$plugin_id"
)

echo "Created unsigned internal all-platform package: $zip_path"
