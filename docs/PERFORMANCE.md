# Leistung

Alle Werte stammen aus reproduzierbaren Messungen im Repo. Gemessen am 2026-11-02 mit Tandem 0.4.0.

**Messrechner:** AMD Ryzen 7 5800X (8 Kerne / 16 Threads), 32 GB RAM, CachyOS, Obsidian 1.15.0 (Electron, headless), Rust 1.95, Node 22.
**Produktion:** VPS mit 4 vCPU / 8 GB, Docker, hinter Nginx Proxy Manager und Cloudflare.

## Auf einen Blick

| | Wert |
|---|---|
| Tastendruck von A bis im Editor von B (lokal) | **3,6 ms** Median, 4,5 ms p95 |
| Tastendruck bei 80 ms Netz-Rundlaufzeit | **83,9 ms** Median, also ~4 ms über der reinen Netzlaufzeit |
| Neue Notiz erscheint im Vault des anderen (lokal) | 3,4 ms Median |
| Anhang 5 MiB (lokal / 80 ms RTT) | 87 ms / 426 ms |
| Erstabgleich eines neuen Geräts, 1026 Dateien (lokal) | 1,8 s |
| Server-RAM in Produktion (echter Vault, ~4600 Dateien, 560 MB) | **5,9 MiB** |
| Server-RAM im Lasttest, 100 Clients × 200 Notizen | 47,7 MiB Spitze |
| Docker-Image | 11,5 MiB (`FROM scratch`, statischer musl-Binary) |
| Plugin `main.js` | 156 KB (49 KB gzip) |

Zum Vergleich: Die CouchDB von Self-hosted LiveSync, die Tandem ersetzt, belegte auf demselben Server **etwa 5,6 GB RAM**.

## Ende-zu-Ende-Latenz

Zwei echte Obsidian-Instanzen (A und B) mit dem Rust-Server. Gemessen wird nicht nur die Netzwerknachricht, sondern der ganze Weg: Eingabe bei A per Chrome DevTools Protocol → Yjs-Update → WebSocket → Server → WebSocket → Yjs → CodeMirror-Rendering bei B. Der Zeitstempel bei B kommt von einem `MutationObserver` auf dem Editor-DOM.

`latency-proxy.mjs` verzögert jedes Paket in beide Richtungen um den angegebenen Wert. „40 ms je Richtung“ entspricht etwa 80 ms Rundlaufzeit, also einer typischen Verbindung über Cloudflare mit Mobilfunk-Anteil.

| Messung | lokal (0 ms) | 40 ms je Richtung |
|---|---|---|
| Tastendruck A → im Editor von B (n=100) | Median **3,6 ms** · p95 4,5 ms · max 18,5 ms | Median **83,9 ms** · p95 86,1 ms |
| Neue Notiz A → Datei im Vault von B (n=20) | Median 3,4 ms · p95 11,3 ms | Median 164 ms · p95 220 ms |
| Anhang 5 MiB, zufällige Bytes (n=3) | Median 87 ms | Median 426 ms |
| Erstabgleich: neues Gerät mit leerem Vault holt 1026 Dateien (1000 Notizen + 15 MiB Anhänge) | 1,8 s | 28,4 s |
| Server-RSS nach dem Erstabgleich | 21,7 MiB | 19,3 MiB |

Einordnung:
- Tippen ist praktisch nur durch das Netz begrenzt. Bei 80 ms RTT kommen ~4 ms Verarbeitung dazu, beide Plugins und der Server zusammen.
- Eine neue Notiz braucht zwei Wege (Index-Eintrag, dann Inhalt), daher etwa die doppelte Netzlaufzeit.
- Der Erstabgleich über eine langsame Leitung lädt die Notizen derzeit weitgehend nacheinander. Das betrifft nur die erste Verbindung eines neuen Geräts, danach werden nur Änderungen übertragen.

Ink Blocks (aus den E2E-Tests m06/m07): Ein fremder Strich ist schon **während des Schreibens** als „Geist“ mit Namensschild sichtbar. Der fertige Strich ersetzt den Geist ohne Wartezeit, mit älteren Ink-Blocks-Versionen (Stufe A) kommt er ~2 s nach dem Absetzen.

## Server unter Last

`protocol/loadtest.mjs` startet den echten Server und simuliert Clients direkt auf Protokollebene (ohne Obsidian). Jeder Client abonniert alle Notizen und bearbeitet alle 200 ms eine zufällige davon, dazu kommen Cursor-Updates (Awareness). Danach prüft der Test, ob alle Kopien identisch sind und ob ein frisch verbundener Client denselben Stand aus der Datenbank bekommt.

| Szenario | RSS Leerlauf | RSS nach Abonnieren | Bearbeitungen | RSS-Spitze | Konvergenz | RSS nach Entladen |
|---|---|---|---|---|---|---|
| 20 Clients × 50 Notizen, 30 s | 11,1 MiB | 14,6 MiB | 2980 (99/s) | **16,3 MiB** | ✓ 1000/1000 Kopien identisch | 13,9 MiB |
| 100 Clients × 200 Notizen, 30 s | 11,2 MiB | 27,2 MiB | 6800 (227/s) | **47,7 MiB** | ✓ 20 000/20 000 Kopien identisch | 34,8 MiB |

Bei 100 Clients verteilt der Server jede Bearbeitung an 99 andere, also rund 22 000 Nachrichten pro Sekunde. Der Lasttest-Client (ein einzelner Node-Prozess) war dabei der Engpass, nicht der Server.

Notizen, die niemand geöffnet hat, entlädt der Server nach 30 s aus dem RAM. Im Speicher liegt also nur, was gerade bearbeitet wird.

## Produktion

| | Wert |
|---|---|
| Vault | ~4600 Dateien, 560 MB (viele PDFs bis 57 MiB) |
| RAM des Containers | 5,9 MiB (davon 4,2 MiB anonym) |
| Container-Limit | `mem_limit: 128m` |
| Anhänge | werden gestreamt, nie ganz im RAM gepuffert (seit 0.3.1) |
| Admin-Oberfläche im Leerlauf | kein Datenverkehr (kein Polling, kein WebSocket) |

## Selbst messen

```bash
cd plugin && npm ci && npm run build && cd ..
node e2e/bench.mjs 0          # Ende-zu-Ende lokal          (KEYS=100 NOTES=1000 als Vorgabe)
node e2e/bench.mjs 40         # mit 40 ms Verzögerung je Richtung
node protocol/loadtest.mjs 20 50 30      # Clients, Notizen, Sekunden
node protocol/loadtest.mjs 100 200 30
```

`e2e/bench.mjs` braucht Obsidian unter `/usr/lib/obsidian/app.asar` und `electron43` (wie alle E2E-Tests). Die Ergebnisse landen zusätzlich als JSON in `e2e-out/bench-<ms>ms.json`.
