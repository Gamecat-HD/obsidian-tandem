//! Admin-Oberfläche: statische Seite unter /admin/ und JSON-API unter /admin/api/ (siehe docs/ADMIN.md).
//!
//! Sicherheit: Sitzung nur per `__Host-`-Cookie (HttpOnly, Secure, SameSite=Strict), Anmeldung mit
//! Passwort (Argon2id) + TOTP, CSRF-Schutz über Pflicht-Header und Origin-Prüfung, strenge CSP,
//! Bremsen gegen Durchprobieren, Audit-Log jeder Änderung.

use crate::auth;
use crate::codec;
use crate::db::{self, User, now, sha256_hex};
use crate::hub::HubError;
use crate::server::{App, client_ip};
use crate::vault::{self, Entry};
use crate::webauthn;
use axum::body::Body;
use axum::extract::{DefaultBodyLimit, Path, Query, Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tokio::sync::Semaphore;
use tracing::info;
use yrs::{Any, Transact};

mod backups;

mod ui {
    include!(concat!(env!("OUT_DIR"), "/admin_ui.rs"));
}

const COOKIE: &str = "__Host-tandem-admin";
const PAGE_CSP: &str = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self'; \
connect-src 'self'; frame-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
/// Für Dateien aus dem Vault: in einer Sandbox ohne Skripte (schützt z. B. vor SVG mit JavaScript).
pub(crate) const RAW_CSP: &str = "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'";
const MAX_TEXT: usize = 5 << 20;

/// Zwischenstand nach richtigem Passwort: wartet auf den zweiten Faktor.
struct Ticket {
    user: String,
    expires: Instant,
    tries: u32,
    /// WebAuthn-Challenge für die Anmeldung per Passkey
    challenge: Vec<u8>,
}

pub struct AdminState {
    /// IP → (Fehlversuche, Beginn des Fensters)
    fails: Mutex<HashMap<String, (u32, Instant)>>,
    /// sha256(Ticket) → Zwischenstand der Anmeldung (5 min, höchstens 5 Versuche)
    tickets: Mutex<HashMap<String, Ticket>>,
    /// Sitzungs-ID → Challenge zum Einrichten eines Passkeys (5 min)
    reg: Mutex<HashMap<String, (Vec<u8>, Instant)>>,
    /// Argon2 braucht ~19 MiB pro Lauf – nie mehrere gleichzeitig (128-MiB-Container).
    argon: Semaphore,
    /// Entwicklung: UI-Dateien bei jeder Anfrage von hier lesen statt eingebettet.
    ui_dir: Option<std::path::PathBuf>,
}

impl AdminState {
    pub fn new() -> Self {
        Self {
            fails: Mutex::default(),
            tickets: Mutex::default(),
            reg: Mutex::default(),
            argon: Semaphore::new(1),
            ui_dir: std::env::var_os("TANDEM_ADMIN_UI_DIR").map(Into::into),
        }
    }
}

pub fn enabled() -> bool {
    !matches!(std::env::var("TANDEM_ADMIN").as_deref(), Ok("off" | "0" | "false"))
}

pub fn router() -> Router<App> {
    let api = Router::new()
        .route("/me", get(me))
        // Ohne Anmeldung erreichbar → kleine Bodies (der globale Grenzwert ist 100 MiB für Anhänge).
        .route("/login", post(login).layer(DefaultBodyLimit::max(16 << 10)))
        .route("/login/totp", post(login_totp).layer(DefaultBodyLimit::max(16 << 10)))
        .route("/login/passkey", post(login_passkey).layer(DefaultBodyLimit::max(16 << 10)))
        .route("/passkeys", get(passkeys_list).post(passkey_add))
        .route("/passkeys/options", post(passkey_options))
        .route("/passkeys/{id}", axum::routing::delete(passkey_remove))
        .route("/logout", post(logout))
        .route("/setup/start", post(setup_start).layer(DefaultBodyLimit::max(16 << 10)))
        .route("/setup/finish", post(setup_finish).layer(DefaultBodyLimit::max(16 << 10)))
        .route("/setup/check", post(setup_check).layer(DefaultBodyLimit::max(16 << 10)))
        .route("/sessions", get(sessions))
        .route("/sessions/end-others", post(end_others))
        .route("/overview", get(overview))
        .route("/audit", get(audit_list))
        .route("/users", get(users).post(user_add))
        .route("/users/{id}", axum::routing::patch(user_patch).delete(user_delete))
        .route("/users/{id}/invite", post(user_invite))
        .route("/users/{id}/service", post(user_to_service))
        .route("/services", get(services).post(service_add))
        .route("/services/{id}/token", post(service_token))
        .route("/devices/{id}/revoke", post(device_revoke))
        .route("/devices/{id}/unrevoke", post(device_unrevoke))
        .route("/devices/{id}/space", post(device_assign))
        .route("/devices/{id}", axum::routing::delete(device_delete))
        .route("/devices/cleanup", post(devices_cleanup))
        .route("/stats", get(stats))
        .route("/backups", get(backups::list).post(backups::create))
        .route("/backups/settings", put(backups::settings))
        .route("/backups/{name}", axum::routing::delete(backups::delete))
        .route("/backups/{name}/download", get(backups::download))
        .route("/backups/{name}/restore", post(backups::restore))
        .route("/backups/{name}/spaces", get(backups::spaces))
        .route("/backups/{name}/spaces/{space}/files", get(backups::files))
        .route("/backups/{name}/spaces/{space}/docs/{doc}", get(backups::doc))
        .route("/backups/{name}/spaces/{space}/export", get(backups::export_backup))
        .route("/backups/{name}/spaces/{space}/raw/{doc}", get(backups::raw))
        .route("/spaces/{space}/export", get(backups::export_live))
        .route("/spaces", get(spaces).post(space_add))
        .route("/spaces/{space}", axum::routing::patch(space_patch).delete(space_delete))
        .route("/spaces/{space}/members/{user}", put(member_set).delete(member_remove))
        .route("/spaces/{space}/files", get(files).post(file_create))
        .route("/spaces/{space}/docs/{doc}", get(doc_get).put(doc_put))
        .route("/spaces/{space}/upload", post(upload))
        .route("/spaces/{space}/move", post(file_move))
        .route("/spaces/{space}/delete", post(file_delete))
        .route("/spaces/{space}/undelete", post(file_undelete))
        .route("/spaces/{space}/raw/{doc}", get(raw))
        .route("/spaces/{space}/search", get(search))
        .route("/spaces/{space}/history/{doc}", get(history_list))
        .route("/spaces/{space}/history/{doc}/{ts}", get(history_get))
        .route("/spaces/{space}/history/{doc}/{ts}/restore", post(history_restore))
        .fallback(|| async { E(StatusCode::NOT_FOUND, "Unbekannter Pfad".into()) })
        .layer(middleware::from_fn(csrf_guard));
    Router::new()
        .route("/admin", get(|| async { Redirect::permanent("/admin/") }))
        .route("/admin/", get(|s: State<App>, h: HeaderMap, u: axum::http::Uri| static_file(s, h, u, "index.html")))
        .route("/admin/app.css", get(|s: State<App>, h: HeaderMap, u: axum::http::Uri| static_file(s, h, u, "app.css")))
        .route("/admin/app.js", get(|s: State<App>, h: HeaderMap, u: axum::http::Uri| static_file(s, h, u, "app.js")))
        .nest("/admin/api", api)
        .layer(middleware::from_fn(security_headers))
}

// ── Middleware ───────────────────────────────────────────────────────

async fn security_headers(req: Request, next: Next) -> Response {
    let https = req.headers().get("x-forwarded-proto").and_then(|v| v.to_str().ok()) == Some("https");
    let api = req.uri().path().starts_with("/admin/api/");
    let mut res = next.run(req).await;
    let h = res.headers_mut();
    h.entry(header::CONTENT_SECURITY_POLICY).or_insert(HeaderValue::from_static(PAGE_CSP));
    h.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    h.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("SAMEORIGIN"));
    h.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    h.insert("cross-origin-opener-policy", HeaderValue::from_static("same-origin"));
    h.insert("cross-origin-resource-policy", HeaderValue::from_static("same-origin"));
    h.insert("permissions-policy", HeaderValue::from_static("camera=(), microphone=(), geolocation=(), interest-cohort=()"));
    if https {
        h.insert(header::STRICT_TRANSPORT_SECURITY, HeaderValue::from_static("max-age=31536000"));
    }
    if api {
        h.entry(header::CACHE_CONTROL).or_insert(HeaderValue::from_static("no-store"));
    }
    res
}

/// Schreibende Anfragen nur mit `X-Tandem-Admin: 1` (erzwingt bei fremden Seiten einen CORS-Preflight,
/// den wir nie erlauben) und – falls vorhanden – passendem `Origin`.
async fn csrf_guard(req: Request, next: Next) -> Response {
    if !matches!(*req.method(), Method::GET | Method::HEAD) {
        let h = req.headers();
        if h.get("x-tandem-admin").and_then(|v| v.to_str().ok()) != Some("1") {
            return E(StatusCode::FORBIDDEN, "Anfrage abgelehnt (Header fehlt)".into()).into_response();
        }
        if let Some(origin) = h.get(header::ORIGIN).and_then(|v| v.to_str().ok()) {
            let host = h.get(header::HOST).and_then(|v| v.to_str().ok()).unwrap_or("");
            let o = origin.strip_prefix("https://").or_else(|| origin.strip_prefix("http://")).unwrap_or("");
            if o.is_empty() || o != host {
                return E(StatusCode::FORBIDDEN, "Anfrage abgelehnt (fremde Herkunft)".into()).into_response();
            }
        }
    }
    next.run(req).await
}

fn ui_source(app: &App, name: &str) -> String {
    match &app.admin.ui_dir {
        Some(dir) => std::fs::read_to_string(dir.join(name)).unwrap_or_default(),
        None => match name {
            "index.html" => ui::INDEX_HTML,
            "app.css" => ui::APP_CSS,
            _ => ui::APP_JS,
        }
        .to_string(),
    }
}

fn short_hash(s: &str) -> String {
    sha256_hex(s.as_bytes())[..16].to_string()
}

/// Statische Dateien. Cloudflare überschreibt `no-cache` bei .js/.css mit seiner Browser-Cache-TTL (4 h) –
/// darum verweist index.html auf `app.js?v=<Hash>`: jede neue Fassung hat eine neue Adresse, versionierte
/// Abrufe dürfen dauerhaft gecacht werden. index.html selbst wird immer neu geprüft.
async fn static_file(State(app): State<App>, h: HeaderMap, uri: axum::http::Uri, name: &'static str) -> Response {
    let mut body = ui_source(&app, name);
    if name == "index.html" {
        for asset in ["app.css", "app.js"] {
            let v = short_hash(&ui_source(&app, asset));
            body = body.replace(&format!("\"./{asset}\""), &format!("\"./{asset}?v={v}\""));
        }
    }
    let etag = format!("\"{}\"", short_hash(&body));
    let ct = match name {
        "index.html" => "text/html; charset=utf-8",
        "app.css" => "text/css; charset=utf-8",
        _ => "text/javascript; charset=utf-8",
    };
    // Nur die passende Version dauerhaft cachen (eine veraltete ?v= aus einem alten index.html nicht festnageln).
    let versioned = name != "index.html"
        && uri.query().and_then(|q| q.strip_prefix("v=")).is_some_and(|v| v == short_hash(&body))
        && app.admin.ui_dir.is_none();
    let cc = if versioned { "public, max-age=31536000, immutable" } else { "no-cache" };
    let cache = [(header::CACHE_CONTROL, cc), (header::ETAG, etag.as_str())];
    if h.get(header::IF_NONE_MATCH).and_then(|v| v.to_str().ok()) == Some(etag.as_str()) {
        return (StatusCode::NOT_MODIFIED, cache).into_response();
    }
    (cache, [(header::CONTENT_TYPE, ct)], body).into_response()
}

// ── Fehler, Sitzung ──────────────────────────────────────────────────

pub struct E(StatusCode, String);

impl IntoResponse for E {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "error": self.1 }))).into_response()
    }
}

impl From<anyhow::Error> for E {
    fn from(e: anyhow::Error) -> Self {
        E(StatusCode::BAD_REQUEST, e.to_string())
    }
}

impl From<HubError> for E {
    fn from(e: HubError) -> Self {
        match e {
            HubError::Forbidden => E(StatusCode::FORBIDDEN, "kein Zugriff".into()),
            HubError::E2ee => E(StatusCode::CONFLICT, "Dieser Vault ist Ende-zu-Ende-verschlüsselt – Inhalte sind nur in Obsidian lesbar".into()),
            HubError::BadRequest(m) => E(StatusCode::BAD_REQUEST, m.into()),
            HubError::Internal(m) => {
                tracing::warn!("Admin: interner Fehler: {m}");
                E(StatusCode::INTERNAL_SERVER_ERROR, "interner Fehler".into())
            }
        }
    }
}

fn bad(msg: impl Into<String>) -> E {
    E(StatusCode::BAD_REQUEST, msg.into())
}
fn not_found(msg: impl Into<String>) -> E {
    E(StatusCode::NOT_FOUND, msg.into())
}
fn conflict(msg: impl Into<String>) -> E {
    E(StatusCode::CONFLICT, msg.into())
}

type R = Result<Response, E>;

/// Angemeldete Person samt Herkunft.
struct Ctx {
    user: User,
    sid: String,
    ip: String,
    expires: i64,
}

fn cookie_token(h: &HeaderMap) -> Option<String> {
    for v in h.get_all(header::COOKIE) {
        for part in v.to_str().ok()?.split(';') {
            if let Some(t) = part.trim().strip_prefix(&format!("{COOKIE}=")) {
                return Some(t.to_string());
            }
        }
    }
    None
}

fn ctx(app: &App, h: &HeaderMap) -> Result<Ctx, E> {
    let unauth = || E(StatusCode::UNAUTHORIZED, "Bitte anmelden".into());
    let t = cookie_token(h).ok_or_else(unauth)?;
    let (user, sid, expires) = app.hub.store.lock().unwrap_or_else(|e| e.into_inner()).session(&t).ok().flatten().ok_or_else(unauth)?;
    Ok(Ctx { user, sid, ip: client_ip(h), expires })
}

fn session_cookie(token: &str) -> String {
    format!("{COOKIE}={token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age={}", db::SESSION_MAX)
}

fn audit(app: &App, c: &Ctx, action: &str, detail: impl AsRef<str>) {
    app.hub.store.lock().unwrap_or_else(|e| e.into_inner()).audit(&c.user.id, &c.ip, action, detail.as_ref());
    info!(admin = c.user.id, action, detail = detail.as_ref(), "Admin");
}

fn me_json(c: &Ctx) -> Value {
    json!({ "user": c.user, "session": c.sid, "expires": c.expires })
}

// ── Anmeldung ────────────────────────────────────────────────────────

const IP_WINDOW: Duration = Duration::from_secs(15 * 60);
const IP_MAX_FAILS: u32 = 10;

fn ip_blocked(app: &App, ip: &str) -> bool {
    let mut f = app.admin.fails.lock().unwrap_or_else(|e| e.into_inner());
    let now = Instant::now();
    f.retain(|_, (_, t)| now.duration_since(*t) < IP_WINDOW);
    f.get(ip).is_some_and(|(n, _)| *n >= IP_MAX_FAILS)
}

fn ip_failed(app: &App, ip: &str) {
    let mut f = app.admin.fails.lock().unwrap_or_else(|e| e.into_inner());
    f.entry(ip.to_string()).or_insert((0, Instant::now())).0 += 1;
}

/// Argon2 nacheinander; wer länger als 5 s warten müsste, bekommt 429 (gegen aufgestaute Anfragen).
async fn argon_permit(app: &App) -> Result<tokio::sync::SemaphorePermit<'_>, E> {
    match tokio::time::timeout(Duration::from_secs(5), app.admin.argon.acquire()).await {
        Ok(Ok(p)) => Ok(p),
        _ => Err(E(StatusCode::TOO_MANY_REQUESTS, "Server ausgelastet – bitte gleich erneut versuchen".into())),
    }
}

async fn argon_verify(app: &App, pw: String, hash: String) -> Result<bool, E> {
    let _permit = argon_permit(app).await?;
    Ok(tokio::task::spawn_blocking(move || auth::verify_password(&pw, &hash)).await.unwrap_or(false))
}

async fn me(State(app): State<App>, h: HeaderMap) -> R {
    let c = ctx(&app, &h)?;
    Ok(Json(me_json(&c)).into_response())
}

#[derive(Deserialize)]
struct LoginReq {
    user: String,
    password: String,
}

const TICKET_TTL: Duration = Duration::from_secs(5 * 60);
const TICKET_TRIES: u32 = 5;

fn login_failed(app: &App, ip: &str, uid: &str, why: &str) -> E {
    ip_failed(app, ip);
    let st = app.hub.store.lock().unwrap_or_else(|e| e.into_inner());
    st.audit(uid, ip, "login.failed", why);
    tracing::warn!(user = uid, ip, why, "Admin-Anmeldung fehlgeschlagen");
    E(StatusCode::UNAUTHORIZED, "Anmeldung fehlgeschlagen: Kennung oder Passwort stimmt nicht.".into())
}

fn locked(cred_locked_until: i64) -> Option<E> {
    (cred_locked_until > now()).then(|| {
        let mins = ((cred_locked_until - now()) as f64 / 60.0).ceil().max(1.0) as i64;
        E(StatusCode::TOO_MANY_REQUESTS, format!("Zu viele Fehlversuche – bitte in {mins} min erneut versuchen"))
    })
}

fn rp(h: &HeaderMap) -> webauthn::Rp {
    let host = h.get(header::HOST).and_then(|v| v.to_str().ok()).unwrap_or("localhost");
    webauthn::Rp::from(std::env::var("TANDEM_PUBLIC_URL").ok().as_deref().filter(|u| !u.is_empty()), host)
}

/// Schritt 1: Kennung + Passwort. Bei Erfolg gibt es ein kurzlebiges Ticket für den zweiten Faktor
/// (TOTP-Code oder Passkey) – noch keine Sitzung.
async fn login(State(app): State<App>, h: HeaderMap, Json(req): Json<LoginReq>) -> R {
    let ip = client_ip(&h);
    if ip_blocked(&app, &ip) {
        return Err(E(StatusCode::TOO_MANY_REQUESTS, "Zu viele Fehlversuche – bitte später erneut versuchen".into()));
    }
    let uid = req.user.trim().to_lowercase();
    if req.password.len() > 1024 || uid.len() > 64 {
        return Err(login_failed(&app, &ip, &uid, "Eingabe zu lang"));
    }
    let cred = app.hub.store.lock().unwrap_or_else(|e| e.into_inner()).admin_cred(&uid)?;
    let Some(cred) = cred else {
        // Gleiche Arbeit wie bei einem echten Konto, damit die Antwortzeit nichts verrät.
        argon_verify(&app, req.password, auth::DUMMY_HASH.clone()).await?;
        return Err(login_failed(&app, &ip, &uid, "unbekannte Kennung"));
    };
    if let Some(e) = locked(cred.locked_until) {
        ip_failed(&app, &ip);
        return Err(e);
    }
    if !argon_verify(&app, req.password, cred.pw_hash.clone()).await? {
        let _ = app.hub.store.lock().unwrap_or_else(|e| e.into_inner()).admin_login_failed(&cred.user_id);
        return Err(login_failed(&app, &ip, &uid, "Passwort falsch"));
    }
    let ticket = crate::db::random_token(32);
    let challenge = webauthn::challenge();
    let keys = app.hub.store.lock().unwrap_or_else(|e| e.into_inner()).passkeys(&cred.user_id)?;
    {
        let mut t = app.admin.tickets.lock().unwrap_or_else(|e| e.into_inner());
        let now_i = Instant::now();
        t.retain(|_, v| v.expires > now_i);
        t.insert(sha256_hex(ticket.as_bytes()), Ticket { user: cred.user_id.clone(), expires: now_i + TICKET_TTL, tries: 0, challenge: challenge.clone() });
    }
    let passkey = (!keys.is_empty()).then(|| {
        json!({
            "challenge": webauthn::b64url(&challenge),
            "rpId": rp(&h).id,
            "timeout": 120000,
            "userVerification": "required",
            "allowCredentials": keys.iter().map(|k| json!({ "type": "public-key", "id": k.0 })).collect::<Vec<_>>(),
        })
    });
    let mut methods = vec!["totp"];
    if passkey.is_some() {
        methods.insert(0, "passkey");
    }
    Ok(Json(json!({ "ticket": ticket, "methods": methods, "passkey": passkey })).into_response())
}

/// Ticket nachschlagen (ohne es zu verbrauchen). Ungültig/abgelaufen → 401, Schritt 1 wiederholen.
fn ticket_user(app: &App, ticket: &str) -> Result<(String, String, Vec<u8>), E> {
    let key = sha256_hex(ticket.as_bytes());
    let t = app.admin.tickets.lock().unwrap_or_else(|e| e.into_inner());
    match t.get(&key) {
        Some(v) if v.expires > Instant::now() => Ok((key, v.user.clone(), v.challenge.clone())),
        _ => Err(E(StatusCode::UNAUTHORIZED, "Anmeldung abgelaufen – bitte noch einmal mit Passwort anmelden".into())),
    }
}

/// Fehlversuch im zweiten Schritt: zählt fürs Konto und die IP; nach 5 Versuchen ist das Ticket verbraucht.
fn second_factor_failed(app: &App, ip: &str, key: &str, uid: &str, why: &str) -> E {
    {
        let mut t = app.admin.tickets.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(v) = t.get_mut(key) {
            v.tries += 1;
            if v.tries >= TICKET_TRIES {
                t.remove(key);
            }
        }
    }
    ip_failed(app, ip);
    let st = app.hub.store.lock().unwrap_or_else(|e| e.into_inner());
    let _ = st.admin_login_failed(uid);
    st.audit(uid, ip, "login.failed", why);
    tracing::warn!(user = uid, ip, why, "Admin-Anmeldung (2. Faktor) fehlgeschlagen");
    E(StatusCode::UNAUTHORIZED, format!("{why}."))
}

/// Ticket verbrauchen und die Sitzung anlegen.
fn finish_login(app: &App, h: &HeaderMap, key: &str, uid: &str, ip: &str, how: &str) -> R {
    app.admin.tickets.lock().unwrap_or_else(|e| e.into_inner()).remove(key);
    let agent = h.get(header::USER_AGENT).and_then(|v| v.to_str().ok()).unwrap_or("");
    let token = app.hub.store.lock().unwrap_or_else(|e| e.into_inner()).create_session(uid, ip, agent)?;
    let mut hh = HeaderMap::new();
    hh.insert(header::COOKIE, HeaderValue::from_str(&format!("{COOKIE}={token}")).unwrap());
    let mut c = ctx(app, &hh)?;
    c.ip = ip.to_string();
    audit(app, &c, "login", format!("{agent} [{how}]"));
    Ok(([(header::SET_COOKIE, session_cookie(&token))], Json(me_json(&c))).into_response())
}

#[derive(Deserialize)]
struct TotpReq {
    ticket: String,
    code: String,
}

/// Schritt 2a: sechsstelliger Code aus der Authenticator-App.
async fn login_totp(State(app): State<App>, h: HeaderMap, Json(req): Json<TotpReq>) -> R {
    let ip = client_ip(&h);
    if ip_blocked(&app, &ip) {
        return Err(E(StatusCode::TOO_MANY_REQUESTS, "Zu viele Fehlversuche – bitte später erneut versuchen".into()));
    }
    let (key, uid, _) = ticket_user(&app, &req.ticket)?;
    let cred = app.hub.store.lock().unwrap_or_else(|e| e.into_inner()).admin_cred(&uid)?.ok_or_else(|| E(StatusCode::UNAUTHORIZED, "Zugang nicht mehr vorhanden".into()))?;
    if let Some(e) = locked(cred.locked_until) {
        return Err(e);
    }
    let Some(step) = auth::verify_totp(&cred.totp_secret, &req.code, cred.totp_last, now()) else {
        return Err(second_factor_failed(&app, &ip, &key, &uid, "Code stimmt nicht – jeder Code gilt nur einmal, ggf. den nächsten abwarten"));
    };
    // Bedingt speichern: zwei gleichzeitige Anmeldungen mit demselben Code → nur eine gewinnt.
    if !app.hub.store.lock().unwrap_or_else(|e| e.into_inner()).admin_login_ok(&uid, Some(step))? {
        return Err(second_factor_failed(&app, &ip, &key, &uid, "Code wurde gerade schon benutzt – den nächsten abwarten"));
    }
    finish_login(&app, &h, &key, &uid, &ip, "Code")
}

#[derive(Deserialize)]
struct AssertionResp {
    #[serde(rename = "clientDataJSON")]
    client_data: String,
    #[serde(rename = "authenticatorData")]
    auth_data: String,
    signature: String,
}

#[derive(Deserialize)]
struct Assertion {
    id: String,
    response: AssertionResp,
}

#[derive(Deserialize)]
struct PasskeyLoginReq {
    ticket: String,
    credential: Assertion,
}

/// Schritt 2b: Passkey (WebAuthn-Assertion zur Challenge aus Schritt 1).
async fn login_passkey(State(app): State<App>, h: HeaderMap, Json(req): Json<PasskeyLoginReq>) -> R {
    let ip = client_ip(&h);
    if ip_blocked(&app, &ip) {
        return Err(E(StatusCode::TOO_MANY_REQUESTS, "Zu viele Fehlversuche – bitte später erneut versuchen".into()));
    }
    let (key, uid, challenge) = ticket_user(&app, &req.ticket)?;
    let cred = app.hub.store.lock().unwrap_or_else(|e| e.into_inner()).admin_cred(&uid)?.ok_or_else(|| E(StatusCode::UNAUTHORIZED, "Zugang nicht mehr vorhanden".into()))?;
    if let Some(e) = locked(cred.locked_until) {
        return Err(e);
    }
    let a = &req.credential;
    let pk = app.hub.store.lock().unwrap_or_else(|e| e.into_inner()).passkey(&uid, &a.id)?;
    let Some((cose, count)) = pk else {
        return Err(second_factor_failed(&app, &ip, &key, &uid, "Dieser Passkey gehört nicht zu deinem Zugang"));
    };
    let dec = |s: &str| webauthn::b64url_decode(s).ok_or_else(|| bad("Passkey-Antwort nicht lesbar"));
    let (cd, ad, sig) = (dec(&a.response.client_data)?, dec(&a.response.auth_data)?, dec(&a.response.signature)?);
    let new_count = match webauthn::verify(&cose, count, &cd, &ad, &sig, &challenge, &rp(&h)) {
        Ok(n) => n,
        Err(e) => return Err(second_factor_failed(&app, &ip, &key, &uid, &format!("Passkey abgelehnt: {e}"))),
    };
    {
        let st = app.hub.store.lock().unwrap_or_else(|e| e.into_inner());
        st.passkey_used(&a.id, new_count)?;
        st.admin_login_ok(&uid, None)?;
    }
    finish_login(&app, &h, &key, &uid, &ip, "Passkey")
}

// ── Passkeys verwalten (angemeldet) ──────────────────────────────────

async fn passkeys_list(State(app): State<App>, h: HeaderMap) -> R {
    let c = ctx(&app, &h)?;
    let list = app.hub.store.lock().unwrap_or_else(|e| e.into_inner()).passkeys(&c.user.id)?;
    Ok(Json(list.into_iter().map(|(id, name, created, last)| json!({ "id": id, "name": name, "created": created, "lastUsed": last })).collect::<Vec<_>>()).into_response())
}

/// Optionen für `navigator.credentials.create()`.
async fn passkey_options(State(app): State<App>, h: HeaderMap) -> R {
    let c = ctx(&app, &h)?;
    let challenge = webauthn::challenge();
    {
        let mut r = app.admin.reg.lock().unwrap_or_else(|e| e.into_inner());
        let now_i = Instant::now();
        r.retain(|_, v| v.1 > now_i);
        r.insert(c.sid.clone(), (challenge.clone(), now_i + TICKET_TTL));
    }
    let existing = app.hub.store.lock().unwrap_or_else(|e| e.into_inner()).passkeys(&c.user.id)?;
    let rp = rp(&h);
    let params: Vec<Value> = [webauthn::ES256, webauthn::EDDSA, webauthn::RS256].iter().map(|a| json!({ "type": "public-key", "alg": a })).collect();
    Ok(Json(json!({
        "challenge": webauthn::b64url(&challenge),
        "rp": { "id": rp.id, "name": "Tandem" },
        "user": { "id": webauthn::b64url(format!("tandem-admin:{}", c.user.id).as_bytes()), "name": c.user.id, "displayName": c.user.name },
        "pubKeyCredParams": params,
        "excludeCredentials": existing.iter().map(|k| json!({ "type": "public-key", "id": k.0 })).collect::<Vec<_>>(),
        "authenticatorSelection": { "residentKey": "preferred", "userVerification": "required" },
        "attestation": "none",
        "timeout": 120000,
    }))
    .into_response())
}

#[derive(Deserialize)]
struct AttestationResp {
    #[serde(rename = "clientDataJSON")]
    client_data: String,
    #[serde(rename = "attestationObject")]
    attestation: String,
}

#[derive(Deserialize)]
struct Attestation {
    response: AttestationResp,
}

#[derive(Deserialize)]
struct PasskeyAdd {
    name: String,
    credential: Attestation,
}

async fn passkey_add(State(app): State<App>, h: HeaderMap, Json(req): Json<PasskeyAdd>) -> R {
    let c = ctx(&app, &h)?;
    let challenge = app.admin.reg.lock().unwrap_or_else(|e| e.into_inner()).remove(&c.sid).filter(|v| v.1 > Instant::now()).map(|v| v.0);
    let Some(challenge) = challenge else { return Err(bad("Einrichtung abgelaufen – bitte erneut starten")) };
    let dec = |s: &str| webauthn::b64url_decode(s).ok_or_else(|| bad("Passkey-Antwort nicht lesbar"));
    let nc = webauthn::register(&dec(&req.credential.response.client_data)?, &dec(&req.credential.response.attestation)?, &challenge, &rp(&h))
        .map_err(|e| bad(format!("Passkey abgelehnt: {e}")))?;
    let name = req.name.trim().chars().take(60).collect::<String>();
    let name = if name.is_empty() { "Passkey".to_string() } else { name };
    let id = webauthn::b64url(&nc.id);
    app.hub.store.lock().unwrap_or_else(|e| e.into_inner()).add_passkey(&c.user.id, &id, &name, &nc.cose, nc.alg, nc.count)?;
    audit(&app, &c, "passkey.add", &name);
    Ok(Json(json!({ "id": id, "name": name })).into_response())
}

async fn passkey_remove(State(app): State<App>, h: HeaderMap, Path(id): Path<String>) -> R {
    let c = ctx(&app, &h)?;
    if !app.hub.store.lock().unwrap_or_else(|e| e.into_inner()).remove_passkey(&c.user.id, &id)? {
        return Err(not_found("Passkey nicht gefunden"));
    }
    audit(&app, &c, "passkey.remove", &id);
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn logout(State(app): State<App>, h: HeaderMap) -> R {
    if let Some(t) = cookie_token(&h) {
        if let Ok(c) = ctx(&app, &h) {
            audit(&app, &c, "logout", "");
        }
        app.hub.store.lock().unwrap_or_else(|e| e.into_inner()).delete_session(&t)?;
    }
    let clear = format!("{COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0");
    Ok((StatusCode::NO_CONTENT, [(header::SET_COOKIE, clear)]).into_response())
}

#[derive(Deserialize)]
struct SetupStart {
    code: String,
    password: String,
}

async fn setup_start(State(app): State<App>, h: HeaderMap, Json(req): Json<SetupStart>) -> R {
    let ip = client_ip(&h);
    if ip_blocked(&app, &ip) {
        return Err(E(StatusCode::TOO_MANY_REQUESTS, "Zu viele Fehlversuche – bitte später erneut versuchen".into()));
    }
    let row = app.hub.store.lock().unwrap_or_else(|e| e.into_inner()).admin_setup(&req.code)?;
    let Some((user, _, staged_secret, _)) = row else {
        ip_failed(&app, &ip);
        return Err(bad("Link ungültig oder abgelaufen – neuen Link mit „tandem-server admin setup <kennung>“ erzeugen"));
    };
    auth::check_password_policy(&req.password).map_err(bad)?;
    let hash = {
        let _permit = argon_permit(&app).await?;
        let pw = req.password.clone();
        tokio::task::spawn_blocking(move || auth::hash_password(&pw)).await.map_err(|e| anyhow::anyhow!("{e}"))??
    };
    // Schon einmal begonnen (z. B. Seite neu geladen)? Dann dasselbe Geheimnis – ein gescannter App-Eintrag bleibt gültig.
    let secret = staged_secret.unwrap_or_else(auth::new_totp_secret);
    app.hub.store.lock().unwrap_or_else(|e| e.into_inner()).admin_setup_stage(&req.code, &hash, &secret)?;
    let host = h.get(header::HOST).and_then(|v| v.to_str().ok()).unwrap_or("Tandem");
    let uri = auth::otpauth_uri(&secret, &user, &format!("Tandem {}", host.split(':').next().unwrap_or(host)));
    Ok(Json(json!({ "user": user, "secret": secret, "uri": uri, "qr": auth::qr_svg(&uri) })).into_response())
}

#[derive(Deserialize)]
struct SetupCheck {
    code: String,
}

/// Einrichtungslink vorab prüfen (vor der Passworteingabe): `{user, staged}` oder 400.
async fn setup_check(State(app): State<App>, h: HeaderMap, Json(req): Json<SetupCheck>) -> R {
    let ip = client_ip(&h);
    if ip_blocked(&app, &ip) {
        return Err(E(StatusCode::TOO_MANY_REQUESTS, "Zu viele Fehlversuche – bitte später erneut versuchen".into()));
    }
    let row = app.hub.store.lock().unwrap_or_else(|e| e.into_inner()).admin_setup(&req.code)?;
    let Some((user, _, staged, _)) = row else {
        ip_failed(&app, &ip);
        return Err(bad("Link ungültig oder abgelaufen – neuen Link mit „tandem-server admin setup <kennung>“ erzeugen"));
    };
    Ok(Json(json!({ "user": user, "staged": staged.is_some() })).into_response())
}

#[derive(Deserialize)]
struct SetupFinish {
    code: String,
    totp: String,
}

async fn setup_finish(State(app): State<App>, h: HeaderMap, Json(req): Json<SetupFinish>) -> R {
    let ip = client_ip(&h);
    if ip_blocked(&app, &ip) {
        return Err(E(StatusCode::TOO_MANY_REQUESTS, "Zu viele Fehlversuche – bitte später erneut versuchen".into()));
    }
    let token = {
        let mut st = app.hub.store.lock().unwrap_or_else(|e| e.into_inner());
        let Some((_, Some(_), Some(secret), _)) = st.admin_setup(&req.code)? else {
            ip_failed(&app, &ip);
            return Err(bad("Link ungültig oder abgelaufen"));
        };
        let Some(step) = auth::verify_totp(&secret, &req.totp, 0, now()) else {
            st.admin_setup_fail(&req.code)?;
            ip_failed(&app, &ip);
            return Err(bad("Code stimmt nicht – Uhrzeit des Handys prüfen und den aktuellen Code eingeben"));
        };
        let user = st.admin_setup_finish(&req.code, step)?;
        let agent = h.get(header::USER_AGENT).and_then(|v| v.to_str().ok()).unwrap_or("");
        st.create_session(&user, &ip, agent)?
    };
    let mut hh = HeaderMap::new();
    hh.insert(header::COOKIE, HeaderValue::from_str(&format!("{COOKIE}={token}")).unwrap());
    let mut c = ctx(&app, &hh)?;
    c.ip = ip;
    audit(&app, &c, "admin.setup", "Passwort und 2FA eingerichtet");
    Ok(([(header::SET_COOKIE, session_cookie(&token))], Json(me_json(&c))).into_response())
}

async fn sessions(State(app): State<App>, h: HeaderMap) -> R {
    let c = ctx(&app, &h)?;
    let mut list = app.hub.store.lock().unwrap_or_else(|e| e.into_inner()).sessions(&c.user.id)?;
    for s in &mut list {
        let cur = s["id"] == c.sid;
        s["current"] = json!(cur);
    }
    Ok(Json(list).into_response())
}

async fn end_others(State(app): State<App>, h: HeaderMap) -> R {
    let c = ctx(&app, &h)?;
    let n = app.hub.store.lock().unwrap_or_else(|e| e.into_inner()).end_sessions(&c.user.id, Some(&c.sid))?;
    audit(&app, &c, "sessions.end", format!("{n} beendet"));
    Ok(Json(json!({ "ended": n })).into_response())
}

// ── Übersicht ────────────────────────────────────────────────────────

async fn overview(State(app): State<App>, h: HeaderMap) -> R {
    ctx(&app, &h)?;
    let (stats, db_bytes, admins, attention, auto) = {
        let st = app.hub.store.lock().unwrap_or_else(|e| e.into_inner());
        let admins: Vec<Value> =
            st.admins()?.into_iter().map(|(u, c, l)| json!({ "user": u, "created": c, "lastLogin": l })).collect();
        (st.stats()?, st.db_bytes(), admins, st.attention()?, crate::backup::Settings::load(&st).auto)
    };
    let list = {
        let st = app.hub.store.lock().unwrap_or_else(|e| e.into_inner());
        crate::backup::list_labeled(&st, &backups::dir(&app))
    };
    let backup = json!({
        "auto": auto,
        "count": list.len(),
        "last": list.first(),
        "lastAuto": list.iter().find(|b| b.kind == "auto"),
    });
    Ok(Json(json!({
        "version": env!("CARGO_PKG_VERSION"),
        "startedAt": app.hub.metrics.started,
        "rssKib": crate::server::rss_kib(),
        "dbBytes": db_bytes,
        "store": stats,
        "online": with_paths(&app, app.hub.online(None)),
        "admins": admins,
        "backup": backup,
        "attention": attention,
    }))
    .into_response())
}

#[derive(Deserialize)]
struct Before {
    before: Option<i64>,
    /// Filter: Person (exakt), Aktion (Präfix, z. B. "file." oder "login.failed"), Text in Details, ab Zeitpunkt (Unix-s)
    user: Option<String>,
    action: Option<String>,
    q: Option<String>,
    since: Option<i64>,
}

/// Online-Einträge um `files: [{space, doc, path}]` ergänzen (geöffnete Dateien mit Pfad, ohne den Index).
fn with_paths(app: &App, mut online: Vec<Value>) -> Vec<Value> {
    let mut cache: HashMap<String, HashMap<String, String>> = HashMap::new();
    for o in &mut online {
        let docs: Vec<String> = o["docs"].as_array().map(|a| a.iter().filter_map(|d| d.as_str().map(str::to_string)).collect()).unwrap_or_default();
        let mut files = Vec::new();
        for d in docs {
            let Some((space, id)) = d.split_once('/') else { continue };
            if id == vault::INDEX {
                continue;
            }
            let map = cache
                .entry(space.to_string())
                .or_insert_with(|| read_index(app, space).unwrap_or_default().into_iter().filter(|e| !e.del).map(|e| (e.id, e.path)).collect());
            files.push(json!({ "space": space, "doc": id, "path": map.get(id) }));
        }
        o["files"] = json!(files);
    }
    online
}

async fn audit_list(State(app): State<App>, h: HeaderMap, Query(q): Query<Before>) -> R {
    ctx(&app, &h)?;
    let f = db::AuditFilter {
        user: q.user.filter(|s| !s.is_empty()),
        action: q.action.filter(|s| !s.is_empty()),
        q: q.q.filter(|s| !s.is_empty()).map(|s| s.chars().take(100).collect()),
        since: q.since,
    };
    Ok(Json(app.hub.store.lock().unwrap_or_else(|e| e.into_inner()).audit_log(q.before, 100, &f)?).into_response())
}

// ── Personen & Geräte ────────────────────────────────────────────────

async fn users(State(app): State<App>, h: HeaderMap) -> R {
    ctx(&app, &h)?;
    let online: Vec<Value> = app.hub.online(None);
    let st = app.hub.store.lock().unwrap_or_else(|e| e.into_inner());
    let admins: Vec<String> = st.admins()?.into_iter().map(|a| a.0).collect();
    let services: Vec<String> = st.services()?.into_iter().map(|u| u.id).collect();
    let mut out = Vec::new();
    for u in st.users()?.into_iter().filter(|u| !services.contains(&u.id)) {
        let mut devices = st.devices(&u.id)?;
        for d in &mut devices {
            let o = online.iter().find(|o| o["token"] == d["id"]);
            d["online"] = json!(o.is_some());
            d["rttMs"] = o.map(|o| o["rttMs"].clone()).unwrap_or(Value::Null);
        }
        out.push(json!({ "id": u.id, "name": u.name, "color": u.color, "admin": admins.contains(&u.id),
            "spaces": st.spaces_of(&u.id)?, "devices": devices }));
    }
    Ok(Json(out).into_response())
}

fn valid_color(c: &str) -> bool {
    c.len() == 7 && c.starts_with('#') && c[1..].bytes().all(|b| b.is_ascii_hexdigit())
}

fn clean_name(n: &str) -> Result<String, E> {
    let n = n.trim();
    if n.is_empty() || n.chars().count() > 64 || n.chars().any(char::is_control) {
        return Err(bad("Name: 1–64 Zeichen"));
    }
    Ok(n.to_string())
}

#[derive(Deserialize)]
struct UserAdd {
    id: String,
    name: String,
    color: Option<String>,
}

async fn user_add(State(app): State<App>, h: HeaderMap, Json(req): Json<UserAdd>) -> R {
    let c = ctx(&app, &h)?;
    let id = req.id.trim().to_lowercase();
    let name = clean_name(&req.name)?;
    if let Some(col) = &req.color {
        if !valid_color(col) {
            return Err(bad("Farbe als #rrggbb"));
        }
    }
    let u = {
        let st = app.hub.store.lock().unwrap_or_else(|e| e.into_inner());
        if st.user(&id)?.is_some() {
            return Err(conflict(format!("Eine Person mit der Kennung „{id}“ gibt es schon")));
        }
        st.add_user(&id, &name, req.color.as_deref()).map_err(|_| bad("Kennung: nur a-z, 0-9, _ und - (max. 64 Zeichen)"))?
    };
    audit(&app, &c, "user.add", &id);
    Ok(Json(u).into_response())
}

#[derive(Deserialize)]
struct UserPatch {
    name: Option<String>,
    color: Option<String>,
}

async fn user_patch(State(app): State<App>, h: HeaderMap, Path(id): Path<String>, Json(req): Json<UserPatch>) -> R {
    let c = ctx(&app, &h)?;
    let name = req.name.as_deref().map(clean_name).transpose()?;
    if req.color.as_deref().is_some_and(|c| !valid_color(c)) {
        return Err(bad("Farbe als #rrggbb"));
    }
    {
        let st = app.hub.store.lock().unwrap_or_else(|e| e.into_inner());
        st.user(&id)?.ok_or_else(|| not_found("Person nicht gefunden"))?;
        st.update_user(&id, name.as_deref(), req.color.as_deref())?;
    }
    audit(&app, &c, "user.edit", format!("{id} {}", serde_json::to_string(&json!({"name": name, "color": req.color})).unwrap_or_default()));
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn user_delete(State(app): State<App>, h: HeaderMap, Path(id): Path<String>) -> R {
    let c = ctx(&app, &h)?;
    if id == c.user.id {
        return Err(bad("Das eigene Konto kann nicht gelöscht werden"));
    }
    app.hub.store.lock().unwrap_or_else(|e| e.into_inner()).delete_user(&id)?;
    let n = app.hub.kick_where(|k| k.user.id == id);
    audit(&app, &c, "user.delete", format!("{id} ({n} Verbindungen getrennt)"));
    Ok(StatusCode::NO_CONTENT.into_response())
}

#[derive(Deserialize)]
struct InviteReq {
    hours: Option<i64>,
    /// Vault, für den das Gerät gilt
    space: Option<String>,
}

async fn user_invite(State(app): State<App>, h: HeaderMap, Path(id): Path<String>, Json(req): Json<InviteReq>) -> R {
    let c = ctx(&app, &h)?;
    let hours = req.hours.unwrap_or(72).clamp(1, 24 * 30);
    let code = {
        let st = app.hub.store.lock().unwrap_or_else(|e| e.into_inner());
        if st.is_service(&id)? {
            return Err(bad("Dienste bekommen keine Einladung – Token unter „Schnittstellen“ neu erzeugen"));
        }
        st.create_invite(&id, hours, req.space.as_deref())?
    };
    audit(&app, &c, "invite", format!("{id}, {hours} h{}", req.space.as_deref().map(|s| format!(", {s}")).unwrap_or_default()));
    Ok(Json(json!({ "code": code, "hours": hours, "space": req.space })).into_response())
}

#[derive(Deserialize)]
struct AssignReq {
    space: String,
}

/// Gerät einem Vault zuordnen; es verbindet sich neu und sieht danach nur noch diesen.
async fn device_assign(State(app): State<App>, h: HeaderMap, Path(id): Path<String>, Json(req): Json<AssignReq>) -> R {
    let c = ctx(&app, &h)?;
    check_space(&app, &req.space)?;
    let hash = app.hub.store.lock().unwrap_or_else(|e| e.into_inner()).assign_device(&id, &req.space)?;
    let n = app.hub.kick_where(|k| k.token == hash);
    audit(&app, &c, "device.assign", format!("{id} → {} ({n} Verbindungen neu)", req.space));
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn device_revoke(State(app): State<App>, h: HeaderMap, Path(id): Path<String>) -> R {
    let c = ctx(&app, &h)?;
    let hash = app.hub.store.lock().unwrap_or_else(|e| e.into_inner()).revoke_one(&id)?;
    let n = app.hub.kick_where(|k| k.token == hash);
    audit(&app, &c, "device.revoke", format!("{id} ({n} Verbindungen getrennt)"));
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn device_unrevoke(State(app): State<App>, h: HeaderMap, Path(id): Path<String>) -> R {
    let c = ctx(&app, &h)?;
    app.hub.store.lock().unwrap_or_else(|e| e.into_inner()).unrevoke(&id)?;
    audit(&app, &c, "device.unrevoke", &id);
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn device_delete(State(app): State<App>, h: HeaderMap, Path(id): Path<String>) -> R {
    let c = ctx(&app, &h)?;
    let hash = app.hub.store.lock().unwrap_or_else(|e| e.into_inner()).delete_device(&id)?;
    let n = app.hub.kick_where(|k| k.token == hash);
    audit(&app, &c, "device.delete", format!("{id} ({n} Verbindungen getrennt)"));
    Ok(StatusCode::NO_CONTENT.into_response())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CleanupReq {
    #[serde(default)]
    revoked: bool,
    inactive_days: Option<i64>,
}

async fn devices_cleanup(State(app): State<App>, h: HeaderMap, Json(req): Json<CleanupReq>) -> R {
    let c = ctx(&app, &h)?;
    if !req.revoked && req.inactive_days.is_none() {
        return Err(bad("Nichts ausgewählt"));
    }
    let online = app.hub.online_tokens();
    let gone = app.hub.store.lock().unwrap_or_else(|e| e.into_inner()).cleanup_devices(req.revoked, req.inactive_days, &online)?;
    let set: std::collections::HashSet<&str> = gone.iter().map(String::as_str).collect();
    app.hub.kick_where(|k| set.contains(k.token.as_str()));
    let mut what = Vec::new();
    if req.revoked {
        what.push("gesperrte".to_string());
    }
    if let Some(d) = req.inactive_days {
        what.push(format!("seit {d} Tagen nicht gesehen"));
    }
    audit(&app, &c, "device.cleanup", format!("{} entfernt ({}; verbundene ausgenommen)", gone.len(), what.join(", ")));
    Ok(Json(json!({ "removed": gone.len() })).into_response())
}

// ── Schnittstellen (Dienste der Lese-API) ────────────────────────────

/// Dienste mit Vaults, Tokens (Kennung, zuletzt gelesen, gesperrt) und Zahl offener Änderungs-Feeds.
async fn services(State(app): State<App>, h: HeaderMap) -> R {
    ctx(&app, &h)?;
    let feeds = app.feeds.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let st = app.hub.store.lock().unwrap_or_else(|e| e.into_inner());
    let mut out = Vec::new();
    for u in st.services()? {
        out.push(json!({ "id": u.id, "name": u.name, "color": u.color, "spaces": st.spaces_of(&u.id)?,
            "tokens": st.devices(&u.id)?, "feeds": feeds.get(&u.id).copied().unwrap_or(0) }));
    }
    Ok(Json(out).into_response())
}

#[derive(Deserialize)]
struct ServiceAdd {
    id: String,
    name: String,
    #[serde(default)]
    spaces: Vec<String>,
}

/// Dienst anlegen, Vaults mit „Lesen“ zuweisen und den Token einmalig zurückgeben.
async fn service_add(State(app): State<App>, h: HeaderMap, Json(req): Json<ServiceAdd>) -> R {
    let c = ctx(&app, &h)?;
    let id = req.id.trim().to_lowercase();
    let name = clean_name(&req.name)?;
    for s in &req.spaces {
        check_space(&app, s)?;
    }
    let token = {
        let mut st = app.hub.store.lock().unwrap_or_else(|e| e.into_inner());
        if st.user(&id)?.is_some() {
            return Err(conflict(format!("Die Kennung „{id}“ ist schon vergeben")));
        }
        st.add_user(&id, &name, None).map_err(|_| bad("Kennung: nur a-z, 0-9, _ und - (max. 64 Zeichen)"))?;
        st.make_service(&id)?;
        for s in &req.spaces {
            st.set_member(s, &id, "read")?;
        }
        st.replace_token(&id, &name)?.0
    };
    audit(&app, &c, "service.add", format!("{id} ({})", req.spaces.join(", ")));
    Ok(Json(json!({ "id": id, "token": token })).into_response())
}

/// Neuen Token ausstellen, alle alten sperren (offene Feeds enden spätestens nach einer Minute).
async fn service_token(State(app): State<App>, h: HeaderMap, Path(id): Path<String>) -> R {
    let c = ctx(&app, &h)?;
    let token = {
        let mut st = app.hub.store.lock().unwrap_or_else(|e| e.into_inner());
        let u = st.user(&id)?.ok_or_else(|| not_found("Dienst nicht gefunden"))?;
        if !st.is_service(&id)? {
            return Err(bad("Keine Schnittstelle"));
        }
        st.replace_token(&id, &u.name)?.0
    };
    audit(&app, &c, "service.token", &id);
    Ok(Json(json!({ "token": token })).into_response())
}

/// Bestehende Person (z. B. die alte Lernplattform-Person) als Dienst übernehmen – Tokens bleiben gültig.
async fn user_to_service(State(app): State<App>, h: HeaderMap, Path(id): Path<String>) -> R {
    let c = ctx(&app, &h)?;
    if id == c.user.id {
        return Err(bad("Das eigene Konto kann kein Dienst werden"));
    }
    {
        let st = app.hub.store.lock().unwrap_or_else(|e| e.into_inner());
        if st.admins()?.iter().any(|a| a.0 == id) {
            return Err(bad("Admins können keine Dienste sein"));
        }
        st.make_service(&id)?;
    }
    let n = app.hub.kick_where(|k| k.user.id == id);
    audit(&app, &c, "service.adopt", format!("{id} ({n} Verbindungen getrennt)"));
    Ok(StatusCode::NO_CONTENT.into_response())
}

#[derive(Deserialize)]
struct StatsQ {
    range: Option<String>,
}

/// Statistik: Zeitreihe (Minuten aus dem RAM bis 48 h, darüber Stunden aus der DB), Summen,
/// Nutzung je Person und Vault, Geräte mit Latenz, zuletzt geänderte Dateien.
async fn stats(State(app): State<App>, h: HeaderMap, Query(q): Query<StatsQ>) -> R {
    ctx(&app, &h)?;
    let range = q.range.as_deref().unwrap_or("24h");
    let secs: i64 = match range {
        "1h" => 3600,
        "6h" => 6 * 3600,
        "24h" => 86400,
        "48h" => 2 * 86400,
        "7d" => 7 * 86400,
        "30d" => 30 * 86400,
        "90d" => 90 * 86400,
        _ => return Err(bad("range: 1h, 6h, 24h, 48h, 7d, 30d oder 90d")),
    };
    let now = now();
    let since = now - secs;
    let m = &app.hub.metrics;
    let (series, step) = if secs <= 2 * 86400 {
        // Minuten aus dem RAM; die Zeit davor (z. B. vor einem Neustart) aus den gespeicherten Stunden
        let minutes = m.minutes_since(since);
        let first = minutes.first().map(|p| p.ts).unwrap_or(now);
        let mut pts: Vec<crate::metrics::Point> = app
            .hub
            .store
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .metrics_hours(since / 3600 * 3600)?
            .into_iter()
            // nur Stunden, die ganz im Zeitraum liegen und vor der ersten Minute im RAM enden
            .filter(|p| p.ts >= since && p.ts + 3600 <= first)
            .collect();
        pts.extend(minutes);
        (crate::metrics::downsample(pts, 360), 60)
    } else {
        let mut hours = app.hub.store.lock().unwrap_or_else(|e| e.into_inner()).metrics_hours(since / 3600 * 3600)?;
        let cur = crate::metrics::Point { dur: (now - now / 3600 * 3600).max(60), ..m.current_hour() };
        hours.retain(|p| p.ts != cur.ts);
        hours.push(cur);
        (crate::metrics::downsample(hours, 360), 3600)
    };
    // Summen über den Zeitraum; Personen/Vaults aus den Stunden (laufende inkl.)
    let mut total = crate::metrics::Point::default();
    for p in &series {
        crate::metrics::merge(&mut total, p);
    }
    let mut who = crate::metrics::Point::default();
    {
        let hours = app.hub.store.lock().unwrap_or_else(|e| e.into_inner()).metrics_hours(since / 3600 * 3600)?;
        let cur = m.current_hour();
        for p in hours.iter().filter(|p| p.ts != cur.ts).chain(std::iter::once(&cur)) {
            crate::metrics::merge(&mut who, p);
        }
    }
    let rank = |map: &HashMap<String, u64>| {
        let mut v: Vec<(String, u64)> = map.iter().map(|(k, v)| (k.clone(), *v)).collect();
        v.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        v.into_iter().map(|(id, n)| json!({ "id": id, "updates": n })).collect::<Vec<_>>()
    };
    // Zuletzt geänderte Dateien mit Pfad
    let recent_rows = app.hub.store.lock().unwrap_or_else(|e| e.into_inner()).recent_docs(20)?;
    let mut paths: HashMap<String, HashMap<String, String>> = HashMap::new();
    let mut recent = Vec::new();
    for (space, doc, updated) in recent_rows {
        if !paths.contains_key(&space) {
            let idx = read_index(&app, &space).unwrap_or_default();
            paths.insert(space.clone(), idx.into_iter().map(|e| (e.id, e.path)).collect());
        }
        let id = doc.split_once('/').map(|x| x.1).unwrap_or(&doc).to_string();
        let path = paths.get(&space).and_then(|m| m.get(&id)).cloned();
        recent.push(json!({ "space": space, "doc": id, "path": path, "updated": updated }));
    }
    Ok(Json(json!({
        "range": range,
        "step": step,
        "now": now,
        "startedAt": m.started,
        "rssKib": crate::server::rss_kib(),
        "series": series,
        "total": total,
        "users": rank(&who.users),
        "spaces": rank(&who.spaces),
        "devices": with_paths(&app, app.hub.online(None)),
        "recent": recent,
    }))
    .into_response())
}

// ── Spaces ───────────────────────────────────────────────────────────

fn check_space(app: &App, space: &str) -> Result<(), E> {
    if !codec::valid_id(space) {
        return Err(bad("Space-Kennung ungültig"));
    }
    let exists = app.hub.store.lock().unwrap_or_else(|e| e.into_inner()).spaces()?.iter().any(|s| s.0 == space);
    if exists { Ok(()) } else { Err(not_found("Space nicht gefunden")) }
}

async fn spaces(State(app): State<App>, h: HeaderMap) -> R {
    ctx(&app, &h)?;
    let mut out = Vec::new();
    let all = app.hub.store.lock().unwrap_or_else(|e| e.into_inner()).spaces()?;
    for (id, name, seq, _) in all {
        let online = app.hub.online(Some(&id)).len();
        let st = app.hub.store.lock().unwrap_or_else(|e| e.into_inner());
        let members: Vec<Value> = st
            .members(&id)?
            .into_iter()
            .map(|m| json!({ "id": m["id"], "name": m["name"], "color": m["color"], "role": m["role"], "service": m["service"] }))
            .collect();
        let e2ee = match st.space_e2ee(&id)?.as_deref() {
            None => "off",
            Some(crate::db::E2EE_PENDING) => "pending",
            Some(_) => "on",
        };
        out.push(json!({ "id": id, "name": name, "seq": seq, "members": members, "stats": st.space_stats(&id)?, "online": online, "e2ee": e2ee }));
    }
    Ok(Json(out).into_response())
}

#[derive(Deserialize)]
struct SpaceAdd {
    id: String,
    name: String,
    /// Ende-zu-Ende-verschlüsselt anlegen: die Passphrase legt danach der Besitzer in Obsidian fest.
    #[serde(default)]
    e2ee: bool,
}

async fn space_add(State(app): State<App>, h: HeaderMap, Json(req): Json<SpaceAdd>) -> R {
    let c = ctx(&app, &h)?;
    let id = req.id.trim().to_lowercase();
    let name = clean_name(&req.name)?;
    {
        let st = app.hub.store.lock().unwrap_or_else(|e| e.into_inner());
        if st.spaces()?.iter().any(|s| s.0 == id) {
            return Err(conflict(format!("Einen Vault mit der ID „{id}“ gibt es schon")));
        }
        st.add_space(&id, &name).map_err(|_| bad("ID: nur a-z, 0-9, _ und - (max. 64 Zeichen)"))?;
        if req.e2ee {
            st.set_space_e2ee(&id, Some(crate::db::E2EE_PENDING))?;
        }
    }
    audit(&app, &c, "space.add", if req.e2ee { format!("{id} (Ende-zu-Ende-verschlüsselt)") } else { id.clone() });
    Ok(StatusCode::NO_CONTENT.into_response())
}

#[derive(Deserialize)]
struct NameReq {
    name: String,
}

async fn space_patch(State(app): State<App>, h: HeaderMap, Path(space): Path<String>, Json(req): Json<NameReq>) -> R {
    let c = ctx(&app, &h)?;
    let name = clean_name(&req.name)?;
    app.hub.store.lock().unwrap_or_else(|e| e.into_inner()).rename_space(&space, &name)?;
    audit(&app, &c, "space.rename", format!("{space} → {name}"));
    Ok(StatusCode::NO_CONTENT.into_response())
}

#[derive(Deserialize)]
struct Confirm {
    confirm: String,
}

async fn space_delete(State(app): State<App>, h: HeaderMap, Path(space): Path<String>, Json(req): Json<Confirm>) -> R {
    let c = ctx(&app, &h)?;
    check_space(&app, &space)?;
    if req.confirm != space {
        return Err(bad("Zur Bestätigung die Kennung des Space eingeben"));
    }
    let n = app.hub.kick_where(|k| k.spaces.contains_key(&space));
    app.hub.drop_space(&space);
    app.hub.store.lock().unwrap_or_else(|e| e.into_inner()).delete_space(&space)?;
    // Anhänge bleiben liegen: ältere Sicherungen dieses Vaults brauchen sie zum Wiederherstellen/Exportieren.
    audit(&app, &c, "space.delete", format!("{space} ({n} Verbindungen getrennt)"));
    Ok(StatusCode::NO_CONTENT.into_response())
}

#[derive(Deserialize)]
struct RoleReq {
    role: String,
}

async fn member_set(State(app): State<App>, h: HeaderMap, Path((space, user)): Path<(String, String)>, Json(req): Json<RoleReq>) -> R {
    let c = ctx(&app, &h)?;
    check_space(&app, &space)?;
    {
        let st = app.hub.store.lock().unwrap_or_else(|e| e.into_inner());
        st.user(&user)?.ok_or_else(|| not_found("Person nicht gefunden"))?;
        st.set_member(&space, &user, &req.role)?;
    }
    // Neu verbinden lassen, damit die neue Rolle gilt.
    let n = app.hub.kick_where(|k| k.user.id == user);
    audit(&app, &c, "member.set", format!("{user} in {space}: {} ({n} Verbindungen neu)", req.role));
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn member_remove(State(app): State<App>, h: HeaderMap, Path((space, user)): Path<(String, String)>) -> R {
    let c = ctx(&app, &h)?;
    check_space(&app, &space)?;
    app.hub.store.lock().unwrap_or_else(|e| e.into_inner()).remove_member(&space, &user)?;
    let n = app.hub.kick_where(|k| k.user.id == user);
    audit(&app, &c, "member.remove", format!("{user} aus {space} ({n} Verbindungen neu)"));
    Ok(StatusCode::NO_CONTENT.into_response())
}

// ── Vault-Inhalte ────────────────────────────────────────────────────

fn index_name(space: &str) -> String {
    format!("{space}/{}", vault::INDEX)
}

fn read_index(app: &App, space: &str) -> Result<Vec<Entry>, E> {
    Ok(app.hub.read_doc(&index_name(space), vault::read_index)?)
}

/// Eintrag zu einer docId (muss existieren).
fn entry(app: &App, space: &str, doc: &str) -> Result<Entry, E> {
    if !codec::valid_id(doc) || doc == vault::INDEX {
        return Err(bad("Datei-Kennung ungültig"));
    }
    read_index(app, space)?.into_iter().find(|e| e.id == doc).ok_or_else(|| not_found("Datei nicht gefunden"))
}

async fn files(State(app): State<App>, h: HeaderMap, Path(space): Path<String>) -> R {
    ctx(&app, &h)?;
    check_space(&app, &space)?;
    Ok(Json(json!({ "files": read_index(&app, &space)?, "online": with_paths(&app, app.hub.online(Some(&space))) })).into_response())
}

async fn doc_get(State(app): State<App>, h: HeaderMap, Path((space, doc)): Path<(String, String)>) -> R {
    ctx(&app, &h)?;
    check_space(&app, &space)?;
    let e = entry(&app, &space, &doc)?;
    let name = format!("{space}/{doc}");
    match e.kind.as_str() {
        "md" => {
            let text = app.hub.read_doc(&name, vault::read_text)?;
            Ok(Json(json!({ "id": e.id, "path": e.path, "kind": "md", "version": vault::text_version(&text), "text": text })).into_response())
        }
        "ink" => {
            let mut info = app.hub.read_doc(&name, vault::ink_info)?;
            info["id"] = json!(e.id);
            info["path"] = json!(e.path);
            info["kind"] = json!("ink");
            Ok(Json(info).into_response())
        }
        _ => Err(bad("Anhänge über /raw abrufen")),
    }
}

#[derive(Deserialize)]
struct DocPut {
    text: String,
    version: String,
    /// Text, auf dem die Bearbeitung beruht (zu `version`). Hat sich die Notiz inzwischen geändert, werden die
    /// eigenen Änderungen per 3-Wege-Merge übertragen; nur bei Überschneidung gibt es 409.
    base: Option<String>,
}

async fn doc_put(State(app): State<App>, h: HeaderMap, Path((space, doc)): Path<(String, String)>, Json(req): Json<DocPut>) -> R {
    let c = ctx(&app, &h)?;
    check_space(&app, &space)?;
    let e = entry(&app, &space, &doc)?;
    if e.kind != "md" || e.del {
        return Err(bad("Nur vorhandene Notizen lassen sich bearbeiten"));
    }
    if req.text.len() > MAX_TEXT {
        return Err(bad("Text zu groß (max. 5 MiB)"));
    }
    let base = req.base.as_deref().filter(|b| b.len() <= MAX_TEXT && vault::text_version(b) == req.version);
    let res = app.hub.edit_doc(&format!("{space}/{doc}"), |d| {
        let t = d.get_or_insert_text("content");
        let mut txn = d.transact_mut();
        let cur = yrs::GetString::get_string(&t, &txn);
        let target = if vault::text_version(&cur) == req.version {
            req.text.clone()
        } else {
            match base.and_then(|b| vault::merge3(b, &req.text, &cur)) {
                Some(m) => m,
                None => return Err(cur),
            }
        };
        let merged = target != req.text;
        if target != cur {
            vault::set_text(&t, &mut txn, &target);
        }
        Ok((target, merged, cur))
    })?;
    let (text, merged, before) = match res {
        Ok(v) => v,
        Err(cur) => {
            let v = vault::text_version(&cur);
            return Ok((StatusCode::CONFLICT, Json(json!({ "error": "Die Notiz wurde inzwischen an derselben Stelle geändert", "text": cur, "version": v })))
                .into_response());
        }
    };
    if text != before {
        audit(&app, &c, "file.edit", format!("{space}: {}{}", e.path, if merged { " (zusammengeführt)" } else { "" }));
    }
    let mut out = json!({ "version": vault::text_version(&text), "merged": merged });
    if merged {
        out["text"] = json!(text);
    }
    Ok(Json(out).into_response())
}

/// Text in eine (neue oder bestehende) Notiz schreiben, ggf. Index-Eintrag anlegen. Liefert die docId.
fn write_note(app: &App, space: &str, path: &str, text: &str, by: &str, replace: bool) -> Result<String, E> {
    let entries = read_index(app, space)?;
    if let Some(id) = vault::id_for_path(&entries, path) {
        if !replace {
            return Err(conflict("Unter diesem Pfad gibt es schon eine Datei"));
        }
        app.hub.edit_doc(&format!("{space}/{id}"), |d| {
            let t = d.get_or_insert_text("content");
            vault::set_text(&t, &mut d.transact_mut(), text);
        })?;
        return Ok(id);
    }
    let id = vault::new_doc_id();
    // Erst der Inhalt, dann der Index-Eintrag: Clients finden beim Anlegen der Datei schon den Text vor.
    if !text.is_empty() {
        app.hub.edit_doc(&format!("{space}/{id}"), |d| {
            let t = d.get_or_insert_text("content");
            vault::set_text(&t, &mut d.transact_mut(), text);
        })?;
    }
    let hash = sha256_hex(text.as_bytes());
    app.hub.edit_doc(&index_name(space), |d| {
        let mut txn = d.transact_mut();
        vault::add_entry(&mut txn, &id, path, "md", by, vec![("hash", Any::from(hash.as_str())), ("origin", Any::from(vault::ORIGIN))]);
    })?;
    Ok(id)
}

#[derive(Deserialize)]
struct Create {
    path: String,
    text: Option<String>,
}

async fn file_create(State(app): State<App>, h: HeaderMap, Path(space): Path<String>, Json(req): Json<Create>) -> R {
    let c = ctx(&app, &h)?;
    check_space(&app, &space)?;
    let path = req.path.trim();
    vault::valid_path(path).map_err(bad)?;
    if vault::kind_for_path(path) != "md" {
        return Err(bad("Neue Notizen enden auf .md oder .txt"));
    }
    let text = req.text.unwrap_or_default();
    if text.len() > MAX_TEXT {
        return Err(bad("Text zu groß (max. 5 MiB)"));
    }
    let id = write_note(&app, &space, path, &text, &c.user.id, false)?;
    audit(&app, &c, "file.create", format!("{space}: {path}"));
    Ok(Json(json!({ "id": id })).into_response())
}

#[derive(Deserialize)]
struct UploadQ {
    path: String,
}

async fn upload(State(app): State<App>, h: HeaderMap, Path(space): Path<String>, Query(q): Query<UploadQ>, body: Body) -> R {
    let c = ctx(&app, &h)?;
    check_space(&app, &space)?;
    // Vor dem Speichern prüfen: in einem verschlüsselten Vault darf kein Klartext-Anhang landen.
    if app.hub.store.lock().unwrap_or_else(|e| e.into_inner()).space_e2ee(&space)?.is_some() {
        return Err(HubError::E2ee.into());
    }
    let path = q.path.trim().to_string();
    vault::valid_path(&path).map_err(bad)?;
    match vault::kind_for_path(&path) {
        "md" => {
            let body = axum::body::to_bytes(body, MAX_TEXT + 1).await.map_err(|_| bad("Text zu groß (max. 5 MiB)"))?;
            let text = std::str::from_utf8(&body).map_err(|_| bad("Keine gültige UTF-8-Textdatei"))?;
            if text.len() > MAX_TEXT {
                return Err(bad("Text zu groß (max. 5 MiB)"));
            }
            let id = write_note(&app, &space, &path, text, &c.user.id, true)?;
            audit(&app, &c, "file.upload", format!("{space}: {path}"));
            return Ok(Json(json!({ "id": id, "hash": sha256_hex(text.as_bytes()), "size": body.len() })).into_response());
        }
        "ink" => return Err(bad("Ink-Dateien bitte in Obsidian anlegen")),
        _ => {}
    }
    let (hash, size_u) = crate::server::receive_blob(&app, &space, None, body).await.map_err(|(s, m)| E(s, m.into()))?;
    let size = size_u as f64;
    let entries = read_index(&app, &space)?;
    let existing = vault::id_for_path(&entries, &path).and_then(|id| entries.iter().find(|e| e.id == id).cloned());
    let by = c.user.id.clone();
    let id = match existing {
        Some(e) if e.kind != "blob" => return Err(conflict("Unter diesem Pfad liegt eine Notiz")),
        Some(e) => {
            if e.hash.as_deref() != Some(hash.as_str()) {
                let parent = e.hash.clone().unwrap_or_default();
                app.hub.edit_doc(&index_name(&space), |d| {
                    let mut txn = d.transact_mut();
                    vault::update_entry(
                        &mut txn,
                        &e.id,
                        &by,
                        vec![("hash", Any::from(hash.as_str())), ("size", Any::from(size)), ("parent", Any::from(parent.as_str()))],
                    );
                })?;
            }
            e.id
        }
        None => {
            let id = vault::new_doc_id();
            app.hub.edit_doc(&index_name(&space), |d| {
                let mut txn = d.transact_mut();
                vault::add_entry(
                    &mut txn,
                    &id,
                    &path,
                    "blob",
                    &by,
                    vec![("hash", Any::from(hash.as_str())), ("size", Any::from(size)), ("origin", Any::from(vault::ORIGIN))],
                );
            })?;
            id
        }
    };
    audit(&app, &c, "file.upload", format!("{space}: {path} ({size_u} B)"));
    Ok(Json(json!({ "id": id, "hash": hash, "size": size_u })).into_response())
}

#[derive(Deserialize)]
struct MoveReq {
    from: String,
    to: String,
}

async fn file_move(State(app): State<App>, h: HeaderMap, Path(space): Path<String>, Json(req): Json<MoveReq>) -> R {
    let c = ctx(&app, &h)?;
    check_space(&app, &space)?;
    let (from, to) = (req.from.trim().trim_end_matches('/'), req.to.trim().trim_end_matches('/'));
    vault::valid_path(to).map_err(bad)?;
    if from == to {
        return Ok(Json(json!({ "moved": 0 })).into_response());
    }
    let entries = read_index(&app, &space)?;
    let live: Vec<&Entry> = entries.iter().filter(|e| !e.del).collect();
    let file = live.iter().find(|e| e.path == from);
    let moves: Vec<(String, String)> = if let Some(e) = file {
        if vault::kind_for_path(to) != e.kind {
            return Err(bad("Die Dateiendung muss zur Dateiart passen"));
        }
        vec![(e.id.clone(), to.to_string())]
    } else {
        let prefix = format!("{from}/");
        if to.starts_with(&prefix) {
            return Err(bad("Ein Ordner kann nicht in sich selbst verschoben werden"));
        }
        live.iter().filter(|e| e.path.starts_with(&prefix)).map(|e| (e.id.clone(), format!("{to}/{}", &e.path[prefix.len()..]))).collect()
    };
    if moves.is_empty() {
        return Err(not_found("Nichts unter diesem Pfad"));
    }
    let moving: std::collections::HashSet<&str> = moves.iter().map(|m| m.0.as_str()).collect();
    for (_, p) in &moves {
        vault::valid_path(p).map_err(bad)?;
        if live.iter().any(|e| e.path == *p && !moving.contains(e.id.as_str())) {
            return Err(conflict(format!("„{p}“ gibt es schon")));
        }
    }
    let by = c.user.id.clone();
    app.hub.edit_doc(&index_name(&space), |d| {
        let mut txn = d.transact_mut();
        for (id, p) in &moves {
            vault::update_entry(&mut txn, id, &by, vec![("path", Any::from(p.as_str()))]);
        }
    })?;
    audit(&app, &c, "file.move", format!("{space}: {from} → {to} ({} Dateien)", moves.len()));
    Ok(Json(json!({ "moved": moves.len() })).into_response())
}

#[derive(Deserialize)]
struct PathReq {
    path: String,
}

async fn file_delete(State(app): State<App>, h: HeaderMap, Path(space): Path<String>, Json(req): Json<PathReq>) -> R {
    let c = ctx(&app, &h)?;
    check_space(&app, &space)?;
    let path = req.path.trim().trim_end_matches('/');
    if path.is_empty() {
        return Err(bad("Pfad fehlt"));
    }
    let prefix = format!("{path}/");
    let ids: Vec<String> =
        read_index(&app, &space)?.into_iter().filter(|e| !e.del && (e.path == path || e.path.starts_with(&prefix))).map(|e| e.id).collect();
    if ids.is_empty() {
        return Err(not_found("Nichts unter diesem Pfad"));
    }
    let by = c.user.id.clone();
    app.hub.edit_doc(&index_name(&space), |d| {
        let mut txn = d.transact_mut();
        for id in &ids {
            vault::update_entry(&mut txn, id, &by, vec![("del", Any::Bool(true))]);
        }
    })?;
    audit(&app, &c, "file.delete", format!("{space}: {path} ({} Dateien)", ids.len()));
    Ok(Json(json!({ "deleted": ids.len() })).into_response())
}

#[derive(Deserialize)]
struct DocReq {
    doc: String,
    /// optional: unter diesem Pfad wiederherstellen (wenn der alte inzwischen belegt ist)
    path: Option<String>,
}

async fn file_undelete(State(app): State<App>, h: HeaderMap, Path(space): Path<String>, Json(req): Json<DocReq>) -> R {
    let c = ctx(&app, &h)?;
    check_space(&app, &space)?;
    let entries = read_index(&app, &space)?;
    let e = entries.iter().find(|e| e.id == req.doc).ok_or_else(|| not_found("Datei nicht gefunden"))?;
    if !e.del {
        return Ok(StatusCode::NO_CONTENT.into_response());
    }
    let target = req.path.as_deref().map(str::trim).filter(|p| !p.is_empty()).unwrap_or(&e.path).to_string();
    vault::valid_path(&target).map_err(bad)?;
    if vault::kind_for_path(&target) != e.kind {
        return Err(bad("Die Dateiendung muss zur Dateiart passen"));
    }
    if vault::id_for_path(&entries, &target).is_some() {
        return Err(conflict(format!("„{target}“ ist inzwischen wieder belegt – unter anderem Namen wiederherstellen")));
    }
    let by = c.user.id.clone();
    let mut patch = vec![("del", Any::Bool(false))];
    if target != e.path {
        patch.push(("path", Any::from(target.as_str())));
    }
    app.hub.edit_doc(&index_name(&space), |d| {
        let mut txn = d.transact_mut();
        vault::update_entry(&mut txn, &e.id, &by, patch);
    })?;
    audit(&app, &c, "file.undelete", format!("{space}: {target}"));
    Ok(StatusCode::NO_CONTENT.into_response())
}

#[derive(Deserialize)]
struct RawQ {
    download: Option<String>,
}

fn disposition(path: &str, inline: bool) -> String {
    let name = path.rsplit('/').next().unwrap_or("datei");
    let ascii: String = name.chars().map(|c| if c.is_ascii_alphanumeric() || "._- ".contains(c) { c } else { '_' }).collect();
    let enc: String = name
        .bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"._-".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect();
    format!("{}; filename=\"{ascii}\"; filename*=UTF-8''{enc}", if inline { "inline" } else { "attachment" })
}

async fn raw(State(app): State<App>, h: HeaderMap, Path((space, doc)): Path<(String, String)>, Query(q): Query<RawQ>) -> R {
    ctx(&app, &h)?;
    check_space(&app, &space)?;
    let e = entry(&app, &space, &doc)?;
    let download = q.download.is_some();
    let (body, ct, inline_ok, len): (Body, &str, bool, Option<u64>) = match e.kind.as_str() {
        "md" => (Body::from(app.hub.read_doc(&format!("{space}/{doc}"), vault::read_text)?), "text/plain; charset=utf-8", true, None),
        "ink" => {
            let info = app.hub.read_doc(&format!("{space}/{doc}"), vault::ink_info)?;
            (Body::from(serde_json::to_vec_pretty(&info).unwrap_or_default()), "application/json", true, None)
        }
        _ => {
            let hash = e.hash.clone().ok_or_else(|| not_found("Anhang noch nicht hochgeladen"))?;
            if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err(bad("Hash ungültig"));
            }
            let (len, data) = crate::server::open_blob(&app, &space, &hash).await.ok_or_else(|| not_found("Anhang fehlt auf dem Server"))?;
            let (ct, inline) = vault::content_type(&e.path);
            (data, ct, inline, Some(len))
        }
    };
    let inline = inline_ok && !download;
    let csp = if ct == "application/pdf" { "frame-ancestors 'self'; default-src 'none'" } else { RAW_CSP };
    let mut res = Response::new(body);
    let hh = res.headers_mut();
    if let Some(len) = len {
        hh.insert(header::CONTENT_LENGTH, HeaderValue::from(len));
    }
    hh.insert(header::CONTENT_TYPE, HeaderValue::from_str(ct).unwrap());
    hh.insert(header::CONTENT_DISPOSITION, HeaderValue::from_str(&disposition(&e.path, inline)).unwrap_or(HeaderValue::from_static("attachment")));
    hh.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static(csp));
    hh.insert(header::CACHE_CONTROL, HeaderValue::from_static("private, no-cache"));
    Ok(res)
}

#[derive(Deserialize)]
struct SearchQ {
    q: String,
}

async fn search(State(app): State<App>, h: HeaderMap, Path(space): Path<String>, Query(q): Query<SearchQ>) -> R {
    ctx(&app, &h)?;
    check_space(&app, &space)?;
    let needle = q.q.trim().to_lowercase();
    if needle.chars().count() < 2 || needle.len() > 200 {
        return Err(bad("Suchbegriff: 2–200 Zeichen"));
    }
    let mut hits = Vec::new();
    'files: for e in read_index(&app, &space)?.into_iter().filter(|e| !e.del && e.kind == "md") {
        let text = app.hub.read_doc(&format!("{space}/{}", e.id), vault::read_text)?;
        for (i, line) in text.lines().enumerate() {
            if line.to_lowercase().contains(&needle) {
                let snippet: String = line.chars().take(240).collect();
                hits.push(json!({ "id": e.id, "path": e.path, "line": i + 1, "text": snippet }));
                if hits.len() >= 200 {
                    break 'files;
                }
            }
        }
    }
    Ok(Json(hits).into_response())
}

async fn history_list(State(app): State<App>, h: HeaderMap, Path((space, doc)): Path<(String, String)>) -> R {
    ctx(&app, &h)?;
    check_space(&app, &space)?;
    entry(&app, &space, &doc)?;
    let list = app.hub.store.lock().unwrap_or_else(|e| e.into_inner()).snapshots(&format!("{space}/{doc}"))?;
    Ok(Json(list.into_iter().map(|(ts, size)| json!({ "ts": ts, "size": size })).collect::<Vec<_>>()).into_response())
}

fn snapshot_doc(app: &App, space: &str, doc: &str, ts: i64) -> Result<yrs::Doc, E> {
    let data = app
        .hub
        .store
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .snapshot(&format!("{space}/{doc}"), ts)?
        .ok_or_else(|| not_found("Version nicht gefunden"))?;
    vault::doc_from_state(&data).ok_or_else(|| E(StatusCode::INTERNAL_SERVER_ERROR, "Version defekt".into()))
}

async fn history_get(State(app): State<App>, h: HeaderMap, Path((space, doc, ts)): Path<(String, String, i64)>) -> R {
    ctx(&app, &h)?;
    check_space(&app, &space)?;
    let e = entry(&app, &space, &doc)?;
    let d = snapshot_doc(&app, &space, &doc, ts)?;
    Ok(Json(if e.kind == "ink" { vault::ink_info(&d) } else { json!({ "text": vault::read_text(&d) }) }).into_response())
}

async fn history_restore(State(app): State<App>, h: HeaderMap, Path((space, doc, ts)): Path<(String, String, i64)>) -> R {
    let c = ctx(&app, &h)?;
    check_space(&app, &space)?;
    let e = entry(&app, &space, &doc)?;
    if e.kind != "md" {
        return Err(bad("Wiederherstellen geht hier nur für Notizen – Ink-Flächen über Obsidian"));
    }
    let text = vault::read_text(&snapshot_doc(&app, &space, &doc, ts)?);
    app.hub.edit_doc(&format!("{space}/{doc}"), |d| {
        let t = d.get_or_insert_text("content");
        vault::set_text(&t, &mut d.transact_mut(), &text);
    })?;
    audit(&app, &c, "file.restore", format!("{space}: {} (Stand {ts})", e.path));
    Ok(Json(json!({ "version": vault::text_version(&text) })).into_response())
}
