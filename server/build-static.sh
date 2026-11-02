#!/usr/bin/env bash
# Statisch gelinkter tandem-server (musl) ohne musl-gcc: SQLite wird mit dem System-gcc übersetzt,
# gelinkt wird mit rust-lld gegen Rusts mitgeliefertes musl. Ergebnis läuft in einem leeren Image (FROM scratch).
set -euo pipefail
cd "$(dirname "$0")"
rustup target add x86_64-unknown-linux-musl >/dev/null
export CC_x86_64_unknown_linux_musl=gcc
# SQLite soll keine glibc-*64-Symbole (open64, stat64 …) verwenden – die gibt es in musl nicht.
export CFLAGS_x86_64_unknown_linux_musl="-fno-stack-protector -D_FORTIFY_SOURCE=0 -DSQLITE_DISABLE_LFS -U_FILE_OFFSET_BITS"
# Lokale Pfade (Home, Cargo-Registry) nicht in den Binary schreiben
export RUSTFLAGS="-C linker=rust-lld -C link-self-contained=yes --remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/cargo --remap-path-prefix=$PWD=/src"
cargo build --release --target x86_64-unknown-linux-musl
ls -la target/x86_64-unknown-linux-musl/release/tandem-server
