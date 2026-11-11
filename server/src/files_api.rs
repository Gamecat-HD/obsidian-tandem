//! Nur-Lese-Zugriff auf einen Vault per HTTP – für Dienste, die den Vault lesen statt mitzuschreiben
//! (die Lernplattform importiert so die Obsidian-Notizen; vorher über CouchDB/LiveSync).
//!
//! | Methode | Pfad | Antwort |
//! |---|---|---|
//! | GET | `/api/files/<space>` | `{ files: [{ id, path, kind, size, ts, rev }] }` – nur lebende Einträge, je Pfad einer |
//! | GET | `/api/file/<space>/<docId>` | Inhalt als Bytes (md: Text, ink: `.ink`-Datei, blob: Anhang), Header `X-Tandem-Rev` |
//! | GET | `/api/changes/<space>?since=<seq>` | Änderungs-Feed (Server-Sent Events), siehe unten |
//!
//! Diese Routen sind die offizielle Schnittstelle für fremde Dienste („Lese-API v1“, `docs/LESE-API.md`). Sie
//! hängen nicht an der Plugin-Version und ändern sich nur abwärtskompatibel (neue Felder, neue Ereignisse).
//!
//! Änderungs-Feed: Erst ein Ereignis `changes` mit allen Docs, die seit `since` geändert wurden (`catchup: true`),
//! danach laufend je Takt (300 ms) ein `changes` mit den neu geänderten Docs. Die Ereignis-ID ist die Sequenz des
//! Space – wer sie sich merkt, setzt nach einer Unterbrechung mit `?since=` (oder `Last-Event-ID`) dort an.
//!
//! `rev` ändert sich mit jeder Änderung: Änderungszähler (`docs.seq`) bei md/ink, Hash bei Anhängen. Wer liest,
//! vergleicht `X-Tandem-Rev` mit dem Index – weicht er ab, wurde die Datei zwischendurch geändert.
//! Zugang: Geräte-Token mit (mindestens) Leserecht im Space.

use crate::codec;
use crate::server::{App, open_blob, require_role};
use crate::vault::{self, Entry};
use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::convert::Infallible;
use std::time::{Duration, Instant};
use yrs::{Any, Array, Doc, Map, Out, ReadTxn, Transact};

#[derive(Serialize)]
struct FileInfo {
    id: String,
    path: String,
    kind: String,
    size: f64,
    ts: f64,
    rev: String,
}

fn index_name(space: &str) -> String {
    format!("{space}/{}", vault::INDEX)
}

/// Lebende Einträge; bei doppeltem Pfad gewinnt wie im Plugin die kleinste docId. Anhänge ohne Hash (noch nicht
/// hochgeladen) fehlen, bis ihr Inhalt da ist – sonst versuchte jeder Leser sie bei jedem Abruf vergeblich.
fn live(entries: Vec<Entry>) -> Vec<Entry> {
    let mut v: Vec<Entry> = entries.into_iter().filter(|e| !e.del && (e.kind != "blob" || e.hash.as_deref().is_some_and(|h| !h.is_empty()))).collect();
    v.sort_by(|a, b| a.path.cmp(&b.path).then(a.id.cmp(&b.id)));
    let mut seen = HashSet::new();
    v.retain(|e| seen.insert(e.path.clone()));
    v
}

/// Änderungszähler und gespeicherte Größe je Doc des Space.
fn doc_stats(app: &App, space: &str) -> rusqlite::Result<HashMap<String, (i64, i64)>> {
    let st = app.hub.store.lock().unwrap_or_else(|e| e.into_inner());
    let mut q = st.conn.prepare_cached("SELECT doc, seq, size FROM docs WHERE space = ?1")?;
    let rows = q.query_map([space], |r| Ok((r.get::<_, String>(0)?, (r.get::<_, i64>(1)?, r.get::<_, i64>(2)?))))?;
    rows.collect()
}

fn rev_of(e: &Entry, stats: &HashMap<String, (i64, i64)>, space: &str) -> String {
    if e.kind == "blob" {
        return e.hash.clone().unwrap_or_default();
    }
    stats.get(&format!("{space}/{}", e.id)).map(|(seq, _)| seq.to_string()).unwrap_or_else(|| "0".into())
}

/// `.ink`-Datei aus dem Ink-Doc – wie `encodeInkDoc` im Plugin (plugin/src/ink/inkDoc.ts): Kopf ohne `strokes`,
/// dann die Strich-Zeilen in der Reihenfolge von `order`, Striche ohne Platz in `order` hinten an.
/// Achtung: innerhalb der offenen Transaktion nur `txn.get_*`, nie `doc.get_or_insert_*` (Deadlock).
pub fn encode_ink(doc: &Doc) -> Option<String> {
    let txn = doc.transact();
    let meta = txn.get_map("meta")?;
    // Leere Fläche: Yjs schreibt leere Root-Typen nicht ins Update – „strokes“ (und „order“) fehlen dann ganz
    let strokes = txn.get_map("strokes");
    let head = match meta.get(&txn, "head") {
        Some(Out::Any(Any::String(s))) => s.to_string(),
        _ => return None,
    };
    let head = head.trim_end();
    if !head.starts_with('{') || !head.ends_with('}') {
        return None;
    }
    let mut seen = HashSet::new();
    let mut lines: Vec<String> = Vec::new();
    if let Some(order) = txn.get_array("order") {
        for v in order.iter(&txn) {
            if let Out::Any(Any::String(id)) = v
                && seen.insert(id.to_string())
                && let Some(Out::Any(Any::String(line))) = strokes.as_ref().and_then(|m| m.get(&txn, &id))
            {
                lines.push(line.to_string());
            }
        }
    }
    let mut rest: Vec<(String, String)> = strokes
        .iter()
        .flat_map(|m| m.iter(&txn))
        .filter(|(id, _)| !seen.contains(*id))
        .filter_map(|(id, v)| match v {
            Out::Any(Any::String(line)) => Some((id.to_string(), line.to_string())),
            _ => None,
        })
        .collect();
    rest.sort();
    lines.extend(rest.into_iter().map(|(_, l)| l));
    let body = &head[..head.len() - 1];
    let sep = if body.trim_end().ends_with('{') { "" } else { "," };
    Some(format!("{body}{sep}\"strokes\":[{}]}}\n", if lines.is_empty() { String::new() } else { format!("\n{}\n", lines.join(",\n")) }))
}

pub async fn files(State(app): State<App>, h: HeaderMap, Path(space): Path<String>) -> Response {
    if !codec::valid_id(&space) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    if let Err(c) = require_role(&app, &h, &space, false) {
        return c.into_response();
    }
    let entries = match app.hub.read_doc(&index_name(&space), vault::read_index) {
        Ok(e) => live(e),
        Err(crate::hub::HubError::E2ee) => return (StatusCode::CONFLICT, "Vault ist Ende-zu-Ende-verschlüsselt").into_response(),
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:?}")).into_response(),
    };
    let stats = match doc_stats(&app, &space) {
        Ok(s) => s,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:?}")).into_response(),
    };
    let files: Vec<FileInfo> = entries
        .iter()
        .map(|e| FileInfo {
            id: e.id.clone(),
            path: e.path.clone(),
            kind: e.kind.clone(),
            size: if e.kind == "blob" { e.size.unwrap_or(0.0) } else { stats.get(&format!("{space}/{}", e.id)).map(|(_, s)| *s as f64).unwrap_or(0.0) },
            ts: e.ts,
            rev: rev_of(e, &stats, &space),
        })
        .collect();
    axum::Json(serde_json::json!({ "files": files })).into_response()
}

pub async fn file(State(app): State<App>, h: HeaderMap, Path((space, id)): Path<(String, String)>) -> Response {
    if !codec::valid_id(&space) || !codec::valid_id(&id) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    if let Err(c) = require_role(&app, &h, &space, false) {
        return c.into_response();
    }
    let entries = match app.hub.read_doc(&index_name(&space), vault::read_index) {
        Ok(e) => e,
        Err(crate::hub::HubError::E2ee) => return (StatusCode::CONFLICT, "Vault ist Ende-zu-Ende-verschlüsselt").into_response(),
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:?}")).into_response(),
    };
    let Some(entry) = entries.into_iter().find(|e| e.id == id && !e.del) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let stats = doc_stats(&app, &space).unwrap_or_default();
    let rev = rev_of(&entry, &stats, &space);
    let name = format!("{space}/{id}");
    // Anhänge (PDFs bis 100 MiB) werden gestreamt, nie ganz in den RAM geladen (mem_limit des Containers)
    let body: Body = match entry.kind.as_str() {
        "blob" => {
            let Some(hash) = entry.hash.as_deref() else { return StatusCode::NOT_FOUND.into_response() };
            match open_blob(&app, &space, hash).await {
                Some((_len, body)) => body,
                None => return StatusCode::NOT_FOUND.into_response(),
            }
        }
        "ink" => match app.hub.read_doc(&name, encode_ink) {
            Ok(Some(text)) => Body::from(text),
            Ok(None) => return StatusCode::NOT_FOUND.into_response(),
            Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:?}")).into_response(),
        },
        _ => match app.hub.read_doc(&name, vault::read_text) {
            Ok(text) => Body::from(text),
            Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:?}")).into_response(),
        },
    };
    let mut res = ([(header::CONTENT_TYPE, "application/octet-stream"), (header::CACHE_CONTROL, "no-store")], body).into_response();
    if let Ok(v) = HeaderValue::from_str(&rev) {
        res.headers_mut().insert("x-tandem-rev", v);
    }
    res
}

// ── Änderungs-Feed (SSE) ──────────────────────────────────────────────

#[derive(Deserialize)]
pub struct ChangesQuery {
    since: Option<u64>,
}

/// So oft wird geprüft, ob der Token noch gilt (gesperrt, Space entzogen) – dann endet der Feed.
const RECHECK: Duration = Duration::from_secs(60);
/// Portionsgröße beim Nachholen (wie CATCHUP im WebSocket-Protokoll)
const CATCHUP_CHUNK: usize = 500;

/// Doc-Name `space/docId` → `docId` (die IDs aus `/api/files`; `_index` = Dateiliste geändert)
fn doc_ids(space: &str, docs: &[String]) -> Vec<String> {
    let prefix = format!("{space}/");
    docs.iter().map(|d| d.strip_prefix(&prefix).unwrap_or(d).to_string()).collect()
}

fn changes_event(seq: u64, docs: &[String], catchup: bool) -> Event {
    let mut v = serde_json::json!({ "seq": seq, "docs": docs });
    if catchup {
        v["catchup"] = serde_json::Value::Bool(true);
    }
    Event::default().event("changes").id(seq.to_string()).data(v.to_string())
}

/// Nachholen seit `since`: Ereignisse (in Portionen) und die aktuelle Sequenz.
fn catchup(app: &App, space: &str, since: u64) -> Result<(u64, Vec<Event>), String> {
    let st = app.hub.store.lock().unwrap_or_else(|e| e.into_inner());
    let seq = st.space_seq(space).map_err(|e| e.to_string())?;
    // Leser ist „aus der Zukunft“ (Server-DB zurückgesetzt) → alles melden
    let since = if since > seq { 0 } else { since };
    let docs = doc_ids(space, &st.changed_since(space, since).map_err(|e| e.to_string())?);
    drop(st);
    let mut events: Vec<Event> = docs.chunks(CATCHUP_CHUNK).map(|c| changes_event(seq, c, true)).collect();
    if events.is_empty() {
        events.push(changes_event(seq, &[], true));
    }
    Ok((seq, events))
}

/// Zählt einen offenen Feed in `App::feeds`, solange er lebt.
struct Open(App, String);

impl Drop for Open {
    fn drop(&mut self) {
        let mut m = self.0.feeds.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(n) = m.get_mut(&self.1) {
            *n -= 1;
            if *n == 0 {
                m.remove(&self.1);
            }
        }
    }
}

impl Open {
    fn new(app: &App, user: &str) -> Self {
        *app.feeds.lock().unwrap_or_else(|e| e.into_inner()).entry(user.to_string()).or_default() += 1;
        Self(app.clone(), user.to_string())
    }
}

struct Feed {
    _open: Open,
    app: App,
    headers: HeaderMap,
    space: String,
    rx: tokio::sync::broadcast::Receiver<std::sync::Arc<crate::hub::SpaceChanges>>,
    seq: u64,
    queue: std::collections::VecDeque<Event>,
    checked: Instant,
    closing: tokio::sync::watch::Receiver<bool>,
}

impl Feed {
    /// Nächstes Ereignis; None beendet den Feed (Zugang entzogen, Server fährt herunter).
    async fn next(&mut self) -> Option<Event> {
        loop {
            if *self.closing.borrow() {
                return None;
            }
            if let Some(e) = self.queue.pop_front() {
                return Some(e);
            }
            if self.checked.elapsed() >= RECHECK {
                if require_role(&self.app, &self.headers, &self.space, false).is_err() {
                    return None;
                }
                self.checked = Instant::now();
            }
            let recv = tokio::select! {
                r = tokio::time::timeout(RECHECK, self.rx.recv()) => r,
                _ = self.closing.changed() => return None,
            };
            match recv {
                Err(_) => continue, // nur Zugang prüfen; KeepAlive hält die Leitung offen
                Ok(Ok(c)) => {
                    if c.space != self.space || c.seq <= self.seq {
                        continue;
                    }
                    self.seq = c.seq;
                    return Some(changes_event(c.seq, &doc_ids(&self.space, &c.docs), false));
                }
                // Zu langsam gelesen → aus der Datenbank nachholen, was fehlt
                Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(_))) => match catchup(&self.app, &self.space, self.seq) {
                    Ok((seq, events)) => {
                        self.seq = seq;
                        self.queue.extend(events);
                    }
                    Err(_) => return None,
                },
                Ok(Err(tokio::sync::broadcast::error::RecvError::Closed)) => return None,
            }
        }
    }
}

pub async fn changes(State(app): State<App>, h: HeaderMap, Path(space): Path<String>, Query(q): Query<ChangesQuery>) -> Response {
    if !codec::valid_id(&space) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let user = match require_role(&app, &h, &space, false) {
        Ok(u) => u,
        Err(c) => return c.into_response(),
    };
    let e2ee = app.hub.store.lock().unwrap_or_else(|e| e.into_inner()).space_e2ee(&space);
    if matches!(e2ee, Ok(Some(_))) {
        return (StatusCode::CONFLICT, "Vault ist Ende-zu-Ende-verschlüsselt").into_response();
    }
    let since = q.since.or_else(|| h.get("last-event-id").and_then(|v| v.to_str().ok()).and_then(|v| v.trim().parse().ok())).unwrap_or(0);
    // Erst abonnieren, dann nachholen: nichts geht zwischen den beiden verloren (Doppeltes filtert die Sequenz)
    let rx = app.hub.changes_tx.subscribe();
    let (seq, events) = match catchup(&app, &space, since) {
        Ok(v) => v,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    };
    let closing = app.hub.closing.subscribe();
    let feed = Feed { _open: Open::new(&app, &user.id), app, headers: h, space, rx, seq, queue: events.into(), checked: Instant::now(), closing };
    let stream = futures_util::stream::unfold(feed, |mut f| async move { f.next().await.map(|e| (Ok::<_, Infallible>(e), f)) });
    let mut res = Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(25))).into_response();
    // nginx (Reverse-Proxy) puffert sonst den Strom
    res.headers_mut().insert("x-accel-buffering", HeaderValue::from_static("no"));
    res.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

#[cfg(test)]
mod tests {
    use super::*;
    use yrs::WriteTxn;

    #[test]
    fn ink_roundtrip_like_plugin() {
        let doc = Doc::new();
        {
            let mut txn = doc.transact_mut();
            let meta = txn.get_or_insert_map("meta");
            meta.insert(&mut txn, "head", r#"{"v":1,"w":800,"h":400}"#);
            let strokes = txn.get_or_insert_map("strokes");
            strokes.insert(&mut txn, "b", r#"{"id":"b","p":[1,2]}"#);
            strokes.insert(&mut txn, "a", r#"{"id":"a","p":[3]}"#);
            strokes.insert(&mut txn, "z", r#"{"id":"z","p":[]}"#);
            let order = txn.get_or_insert_array("order");
            order.push_back(&mut txn, "a");
            order.push_back(&mut txn, "b");
            order.push_back(&mut txn, "a"); // doppelt – zählt einmal
            order.push_back(&mut txn, "fehlt"); // ohne Strich – fällt weg
        }
        let text = encode_ink(&doc).unwrap();
        assert_eq!(text, "{\"v\":1,\"w\":800,\"h\":400,\"strokes\":[\n{\"id\":\"a\",\"p\":[3]},\n{\"id\":\"b\",\"p\":[1,2]},\n{\"id\":\"z\",\"p\":[]}\n]}\n");
        let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(parsed["strokes"].as_array().unwrap().len(), 3);
    }

    #[test]
    fn ink_without_strokes_and_missing_head() {
        let doc = Doc::new();
        assert!(encode_ink(&doc).is_none());
        {
            let mut txn = doc.transact_mut();
            txn.get_or_insert_map("meta").insert(&mut txn, "head", r#"{"v":1}"#);
            txn.get_or_insert_map("strokes");
        }
        assert_eq!(encode_ink(&doc).unwrap(), "{\"v\":1,\"strokes\":[]}\n");
    }

    /// Wie auf dem Server: Das Doc entsteht aus dem gespeicherten Update eines Clients. Bei einer leeren Fläche
    /// enthält das Update nur `meta` – „strokes“ und „order“ gibt es dann gar nicht.
    #[test]
    fn empty_surface_from_stored_update() {
        use yrs::updates::decoder::Decode;
        let client = Doc::new();
        {
            let mut txn = client.transact_mut();
            txn.get_or_insert_map("meta").insert(&mut txn, "head", r#"{"v":1,"w":800,"h":300}"#);
            txn.get_or_insert_map("strokes");
            txn.get_or_insert_array("order");
        }
        let update = client.transact().encode_state_as_update_v1(&yrs::StateVector::default());
        let server = Doc::new();
        server.transact_mut().apply_update(yrs::Update::decode_v1(&update).unwrap()).unwrap();
        assert!(server.transact().get_map("strokes").is_none(), "Voraussetzung: leere Root-Map fehlt im Update");
        assert_eq!(encode_ink(&server).unwrap(), "{\"v\":1,\"w\":800,\"h\":300,\"strokes\":[]}\n");
    }

    #[test]
    fn duplicate_paths_keep_smallest_id() {
        let e = |id: &str, path: &str, del: bool| Entry { id: id.into(), path: path.into(), kind: "md".into(), hash: None, size: None, del, by: String::new(), ts: 0.0 };
        let v = live(vec![e("b", "x.md", false), e("a", "x.md", false), e("c", "y.md", true)]);
        assert_eq!(v.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(), vec!["a"]);
        // Anhang ohne Hash (Upload steht noch aus) wird nicht angeboten, mit Hash schon
        let blob = |id: &str, hash: Option<&str>| Entry { kind: "blob".into(), hash: hash.map(Into::into), ..e(id, &format!("{id}.png"), false) };
        let v = live(vec![blob("p", None), blob("q", Some("")), blob("r", Some(&"a".repeat(64)))]);
        assert_eq!(v.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(), vec!["r"]);
    }
}
