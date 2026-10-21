#!/usr/bin/env bash
# Downloads the multilingual-e5-small (q8) model files into models/ (repo root, gitignored) for
# development and the eval harness (scripts/eval). They are NOT bundled into the extension: the
# extension downloads the same pinned revision on demand (src/embed/model-files.ts).
# Idempotent: files whose size matches the remote size are skipped.
set -euo pipefail

MODEL="Xenova/multilingual-e5-small"
REVISION="761b726dd34fb83930e26aab4e9ac3899aa1fa78" # keep in sync with src/embed/model-files.ts
BASE="https://huggingface.co/${MODEL}/resolve/${REVISION}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${ROOT}/models/${MODEL}"

REQUIRED=(config.json tokenizer.json tokenizer_config.json onnx/model_quantized.onnx)
OPTIONAL=(special_tokens_map.json)

file_size() { stat -f%z "$1" 2>/dev/null || stat -c%s "$1"; }

# Final size after redirects (LFS files redirect to a CDN; take the last content-length).
remote_size() {
  curl -sfIL "$1" | tr -d '\r' | awk 'tolower($1)=="content-length:"{n=$2} END{print n}'
}

fetch() {
  local rel="$1" optional="$2" url="${BASE}/$1" out="${DEST}/$1"
  local want
  want="$(remote_size "$url" || true)"
  if [[ -z "$want" ]]; then
    if [[ "$optional" == 1 ]]; then echo "skip   $rel (not in repo)"; return 0; fi
    echo "error: cannot reach $url" >&2; return 1
  fi
  if [[ -f "$out" && "$(file_size "$out")" == "$want" ]]; then
    echo "ok     $rel ($want bytes)"; return 0
  fi
  mkdir -p "$(dirname "$out")"
  echo "fetch  $rel ($want bytes)"
  curl -fsSL --retry 3 -o "${out}.part" "$url"
  local got; got="$(file_size "${out}.part")"
  if [[ "$got" != "$want" ]]; then
    rm -f "${out}.part"; echo "error: $rel size $got != expected $want" >&2; return 1
  fi
  mv "${out}.part" "$out"
}

for f in "${REQUIRED[@]}"; do fetch "$f" 0; done
for f in "${OPTIONAL[@]}"; do fetch "$f" 1; done
echo "model ready in ${DEST}"
