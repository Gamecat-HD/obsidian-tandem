# Lese-API v1

Mit dieser Schnittstelle lesen fremde Dienste einen Vault, ohne selbst mitzuschreiben. Die Lernplattform importiert darüber zum Beispiel die Obsidian-Notizen. Implementiert ist sie in `server/src/files_api.rs`, getestet in `e2e/files-api.mjs`.

**Stabil:** Die Lese-API hängt nicht an der Plugin-Version. Die Versionsbindung aus 0.8.2 gilt nur für das Obsidian-Plugin, und Dienste brauchen keine Kennung (`X-Tandem-Client`). Änderungen an v1 sind nur abwärtskompatibel möglich, also neue Felder, neue Ereignistypen oder neue Routen. Leser ignorieren Unbekanntes. Ein inkompatibler Umbau bekäme neue Pfade (`/api/v2/…`), v1 bliebe daneben bestehen.

Nicht Teil der Schnittstelle ist das WebSocket-Protokoll (`/ws`, [PROTOKOLL.md](PROTOKOLL.md)). Es gehört dem Plugin und darf sich mit jeder Version ändern.

## Zugang

Für den Zugang braucht man einen Geräte-Token mit mindestens Leserecht im Space und schickt ihn als `Authorization: Bearer <token>` mit. Zum Token kommt man so: Im Admin unter „Person → Einladen“ einen Code mit Rolle „Lesen“ erzeugen und ihn mit `POST /api/redeem` (`{ "code": "…", "device": "<Name des Dienstes>" }`) einlösen. Die Antwort enthält `token`.

| Status | Bedeutung |
|---|---|
| 400 | ungültige Space- oder Doc-ID |
| 401 | Token fehlt, ist unbekannt oder gesperrt |
| 403 | kein Zugriff auf diesen Space (bzw. Token an einen anderen Vault gebunden) |
| 409 | Space ist Ende-zu-Ende-verschlüsselt, der Server kennt keinen Klartext |

## Routen

### `GET /api/files/<space>`

Die Antwort enthält nur lebende Einträge, und zwar einen je Pfad:

```json
{ "files": [{ "id": "n…", "path": "SQL/Kunden.md", "kind": "md", "size": 1234, "ts": 1731150000000, "rev": "3926" }] }
```

- `kind`: `md` (Notiz), `ink` (Ink-Blocks-Fläche), `blob` (Anhang: PDF, Bild, `.xlsx`, …)
- `rev`: Bei `md`/`ink` ist das der Änderungszähler, bei `blob` der SHA-256 des Inhalts. Hat sich `rev` geändert, hat sich die Datei geändert.
- Anhänge, deren Inhalt noch nicht hochgeladen ist, fehlen so lange in der Liste.

### `GET /api/file/<space>/<id>`

Liefert den Inhalt als Bytes: bei `md` den Markdown-Text, bei `ink` die `.ink`-Datei wie auf der Platte, bei `blob` den Anhang (gestreamt). Der Header `X-Tandem-Rev` trägt die Revision des gelieferten Stands. Weicht sie vom Index ab, wurde die Datei zwischendurch geändert.

### `GET /api/changes/<space>?since=<seq>`

Der Änderungs-Feed als [Server-Sent Events](https://html.spec.whatwg.org/multipage/server-sent-events.html):

```
event: changes
id: 3926
data: {"seq":3926,"docs":["_index","n0000000000001"],"catchup":true}

event: changes
id: 3927
data: {"seq":3927,"docs":["n0000000000001"]}
```

- `seq` ist die Sequenz des Space. Jede gespeicherte Änderung erhöht sie. Die Ereignis-ID ist dieselbe Zahl.
- `docs` sind Doc-IDs wie in `/api/files`. `_index` heißt: Die Dateiliste hat sich geändert (neu, umbenannt, gelöscht, neuer Anhang-Inhalt).
- **Nachholen:** Direkt nach dem Verbinden kommt mindestens ein Ereignis mit `catchup: true`. Es nennt alle Docs, die seit `since` geändert wurden. Bei vielen Docs kommen mehrere Ereignisse mit je höchstens 500 Docs. Ist nichts passiert, kommt eines mit `docs: []`. `since` fehlt oder ist 0: Es kommt alles. Ist `since` größer als die aktuelle Sequenz (Server-Datenbank zurückgesetzt), kommt ebenfalls alles.
- **Laufend:** Danach kommt je Takt (300 ms) ein Ereignis mit den neu geänderten Docs.
- **Wiederaufnahme:** Statt `?since=` geht auch der Header `Last-Event-ID`. Das macht `EventSource` im Browser beim Neuverbinden von selbst.
- Alle 25 s kommt ein Kommentar (`:`) als Lebenszeichen. Der Server prüft jede Minute, ob der Token noch gilt, und beendet den Feed, wenn nicht.
- Begleit-Dokumente der [Live-API](LIVE-API.md) (`<id>-live`, z. B. Zellwerk) erscheinen ebenfalls. Sie gehören zu keiner Datei, und die zugehörige Datei meldet sich selbst, sobald sie geschrieben wird. Leser, die nur Dateien brauchen, ignorieren sie.
- Auch reine Metadaten-Änderungen zählen als Änderung, etwa Blame-Marken (`tandem:p`/`a`/`t`) ohne Textänderung. Wer nur Inhalte braucht, vergleicht nach dem Lesen den Inhalt.

Empfohlener Ablauf für einen Dienst:

1. Beim Start `/api/files` holen und mit dem eigenen Stand abgleichen (`rev` je Datei).
2. Den Feed mit der höchsten bekannten `seq` öffnen.
3. Bei Ereignissen entprellen (z. B. 20 s Ruhe) und dann erneut nach Schritt 1 abgleichen. Die gemeldeten IDs sagen, was sich geändert hat. Maßgeblich bleibt aber `rev` im Index.
4. Bricht die Verbindung ab, mit Backoff neu verbinden und dabei `since` mitgeben.
