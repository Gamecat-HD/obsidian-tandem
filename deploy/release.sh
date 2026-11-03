#!/usr/bin/env bash
# Release bauen und auf GitHub veröffentlichen: Plugin (main.js, manifest.json, styles.css + zip),
# statischer Server-Binary (musl) und SHA256SUMS. Der Update-Knopf im Plugin lädt genau diese Dateien.
#
#   deploy/release.sh            # Version aus plugin/manifest.json, Tag muss committet sein
#   deploy/release.sh --dry-run  # nur bauen und prüfen, nichts hochladen
set -euo pipefail
cd "$(dirname "$0")/.."
DRY=${1:-}

VER=$(node -p "require('./plugin/manifest.json').version")
[ "$(node -p "require('./plugin/package.json').version")" = "$VER" ] || { echo "package.json ≠ manifest.json ($VER)"; exit 1; }
grep -q "^version = \"$VER\"" server/Cargo.toml || { echo "server/Cargo.toml hat nicht $VER"; exit 1; }
node -e "process.exit(require('./plugin/versions.json')['$VER'] ? 0 : 1)" || { echo "versions.json kennt $VER nicht"; exit 1; }
if [ -z "$DRY" ]; then
  [ -z "$(git status --porcelain)" ] || { echo "Arbeitsverzeichnis nicht sauber – erst committen"; exit 1; }
  git rev-parse "$VER" >/dev/null 2>&1 || git tag -a "$VER" -m "Tandem $VER"
fi

OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT
(cd plugin && npm ci --silent && npm test --silent && npm run build --silent)
cp plugin/main.js plugin/manifest.json plugin/styles.css "$OUT/"
(cd "$OUT" && mkdir tandem && cp main.js manifest.json styles.css tandem/ && zip -qr "tandem-$VER.zip" tandem && rm -r tandem)
(cd server && cargo test -q && ./build-static.sh >/dev/null)
cp server/target/x86_64-unknown-linux-musl/release/tandem-server "$OUT/tandem-server-$VER-x86_64-linux-musl"
(cd "$OUT" && sha256sum main.js manifest.json styles.css "tandem-$VER.zip" "tandem-server-$VER-x86_64-linux-musl" > SHA256SUMS && cat SHA256SUMS)

if [ -n "$DRY" ]; then
  echo "Probelauf – nichts veröffentlicht."
  exit 0
fi
git push origin "$VER"
NOTES=$(awk "/^## $VER/{f=1;next}/^## /{f=0}f" CHANGELOG.md 2>/dev/null || true)
gh release create "$VER" --title "Tandem $VER" --notes "${NOTES:-Tandem $VER}" "$OUT"/*
echo "Release $VER veröffentlicht."
