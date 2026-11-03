//! Admin: Sicherungen (Liste, anlegen, löschen, herunterladen, Aufbewahrung), Sicherung durchsuchen und
//! mit dem aktuellen Stand vergleichen, Dateien/ganze Vaults daraus wiederherstellen, Vault als tar exportieren.

use super::{E, R, audit, bad, check_space, ctx, index_name, not_found, read_index};
use crate::backup::{self, Settings};
use crate::server::App;
use crate::vault::{self, Entry};
use axum::Json;
use axum::body::{Body, Bytes};
use axum::extract::{Path, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use yrs::{Any, Doc};

pub fn dir(app: &App) -> PathBuf {
    app.blob_dir.parent().map(|p| p.join("backups")).unwrap_or_else(|| PathBuf::from("backups"))
}

fn blob_file(app: &App, space: &str, hash: &str) -> PathBuf {
    app.blob_dir.join(space).join(&hash[..2.min(hash.len())]).join(hash)
}

fn valid_hash(h: &str) -> bool {
    h.len() == 64 && h.bytes().all(|b| b.is_ascii_hexdigit())
}

// ── Liste, anlegen, löschen, Einstellungen ──────────────────────────

pub async fn list(State(app): State<App>, h: HeaderMap) -> R {
    ctx(&app, &h)?;
    let d = dir(&app);
    let (settings, blobs, db_bytes) = {
        let st = app.hub.store.lock().unwrap_or_else(|e| e.into_inner());
        (Settings::load(&st), st.blob_totals(), st.db_bytes())
    };
    let list = {
        let st = app.hub.store.lock().unwrap_or_else(|e| e.into_inner());
        backup::list_labeled(&st, &d)
    };
    let today = crate::db::now().div_euclid(86400);
    let (y, m, dd) = backup::civil_from_days(today);
    let has_today = list.iter().any(|b| b.name == format!("tandem-{y:04}-{m:02}-{dd:02}.db"));
    // Nächste automatische: heute (falls noch keine, stündliche Prüfung) bzw. morgen kurz nach 0 Uhr UTC.
    let next_auto = settings.auto.then(|| if has_today { (today + 1) * 86400 } else { crate::db::now() });
    Ok(Json(json!({
        "backups": list,
        "settings": settings,
        "nextAuto": next_auto,
        "dbBytes": db_bytes,
        "blobs": { "count": blobs.0, "bytes": blobs.1 },
    }))
    .into_response())
}

#[derive(Deserialize)]
pub struct CreateReq {
    label: Option<String>,
}

pub async fn create(State(app): State<App>, h: HeaderMap, Json(req): Json<CreateReq>) -> R {
    let c = ctx(&app, &h)?;
    let info = {
        let st = app.hub.store.lock().unwrap_or_else(|e| e.into_inner());
        backup::create_manual(&st, &dir(&app), req.label.as_deref())?
    };
    audit(&app, &c, "backup.create", &info.name);
    Ok(Json(info).into_response())
}

pub async fn delete(State(app): State<App>, h: HeaderMap, Path(name): Path<String>) -> R {
    let c = ctx(&app, &h)?;
    if !backup::valid_name(&name) {
        return Err(bad("Name ungültig"));
    }
    let p = dir(&app).join(&name);
    if !p.exists() {
        return Err(not_found("Sicherung nicht gefunden"));
    }
    tokio::fs::remove_file(&p).await.map_err(|e| E(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let _ = app.hub.store.lock().unwrap_or_else(|e| e.into_inner()).delete_setting(&format!("backup-label:{name}"));
    audit(&app, &c, "backup.delete", &name);
    Ok(StatusCode::NO_CONTENT.into_response())
}

pub async fn settings(State(app): State<App>, h: HeaderMap, Json(cfg): Json<Settings>) -> R {
    let c = ctx(&app, &h)?;
    let pruned = {
        let st = app.hub.store.lock().unwrap_or_else(|e| e.into_inner());
        cfg.save(&st)?;
        backup::prune(&dir(&app), &cfg)?
    };
    audit(
        &app,
        &c,
        "backup.settings",
        format!(
            "automatisch: {}, täglich {}, wöchentlich {}, monatlich {}; {} ausgedünnt",
            if cfg.auto { "an" } else { "aus" },
            cfg.keep_daily,
            cfg.keep_weekly,
            cfg.keep_monthly,
            pruned.len()
        ),
    );
    Ok(Json(json!({ "settings": cfg, "pruned": pruned })).into_response())
}

pub async fn download(State(app): State<App>, h: HeaderMap, Path(name): Path<String>) -> R {
    let c = ctx(&app, &h)?;
    if !backup::valid_name(&name) {
        return Err(bad("Name ungültig"));
    }
    let file = tokio::fs::File::open(dir(&app).join(&name)).await.map_err(|_| not_found("Sicherung nicht gefunden"))?;
    let len = file.metadata().await.map(|m| m.len()).unwrap_or(0);
    audit(&app, &c, "backup.download", &name);
    let mut res = Response::new(file_stream(file));
    let hh = res.headers_mut();
    hh.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/vnd.sqlite3"));
    hh.insert(header::CONTENT_LENGTH, HeaderValue::from(len));
    hh.insert(header::CONTENT_DISPOSITION, HeaderValue::from_str(&format!("attachment; filename=\"{name}\"")).unwrap());
    Ok(res)
}

fn file_stream(file: tokio::fs::File) -> Body {
    use tokio::io::AsyncReadExt;
    Body::from_stream(futures_util::stream::unfold(file, |mut f| async move {
        let mut buf = vec![0u8; 64 << 10];
        match f.read(&mut buf).await {
            Ok(0) => None,
            Ok(n) => {
                buf.truncate(n);
                Some((Ok::<_, std::io::Error>(Bytes::from(buf)), f))
            }
            Err(e) => Some((Err(e), f)),
        }
    }))
}

// ── Sicherung durchsuchen ────────────────────────────────────────────

fn open(app: &App, name: &str) -> Result<rusqlite::Connection, E> {
    backup::open(&dir(app), name).map_err(|e| not_found(e.to_string()))
}

fn backup_index(conn: &rusqlite::Connection, space: &str) -> Result<Vec<Entry>, E> {
    if backup::is_e2ee(conn, space) {
        return Err(crate::hub::HubError::E2ee.into());
    }
    Ok(backup::load_doc(conn, &index_name(space))?.map(|d| vault::read_index(&d)).unwrap_or_default())
}

/// Vergleichbarer Inhalt eines Docs: md → Text, ink → Kopf + Striche.
fn content_key(kind: &str, doc: Option<&Doc>) -> Option<String> {
    let d = doc?;
    Some(match kind {
        "md" => vault::read_text(d),
        "ink" => vault::ink_info(d).to_string(),
        _ => return None,
    })
}

pub async fn spaces(State(app): State<App>, h: HeaderMap, Path(name): Path<String>) -> R {
    ctx(&app, &h)?;
    let conn = open(&app, &name)?;
    let list = backup::spaces(&conn)?;
    let mut out = Vec::new();
    for (id, title) in list {
        // Verschlüsselte Vaults: Inhalt nicht lesbar – trotzdem auflisten, damit die übrigen durchsuchbar bleiben.
        if backup::is_e2ee(&conn, &id) {
            out.push(json!({ "id": id, "name": title, "files": null, "e2ee": true }));
            continue;
        }
        let files = backup_index(&conn, &id)?.into_iter().filter(|e| !e.del).count();
        out.push(json!({ "id": id, "name": title, "files": files, "e2ee": false }));
    }
    Ok(Json(out).into_response())
}

/// Dateien eines Vaults in der Sicherung, je mit Vergleich zum aktuellen Stand:
/// `same` | `changed` | `moved` (anderer Pfad) | `missing` (heute gelöscht/fehlt). Dazu `added`: heute neue Dateien.
pub async fn files(State(app): State<App>, h: HeaderMap, Path((name, space)): Path<(String, String)>) -> R {
    ctx(&app, &h)?;
    let conn = open(&app, &name)?;
    let entries: Vec<Entry> = backup_index(&conn, &space)?.into_iter().filter(|e| !e.del).collect();
    let live: Vec<Entry> = if check_space(&app, &space).is_ok() { read_index(&app, &space)? } else { Vec::new() };
    let live_by_id: HashMap<&str, &Entry> = live.iter().map(|e| (e.id.as_str(), e)).collect();
    let mut files = Vec::new();
    for e in &entries {
        let status = match live_by_id.get(e.id.as_str()) {
            None => "missing",
            Some(l) if l.del => "missing",
            Some(l) => {
                let same_content = match e.kind.as_str() {
                    "blob" => l.hash == e.hash,
                    k => {
                        let docname = format!("{space}/{}", e.id);
                        let b = backup::load_doc(&conn, &docname)?;
                        let cur = app.hub.read_doc(&docname, |d| content_key(k, Some(d)))?;
                        content_key(k, b.as_ref()) == cur
                    }
                };
                if !same_content {
                    "changed"
                } else if l.path != e.path {
                    "moved"
                } else {
                    "same"
                }
            }
        };
        let mut v = serde_json::to_value(e).unwrap_or(Value::Null);
        v["status"] = json!(status);
        if let Some(l) = live_by_id.get(e.id.as_str()).filter(|l| !l.del && l.path != e.path) {
            v["livePath"] = json!(l.path);
        }
        files.push(v);
    }
    let ids: HashSet<&str> = entries.iter().map(|e| e.id.as_str()).collect();
    let added: Vec<&Entry> = live.iter().filter(|l| !l.del && !ids.contains(l.id.as_str())).collect();
    Ok(Json(json!({ "files": files, "added": added })).into_response())
}

pub async fn doc(State(app): State<App>, h: HeaderMap, Path((name, space, doc)): Path<(String, String, String)>) -> R {
    ctx(&app, &h)?;
    if !crate::codec::valid_id(&space) || !crate::codec::valid_id(&doc) {
        return Err(bad("Kennung ungültig"));
    }
    let conn = open(&app, &name)?;
    let e = backup_index(&conn, &space)?.into_iter().find(|e| e.id == doc).ok_or_else(|| not_found("Datei nicht in der Sicherung"))?;
    let d = backup::load_doc(&conn, &format!("{space}/{doc}"))?;
    Ok(Json(match e.kind.as_str() {
        "md" => json!({ "id": e.id, "path": e.path, "kind": "md", "text": d.as_ref().map(vault::read_text).unwrap_or_default() }),
        "ink" => {
            let mut v = d.as_ref().map(vault::ink_info).unwrap_or(json!({}));
            v["id"] = json!(e.id);
            v["path"] = json!(e.path);
            v["kind"] = json!("ink");
            v
        }
        _ => json!({ "id": e.id, "path": e.path, "kind": "blob", "hash": e.hash, "size": e.size }),
    })
    .into_response())
}

/// Datei im Stand der Sicherung ausliefern (Notiz als Text, Anhang aus dem Blob-Speicher) – für Vorschauen.
pub async fn raw(State(app): State<App>, h: HeaderMap, Path((name, space, doc)): Path<(String, String, String)>) -> R {
    ctx(&app, &h)?;
    if !crate::codec::valid_id(&space) || !crate::codec::valid_id(&doc) {
        return Err(bad("Kennung ungültig"));
    }
    let (e, text) = {
        let conn = open(&app, &name)?;
        let e = backup_index(&conn, &space)?.into_iter().find(|e| e.id == doc).ok_or_else(|| not_found("Datei nicht in der Sicherung"))?;
        let text = if e.kind == "md" { backup::load_doc(&conn, &format!("{space}/{doc}"))?.map(|d| vault::read_text(&d)) } else { None };
        (e, text)
    };
    let (body, ct, len): (Body, &str, Option<u64>) = match e.kind.as_str() {
        "md" => (Body::from(text.unwrap_or_default()), "text/plain; charset=utf-8", None),
        "blob" => {
            let hash = e.hash.clone().filter(|h| valid_hash(h)).ok_or_else(|| not_found("Anhang ohne Inhalt"))?;
            let (len, body) = crate::server::open_blob(&app, &space, &hash).await.ok_or_else(|| not_found("Inhalt des Anhangs fehlt auf dem Server"))?;
            (body, vault::content_type(&e.path).0, Some(len))
        }
        _ => return Err(bad("Ink-Flächen über …/docs/{doc} abrufen")),
    };
    let mut res = Response::new(body);
    let hh = res.headers_mut();
    hh.insert(header::CONTENT_TYPE, HeaderValue::from_str(ct).unwrap());
    if let Some(l) = len {
        hh.insert(header::CONTENT_LENGTH, HeaderValue::from(l));
    }
    hh.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static(super::RAW_CSP));
    hh.insert(header::CACHE_CONTROL, HeaderValue::from_static("private, no-cache"));
    Ok(res)
}

// ── Wiederherstellen ─────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct RestoreReq {
    space: String,
    /// einzelne Dateien (docIds der Sicherung) …
    #[serde(default)]
    docs: Vec<String>,
    /// … oder alle Dateien der Sicherung
    #[serde(default)]
    all: bool,
    /// bei `all`: heute vorhandene Dateien, die es in der Sicherung nicht gab, in den Papierkorb
    #[serde(default)]
    prune: bool,
}

pub async fn restore(State(app): State<App>, h: HeaderMap, Path(name): Path<String>, Json(req): Json<RestoreReq>) -> R {
    let c = ctx(&app, &h)?;
    check_space(&app, &req.space)?;
    if !req.all && req.docs.is_empty() {
        return Err(bad("Nichts ausgewählt"));
    }
    if req.prune && !req.all {
        return Err(bad("„Neue Dateien entfernen“ geht nur beim Wiederherstellen des ganzen Vaults"));
    }
    let conn = open(&app, &name)?;
    // Sicherheitsnetz: aktuellen Stand vorher sichern
    let safety = {
        let st = app.hub.store.lock().unwrap_or_else(|e| e.into_inner());
        backup::create_manual(&st, &dir(&app), Some("vor wiederherstellung"))?
    };
    let res = restore_sync(&app, &conn, &req, &c.user.id)?;
    audit(
        &app,
        &c,
        "backup.restore",
        format!(
            "{} → {}: {} wiederhergestellt, {} unverändert, {} übersprungen, {} in den Papierkorb (Sicherheitskopie {})",
            name,
            req.space,
            res.0,
            res.1,
            res.2.len(),
            res.3,
            safety.name
        ),
    );
    Ok(Json(json!({ "restored": res.0, "unchanged": res.1, "skipped": res.2, "trashed": res.3, "safety": safety.name })).into_response())
}

/// (geändert, schon gleich, übersprungen [{path, reason}], in den Papierkorb)
fn restore_sync(app: &App, conn: &rusqlite::Connection, req: &RestoreReq, by: &str) -> Result<(usize, usize, Vec<Value>, usize), E> {
    let space = &req.space;
    let backup_entries: Vec<Entry> = backup_index(conn, space)?.into_iter().filter(|e| !e.del).collect();
    let wanted: HashSet<&str> = req.docs.iter().map(String::as_str).collect();
    let selected: Vec<&Entry> = backup_entries.iter().filter(|e| req.all || wanted.contains(e.id.as_str())).collect();
    if selected.is_empty() {
        return Err(not_found("Keine der Dateien ist in der Sicherung"));
    }
    let live = read_index(app, space)?;
    let live_by_id: HashMap<&str, &Entry> = live.iter().map(|e| (e.id.as_str(), e)).collect();
    let selected_ids: HashSet<&str> = selected.iter().map(|e| e.id.as_str()).collect();
    let mut skipped = Vec::new();
    let mut index_ops: Vec<(String, Option<Vec<(&'static str, Any)>>, &Entry)> = Vec::new(); // (id, Patch oder Neuanlage)
    // In den Papierkorb (nur mit prune): heute lebende Dateien, die es in der Sicherung nicht gab.
    // Vorab bestimmen – sie zählen nicht als Belegung eines Pfads (sonst ginge die Fassung aus der Sicherung verloren).
    let backup_ids: HashSet<&str> = backup_entries.iter().map(|e| e.id.as_str()).collect();
    let trash: Vec<String> =
        if req.prune { live.iter().filter(|l| !l.del && !backup_ids.contains(l.id.as_str())).map(|l| l.id.clone()).collect() } else { Vec::new() };
    let trash_set: HashSet<&str> = trash.iter().map(String::as_str).collect();
    let (mut restored, mut unchanged) = (0, 0);
    for e in &selected {
        // Pfad belegt durch eine andere, heute lebende Datei (die nicht selbst gerade verschoben wird oder in den Papierkorb geht)?
        let occupant = live.iter().find(|l| {
            !l.del && l.path == e.path && l.id != e.id && !selected_ids.contains(l.id.as_str()) && !trash_set.contains(l.id.as_str())
        });
        if let Some(o) = occupant {
            skipped.push(json!({ "path": e.path, "reason": format!("Pfad belegt (heute andere Datei, {})", o.id) }));
            continue;
        }
        let mut content_changed = false;
        if e.kind == "blob" {
            let ok = e.hash.as_deref().is_some_and(|h| valid_hash(h) && blob_file(app, space, h).exists());
            if !ok {
                skipped.push(json!({ "path": e.path, "reason": "Inhalt des Anhangs fehlt auf dem Server" }));
                continue;
            }
        } else {
            let docname = format!("{space}/{}", e.id);
            let Some(bdoc) = backup::load_doc(conn, &docname)? else {
                skipped.push(json!({ "path": e.path, "reason": "Inhalt fehlt in der Sicherung" }));
                continue;
            };
            content_changed = if e.kind == "md" {
                let text = vault::read_text(&bdoc);
                app.hub.edit_doc(&docname, |d| {
                    let t = d.get_or_insert_text("content");
                    let mut txn = yrs::Transact::transact_mut(d);
                    let changed = yrs::GetString::get_string(&t, &txn) != text;
                    vault::set_text(&t, &mut txn, &text);
                    changed
                })?
            } else {
                app.hub.edit_doc(&docname, |d| vault::ink_restore(d, &bdoc))?
            };
        }
        // Index: vorhandenen Eintrag zurücksetzen oder neu anlegen
        match live_by_id.get(e.id.as_str()) {
            Some(l) => {
                let mut patch: Vec<(&'static str, Any)> = Vec::new();
                if l.del {
                    patch.push(("del", Any::Bool(false)));
                }
                if l.path != e.path {
                    patch.push(("path", Any::from(e.path.as_str())));
                }
                if e.kind == "blob" && l.hash != e.hash {
                    if let Some(h) = &e.hash {
                        patch.push(("hash", Any::from(h.as_str())));
                    }
                    if let Some(s) = e.size {
                        patch.push(("size", Any::from(s)));
                    }
                    if let Some(old) = &l.hash {
                        patch.push(("parent", Any::from(old.as_str())));
                    }
                }
                if !patch.is_empty() {
                    content_changed = true;
                    index_ops.push((e.id.clone(), Some(patch), e));
                }
            }
            None => {
                content_changed = true;
                index_ops.push((e.id.clone(), None, e));
            }
        }
        if content_changed {
            restored += 1;
        } else {
            unchanged += 1;
        }
    }
    if !index_ops.is_empty() || !trash.is_empty() {
        app.hub.edit_doc(&index_name(space), |d| {
            let mut txn = yrs::Transact::transact_mut(d);
            for (id, patch, e) in index_ops {
                match patch {
                    Some(p) => {
                        vault::update_entry(&mut txn, &id, by, p);
                    }
                    None => {
                        let mut extra: Vec<(&str, Any)> = vec![("origin", Any::from(vault::ORIGIN))];
                        if let Some(h) = &e.hash {
                            extra.push(("hash", Any::from(h.as_str())));
                        }
                        if let Some(s) = e.size {
                            extra.push(("size", Any::from(s)));
                        }
                        vault::add_entry(&mut txn, &id, &e.path, &e.kind, by, extra);
                    }
                }
            }
            for id in &trash {
                vault::update_entry(&mut txn, id, by, vec![("del", Any::Bool(true))]);
            }
        })?;
    }
    Ok((restored, unchanged, skipped, trash.len()))
}

// ── Export als tar ───────────────────────────────────────────────────

enum Item {
    Bytes(Vec<u8>),
    File(PathBuf),
}

/// Vault (heute oder aus einer Sicherung) als tar streamen: Notizen als .md/.txt, Ink-Flächen als .ink,
/// Anhänge aus dem Blob-Speicher. Bei Pfad-Doppelungen gewinnt wie im Plugin die kleinste docId.
fn tar_response(app: &App, space: String, source: Option<String>, filename: String) -> Result<Response, E> {
    let app = app.clone();
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Result<Bytes, std::io::Error>>(8);
    tokio::spawn(async move {
        let send = |b: Vec<u8>| {
            let tx = tx.clone();
            async move { tx.send(Ok(Bytes::from(b))).await.is_ok() }
        };
        // Inhalte einsammeln (synchron, je Datei), Anhänge erst beim Schreiben lesen
        let collected: Result<Vec<(String, u64, Item)>, String> = (|| {
            let conn = match &source {
                Some(n) => Some(backup::open(&dir(&app), n).map_err(|e| e.to_string())?),
                None => None,
            };
            let entries = match &conn {
                Some(c) => backup_index(c, &space).map_err(|e| e.1)?,
                None => read_index(&app, &space).map_err(|e| e.1)?,
            };
            let live: Vec<&Entry> = entries.iter().filter(|e| !e.del).collect();
            let mut winners: HashMap<&str, &Entry> = HashMap::new();
            for e in &live {
                let w = winners.entry(e.path.as_str()).or_insert(e);
                if e.id < w.id {
                    *w = e;
                }
            }
            let mut out: Vec<(String, u64, Item)> = Vec::new();
            for e in winners.values() {
                let mtime = (e.ts / 1000.0).max(0.0) as u64;
                let docname = format!("{space}/{}", e.id);
                let load = |f: &dyn Fn(&Doc) -> Option<Vec<u8>>| -> Option<Vec<u8>> {
                    match &conn {
                        Some(c) => backup::load_doc(c, &docname).ok().flatten().and_then(|d| f(&d)),
                        None => app.hub.read_doc(&docname, f).ok().flatten(),
                    }
                };
                match e.kind.as_str() {
                    "md" => {
                        if let Some(b) = load(&|d| Some(vault::read_text(d).into_bytes())) {
                            out.push((e.path.clone(), mtime, Item::Bytes(b)));
                        }
                    }
                    "ink" => {
                        if let Some(b) = load(&|d| crate::files_api::encode_ink(d).map(String::into_bytes)) {
                            out.push((e.path.clone(), mtime, Item::Bytes(b)));
                        }
                    }
                    _ => {
                        if let Some(h) = e.hash.as_deref().filter(|h| valid_hash(h)) {
                            let p = blob_file(&app, &space, h);
                            if p.exists() {
                                out.push((e.path.clone(), mtime, Item::File(p)));
                            }
                        }
                    }
                }
            }
            out.sort_by(|a, b| a.0.cmp(&b.0));
            Ok(out)
        })();
        let items = match collected {
            Ok(i) => i,
            Err(e) => {
                let _ = tx.send(Err(std::io::Error::other(e))).await;
                return;
            }
        };
        for (path, mtime, item) in items {
            match item {
                Item::Bytes(b) => {
                    let mut chunk = crate::tar::file_header(&path, b.len() as u64, mtime);
                    let pad = crate::tar::padding(b.len() as u64);
                    chunk.extend_from_slice(&b);
                    chunk.resize(chunk.len() + pad, 0);
                    if !send(chunk).await {
                        return;
                    }
                }
                Item::File(p) => {
                    use tokio::io::AsyncReadExt;
                    let Ok(mut f) = tokio::fs::File::open(&p).await else { continue };
                    let size = f.metadata().await.map(|m| m.len()).unwrap_or(0);
                    if !send(crate::tar::file_header(&path, size, mtime)).await {
                        return;
                    }
                    let mut left = size;
                    while left > 0 {
                        let mut buf = vec![0u8; (64 << 10).min(left as usize)];
                        match f.read(&mut buf).await {
                            Ok(0) | Err(_) => {
                                // Datei kürzer als gedacht: mit Nullen auffüllen, damit das Archiv lesbar bleibt
                                buf = vec![0u8; left as usize];
                                left = 0;
                                if !send(buf).await {
                                    return;
                                }
                            }
                            Ok(n) => {
                                buf.truncate(n);
                                left -= n as u64;
                                if !send(buf).await {
                                    return;
                                }
                            }
                        }
                    }
                    let pad = crate::tar::padding(size);
                    if pad > 0 && !send(vec![0u8; pad]).await {
                        return;
                    }
                }
            }
        }
        let _ = send(crate::tar::trailer()).await;
    });
    let stream = futures_util::stream::poll_fn(move |cx| rx.poll_recv(cx));
    let mut res = Response::new(Body::from_stream(stream));
    let hh = res.headers_mut();
    hh.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/x-tar"));
    hh.insert(header::CONTENT_DISPOSITION, HeaderValue::from_str(&format!("attachment; filename=\"{filename}\"")).unwrap());
    Ok(res)
}

pub async fn export_live(State(app): State<App>, h: HeaderMap, Path(space): Path<String>) -> R {
    let c = ctx(&app, &h)?;
    check_space(&app, &space)?;
    let (y, m, d) = backup::civil_from_days(crate::db::now().div_euclid(86400));
    audit(&app, &c, "export", &space);
    tar_response(&app, space.clone(), None, format!("{space}-{y:04}-{m:02}-{d:02}.tar"))
}

pub async fn export_backup(State(app): State<App>, h: HeaderMap, Path((name, space)): Path<(String, String)>) -> R {
    let c = ctx(&app, &h)?;
    if !crate::codec::valid_id(&space) {
        return Err(bad("Kennung ungültig"));
    }
    let conn = open(&app, &name)?;
    if !backup::spaces(&conn)?.iter().any(|s| s.0 == space) {
        return Err(not_found("Vault nicht in der Sicherung"));
    }
    drop(conn);
    audit(&app, &c, "export", format!("{space} aus {name}"));
    let stem = name.trim_end_matches(".db");
    tar_response(&app, space.clone(), Some(name.clone()), format!("{space}-{stem}.tar"))
}
