#!/usr/bin/env bash
# ============================================================
# BCCH MAIL ENGINE — Empaquetar el motor como ZIP autónomo
# Uso:  bash scripts/pack-release.sh [output.zip]
# No incluye node_modules/, dist/, .env ni secretos.
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT="${1:-$ROOT_DIR/bcch-mail-engine-release.zip}"

if [ -f "$OUT" ]; then rm -f "$OUT"; fi

cd "$ROOT_DIR"
# Excluir artefactos y secretos; incluir TODO el código fuente y docs.
zip -r "$OUT" . \
  -x "node_modules/*" \
  -x "dist/*" \
  -x ".env" \
  -x "*.log" \
  -x "logs/*" \
  -x "tmp/*" \
  -x "bcch-mail-engine-release.zip" \
  -x "scripts/pack-release.sh" >/dev/null

echo "Empaquetado: $OUT ($(du -h "$OUT" | cut -f1))"
echo "Contenido:"
unzip -l "$OUT" | tail -n +4 | head -40