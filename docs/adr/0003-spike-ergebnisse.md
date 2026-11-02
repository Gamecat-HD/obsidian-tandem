# ADR 0003: Ergebnisse des Spikes M0

Datum: 2026-11-02 · Status: angenommen

Getestet mit zwei headless Obsidian-Instanzen (Electron, eigene Profile) und dem Referenz-Server (`protocol/reference-server.mjs`), siehe `e2e/tests/m00-live-typing.mjs`.

**Ergebnisse**
- Zwei Personen tippen gleichzeitig in derselben Notiz: Nach etwa 0,3 s sind beide Editoren identisch. Ein einzelner Tastendruck braucht lokal **etwa 10 ms** von A nach B.
- Remote-Cursor mit Namensschild (y-codemirror.next `yRemoteSelections`) funktioniert in Live Preview.
- Obsidian speichert gekoppelte Notizen selbst auf die Platte. Wir müssen offene Notizen also nicht selbst schreiben.
- **Undo:** Obsidians eigener Verlauf bleibt aktiv. Fremde Änderungen werden per `transactionExtender` mit `addToHistory=false` markiert, Strg+Z macht dadurch nur eigene Änderungen rückgängig. Ein Y.UndoManager ist nicht nötig.
- **Tab-Wechsel:** Obsidian verwendet denselben EditorView für die nächste Datei weiter. Eine eigene Sync-Erweiterung mit **Pfad-Wächter** (`editorInfoField`) verhindert, dass der Inhalt der neuen Datei in das Y.Text der alten gerät. `ySync` aus y-codemirror.next hat diesen Schutz nicht.
- **Erstimport von mehreren Geräten** (z. B. alle haben den Vault schon von LiveSync): Sonst würde der Inhalt doppelt eingefügt. Gelöst über `origin` + `hash` im Index-Eintrag: Nur das eintragende Gerät lädt hoch, alle anderen übernehmen ihre identische Datei als Grundlage.

**Gefundene Falle (für den Rust-Server wichtig):** Reine Lösch-Updates ändern den State-Vector nicht. Ein Server, der Updates mit unverändertem SV verwirft, verliert Löschungen, zum Beispiel ein Undo.
