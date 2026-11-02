//! Serverseitiger Zugriff auf Vault-Inhalte (für die Admin-Oberfläche).
//!
//! Hält sich an das Modell des Plugins (plugin/src/docs/VaultIndex.ts):
//! `_index` = `Y.Map("files")`, Schlüssel docId (14 Zeichen [0-9a-z]), Wert ein schlichtes Objekt
//! `{path, kind: "md"|"ink"|"blob", hash?, size?, origin?, parent?, del?, by, ts}` (ts in ms).
//! Inhalte: md → `Y.Text("content")`; ink → `meta`/`strokes`/`order`; blob → Datei nach Hash.

use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use yrs::types::text::TextRef;
use yrs::{Any, Array, Doc, GetString, Map, Out, Text, Transact, TransactionMut, WriteTxn};

pub const INDEX: &str = "_index";
/// `origin` für Einträge, die über die Admin-Oberfläche entstehen (kein Gerät fühlt sich dafür zuständig).
pub const ORIGIN: &str = "admin-web";

#[derive(Debug, Clone, Serialize)]
pub struct Entry {
    pub id: String,
    pub path: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<f64>,
    pub del: bool,
    pub by: String,
    pub ts: f64,
}

pub fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

/// Wie `kindForPath` im Plugin.
pub fn kind_for_path(path: &str) -> &'static str {
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "md" | "txt" => "md",
        "ink" => "ink",
        _ => "blob",
    }
}

/// Neue docId wie `newDocId()` im Plugin: 14 Zeichen aus [0-9a-z].
pub fn new_doc_id() -> String {
    let mut b = [0u8; 9];
    rand::fill(&mut b[..]);
    let s: String = b.iter().map(|x| format!("{:0>2}", radix36(*x as u32))).collect();
    s[..14].to_string()
}

fn radix36(mut n: u32) -> String {
    const D: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if n == 0 {
        return "0".into();
    }
    let mut v = Vec::new();
    while n > 0 {
        v.push(D[(n % 36) as usize]);
        n /= 36;
    }
    v.reverse();
    String::from_utf8(v).unwrap()
}

/// Pfad prüfen: relativ, ohne `..`, keine Steuerzeichen, nicht in Bereichen, die das Plugin ignoriert.
pub fn valid_path(p: &str) -> Result<(), &'static str> {
    if p.is_empty() || p.len() > 512 {
        return Err("Pfad leer oder zu lang");
    }
    if p.starts_with('/') || p.ends_with('/') || p.contains('\\') || p.contains("//") {
        return Err("Pfad ungültig");
    }
    if p.chars().any(|c| c.is_control()) {
        return Err("Pfad enthält Steuerzeichen");
    }
    for seg in p.split('/') {
        if seg == "." || seg == ".." || seg.trim().is_empty() {
            return Err("Pfad ungültig");
        }
        if seg == ".git" || seg == "node_modules" || seg == ".DS_Store" {
            return Err("Dieser Bereich wird nicht synchronisiert");
        }
    }
    if p.starts_with(".obsidian/") || p.starts_with(".trash/") {
        return Err("Dieser Bereich wird nicht synchronisiert");
    }
    Ok(())
}

fn any_str(m: &HashMap<String, Any>, k: &str) -> Option<String> {
    match m.get(k) {
        Some(Any::String(s)) => Some(s.to_string()),
        _ => None,
    }
}

fn any_num(m: &HashMap<String, Any>, k: &str) -> Option<f64> {
    match m.get(k) {
        Some(Any::Number(n)) => n.as_f64(),
        _ => None,
    }
}

fn entry_from(id: &str, m: &HashMap<String, Any>) -> Option<Entry> {
    Some(Entry {
        id: id.to_string(),
        path: any_str(m, "path")?,
        kind: any_str(m, "kind").unwrap_or_else(|| "md".into()),
        hash: any_str(m, "hash"),
        size: any_num(m, "size"),
        del: matches!(m.get("del"), Some(Any::Bool(true))),
        by: any_str(m, "by").unwrap_or_default(),
        ts: any_num(m, "ts").unwrap_or(0.0),
    })
}

/// Alle Einträge des Index (auch gelöschte).
pub fn read_index(doc: &Doc) -> Vec<Entry> {
    let files = doc.get_or_insert_map("files");
    let txn = doc.transact();
    let mut v: Vec<Entry> = files
        .iter(&txn)
        .filter_map(|(k, val)| match val {
            Out::Any(Any::Map(m)) => entry_from(k, &m),
            _ => None,
        })
        .collect();
    v.sort_by(|a, b| a.path.cmp(&b.path).then(a.id.cmp(&b.id)));
    v
}

/// Lebender Eintrag für einen Pfad – bei Doppelungen gewinnt wie im Plugin die kleinste docId.
pub fn id_for_path(entries: &[Entry], path: &str) -> Option<String> {
    entries.iter().filter(|e| !e.del && e.path == path).map(|e| e.id.clone()).min()
}

/// Rohes Objekt eines Eintrags (für Änderungen, die unbekannte Felder erhalten).
/// Achtung: innerhalb einer offenen Transaktion nie `doc.get_or_insert_*` aufrufen (blockiert) – immer über `txn`.
fn raw_entry(txn: &mut TransactionMut, id: &str) -> Option<HashMap<String, Any>> {
    let files = txn.get_or_insert_map("files");
    match files.get(txn, id) {
        Some(Out::Any(Any::Map(m))) => Some((*m).clone()),
        _ => None,
    }
}

/// Eintrag ändern wie `VaultIndex.update`: Felder überschreiben, `ts` und `by` neu setzen.
pub fn update_entry(txn: &mut TransactionMut, id: &str, by: &str, patch: Vec<(&str, Any)>) -> bool {
    let Some(mut m) = raw_entry(txn, id) else { return false };
    for (k, v) in patch {
        m.insert(k.to_string(), v);
    }
    m.insert("ts".into(), Any::from(now_ms()));
    m.insert("by".into(), Any::from(by));
    txn.get_or_insert_map("files").insert(txn, id, Any::Map(Arc::new(m)));
    true
}

/// Neuen Eintrag anlegen wie `VaultIndex.add`.
pub fn add_entry(txn: &mut TransactionMut, id: &str, path: &str, kind: &str, by: &str, extra: Vec<(&str, Any)>) {
    let mut m: HashMap<String, Any> = HashMap::new();
    m.insert("path".into(), Any::from(path));
    m.insert("kind".into(), Any::from(kind));
    m.insert("ts".into(), Any::from(now_ms()));
    m.insert("by".into(), Any::from(by));
    for (k, v) in extra {
        m.insert(k.to_string(), v);
    }
    txn.get_or_insert_map("files").insert(txn, id, Any::Map(Arc::new(m)));
}

pub fn read_text(doc: &Doc) -> String {
    let t = doc.get_or_insert_text("content");
    t.get_string(&doc.transact())
}

/// Version eines Textes für optimistisches Sperren (Bearbeiten im Browser).
pub fn text_version(s: &str) -> String {
    crate::db::sha256_hex(s.as_bytes())[..16].to_string()
}

/// `content` per minimalem Zeichen-Diff auf `new` bringen (Cursor anderer bleiben, wo sie hingehören).
/// Indizes in Bytes – so rechnet ein `Doc::new()` in yrs (OffsetKind::Bytes).
pub fn set_text(text: &TextRef, txn: &mut TransactionMut, new: &str) {
    let old = text.get_string(txn);
    if old == new {
        return;
    }
    let diff = similar::TextDiff::configure().algorithm(similar::Algorithm::Myers).timeout(std::time::Duration::from_secs(2)).diff_chars(&old, new);
    // Rückwärts anwenden, damit frühere Positionen gültig bleiben.
    let mut ops: Vec<(usize, usize, String)> = Vec::new(); // (Byte-Position im alten Text, zu löschende Bytes, Einfügung)
    let mut pos = 0usize;
    for op in diff.ops() {
        match *op {
            similar::DiffOp::Equal { len, old_index, .. } => {
                pos = byte_at(&old, old_index + len);
            }
            similar::DiffOp::Delete { old_index, old_len, .. } => {
                let a = byte_at(&old, old_index);
                let b = byte_at(&old, old_index + old_len);
                ops.push((a, b - a, String::new()));
                pos = b;
            }
            similar::DiffOp::Insert { new_index, new_len, .. } => {
                ops.push((pos, 0, slice_chars(new, new_index, new_len)));
            }
            similar::DiffOp::Replace { old_index, old_len, new_index, new_len } => {
                let a = byte_at(&old, old_index);
                let b = byte_at(&old, old_index + old_len);
                ops.push((a, b - a, slice_chars(new, new_index, new_len)));
                pos = b;
            }
        }
    }
    for (at, del, ins) in ops.into_iter().rev() {
        if del > 0 {
            text.remove_range(txn, at as u32, del as u32);
        }
        if !ins.is_empty() {
            text.insert(txn, at as u32, &ins);
        }
    }
}

/// 3-Wege-Merge für Text: Änderungen `base → ours` auf `cur` übertragen (cur = base + Änderungen anderer).
/// Jede eigene Änderung muss in einem Bereich liegen, den die anderen nicht angefasst haben – sonst None (Konflikt).
pub fn merge3(base: &str, ours: &str, cur: &str) -> Option<String> {
    if ours == base {
        return Some(cur.to_string());
    }
    if cur == base {
        return Some(ours.to_string());
    }
    let b: Vec<char> = base.chars().collect();
    let o: Vec<char> = ours.chars().collect();
    let c: Vec<char> = cur.chars().collect();
    let cfg = || similar::TextDiff::configure().algorithm(similar::Algorithm::Myers).timeout(std::time::Duration::from_secs(2)).clone();
    // Gleiche Bereiche base → cur: (base_start, cur_start, len)
    let theirs = cfg().diff_chars(base, cur);
    let equal: Vec<(usize, usize, usize)> = theirs
        .ops()
        .iter()
        .filter_map(|op| match *op {
            similar::DiffOp::Equal { old_index, new_index, len } => Some((old_index, new_index, len)),
            _ => None,
        })
        .collect();
    // Bereich [a, e) von base in cur abbilden: muss vollständig in EINEM gleichen Block liegen
    let map = |a: usize, e: usize| -> Option<usize> {
        equal.iter().find(|(s, _, l)| *s <= a && e <= s + l).map(|(s, n, _)| n + (a - s))
    };
    // Eigene Änderungen base → ours
    let mine = cfg().diff_chars(base, ours);
    let mut edits: Vec<(usize, usize, Vec<char>)> = Vec::new(); // (Start in cur, Länge, Einfügung)
    for op in mine.ops() {
        match *op {
            similar::DiffOp::Equal { .. } => {}
            similar::DiffOp::Delete { old_index, old_len, .. } => edits.push((map(old_index, old_index + old_len)?, old_len, Vec::new())),
            similar::DiffOp::Insert { old_index, new_index, new_len } => {
                edits.push((map(old_index, old_index)?, 0, o[new_index..new_index + new_len].to_vec()))
            }
            similar::DiffOp::Replace { old_index, old_len, new_index, new_len } => {
                edits.push((map(old_index, old_index + old_len)?, old_len, o[new_index..new_index + new_len].to_vec()))
            }
        }
    }
    let _ = &b;
    let mut out = c.clone();
    edits.sort_by(|x, y| y.0.cmp(&x.0));
    for (at, del, ins) in edits {
        if at + del > out.len() {
            return None;
        }
        out.splice(at..at + del, ins);
    }
    Some(out.into_iter().collect())
}

fn byte_at(s: &str, char_idx: usize) -> usize {
    s.char_indices().nth(char_idx).map(|(b, _)| b).unwrap_or(s.len())
}

fn slice_chars(s: &str, start: usize, len: usize) -> String {
    s.chars().skip(start).take(len).collect()
}

/// Kurzinfo zu einer Ink-Fläche (nur lesen).
pub fn ink_info(doc: &Doc) -> serde_json::Value {
    let meta = doc.get_or_insert_map("meta");
    let strokes = doc.get_or_insert_map("strokes");
    let order = doc.get_or_insert_array("order");
    let txn = doc.transact();
    let head = match meta.get(&txn, "head") {
        Some(Out::Any(Any::String(s))) => serde_json::from_str::<serde_json::Value>(&s).unwrap_or(serde_json::Value::Null),
        _ => serde_json::Value::Null,
    };
    let lines: Vec<String> = order
        .iter(&txn)
        .filter_map(|v| match v {
            Out::Any(Any::String(id)) => match strokes.get(&txn, &id) {
                Some(Out::Any(Any::String(line))) => Some(line.to_string()),
                _ => None,
            },
            _ => None,
        })
        .collect();
    serde_json::json!({ "head": head, "strokes": lines.len(), "lines": lines })
}

/// Ink-Fläche auf den Stand von `from` bringen (Kopf, Striche, Reihenfolge) – als Änderung, die alle Geräte
/// übernehmen. Liefert true, wenn sich etwas geändert hat.
pub fn ink_restore(live: &Doc, from: &Doc) -> bool {
    let (head, lines, order_ids) = {
        let meta = from.get_or_insert_map("meta");
        let strokes = from.get_or_insert_map("strokes");
        let order = from.get_or_insert_array("order");
        let txn = from.transact();
        let head = match meta.get(&txn, "head") {
            Some(Out::Any(Any::String(s))) => Some(s.to_string()),
            _ => None,
        };
        let lines: HashMap<String, String> = strokes
            .iter(&txn)
            .filter_map(|(k, v)| match v {
                Out::Any(Any::String(s)) => Some((k.to_string(), s.to_string())),
                _ => None,
            })
            .collect();
        let ids: Vec<String> = order
            .iter(&txn)
            .filter_map(|v| match v {
                Out::Any(Any::String(s)) => Some(s.to_string()),
                _ => None,
            })
            .collect();
        (head, lines, ids)
    };
    let meta = live.get_or_insert_map("meta");
    let strokes = live.get_or_insert_map("strokes");
    let order = live.get_or_insert_array("order");
    let mut txn = live.transact_mut();
    let mut changed = false;
    if let Some(h) = head {
        let cur = match meta.get(&txn, "head") {
            Some(Out::Any(Any::String(s))) => Some(s.to_string()),
            _ => None,
        };
        if cur.as_deref() != Some(h.as_str()) {
            meta.insert(&mut txn, "head", h);
            changed = true;
        }
    }
    let live_keys: Vec<String> = strokes.keys(&txn).map(str::to_string).collect();
    for k in live_keys {
        if !lines.contains_key(&k) {
            strokes.remove(&mut txn, &k);
            changed = true;
        }
    }
    for (k, line) in &lines {
        let same = matches!(strokes.get(&txn, k), Some(Out::Any(Any::String(s))) if s.as_ref() == line.as_str());
        if !same {
            strokes.insert(&mut txn, k.as_str(), line.as_str());
            changed = true;
        }
    }
    let cur_order: Vec<String> = order
        .iter(&txn)
        .filter_map(|v| match v {
            Out::Any(Any::String(s)) => Some(s.to_string()),
            _ => None,
        })
        .collect();
    if cur_order != order_ids {
        let n = order.len(&txn);
        if n > 0 {
            order.remove_range(&mut txn, 0, n);
        }
        for id in &order_ids {
            order.push_back(&mut txn, id.as_str());
        }
        changed = true;
    }
    changed
}

/// Dokument aus einem gespeicherten Zustand (Snapshot) erzeugen.
pub fn doc_from_state(state: &[u8]) -> Option<Doc> {
    use yrs::updates::decoder::Decode;
    let doc = Doc::new();
    let u = yrs::Update::decode_v1(state).ok()?;
    doc.transact_mut().apply_update(u).ok()?;
    Some(doc)
}

/// Content-Type für Anhänge nach Dateiendung (nur harmlose Typen inline; alles andere als Download).
pub fn content_type(path: &str) -> (&'static str, bool) {
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "png" => ("image/png", true),
        "jpg" | "jpeg" => ("image/jpeg", true),
        "gif" => ("image/gif", true),
        "webp" => ("image/webp", true),
        "avif" => ("image/avif", true),
        "bmp" => ("image/bmp", true),
        "svg" => ("image/svg+xml", true),
        "pdf" => ("application/pdf", true),
        "mp3" => ("audio/mpeg", true),
        "ogg" => ("audio/ogg", true),
        "wav" => ("audio/wav", true),
        "m4a" => ("audio/mp4", true),
        "mp4" => ("video/mp4", true),
        "webm" => ("video/webm", true),
        "json" | "canvas" | "css" | "csv" | "js" | "ts" | "html" | "xml" | "yml" | "yaml" => ("text/plain; charset=utf-8", true),
        _ => ("application/octet-stream", false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_and_kinds() {
        let id = new_doc_id();
        assert_eq!(id.len(), 14);
        assert!(id.bytes().all(|b| b.is_ascii_digit() || b.is_ascii_lowercase()));
        assert!(crate::codec::valid_id(&id));
        assert_eq!(kind_for_path("a/B.MD"), "md");
        assert_eq!(kind_for_path("x.txt"), "md");
        assert_eq!(kind_for_path("x.ink"), "ink");
        assert_eq!(kind_for_path("README"), "blob");
        assert_eq!(radix36(255), "73");
    }

    #[test]
    fn paths() {
        assert!(valid_path("Notizen/a.md").is_ok());
        for bad in ["", "/a.md", "a/../b.md", "a//b.md", ".obsidian/x.json", "x/.git/y", "a/", "a\\b", "a/ /b.md"] {
            assert!(valid_path(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn text_diff_keeps_unicode() {
        let doc = Doc::new();
        let t = doc.get_or_insert_text("content");
        for (a, b) in [("", "hallo"), ("hallo welt", "hallo schöne welt"), ("äöü 🎉 x", "äü 🎉🎉 y"), ("abc", ""), ("Zeile 1\nZeile 2\n", "Zeile 0\nZeile 2\nZeile 3\n")] {
            {
                let mut txn = doc.transact_mut();
                set_text(&t, &mut txn, a);
            }
            assert_eq!(read_text(&doc), a);
            {
                let mut txn = doc.transact_mut();
                set_text(&t, &mut txn, b);
            }
            assert_eq!(read_text(&doc), b);
        }
    }

    #[test]
    fn index_roundtrip() {
        let doc = Doc::new();
        let id = new_doc_id();
        {
            let mut txn = doc.transact_mut();
            add_entry(&mut txn, &id, "a.md", "md", "anna", vec![("origin", Any::from(ORIGIN))]);
        }
        {
            let mut txn = doc.transact_mut();
            assert!(update_entry(&mut txn, &id, "anna", vec![("del", Any::Bool(true))]));
        }
        let e = read_index(&doc);
        assert_eq!(e.len(), 1);
        assert!(e[0].del);
        assert_eq!(e[0].path, "a.md");
        assert!(e[0].ts > 1.7e12, "ts in Millisekunden");
        // Unbekannte Felder bleiben erhalten
        let mut txn = doc.transact_mut();
        assert!(matches!(raw_entry(&mut txn, &id).unwrap().get("origin"), Some(Any::String(_))));
    }

    #[test]
    fn three_way_merge() {
        let base = "# Titel\n\nZeile 1\n";
        // Gerät hängt unten an, Admin ändert den Titel → beides bleibt
        assert_eq!(merge3(base, "# Neuer Titel\n\nZeile 1\n", "# Titel\n\nZeile 1\nLive-Zeile 1").as_deref(), Some("# Neuer Titel\n\nZeile 1\nLive-Zeile 1"));
        // Beide ändern dasselbe Wort → Konflikt
        assert_eq!(merge3("a Wort b", "a Satz b", "a Text b"), None);
        // Nur eine Seite geändert
        assert_eq!(merge3(base, base, "x").as_deref(), Some("x"));
        assert_eq!(merge3(base, "y", base).as_deref(), Some("y"));
        // Umlaute/Emoji, Löschung bei mir, Einfügung woanders bei anderen
        assert_eq!(merge3("äöü 🎉 Ende", "äü 🎉 Ende", "äöü 🎉 Ende!").as_deref(), Some("äü 🎉 Ende!"));
    }

    #[test]
    fn ink_restore_roundtrip() {
        let mk = |head: &str, strokes: &[(&str, &str)]| {
            let d = Doc::new();
            let (m, s, o) = (d.get_or_insert_map("meta"), d.get_or_insert_map("strokes"), d.get_or_insert_array("order"));
            let mut txn = d.transact_mut();
            m.insert(&mut txn, "head", head);
            for (id, l) in strokes {
                s.insert(&mut txn, *id, *l);
                o.push_back(&mut txn, *id);
            }
            drop(txn);
            d
        };
        let backup = mk("{\"v\":1}", &[("a", "A"), ("b", "B")]);
        let live = mk("{\"v\":2}", &[("b", "B2"), ("c", "C")]);
        assert!(ink_restore(&live, &backup));
        let info = ink_info(&live);
        assert_eq!(info["lines"], serde_json::json!(["A", "B"]));
        assert_eq!(info["head"], serde_json::json!({"v": 1}));
        assert!(!ink_restore(&live, &backup), "zweites Mal nichts zu tun");
    }
}
