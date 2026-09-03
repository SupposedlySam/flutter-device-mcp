#!/usr/bin/env bash
# Resolves a usable Node before exec'ing the MCP launcher.
#
# MCP servers are spawned from a non-interactive shell, which never sources
# ~/.zshrc — so a Node installed through nvm/fnm/volta is on PATH for the
# developer and absent for the server. The failure surfaces as
# "flutter-device-mcp server failed to connect", which reads as a defect in
# the server rather than in how it was started.
set -euo pipefail

readonly MIN_MAJOR=18

# Usable means "runs and is new enough", not "exists": a version manager can
# leave a shim on PATH that resolves to nothing.
node_is_usable() {
  local candidate="$1" version
  [[ -n "$candidate" ]] || return 1
  version="$("$candidate" --version 2>/dev/null)" || return 1
  version="${version#v}"
  version="${version%%.*}"
  [[ "$version" =~ ^[0-9]+$ ]] || return 1
  ((version >= MIN_MAJOR))
}

nvm_default_node() {
  local nvm_dir="${NVM_DIR:-$HOME/.nvm}" alias_file="${NVM_DIR:-$HOME/.nvm}/alias/default"
  [[ -f "$alias_file" ]] || return 1
  local aliased
  aliased="$(sed 's/^v//' "$alias_file" | head -1)"
  [[ -n "$aliased" ]] || return 1
  printf '%s' "$nvm_dir/versions/node/v$aliased/bin/node"
}

find_node() {
  local candidate
  for candidate in \
    "${NODE_BIN_OVERRIDE:-}" \
    "$(command -v node 2>/dev/null || true)" \
    "$(nvm_default_node || true)" \
    "${FNM_DIR:-$HOME/.fnm}/aliases/default/bin/node" \
    "$HOME/.volta/bin/node" \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    /usr/bin/node; do
    if node_is_usable "$candidate"; then
      printf '%s' "$candidate"
      return 0
    fi
  done

  # Newest nvm-installed version, for a machine with nvm but no default alias.
  while IFS= read -r candidate; do
    if node_is_usable "$candidate"; then
      printf '%s' "$candidate"
      return 0
    fi
  done < <(ls -d "${NVM_DIR:-$HOME/.nvm}"/versions/node/*/bin/node 2>/dev/null | sort -Vr)

  return 1
}

if ! NODE_BIN="$(find_node)"; then
  echo "flutter-device-mcp: no Node >= $MIN_MAJOR found." >&2
  echo "  Searched NODE_BIN_OVERRIDE, PATH, \$NVM_DIR, fnm, volta, and the Homebrew/system prefixes." >&2
  echo "  Install Node, or set NODE_BIN_OVERRIDE to an absolute path to a node binary." >&2
  exit 127
fi

exec "$NODE_BIN" "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/run.mjs" "$@"
