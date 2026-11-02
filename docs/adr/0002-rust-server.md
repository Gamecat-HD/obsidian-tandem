# ADR 0002: Server in Rust (yrs + axum + SQLite)

Datum: 2026-11-02 · Status: angenommen (vom Nutzer entschieden)

**Kontext:** Der Server läuft auf einem kleinen VPS (4 CPU / 8 GB) neben anderen Diensten. LiveSync/CouchDB belegt dort heute etwa 5,6 GB.

**Entscheidung:** Eigener Server in Rust: tokio/axum für WebSocket und HTTP, yrs für Yjs, rusqlite (bundled, WAL) für die Persistenz. Eine statische Binärdatei im schlanken Docker-Image.

**Alternativen:** Hocuspocus (Node): schneller zum MVP, aber mehr RAM und GC-Spitzen. y-sweet: Rust, aber ausgelegt auf S3/Dateisystem und eine Verbindung pro Doc, ohne eigene Nutzerverwaltung.

**Folgen:** Das Protokoll (Multiplexing, Auth) definieren wir selbst. Plugin und Server halten es über Testvektoren in `protocol/` synchron. Ziel: < 50 MB RAM im Leerlauf, gemessen in M1.

## Messung (M1, 2026-11-02)

`node protocol/loadtest.mjs 20 50 30`: 20 Clients, 50 Docs, 30 s, ca. 100 Bearbeitungen/s plus Awareness.

| Zustand | RSS |
|---|---|
| Leerlauf | 9,6 MiB |
| 20 × 50 abonniert | 12,9 MiB |
| Spitze unter Last | 14,5 MiB |
| nach dem Entladen | 12,1 MiB |

Alle 1000 Doc-Kopien sind identisch, ein neuer Client bekommt denselben Stand aus SQLite. Ein Y.Doc liegt nur für abonnierte Docs im RAM, beim Entladen wird verdichtet (GC) und täglich ein Snapshot gespeichert.
