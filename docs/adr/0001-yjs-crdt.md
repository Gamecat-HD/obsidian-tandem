# ADR 0001: Yjs als CRDT

Datum: 2026-11-02 · Status: angenommen

**Kontext:** Zeichengenaue Zusammenarbeit in Echtzeit mit Offline-Phasen, in Obsidian (CodeMirror 6) auf Desktop und Mobil.

**Entscheidung:** Yjs auf dem Client mit y-codemirror.next für Editor, Cursor und Undo. Auf dem Server yrs (die Rust-Portierung mit kompatiblem Binärformat).

**Begründung:** Ausgereift, mit offizieller CodeMirror-6-Bindung samt Awareness. Relay, Live Share und andere nutzen es in Obsidian bereits. Kompakte Updates, Sync über State-Vector. Automerge wäre schwerer und hat keine fertige CM6-Bindung mit Präsenz.

**Folgen:** Die Datei auf der Platte und das Y.Doc müssen per DiskBridge synchron gehalten werden (siehe PLAN §3.3).
