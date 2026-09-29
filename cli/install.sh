#!/bin/sh
# Installs the bask CLI from GitHub releases (macOS and Linux).
#
#   curl -fsSL https://raw.githubusercontent.com/rbhans/bask-stream/main/cli/install.sh | sh
#
# Options (environment variables):
#   BASK_VERSION=0.1.0            a specific version (default: the newest bask release)
#   BASK_INSTALL_DIR=~/.local/bin where to put the executable
set -eu

REPO="rbhans/bask-stream"
INSTALL_DIR="${BASK_INSTALL_DIR:-$HOME/.local/bin}"

fail() {
  echo "bask install: $*" >&2
  exit 1
}

command -v curl >/dev/null 2>&1 || fail "curl is required"

case "$(uname -s)" in
  Darwin) os="darwin" ;;
  Linux) os="linux" ;;
  *) fail "unsupported system $(uname -s); on Windows use install.ps1" ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch="x64" ;;
  arm64 | aarch64) arch="arm64" ;;
  *) fail "unsupported CPU $(uname -m)" ;;
esac
# An x64 shell under Rosetta still gets the native Apple silicon build.
if [ "$os" = "darwin" ] && [ "$arch" = "x64" ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ]; then
  arch="arm64"
fi
asset="bask-$os-$arch"

if [ -n "${BASK_VERSION:-}" ]; then
  tag="bask-v${BASK_VERSION#v}"
else
  # The repository also holds module releases, so pick the newest tag starting with bask-v.
  tag="$(curl -fsSL "https://api.github.com/repos/$REPO/releases?per_page=50" \
    | grep -o '"tag_name": *"bask-v[^"]*"' | head -n 1 | sed 's/.*"\(bask-v[^"]*\)"/\1/')" || true
  [ -n "$tag" ] || fail "no bask release found at https://github.com/$REPO/releases"
fi

base="https://github.com/$REPO/releases/download/$tag"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM

echo "Downloading $asset ($tag)..."
curl -fL --progress-bar "$base/$asset" -o "$tmp/bask" || fail "download failed: $base/$asset"

if curl -fsSL "$base/SHA256SUMS" -o "$tmp/SHA256SUMS" 2>/dev/null; then
  expected="$(grep " $asset\$" "$tmp/SHA256SUMS" | cut -d ' ' -f 1)"
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$tmp/bask" | cut -d ' ' -f 1)"
  else
    actual="$(shasum -a 256 "$tmp/bask" | cut -d ' ' -f 1)"
  fi
  [ -n "$expected" ] && [ "$expected" = "$actual" ] || fail "checksum mismatch for $asset"
fi

chmod +x "$tmp/bask"
mkdir -p "$INSTALL_DIR"
mv "$tmp/bask" "$INSTALL_DIR/bask"
echo "Installed $("$INSTALL_DIR/bask" --version 2>/dev/null || echo "$tag") to $INSTALL_DIR/bask"

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    echo
    echo "$INSTALL_DIR is not on your PATH. Add it with:"
    case "${SHELL:-}" in
      */zsh) echo "  echo 'export PATH=\"$INSTALL_DIR:\$PATH\"' >> ~/.zshrc && exec zsh" ;;
      */bash) echo "  echo 'export PATH=\"$INSTALL_DIR:\$PATH\"' >> ~/.bashrc && exec bash" ;;
      *) echo "  export PATH=\"$INSTALL_DIR:\$PATH\"" ;;
    esac
    ;;
esac

echo
echo "Next: bask login https://<station> -u <user> --insecure"
echo "Then: bask"
