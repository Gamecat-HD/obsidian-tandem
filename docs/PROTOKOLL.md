# Tandem-Protokoll v1

Eine WebSocket-Verbindung pro Gerät (`wss://<host>/ws`) mit binären Frames. Die Kodierung verwendet `lib0/encoding`, also dieselbe wie Yjs:
`varUint` = LEB128 ohne Vorzeichen, `varString` = varUint-Länge + UTF-8, `varBytes` = varUint-Länge + Bytes.

Jeder Frame beginnt mit `varUint type`.

| type | Name | Richtung | Felder |
|---|---|---|---|
| 0 | HELLO | C→S | `varUint version (=1)`, `varString token`, `varString device`, optional `varString client` (ab 0.8.2: `tandem-plugin/<version>` oder eigene Kennung wie `lernplattform`) |
| 1 | WELCOME | S→C | `varString json` → `{user:{id,name,color}, spaces:[{id,name,role,e2ee?}]}` (`e2ee`: fehlt = Klartext, `"pending"` oder Schlüsselparameter, siehe [E2EE.md](E2EE.md)) |
| 2 | SYNC | ↔ | `varString doc`, danach eine y-protocols-Sync-Nachricht (`varUint sub` 0=Step1 `varBytes sv` / 1=Step2 `varBytes update` / 2=Update `varBytes update`) |
| 3 | AWARENESS | ↔ | `varString doc`, `varBytes awarenessUpdate` (y-protocols/awareness-Format) |
| 4 | UNSUB | C→S | `varString doc` |
| 5 | ERROR | S→C | `varUint code`, `varString doc`, `varString message` |
| 6 | CHANGES | S→C | `varString space`, `varUint seq`, `varUint n`, n × `varString doc` |
| 7 | CATCHUP | C→S | `varString space`, `varUint sinceSeq` |
| 8 | PING | C→S | – |
| 9 | PONG | S→C | – |
| 10–14 | ESUB, ELOG, EUPD, EACK, ECOMPACT | ↔ | nur Ende-zu-Ende-verschlüsselte Spaces, siehe [E2EE.md](E2EE.md) |

**Doc-Namen:** `<spaceId>/<docId>`. Der Dateibaum eines Space ist `<spaceId>/_index`.

## Ablauf

1. Client → `HELLO`. Server → `WELCOME` oder `ERROR(401)` bzw. `ERROR(505)` und schließt die Verbindung. Vor `HELLO` werden alle anderen Frames verworfen.
   **Plugin-Version:** Der Server bedient nur das Plugin mit genau seiner eigenen Version (`client` = `tandem-plugin/<Server-Version>`). Fehlt `client` (Plugin vor 0.8.2) oder passt die Version nicht, antwortet er vor der Token-Prüfung mit `ERROR(505)`; die Meldung beginnt mit `Tandem-Server <version>`. Andere Clients (z. B. die Lernplattform) senden eine eigene Kennung ohne `tandem-plugin/` und sind nicht an die Plugin-Version gebunden.
2. **Abonnieren** = `SYNC Step1` mit dem lokalen State-Vector. Der Server lädt das Doc (falls nötig), antwortet mit `SYNC Step2` (fehlende Updates), schickt danach seinen eigenen `SYNC Step1` und die bekannten Awareness-Zustände. Der Client antwortet mit `SYNC Step2`.
3. Danach fließen `SYNC Update` und `AWARENESS` in beide Richtungen. Der Server verteilt sie an alle anderen Abonnenten dieses Docs.
4. `UNSUB` beendet das Abo. Der Server entfernt die Awareness-Einträge dieser Verbindung und schickt den anderen eine Löschung. 30 s nach dem letzten Abo wird das Doc aus dem RAM entladen.
5. **Änderungen ohne Abo:** Jede gespeicherte Änderung erhöht die Sequenznummer `seq` des Space. Alle Verbindungen des Space, die das Doc *nicht* abonniert haben, bekommen `CHANGES(space, seq, [doc])`. Gesammelt wird höchstens alle 500 ms.
6. **Nachholen:** `CATCHUP(space, lastSeq)` → `CHANGES(space, aktuelleSeq, [alle seit lastSeq geänderten Docs])`. Der Client merkt sich `seq` dauerhaft.
7. `PING` alle 25 s, der Server antwortet mit `PONG`. Kommt 10 s lang kein `PONG`, baut der Client die Verbindung neu auf. Der Server schließt Verbindungen, die 90 s lang still sind.

## Fehlercodes

| code | Bedeutung |
|---|---|
| 400 | Frame ungültig |
| 401 | Token ungültig/widerrufen |
| 403 | kein Zugriff auf den Space bzw. nur Lesezugriff (Update abgelehnt) |
| 413 | Nachricht zu groß (Standard: 8 MiB) |
| 426 | Space ist Ende-zu-Ende-verschlüsselt – Plugin zu alt (SYNC statt ESUB/EUPD) |
| 505 | Plugin-Version passt nicht zur Server-Version (nur auf HELLO, `doc` leer). Das Plugin verbindet sich danach nicht neu |
| 500 | Serverfehler |

## HTTP

Authentifizierung: `Authorization: Bearer <token>`.

Die Routen des Plugins (`/api/invite`, `/api/members`, `/api/e2ee`, `/api/blob`, `/api/history`) verlangen zusätzlich `X-Tandem-Client: tandem-plugin/<Server-Version>`, sonst 426 (vor der Token-Prüfung). `/health`, `/api/redeem`, `/api/status` und die Lese-API (`/api/files`, `/api/file`) brauchen die Kennung nicht.

| Methode | Pfad | Zweck |
|---|---|---|
| GET | `/health` | `ok` |
| POST | `/api/redeem` | `{code, device}` → `{token, user, spaces, space}`. Löst eine Einladung ein (Rate-Limit). `space` = Vault, für den das Token gilt, sonst `null`: Dann bindet es sich beim ersten Zugriff über den WebSocket an den angesprochenen Space. Ein gebundenes Token bekommt für andere Spaces 403 |
| HEAD/GET | `/api/blob/<space>/<sha256>` | Anhang prüfen bzw. laden |
| PUT | `/api/blob/<space>/<sha256>` | Anhang hochladen. Der Server prüft den Hash, Limit Standard 100 MiB |
| GET | `/api/history/<space>/<docId>` | Liste der Snapshots `[{ts, size}]` |
| GET | `/api/history/<space>/<docId>/<ts>` | Snapshot als Yjs-Update (binär) |
| POST | `/api/e2ee/<space>` | Schlüsselparameter `{v, kdf, iter, salt, check}` festlegen (nur Besitzer, nur leerer bzw. wartender Space) → 204; 409 bei vorhandenem Inhalt |
| GET | `/api/files/<space>` | Nur lesen (für Dienste wie die Lernplattform): `{files: [{id, path, kind, size, ts, rev}]}` – lebende Einträge, je Pfad einer (kleinste docId). `rev` = Änderungszähler des Docs (md/ink) bzw. Hash (blob) |
| GET | `/api/file/<space>/<docId>` | Inhalt als Datei: md als Text, ink als `.ink`-JSON (wie `encodeInkDoc`), blob als Bytes; Header `X-Tandem-Rev` |

## Inhalte der Docs

- `_index`: `Y.Map("files")`: `docId → {path, kind: "md"|"ink"|"blob"|"text", hash?, size?, del?: true, by, ts}`
- `md`/`text`: `Y.Text("content")`
- `ink`: `Y.Map("meta")` (`head` = JSON-Kopf der .ink-Datei ohne `strokes`), `Y.Map("strokes")` (`id → Strich-JSON-Zeile`), `Y.Array("order")` (Stroke-IDs)
- `blob`: kein Doc, Inhalt über HTTP nach `hash`.
- Alle Docs außer `_index` (ab Plugin 0.8.0): Autorenschaft für Blame (`plugin/src/blame/authorship.ts`)
  - `Y.Map("tandem:authors")`: `clientID (als Text) → {id, name, color, device?}`, einmal pro Doc-Instanz beim ersten Schreiben
  - `Y.Array("tandem:marks")`: `[clientID, clock, Zeit in ms, Quelle (0 = Editor, 1 = Datei von außen)]`, höchstens eine Marke pro Minute und Instanz. Ein Zeichen `(client, clock)` gilt als zur Zeit der letzten Marke mit gleicher clientID und `clock ≤` geschrieben.

## Awareness-Zustand

```json
{ "user": { "id": "u1", "name": "Alice", "color": "#e5534b", "colorLight": "#e5534b33" },
  "cursor": { "anchor": <RelativePosition>, "head": <RelativePosition> },
  "ink": { "file": "_ink/x.ink", "stroke": { "id": "...", "t": "pen", "c": 0, "s": 2, "p": [..] } },
  "view": { "doc": "<docId>", "mode": "source" | "preview" | "ink" } }
```
`cursor` verwaltet y-codemirror.next. `ink` ist der gerade entstehende Strich. `view` steht nur auf `_index` und dient der Präsenz im Dateibaum.
