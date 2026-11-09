//! HTTP + WebSocket (axum).

use crate::codec::{self, Frame};
use crate::db::{User, sha256_hex};
use crate::hub::{Hub, HubError, Out};
use axum::body::{Body, Bytes};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{DefaultBodyLimit, Path, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use tracing::{debug, info, warn};

pub const MAX_FRAME: usize = 8 << 20;
pub const MAX_BLOB: usize = 100 << 20;

#[derive(Clone)]
pub struct App {
    pub hub: Arc<Hub>,
    pub blob_dir: PathBuf,
    redeem_limit: Arc<Mutex<HashMap<String, (u32, Instant)>>>,
    pub admin: Arc<crate::admin::AdminState>,
}

impl App {
    pub fn new(hub: Arc<Hub>, blob_dir: PathBuf) -> Self {
        Self { hub, blob_dir, redeem_limit: Arc::default(), admin: Arc::new(crate::admin::AdminState::new()) }
    }
}

pub fn router(app: App) -> Router {
    let admin = if crate::admin::enabled() { crate::admin::router() } else { Router::new() };
    // Nur das Obsidian-Plugin ruft diese Routen auf → Plugin-Version muss zum Server passen.
    let plugin_only = Router::new()
        .route("/api/invite", post(invite))
        .route("/api/members/{space}", get(members))
        .route("/api/e2ee/{space}", post(e2ee_setup))
        .route("/api/blob/{space}/{hash}", get(blob_get).head(blob_head).put(blob_put))
        .route("/api/history/{space}/{doc}", get(history_list))
        .route("/api/history/{space}/{doc}/{ts}", get(history_get))
        .route_layer(axum::middleware::from_fn(require_plugin_header));
    Router::new()
        .merge(admin)
        .merge(plugin_only)
        .route("/health", get(|| async { "ok" }))
        .route("/ws", get(ws_handler))
        .route("/api/redeem", post(redeem))
        .route("/api/status", get(status))
        .route("/api/files/{space}", get(crate::files_api::files))
        .route("/api/file/{space}/{doc}", get(crate::files_api::file))
        .layer(DefaultBodyLimit::max(MAX_BLOB))
        .with_state(app)
}

// ── Client-Version ───────────────────────────────────────────────────

/// Kennung des Obsidian-Plugins im HELLO bzw. im Header `X-Tandem-Client`: `tandem-plugin/<version>`.
pub const PLUGIN_CLIENT: &str = "tandem-plugin/";
pub const CLIENT_HEADER: &str = "x-tandem-client";
/// Fehlercode im ERROR-Frame, wenn die Plugin-Version nicht passt (426 ist schon „Space verschlüsselt“).
pub const ERR_VERSION: u64 = 505;

/// Der Server bedient nur das Plugin mit genau seiner eigenen Version. Andere Clients (z. B. die
/// Lernplattform) melden sich mit eigener Kennung und sind nicht an die Plugin-Version gebunden.
/// Ohne Kennung = Plugin vor 0.8.2.
pub fn check_client(client: Option<&str>) -> Result<(), String> {
    match client {
        Some(c) if !c.is_empty() && !c.starts_with(PLUGIN_CLIENT) => Ok(()),
        _ => check_plugin(client.and_then(|c| c.strip_prefix(PLUGIN_CLIENT))),
    }
}

/// `version`: Version aus `tandem-plugin/<version>`, `None` = keine Plugin-Kennung (Plugin vor 0.8.2).
pub fn check_plugin(version: Option<&str>) -> Result<(), String> {
    let server = env!("CARGO_PKG_VERSION");
    if version == Some(server) {
        return Ok(());
    }
    let plugin = version.unwrap_or("vor 0.8.2");
    Err(format!(
        "Tandem-Server {server} bedient nur Tandem-Plugin {server} (dieses Gerät: {plugin}). Plugin aktualisieren: Einstellungen → Tandem → Version."
    ))
}

/// Für die Plugin-Routen: Header `X-Tandem-Client: tandem-plugin/<version>` mit passender Version.
async fn require_plugin_header(req: axum::extract::Request, next: axum::middleware::Next) -> Response {
    let version = req.headers().get(CLIENT_HEADER).and_then(|v| v.to_str().ok()).and_then(|c| c.strip_prefix(PLUGIN_CLIENT));
    match check_plugin(version) {
        Ok(()) => next.run(req).await,
        Err(msg) => (StatusCode::UPGRADE_REQUIRED, msg).into_response(),
    }
}

// ── WebSocket ────────────────────────────────────────────────────────

async fn ws_handler(ws: WebSocketUpgrade, State(app): State<App>) -> Response {
    ws.max_message_size(MAX_FRAME).max_frame_size(MAX_FRAME).on_upgrade(move |s| handle_socket(s, app))
}

async fn handle_socket(socket: WebSocket, app: App) {
    let (mut sink, mut stream) = socket.split();

    // 1. HELLO (innerhalb von 10 s)
    let hello = match tokio::time::timeout(Duration::from_secs(10), stream.next()).await {
        Ok(Some(Ok(Message::Binary(b)))) => b,
        _ => return,
    };
    let (user, bound, device, token_hash) = match codec::decode_client(&hello) {
        Ok(Frame::Hello { version: 1, token, device, client }) => {
            if let Err(msg) = check_client(client) {
                debug!(device, client, "Plugin-Version passt nicht – abgelehnt");
                let _ = sink.send(Message::Binary(codec::error(ERR_VERSION, "", &msg).into())).await;
                let _ = sink.close().await;
                return;
            }
            let u = app.hub.store.lock().unwrap_or_else(|e| e.into_inner()).auth(token).ok().flatten();
            match u {
                Some((u, bound)) => {
                    let (device, hash) = (device.chars().take(64).collect::<String>(), sha256_hex(token.as_bytes()));
                    let _ = app.hub.store.lock().unwrap_or_else(|e| e.into_inner()).rename_token(&hash, &device);
                    (u, bound, device, hash)
                }
                None => {
                    let _ = sink.send(Message::Binary(codec::error(401, "", "Token ungültig").into())).await;
                    let _ = sink.close().await;
                    return;
                }
            }
        }
        Ok(Frame::Hello { .. }) => {
            let _ = sink.send(Message::Binary(codec::error(400, "", "Protokollversion nicht unterstützt").into())).await;
            return;
        }
        _ => return,
    };
    let mut spaces_list = app.hub.store.lock().unwrap_or_else(|e| e.into_inner()).spaces_of(&user.id).unwrap_or_default();
    // Ein Gerät gehört zu einem Vault: Gebunden sieht es nur diesen, sonst bindet es sich beim ersten Zugriff (unten).
    let mut unbound = bound.is_none();
    if let Some(b) = &bound {
        spaces_list.retain(|s| &s.id == b);
    }
    let spaces: HashMap<String, String> = spaces_list.iter().map(|s| (s.id.clone(), s.role.clone())).collect();
    let welcome = serde_json::json!({ "user": &user, "spaces": &spaces_list }).to_string();
    if sink.send(Message::Binary(codec::welcome(&welcome).into())).await.is_err() {
        return;
    }

    let (tx, mut rx) = mpsc::channel::<Out>(2048);
    let stats = Arc::new(crate::metrics::ConnStats::default());
    stats.connected_at.store(crate::db::now() as u64, Relaxed);
    let id = app.hub.register(tx, user.clone(), device.clone(), token_hash, spaces, stats.clone());
    // Zeitpunkt des letzten Pings (µs seit `epoch`) → Laufzeit beim Pong
    let epoch = Instant::now();
    let ping_at = Arc::new(AtomicU64::new(0));
    info!(user = user.id, device, conn = id, "verbunden");

    // 2. Schreiber: Frames + WS-Pings (hält Proxys wie Cloudflare wach; die Pong-Laufzeit ist die Latenz des Geräts)
    let writer = {
        let (stats, ping_at, hub) = (stats.clone(), ping_at.clone(), app.hub.clone());
        tokio::spawn(async move {
            let mut ping = tokio::time::interval(Duration::from_secs(30));
            ping.reset_after(Duration::from_secs(2)); // erste Messung kurz nach dem Verbinden
            loop {
                tokio::select! {
                    out = rx.recv() => match out {
                        Some(Out::Frame(f)) => {
                            stats.bytes_out.fetch_add(f.len() as u64, Relaxed);
                            hub.metrics.frame_out(f.len());
                            if sink.send(Message::Binary(f.into())).await.is_err() { break }
                        }
                        Some(Out::Close) | None => { let _ = sink.close().await; break }
                    },
                    _ = ping.tick() => {
                        ping_at.store(epoch.elapsed().as_micros() as u64, Relaxed);
                        if sink.send(Message::Ping(Bytes::new())).await.is_err() { break }
                    }
                }
            }
        })
    };

    // 3. Leser
    loop {
        let msg = match tokio::time::timeout(Duration::from_secs(90), stream.next()).await {
            Ok(Some(Ok(m))) => m,
            _ => break,
        };
        let data = match msg {
            Message::Binary(b) => b,
            Message::Close(_) => break,
            Message::Pong(_) => {
                let sent = ping_at.swap(0, Relaxed);
                if sent > 0 {
                    stats.rtt_us.store((epoch.elapsed().as_micros() as u64).saturating_sub(sent).max(1), Relaxed);
                }
                continue;
            }
            _ => continue,
        };
        stats.bytes_in.fetch_add(data.len() as u64, Relaxed);
        app.hub.metrics.frame_in(data.len());
        let frame = codec::decode_client(&data);
        if unbound {
            if let Some(space) = frame.as_ref().ok().and_then(frame_space) {
                match app.hub.bind_conn(id, space) {
                    Ok(done) => unbound = !done,
                    Err(e) => warn!(conn = id, "Gerät nicht an den Vault gebunden: {e:?}"),
                }
            }
        }
        let res = match frame {
            Ok(Frame::Sync { doc, sub, data }) => app.hub.on_sync(id, doc, sub, data).map_err(|e| (doc.to_string(), e)),
            Ok(Frame::Awareness { doc, data }) => app.hub.on_awareness(id, doc, data).map_err(|e| (doc.to_string(), e)),
            Ok(Frame::Unsub { doc }) => {
                app.hub.on_unsub(id, doc);
                Ok(())
            }
            Ok(Frame::Catchup { space, since }) => app.hub.on_catchup(id, space, since).map_err(|e| (space.to_string(), e)),
            Ok(Frame::Ping) => {
                app.hub.send_to(id, codec::pong());
                Ok(())
            }
            Ok(Frame::ESub { doc, since }) => app.hub.on_esub(id, doc, since).map_err(|e| (doc.to_string(), e)),
            Ok(Frame::EUpd { doc, data }) => app.hub.on_eupd(id, doc, data).map_err(|e| (doc.to_string(), e)),
            Ok(Frame::ECompact { doc, upto, data }) => app.hub.on_ecompact(id, doc, upto, data).map_err(|e| (doc.to_string(), e)),
            Ok(Frame::Hello { .. }) => Ok(()),
            Err(_) => Err((String::new(), HubError::BadRequest("Frame ungültig"))),
        };
        if let Err((doc, e)) = res {
            let (code, msg) = match e {
                HubError::Forbidden => (403, "kein Zugriff".to_string()),
                HubError::E2ee => (426, "Space ist Ende-zu-Ende-verschlüsselt – Tandem-Plugin aktualisieren (ab 0.5)".to_string()),
                HubError::BadRequest(m) => (400, m.to_string()),
                HubError::Internal(m) => {
                    warn!(conn = id, doc, "interner Fehler: {m}");
                    (500, "interner Fehler".to_string())
                }
            };
            debug!(conn = id, doc, code, msg, "Fehler an Client");
            app.hub.send_to(id, codec::error(code, &doc, &msg));
        }
    }
    app.hub.unregister(id);
    writer.abort();
    info!(user = user.id, conn = id, "getrennt");
}

/// Der Space, den ein Frame anspricht (für die Bindung eines neuen Geräts).
fn frame_space<'a>(f: &Frame<'a>) -> Option<&'a str> {
    match f {
        Frame::Sync { doc, .. } | Frame::Awareness { doc, .. } | Frame::ESub { doc, .. } | Frame::EUpd { doc, .. } | Frame::ECompact { doc, .. } => codec::split_doc(doc).map(|(s, _)| s),
        Frame::Catchup { space, .. } => Some(space),
        _ => None,
    }
}

// ── HTTP ─────────────────────────────────────────────────────────────

fn bearer(h: &HeaderMap) -> Option<&str> {
    h.get(header::AUTHORIZATION)?.to_str().ok()?.strip_prefix("Bearer ")
}

fn auth(app: &App, h: &HeaderMap) -> Result<(User, Option<String>), StatusCode> {
    let t = bearer(h).ok_or(StatusCode::UNAUTHORIZED)?;
    app.hub.store.lock().unwrap_or_else(|e| e.into_inner()).auth(t).ok().flatten().ok_or(StatusCode::UNAUTHORIZED)
}

pub(crate) fn require_role(app: &App, h: &HeaderMap, space: &str, write: bool) -> Result<User, StatusCode> {
    let (u, bound) = auth(app, h)?;
    if bound.is_some_and(|b| b != space) {
        return Err(StatusCode::FORBIDDEN);
    }
    let role = app.hub.store.lock().unwrap_or_else(|e| e.into_inner()).role(space, &u.id).ok().flatten().ok_or(StatusCode::FORBIDDEN)?;
    if write && role == "read" {
        return Err(StatusCode::FORBIDDEN);
    }
    Ok(u)
}

pub fn client_ip(h: &HeaderMap) -> String {
    for k in ["cf-connecting-ip", "x-real-ip", "x-forwarded-for"] {
        if let Some(v) = h.get(k).and_then(|v| v.to_str().ok()) {
            return v.split(',').next().unwrap_or("").trim().to_string();
        }
    }
    "direkt".into()
}

#[derive(Deserialize)]
struct RedeemReq {
    code: String,
    device: String,
}

async fn redeem(State(app): State<App>, h: HeaderMap, Json(req): Json<RedeemReq>) -> Response {
    {
        // Höchstens 10 Versuche pro IP und 10 Minuten.
        let mut lim = app.redeem_limit.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        lim.retain(|_, (_, t)| now.duration_since(*t) < Duration::from_secs(600));
        let e = lim.entry(client_ip(&h)).or_insert((0, now));
        e.0 += 1;
        if e.0 > 10 {
            return (StatusCode::TOO_MANY_REQUESTS, "Zu viele Versuche").into_response();
        }
    }
    let st = app.hub.store.lock().unwrap_or_else(|e| e.into_inner());
    match st.redeem(&req.code, &req.device) {
        Ok((token, user, space)) => {
            let mut spaces = st.spaces_of(&user.id).unwrap_or_default();
            if let Some(b) = &space {
                spaces.retain(|s| &s.id == b);
            }
            info!(user = user.id, device = req.device, "Einladung eingelöst");
            Json(serde_json::json!({ "token": token, "user": user, "spaces": spaces, "space": space })).into_response()
        }
        Err(e) => (StatusCode::BAD_REQUEST, e.to_string()).into_response(),
    }
}

#[derive(Deserialize)]
struct InviteReq {
    space: String,
    /// Kennung der Person (a-z, 0-9, _ und -). Gibt es sie noch nicht, wird sie angelegt.
    user: String,
    name: Option<String>,
    /// owner | write | read – ohne Angabe: bestehende Rolle behalten bzw. write für Neue
    role: Option<String>,
    hours: Option<i64>,
}

/// Einladungscode erzeugen – nur für Besitzer des Space (aus Obsidian heraus, ohne Konsole).
async fn invite(State(app): State<App>, h: HeaderMap, Json(req): Json<InviteReq>) -> Response {
    let me = match require_role(&app, &h, &req.space, true) {
        Ok(u) => u,
        Err(c) => return c.into_response(),
    };
    let st = app.hub.store.lock().unwrap_or_else(|e| e.into_inner());
    if st.role(&req.space, &me.id).ok().flatten().as_deref() != Some("owner") {
        return (StatusCode::FORBIDDEN, "Nur Besitzer des Space können einladen").into_response();
    }
    let user = req.user.trim().to_lowercase();
    if !codec::valid_id(&user) {
        return (StatusCode::BAD_REQUEST, "Kennung: nur a-z, 0-9, _ und - (max. 64 Zeichen)").into_response();
    }
    let hours = req.hours.unwrap_or(72).clamp(1, 24 * 30);
    let res = (|| -> anyhow::Result<(String, String)> {
        if st.user(&user)?.is_none() {
            let name = req.name.as_deref().map(str::trim).filter(|n| !n.is_empty()).unwrap_or(&user);
            st.add_user(&user, name, None)?;
        }
        let current = st.role(&req.space, &user)?;
        let role = match (&req.role, &current) {
            (Some(r), _) => r.clone(),
            (None, Some(c)) => c.clone(),
            (None, None) => "write".to_string(),
        };
        st.set_member(&req.space, &user, &role)?;
        Ok((st.create_invite(&user, hours, Some(&req.space))?, role))
    })();
    match res {
        Ok((code, role)) => {
            info!(by = me.id, user, role, "Einladung erzeugt");
            Json(serde_json::json!({ "code": code, "user": user, "role": role, "hours": hours })).into_response()
        }
        Err(e) => (StatusCode::BAD_REQUEST, e.to_string()).into_response(),
    }
}

/// Öffentliche Schlüsselparameter eines verschlüsselten Space prüfen. Die Passphrase selbst und der
/// Schlüssel verlassen nie das Gerät; `check` ist ein mit dem Schlüssel verschlüsselter Prüfwert.
pub fn valid_e2ee_params(v: &serde_json::Value) -> Option<String> {
    let o = v.as_object()?;
    let b64 = |k: &str, max: usize| o.get(k)?.as_str().filter(|s| !s.is_empty() && s.len() <= max && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"+/=".contains(&b))).map(str::to_string);
    if o.get("v")?.as_u64()? != 1 || o.get("kdf")?.as_str()? != "pbkdf2-sha256" {
        return None;
    }
    let iter = o.get("iter")?.as_u64().filter(|i| (100_000..=10_000_000).contains(i))?;
    let (salt, check) = (b64("salt", 64)?, b64("check", 256)?);
    Some(serde_json::json!({ "v": 1, "kdf": "pbkdf2-sha256", "iter": iter, "salt": salt, "check": check }).to_string())
}

/// Ende-zu-Ende-Verschlüsselung für einen Space festlegen (nur Besitzer, nur solange der Space leer ist
/// oder auf die Passphrase wartet). Danach verbinden sich alle Geräte neu und bekommen die Parameter.
async fn e2ee_setup(State(app): State<App>, h: HeaderMap, Path(space): Path<String>, Json(params): Json<serde_json::Value>) -> Response {
    let me = match require_role(&app, &h, &space, true) {
        Ok(u) => u,
        Err(c) => return c.into_response(),
    };
    let Some(params) = valid_e2ee_params(&params) else {
        return (StatusCode::BAD_REQUEST, "Schlüsselparameter ungültig").into_response();
    };
    {
        let st = app.hub.store.lock().unwrap_or_else(|e| e.into_inner());
        if st.role(&space, &me.id).ok().flatten().as_deref() != Some("owner") {
            return (StatusCode::FORBIDDEN, "Nur Besitzer des Space können die Verschlüsselung einrichten").into_response();
        }
        if let Err(e) = st.set_space_e2ee(&space, Some(&params)) {
            return (StatusCode::CONFLICT, e.to_string()).into_response();
        }
        st.audit(&me.id, &client_ip(&h), "space.e2ee", &space);
    }
    app.hub.drop_space(&space);
    let n = app.hub.kick_where(|k| k.spaces.contains_key(&space));
    info!(by = me.id, space, kicked = n, "Ende-zu-Ende-Verschlüsselung eingerichtet");
    StatusCode::NO_CONTENT.into_response()
}

async fn members(State(app): State<App>, h: HeaderMap, Path(space): Path<String>) -> Response {
    if let Err(c) = require_role(&app, &h, &space, false) {
        return c.into_response();
    }
    match app.hub.store.lock().unwrap_or_else(|e| e.into_inner()).members(&space) {
        Ok(m) => Json(m).into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

async fn status(State(app): State<App>, h: HeaderMap) -> Response {
    if let Err(c) = auth(&app, &h) {
        return c.into_response();
    }
    let stats = app.hub.store.lock().unwrap_or_else(|e| e.into_inner()).stats().unwrap_or_default();
    Json(serde_json::json!({ "live": app.hub.status(), "store": stats, "rss_kib": rss_kib() })).into_response()
}

pub fn rss_kib() -> Option<u64> {
    let s = std::fs::read_to_string("/proc/self/status").ok()?;
    s.lines().find(|l| l.starts_with("VmRSS:"))?.split_whitespace().nth(1)?.parse().ok()
}

fn valid_hash(h: &str) -> bool {
    h.len() == 64 && h.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

fn blob_path(app: &App, space: &str, hash: &str) -> PathBuf {
    app.blob_dir.join(space).join(&hash[..2]).join(hash)
}

async fn blob_head(State(app): State<App>, h: HeaderMap, Path((space, hash)): Path<(String, String)>) -> StatusCode {
    if let Err(c) = require_role(&app, &h, &space, false) {
        return c;
    }
    if !valid_hash(&hash) || !codec::valid_id(&space) {
        return StatusCode::BAD_REQUEST;
    }
    if blob_path(&app, &space, &hash).exists() { StatusCode::OK } else { StatusCode::NOT_FOUND }
}

async fn blob_get(State(app): State<App>, h: HeaderMap, Path((space, hash)): Path<(String, String)>) -> Response {
    if let Err(c) = require_role(&app, &h, &space, false) {
        return c.into_response();
    }
    if !valid_hash(&hash) || !codec::valid_id(&space) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    match open_blob(&app, &space, &hash).await {
        Some((len, body)) => (
            [
                (header::CONTENT_TYPE, "application/octet-stream".to_string()),
                (header::CACHE_CONTROL, "private, max-age=31536000, immutable".to_string()),
                (header::CONTENT_LENGTH, len.to_string()),
            ],
            body,
        )
            .into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

/// Anhang zum Streamen öffnen: (Größe, Body). Der Inhalt wird stückweise gelesen, nie ganz in den RAM.
pub async fn open_blob(app: &App, space: &str, hash: &str) -> Option<(u64, Body)> {
    if !valid_hash(hash) || !codec::valid_id(space) {
        return None;
    }
    let file = tokio::fs::File::open(blob_path(app, space, hash)).await.ok()?;
    let len = file.metadata().await.ok()?.len();
    app.hub.metrics.blob_down(len);
    Some((len, file_body(file)))
}

fn file_body(file: tokio::fs::File) -> Body {
    use tokio::io::AsyncReadExt;
    let stream = futures_util::stream::unfold(file, |mut f| async move {
        let mut buf = vec![0u8; 64 << 10];
        match f.read(&mut buf).await {
            Ok(0) => None,
            Ok(n) => {
                buf.truncate(n);
                Some((Ok::<_, std::io::Error>(Bytes::from(buf)), f))
            }
            Err(e) => Some((Err(e), f)),
        }
    });
    Body::from_stream(stream)
}

async fn blob_put(State(app): State<App>, h: HeaderMap, Path((space, hash)): Path<(String, String)>, body: Body) -> Response {
    if let Err(c) = require_role(&app, &h, &space, true) {
        return c.into_response();
    }
    if !valid_hash(&hash) || !codec::valid_id(&space) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    match receive_blob(&app, &space, Some(&hash), body).await {
        Ok(_) => StatusCode::CREATED.into_response(),
        Err((code, msg)) => (code, msg).into_response(),
    }
}

/// Anhang streamend annehmen: Stück für Stück in eine Temp-Datei schreiben und dabei hashen, dann atomar
/// unter dem Hash ablegen und in der Datenbank vermerken. Der RAM-Bedarf ist unabhängig von der Dateigröße
/// (vorher lag der ganze Upload – kurzzeitig doppelt – im Speicher; große PDFs sprengten so das 128-MiB-Limit).
/// `expected`: vom Client angegebener Hash, muss passen. Liefert (Hash, Größe).
pub async fn receive_blob(app: &App, space: &str, expected: Option<&str>, body: Body) -> Result<(String, u64), (StatusCode, &'static str)> {
    use sha2::{Digest, Sha256};
    use tokio::io::AsyncWriteExt;
    if !codec::valid_id(space) || expected.is_some_and(|h| !valid_hash(h)) {
        return Err((StatusCode::BAD_REQUEST, "Space oder Hash ungültig"));
    }
    let dir = app.blob_dir.join(space);
    let internal = |e: std::io::Error| {
        warn!(space, "Blob speichern: {e}");
        (StatusCode::INTERNAL_SERVER_ERROR, "Speichern fehlgeschlagen")
    };
    tokio::fs::create_dir_all(&dir).await.map_err(internal)?;
    // Eindeutiger Temp-Name: gleiche Inhalte können gleichzeitig hochgeladen werden (zwei Dateien, ein Hash).
    let tmp = dir.join(format!(".upload.{}.tmp", crate::db::random_token(8)));
    let res: Result<(String, u64), (StatusCode, &'static str)> = async {
        let file = tokio::fs::File::create(&tmp).await.map_err(internal)?;
        let mut out = tokio::io::BufWriter::with_capacity(256 << 10, file);
        let mut hasher = Sha256::new();
        let mut size: u64 = 0;
        let mut stream = body.into_data_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| (StatusCode::BAD_REQUEST, "Upload abgebrochen"))?;
            size += chunk.len() as u64;
            if size > MAX_BLOB as u64 {
                return Err((StatusCode::PAYLOAD_TOO_LARGE, "Anhang zu groß"));
            }
            hasher.update(&chunk);
            out.write_all(&chunk).await.map_err(internal)?;
        }
        out.flush().await.map_err(internal)?;
        out.into_inner().sync_all().await.map_err(internal)?;
        Ok((hex::encode(hasher.finalize()), size))
    }
    .await;
    let (hash, size) = match res {
        Ok(v) => v,
        Err(e) => {
            let _ = tokio::fs::remove_file(&tmp).await;
            return Err(e);
        }
    };
    if expected.is_some_and(|h| h != hash) {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err((StatusCode::BAD_REQUEST, "Hash stimmt nicht"));
    }
    let path = blob_path(app, space, &hash);
    if path.exists() {
        let _ = tokio::fs::remove_file(&tmp).await;
    } else {
        let res = async {
            tokio::fs::create_dir_all(path.parent().unwrap()).await?;
            tokio::fs::rename(&tmp, &path).await
        }
        .await;
        if let Err(e) = res {
            let _ = tokio::fs::remove_file(&tmp).await;
            // Ein paralleler Upload desselben Inhalts war schneller → kein Fehler.
            if !path.exists() {
                return Err(internal(e));
            }
        }
    }
    let _ = app.hub.store.lock().unwrap_or_else(|e| e.into_inner()).add_blob(space, &hash, size as i64);
    app.hub.metrics.blob_up(size);
    Ok((hash, size))
}

async fn history_list(State(app): State<App>, h: HeaderMap, Path((space, doc)): Path<(String, String)>) -> Response {
    if let Err(c) = require_role(&app, &h, &space, false) {
        return c.into_response();
    }
    let name = format!("{space}/{doc}");
    if codec::split_doc(&name).is_none() {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let list = app.hub.store.lock().unwrap_or_else(|e| e.into_inner()).snapshots(&name).unwrap_or_default();
    Json(list.into_iter().map(|(ts, size)| serde_json::json!({ "ts": ts, "size": size })).collect::<Vec<_>>()).into_response()
}

async fn history_get(State(app): State<App>, h: HeaderMap, Path((space, doc, ts)): Path<(String, String, i64)>) -> Response {
    if let Err(c) = require_role(&app, &h, &space, false) {
        return c.into_response();
    }
    let name = format!("{space}/{doc}");
    if codec::split_doc(&name).is_none() {
        return StatusCode::BAD_REQUEST.into_response();
    }
    match app.hub.store.lock().unwrap_or_else(|e| e.into_inner()).snapshot(&name, ts) {
        Ok(Some(d)) => ([(header::CONTENT_TYPE, "application/octet-stream")], d).into_response(),
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

#[cfg(test)]
mod client_version_tests {
    use super::*;
    const V: &str = env!("CARGO_PKG_VERSION");

    #[test]
    fn nur_passendes_plugin() {
        assert!(check_client(Some(&format!("tandem-plugin/{V}"))).is_ok());
        assert!(check_client(Some("tandem-plugin/0.0.1")).unwrap_err().contains("0.0.1"));
        assert!(check_client(None).unwrap_err().contains("vor 0.8.2"));
        assert!(check_client(Some("")).is_err());
        assert!(check_client(Some("tandem-plugin/")).is_err());
    }

    #[test]
    fn andere_clients_frei() {
        assert!(check_client(Some("lernplattform")).is_ok());
    }

    #[test]
    fn http_nur_plugin() {
        assert!(check_plugin(Some(V)).is_ok());
        assert!(check_plugin(None).is_err());
        assert!(check_plugin(Some("0.0.1")).is_err());
    }
}
