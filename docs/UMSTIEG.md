# Umstieg von Self-hosted LiveSync auf Tandem

Tandem und LiveSync dürfen **nie gleichzeitig** denselben Vault synchronisieren. Tandem prüft das und startet nicht, solange LiveSync aktiv ist.

## Vorher

- Tandem-Server läuft und ist über HTTPS erreichbar ([INSTALL.md](INSTALL.md)), `https://<host>/health` zeigt `ok`.
- Space und Besitzer sind angelegt (`tandem-server setup <space> <kennung> "<Name>"`).
- **Sicherung des Vaults** als Archiv außerhalb des Vault-Ordners, z. B. `tar czf vault-vor-tandem-$(date +%F).tar.gz <Vault>`. Tandem legt beim ersten Verbinden zusätzlich selbst eine Kopie an.

## Schritte

1. **Erstes Gerät:** In Obsidian LiveSync deaktivieren und Tandem aktivieren. Unter Einstellungen → Tandem den Einladungscode einlösen. Beim ersten Verbinden legt Tandem automatisch eine vollständige Kopie des Vaults neben dem Vault-Ordner an (`… .tandem-sicherung-<Datum>`) und lädt dann alles hoch.
2. **Weitere Geräte** (Tablet, andere Notebooks): erst warten, bis LiveSync dort den letzten Stand hat. Dann LiveSync aus, Tandem installieren, neuen Einladungscode einlösen (`tandem-server invite <kennung>` oder in Obsidian unter „Personen und Geräte“).
   Gleiche Dateien werden erkannt und *nicht* doppelt eingefügt.
3. **Weitere Personen:** `user add` + `space member … write` + `invite` (siehe [INSTALL.md](INSTALL.md#22-weitere-geräte-und-personen)). Name und Farbe sieht man dann am Cursor.
4. Eine Woche parallel beobachten (LiveSync bleibt deaktiviert, CouchDB läuft weiter als Rückfallebene).
5. Danach **CouchDB abschalten**. Das gibt je nach Vault einige GB RAM frei.

## Zurück zu LiveSync (falls nötig)

Tandem deaktivieren, LiveSync aktivieren. Der Vault-Inhalt bleibt, wie er ist. Beide arbeiten auf den normalen Dateien.

## Ink Blocks

- Mit älteren Ink-Blocks-Versionen laufen Striche über **Stufe A**: Sie kommen ca. 2 s nach dem Absetzen beim anderen an.
- Mit der Live-Schnittstelle von Ink Blocks (**Stufe B**) sieht man Striche schon während des Schreibens. Tandem erkennt die Stufe automatisch.
