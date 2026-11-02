# ADR 0004: Konfliktregeln im Vault-Sync

Datum: 2026-11-02 · Status: angenommen (M3)

| Situation | Regel |
|---|---|
| Zwei Personen tippen gleichzeitig in derselben Notiz | Yjs führt zeichengenau zusammen, ohne Konflikt |
| Datei wird von außen geändert (Claude Code, git, Editor), Notiz offen | Obsidian lädt die Datei in den Editor, die Kopplung überträgt den Unterschied. Cursor bleiben stehen |
| Datei von außen geändert, Notiz geschlossen | 3-Wege-Merge `base → Datei` auf den aktuellen Doc-Stand (`disk/rebase.ts`) |
| Beide offline, dieselbe Datei geändert | Beide Änderungen bleiben erhalten (3-Wege-Merge + CRDT) |
| Gelöscht vs. geändert | **Die spätere Aktion gewinnt.** Lokale Bearbeitung nach dem Löschzeitpunkt → wiederherstellen |
| Gleicher Pfad offline auf zwei Geräten angelegt | Die kleinere docId behält den Pfad. Das Gerät des Verlierers benennt *seine* Datei in „Name (2).md“ um und holt danach die Fassung des Gewinners. Abgleiche am umkämpften Pfad warten, bis das erledigt ist |
| Erstimport desselben Vaults von mehreren Geräten (z. B. nach LiveSync) | Nur das eintragende Gerät (`origin`) lädt hoch. Andere Geräte mit identischem Inhalt (`hash`) übernehmen ihn als Grundlage, ohne Verdopplung |
| Anhang auf zwei Geräten verschieden geändert | Jede Fassung kennt ihren Vorgänger (`parent`). Beruht die eingehende nicht auf der lokalen, bleibt die lokale als „Name (Konflikt JJJJ-MM-TT).ext“ erhalten (wird mitsynchronisiert) |
| Nur-Lese-Mitglied | Der Server gewinnt immer, lokale Änderungen werden nicht verteilt |

Der lokale Zustand gelöschter Docs bleibt in IndexedDB erhalten, damit sich eine Löschung verlustfrei zurücknehmen lässt.
