// Tandem Admin – ohne Framework, ohne Build, ohne Hintergrundverkehr.
// Alle Netzwerkzugriffe gehen von einer Nutzeraktion oder Navigation aus. Timer gibt es nur lokal (Toasts, Sperr-Countdown).

const API = '/admin/api/';

// ---------------------------------------------------------------------------
// DOM-Helfer (kein innerHTML – alles über createElement/textContent)

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'for') el.htmlFor = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'value' || k === 'checked' || k === 'selected' || k === 'disabled' || k === 'hidden' || k === 'readOnly' || k === 'multiple' || k === 'inert' || k === 'indeterminate') el[k] = v;
      else if (k === 'style') continue; // keine Inline-Styles (CSP)
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.append(c);
    else el.append(document.createTextNode(String(c)));
  }
}

function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
function frag(...children) { const f = document.createDocumentFragment(); append(f, children); return f; }
function replace(el, ...children) { clear(el); append(el, children); return el; }
const $ = (sel, root = document) => root.querySelector(sel);
let uid = 0;
function nextId(prefix = 'f') { return `${prefix}-${++uid}`; }

function setColorVar(el, color) {
  if (typeof color === 'string' && /^#[0-9a-f]{3,8}$/i.test(color)) el.style.setProperty('--c', color);
  return el;
}

function colorDot(color, extra) { return setColorVar(h('span', { class: 'dot' + (extra ? ' ' + extra : ''), 'aria-hidden': 'true' }), color); }

// Personenmarke: Anfangsbuchstabe auf der Personenfarbe (Punkte bleiben dem Online-Status vorbehalten)
function avatar(u, size) {
  const name = String((u && (u.name || u.id)) || '?').trim();
  const el = h('span', { class: 'avatar' + (size ? ' ' + size : ''), 'aria-hidden': 'true', text: (name[0] || '?').toUpperCase() });
  return setColorVar(el, u && u.color);
}

// ---------------------------------------------------------------------------
// Formatierung (de-DE)

const nf = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 2 });
const coll = new Intl.Collator('de', { numeric: true, sensitivity: 'base' });

function fmtNum(n) { return Number.isFinite(Number(n)) ? nf.format(Number(n)) : '–'; }
// „1 Datei“, „3 Dateien“
function plural(n, one, many) { n = Number(n) || 0; return `${fmtNum(n)} ${n === 1 ? one : many}`; }

function fmtBytes(n) {
  n = Number(n);
  if (!Number.isFinite(n) || n < 0) return '–';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return (i === 0 ? nf.format(n) : (n < 10 ? nf1 : nf).format(n)) + ' ' + units[i];
}

// Zeiten: Sekunden (API) oder Millisekunden (Vault-Index); Heuristik über die Größenordnung.
function toMs(t) {
  t = Number(t);
  if (!Number.isFinite(t) || t <= 0) return NaN;
  return t > 1e11 ? t : t * 1000;
}

const dtf = new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
const dtfSec = new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'medium' });
const dfShort = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
const tfHM = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' });
const tfHMS = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const dfDayLong = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });
const dfUTC = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const dfUTCShort = new Intl.DateTimeFormat('de-DE', { day: 'numeric', month: 'short', timeZone: 'UTC' });

function fmtAbs(t, withSec) { const ms = toMs(t); return Number.isNaN(ms) ? '–' : (withSec ? dtfSec : dtf).format(new Date(ms)); }
function fmtTime(t) { const ms = toMs(t); return Number.isNaN(ms) ? '–' : tfHM.format(new Date(ms)); }
function fmtDateUTC(t) { const ms = toMs(t); return Number.isNaN(ms) ? '–' : dfUTC.format(new Date(ms)); }

function sameLocalDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
// „Heute“, „Gestern“, „Sa., 31.10.2026“
function fmtDayLabel(t) {
  const d = new Date(toMs(t));
  const now = new Date();
  if (sameLocalDay(d, now)) return 'Heute';
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (sameLocalDay(d, y)) return 'Gestern';
  return dfDayLong.format(d);
}
// „heute 01:00“, „morgen 01:00“, sonst Datum + Zeit
function fmtWhen(t) {
  const ms = toMs(t);
  if (Number.isNaN(ms)) return '–';
  const d = new Date(ms), now = new Date();
  const tm = new Date(now); tm.setDate(now.getDate() + 1);
  if (sameLocalDay(d, now)) return 'heute ' + tfHM.format(d);
  if (sameLocalDay(d, tm)) return 'morgen ' + tfHM.format(d);
  return dtf.format(d);
}

function fmtRel(t) {
  const ms = toMs(t);
  if (Number.isNaN(ms)) return '–';
  const d = (Date.now() - ms) / 1000;
  if (d < -60) return 'in ' + fmtSpan(-d);
  if (d < 45) return 'gerade eben';
  if (d < 86400 * 7) return 'vor ' + fmtSpan(d);
  return dfShort.format(new Date(ms));
}

function fmtSpan(s) {
  if (s < 90) return '1 min';
  if (s < 3600) return Math.round(s / 60) + ' min';
  if (s < 86400) return Math.round(s / 3600) + ' h';
  const days = Math.round(s / 86400);
  return days + (days === 1 ? ' Tag' : ' Tagen');
}

// Dauer als „3 Tage 4 h“ / „2 h 15 min“ / „40 min“
function fmtDuration(s) {
  s = Number(s);
  if (!Number.isFinite(s) || s < 0) return '–';
  if (s < 60) return 'unter 1 min';
  const d = Math.floor(s / 86400), hh = Math.floor((s % 86400) / 3600), mm = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d} ${d === 1 ? 'Tag' : 'Tage'}${hh ? ` ${hh} h` : ''}`;
  if (hh > 0) return `${hh} h${mm ? ` ${mm} min` : ''}`;
  return `${mm} min`;
}

// Millisekunden: 0,42 ms / 23 ms / 1,2 s
function fmtMs(ms) {
  ms = Number(ms);
  if (!Number.isFinite(ms) || ms < 0) return '–';
  if (ms >= 1000) return nf1.format(ms / 1000) + ' s';
  if (ms >= 10) return nf.format(ms) + ' ms';
  return nf2.format(ms) + ' ms';
}

// Kompakte Zahl für Achsen: 12.000 → 12k
function fmtCompact(n) {
  n = Number(n);
  if (!Number.isFinite(n)) return '–';
  if (Math.abs(n) >= 1e6) return nf1.format(n / 1e6) + ' Mio.';
  if (Math.abs(n) >= 1e4) return nf1.format(n / 1e3) + 'k';
  return nf1.format(n);
}

function readPref(key) { try { return localStorage.getItem('tandem-admin.' + key); } catch { return null; } }
function writePref(key, value) { try { localStorage.setItem('tandem-admin.' + key, value); } catch { /* privater Modus o. ä. */ } }

function timeEl(t, opts = {}) {
  const ms = toMs(t);
  if (Number.isNaN(ms)) return h('span', { class: 'dim', text: opts.none || '–' });
  return h('time', { datetime: new Date(ms).toISOString(), title: opts.title || fmtAbs(t, true), text: opts.abs ? fmtAbs(t) : fmtRel(t) });
}

function basename(p) { p = String(p || ''); const i = p.lastIndexOf('/'); return i < 0 ? p : p.slice(i + 1); }
function dirname(p) { p = String(p || ''); const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); }
function extOf(p) { const b = basename(p); const i = b.lastIndexOf('.'); return i <= 0 ? '' : b.slice(i + 1).toLowerCase(); }
function stripExt(p) { const i = p.lastIndexOf('.'); return i <= p.lastIndexOf('/') ? p : p.slice(0, i); }
function esc(s) { return s == null ? '' : String(s); }
// Notizname wie in Obsidian: ohne „.md“
function displayName(path) { const b = basename(path); return /\.md$/i.test(b) ? b.slice(0, -3) : b; }

// Kennung aus einem Namen ableiten: „Projekt Ü 2“ → „projekt-ue-2“
function slugify(s) {
  return String(s || '').trim().toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9_-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 64);
}

// Kurzform eines User-Agents: „Firefox 144 · Linux“
function uaLabel(ua) {
  ua = String(ua || '');
  if (!ua) return '–';
  let b = null, m;
  if ((m = ua.match(/Edg\/(\d+)/))) b = 'Edge ' + m[1];
  else if ((m = ua.match(/Firefox\/(\d+)/))) b = 'Firefox ' + m[1];
  else if ((m = ua.match(/HeadlessChrome\/(\d+)/))) b = 'Chrome ' + m[1] + ' (headless)';
  else if ((m = ua.match(/Chrom(?:e|ium)\/(\d+)/))) b = 'Chrome ' + m[1];
  else if ((m = ua.match(/Version\/(\d+)[.\d]*.*Safari/))) b = 'Safari ' + m[1];
  let os = null;
  if (/Windows/.test(ua)) os = 'Windows';
  else if (/iPhone|iPad/.test(ua)) os = 'iOS';
  else if (/Mac OS X/.test(ua)) os = 'macOS';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/Linux/.test(ua)) os = 'Linux';
  if (!b) { m = ua.match(/^([^/\s]+)\/(\d+)/); b = m ? `${m[1]} ${m[2]}` : ua.slice(0, 40); }
  return os ? `${b} · ${os}` : b;
}

// ---------------------------------------------------------------------------
// Toasts: im Top Layer (über offenen Dialogen), gleiche Meldungen werden zusammengefasst

function raiseToasts() {
  const box = $('#toasts');
  if (!box.showPopover) return;
  try {
    if (box.matches(':popover-open')) box.hidePopover();
    if (box.children.length) box.showPopover();
  } catch { /* ältere Browser: normaler fixed-Container */ }
}

function toast(msg, kind = 'info', opts = {}) {
  const box = $('#toasts');
  msg = String(msg);
  const ms = opts.ms || (kind === 'error' ? 9000 : 4000);
  for (const el of box.children) {
    if (el._msg === msg && el._kind === kind) {
      el._n++;
      el._txt.textContent = `${msg} (${el._n}×)`;
      clearTimeout(el._timer);
      el._timer = setTimeout(() => dropToast(el), ms);
      raiseToasts();
      return;
    }
  }
  const txt = h('span', { class: 't', text: msg });
  const el = h('div', { class: 'toast ' + kind, role: kind === 'error' ? 'alert' : null }, txt,
    opts.href ? h('a', { href: opts.href, text: opts.linkText || 'Öffnen', onclick: () => dropToast(el) }) : null,
    kind === 'error' ? h('button', { class: 'x', type: 'button', 'aria-label': 'Meldung schließen', text: '×', onclick: () => dropToast(el) }) : null);
  Object.assign(el, { _msg: msg, _kind: kind, _n: 1, _txt: txt });
  el._timer = setTimeout(() => dropToast(el), ms);
  box.append(el);
  while (box.children.length > 4) dropToast(box.firstChild);
  raiseToasts();
}
function dropToast(el) {
  if (!el) return;
  clearTimeout(el._timer);
  el.remove();
  const box = $('#toasts');
  if (!box.children.length && box.hidePopover) { try { box.hidePopover(); } catch { /* egal */ } }
}

// Button während einer Anfrage sperren; den Fokus danach zurückgeben (disabled wirft ihn sonst ab)
async function busy(btn, fn, label) {
  const btns = (Array.isArray(btn) ? btn : [btn]).filter(Boolean);
  const focused = btns.find((b) => b === document.activeElement);
  const old = label && btns[0] ? btns[0].textContent : null;
  for (const b of btns) b.disabled = true;
  if (label && btns[0]) btns[0].textContent = label;
  try { return await fn(); }
  finally {
    for (const b of btns) b.disabled = false;
    if (old != null && btns[0]) btns[0].textContent = old;
    if (focused && focused.isConnected && (!document.activeElement || document.activeElement === document.body)) focused.focus({ preventScroll: true });
  }
}

async function copyText(text, btn) {
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch {
    const ta = h('textarea', { class: 'input', value: text, readOnly: true, 'aria-hidden': 'true' });
    (btn && btn.closest('dialog') || document.body).append(ta);
    ta.select();
    try { ok = document.execCommand('copy'); } catch { /* egal */ }
    ta.remove();
  }
  if (btn) {
    // Rückmeldung direkt am Knopf (ein Toast läge evtl. hinter einem Dialog)
    const old = btn.dataset.label || btn.textContent;
    btn.dataset.label = old;
    btn.textContent = ok ? 'Kopiert' : 'Nicht möglich';
    setTimeout(() => { if (btn.isConnected) btn.textContent = old; }, 1600);
  } else toast(ok ? 'Kopiert' : 'Kopieren nicht möglich – bitte markieren und kopieren', ok ? 'info' : 'error');
  return ok;
}

// ---------------------------------------------------------------------------
// API

class ApiError extends Error {
  constructor(status, data) {
    super((data && typeof data.error === 'string' && data.error) || (status ? `Fehler ${status}` : 'Keine Verbindung zum Server'));
    this.status = status;
    this.data = data || {};
  }
}

function enc(s) { return encodeURIComponent(String(s)); }
function dec(s) { try { return decodeURIComponent(s); } catch { return s; } }

// opts: method, body (JSON), raw (Body roh), contentType, quiet (kein Toast), expect ([Status], kein Toast), noAuth (401 nicht abfangen)
async function api(path, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase();
  for (let attempt = 0; attempt < 2; attempt++) {
    const headers = { Accept: 'application/json' };
    const init = { method, credentials: 'same-origin', headers };
    if (method !== 'GET' && method !== 'HEAD') {
      headers['X-Tandem-Admin'] = '1';
      if (opts.raw !== undefined) {
        headers['Content-Type'] = opts.contentType || 'application/octet-stream';
        init.body = opts.raw;
      } else {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(opts.body ?? {});
      }
    }
    let res;
    try {
      res = await fetch(API + path, init);
    } catch {
      const err = new ApiError(0, null);
      if (!opts.quiet) toast(err.message, 'error');
      throw err;
    }
    if (res.status === 401 && !opts.noAuth) {
      await requireLogin('expired');
      continue;
    }
    let data = null;
    if (res.status !== 204) {
      const txt = await res.text();
      if (txt) {
        try { data = JSON.parse(txt); } catch { data = { error: txt.slice(0, 200) }; }
      }
    }
    if (!res.ok) {
      const err = new ApiError(res.status, data);
      if (!opts.quiet && !(opts.expect || []).includes(res.status)) toast(err.message, 'error');
      throw err;
    }
    return data;
  }
  throw new ApiError(401, { error: 'Nicht angemeldet' });
}

// Datei-Download über einen Link (GET braucht keinen CSRF-Header). Vorher die Sitzung prüfen, sonst
// speichert der Browser bei abgelaufener Sitzung eine JSON-Fehlermeldung als Datei.
async function downloadUrl(url, filename) {
  try { await api('me', { quiet: true }); } catch { return false; }
  const a = h('a', { href: url, download: filename || '' });
  document.body.append(a);
  a.click();
  a.remove();
  return true;
}
async function exportVault(space, backupName) {
  const url = backupName ? `${API}backups/${enc(backupName)}/spaces/${enc(space)}/export` : `${API}spaces/${enc(space)}/export`;
  if (await downloadUrl(url)) toast('Export wird heruntergeladen');
}

// ---------------------------------------------------------------------------
// Zustand

const state = {
  me: null,
  hash: location.hash,
  dirtyCheck: null, // () => boolean, vom Editor gesetzt
  saveDirty: null,  // async () => boolean, speichert den Editor (für „Speichern und weiter“)
  users: null,      // letzte Antwort von GET users (für Namen/Farben)
  spaces: null,     // letzte Antwort von GET spaces
  stamp: null,      // „Stand hh:mm“ im Seitenkopf
  rendered: false,
};

// Personen- und Vault-Listen laden; mit `cached` wird eine vorhandene Antwort wiederverwendet (nur zum Auflösen von Namen).
async function loadUsers(cached) {
  if (cached && Array.isArray(state.users)) return state.users;
  const r = await api('users', { quiet: true });
  state.users = Array.isArray(r) ? r : [];
  return state.users;
}
async function loadSpaces(cached) {
  if (cached && Array.isArray(state.spaces)) return state.spaces;
  const r = await api('spaces', { quiet: true });
  state.spaces = Array.isArray(r) ? r : [];
  return state.spaces;
}
function userById(id) { return (Array.isArray(state.users) ? state.users : []).find((u) => u && u.id === id) || null; }
function spaceName(id, spaces) {
  const s = (Array.isArray(spaces) ? spaces : (state.spaces || [])).find((x) => x && x.id === id);
  return s && s.name ? s.name : id;
}
// Name mit Kennung dahinter, aber nur wenn sie sich vom Namen unterscheidet
function nameWithId(name, id) {
  name = esc(name) || esc(id);
  const same = name.toLowerCase() === String(id).toLowerCase();
  return same ? name : frag(name, ' ', h('span', { class: 'dim id', text: esc(id) }));
}
function personLabel(id, opts = {}) {
  const u = userById(id);
  const name = u ? (u.name || u.id) : id;
  const inner = frag(opts.noDot ? null : colorDot(u ? u.color : null), esc(name));
  return opts.link && u ? h('a', { class: 'plain-link', href: `#/users/${enc(id)}`, title: id }, inner) : h('span', { title: id }, inner);
}

function setMe(me) {
  state.me = me;
  const who = $('#who');
  clear(who);
  if (me && me.user) {
    who.append(colorDot(me.user.color), h('span', { class: 'n', text: esc(me.user.name || me.user.id) }));
    who.setAttribute('aria-label', `Konto: ${esc(me.user.name || me.user.id)}`);
    who.title = `Angemeldet als ${esc(me.user.id)}`;
    who.hidden = false;
  } else {
    who.hidden = true;
  }
}

function isDirty() { return !!(state.dirtyCheck && state.dirtyCheck()); }

window.addEventListener('beforeunload', (e) => {
  if (isDirty()) { e.preventDefault(); e.returnValue = ''; }
});

// ---------------------------------------------------------------------------
// Laden mit einheitlichem Muster: erster Aufruf „Lade …“, danach bleibt der alte Stand gedimmt stehen.
// Fehler erscheinen an Ort und Stelle mit „Erneut versuchen“ (nicht als falscher Leerzustand).

function loadingEl(text) { return h('div', { class: 'loading', role: 'status', text: text || 'Lade …' }); }
function emptyEl(text, extra) { return h('div', { class: 'empty' }, h('p', { text }), extra || null); }
function errorEl(text, err, retry) {
  const msg = err && err.message ? `${text}: ${err.message}` : text;
  const btn = retry ? h('button', { class: 'btn sm', type: 'button', text: 'Erneut versuchen' }) : null;
  if (btn) btn.addEventListener('click', () => busy(btn, retry));
  return h('div', { class: 'load-error', role: 'alert' }, h('span', { text: msg }), btn);
}

function setStamp(ok, el) {
  const s = el || state.stamp;
  if (!s || !s.isConnected) return;
  if (ok) {
    const now = Date.now();
    s.textContent = 'Stand ' + tfHM.format(new Date(now));
    s.title = 'Daten geladen ' + dtfSec.format(new Date(now)) + '. Die Seite aktualisiert sich nicht von selbst.';
    s.classList.remove('bad');
  } else if (s.textContent) {
    s.classList.add('bad');
  }
}

// loader(box, fn, opts) → load(): fn liefert den neuen Inhalt (Node) oder wirft.
function loader(box, fn, { what = 'Inhalt', stamp } = {}) {
  let seq = 0;
  const load = async () => {
    const my = ++seq;
    const had = box.dataset.loaded === '1';
    box.setAttribute('aria-busy', 'true');
    if (had) box.classList.add('reloading');
    else replace(box, loadingEl());
    try {
      const content = await fn();
      if (my !== seq) return;
      replace(box, content);
      box.dataset.loaded = '1';
      setStamp(true, stamp);
    } catch (e) {
      if (my !== seq) return;
      if (had) {
        const old = box.querySelector(':scope > .load-error');
        if (old) old.remove();
        const s = stamp || state.stamp;
        box.prepend(errorEl(`Aktualisieren fehlgeschlagen${s && s.textContent ? ` – angezeigt wird der ${s.textContent}` : ''}`, e, load));
        setStamp(false, stamp);
      } else replace(box, errorEl(`${what} konnte nicht geladen werden`, e, load));
    } finally {
      if (my === seq) { box.classList.remove('reloading'); box.removeAttribute('aria-busy'); }
    }
  };
  return load;
}

// Nach einem Neuaufbau den Fokus an eine stabile Stelle zurückgeben (data-key an Zeilen)
function refocus(root, key, fallback) {
  let el = key ? root.querySelector(`[data-key="${CSS.escape(String(key))}"]`) : null;
  if (el && !el.matches('a[href], button, input, select, textarea, [tabindex]')) el = el.querySelector('a[href], button:not([disabled]), select, input');
  if (el) { el.focus({ preventScroll: false }); return true; }
  if (fallback) { fallback.focus({ preventScroll: true }); }
  return false;
}

// ---------------------------------------------------------------------------
// Overlay: Anmeldung und Einrichtung (lässt den Zustand der Seite unangetastet). Esc schließt es nicht.

const overlay = $('#overlay');
let overlayHeld = false;
let titleBeforeOverlay = null;

overlay.addEventListener('cancel', (e) => e.preventDefault());
// Rückfall für Browser ohne closedby="none": wird das Overlay trotzdem geschlossen, sofort wieder öffnen
overlay.addEventListener('close', () => { if (overlayHeld) { try { overlay.showModal(); } catch { /* egal */ } } });

function showOverlay(content, title) {
  overlayHeld = true;
  clear(overlay);
  overlay.append(content);
  overlay.setAttribute('aria-labelledby', 'auth-title');
  if (titleBeforeOverlay == null) titleBeforeOverlay = document.title;
  document.title = `${title} – Tandem Admin`;
  if (!overlay.open) overlay.showModal();
  raiseToasts();
}

function hideOverlay() {
  overlayHeld = false;
  if (overlay.open) overlay.close();
  clear(overlay);
  if (titleBeforeOverlay != null) { document.title = titleBeforeOverlay; titleBeforeOverlay = null; }
}

let loginPromise = null;

function requireLogin(reason) {
  if (!loginPromise) {
    const back = document.activeElement;
    loginPromise = new Promise((resolve) => showLogin(resolve, reason)).finally(() => {
      loginPromise = null;
      // Fokus an den Auslöser zurück (sobald er wieder bedienbar ist), sonst auf den Inhalt
      setTimeout(() => {
        if (back && back !== document.body && back.isConnected && !back.disabled) back.focus({ preventScroll: true });
        else main.focus({ preventScroll: true });
      }, 0);
    });
  }
  return loginPromise;
}

// Eingabefeld für sechsstellige Codes: Leerzeichen beim Einfügen entfernen
function totpInput(id) {
  const el = h('input', { class: 'input code', id, name: 'totp', inputmode: 'numeric', autocomplete: 'one-time-code', pattern: '[0-9]{6}', maxlength: '7', required: true, 'aria-describedby': 'auth-error' });
  el.addEventListener('input', () => {
    const v = el.value.replace(/\D/g, '').slice(0, 6);
    if (v !== el.value) el.value = v;
  });
  return el;
}

function markInvalid(fields, bad, err, text) {
  for (const f of fields) f.removeAttribute('aria-invalid');
  if (bad) { bad.setAttribute('aria-invalid', 'true'); bad.focus(); }
  err.textContent = text;
}

let lockTimer = null;
function showLogin(done, reason) {
  const err = h('div', { class: 'form-error', id: 'auth-error', role: 'alert' });
  const user = h('input', { class: 'input', id: 'l-user', name: 'username', autocomplete: 'username', required: true, autocapitalize: 'none', spellcheck: 'false', 'aria-describedby': 'auth-error' });
  const pass = h('input', { class: 'input', id: 'l-pass', type: 'password', name: 'password', autocomplete: 'current-password', required: true, 'aria-describedby': 'auth-error' });
  const totp = totpInput('l-totp');
  const fields = [user, pass, totp];
  for (const f of fields) f.addEventListener('input', () => f.removeAttribute('aria-invalid'));
  const submit = h('button', { class: 'btn primary', type: 'submit', text: 'Anmelden' });
  const sub = reason === 'expired' && state.me ? 'Die Sitzung ist abgelaufen. Nach der Anmeldung geht es an derselben Stelle weiter.'
    : reason === 'logout' ? 'Abgemeldet.' : null;
  const form = h('form', { class: 'auth', novalidate: true, onsubmit: async (e) => {
    e.preventDefault();
    if (submit.disabled) return;
    if (!user.value.trim()) return markInvalid(fields, user, err, 'Kennung eingeben.');
    if (!pass.value) return markInvalid(fields, pass, err, 'Passwort eingeben.');
    if (!/^\d{6}$/.test(totp.value.trim())) return markInvalid(fields, totp, err, 'Sechsstelligen Code aus der Authenticator-App eingeben.');
    markInvalid(fields, null, err, '');
    await busy(submit, async () => {
      try {
        const me = await api('login', { method: 'POST', noAuth: true, quiet: true, body: { user: user.value.trim(), password: pass.value, totp: totp.value.trim() } });
        setMe(me);
        hideOverlay();
        done(me);
      } catch (ex) {
        err.textContent = ex.message;
        totp.value = '';
        totp.focus();
        // Sperre: Knopf lokal bis zum Ablauf sperren (kein Netzverkehr)
        const m = ex.status === 429 && /in (\d+) min/.exec(ex.message);
        if (m) {
          const until = Date.now() + Number(m[1]) * 60000;
          err.textContent = `Zu viele Fehlversuche. Anmelden wieder ab ${tfHM.format(new Date(until))} Uhr möglich.`;
          setTimeout(() => { submit.disabled = true; }, 0);
          clearTimeout(lockTimer);
          lockTimer = setTimeout(() => { submit.disabled = false; err.textContent = ''; }, until - Date.now());
        }
      }
    }, 'Anmelden …');
  } },
    h('h1', { id: 'auth-title', text: 'Tandem Admin' }),
    sub ? h('p', { class: 'sub', text: sub }) : null,
    h('div', { class: 'field' }, h('label', { for: 'l-user', text: 'Kennung' }), user),
    h('div', { class: 'field' }, h('label', { for: 'l-pass', text: 'Passwort' }), pass),
    h('div', { class: 'field' }, h('label', { for: 'l-totp', text: 'Code aus der Authenticator-App' }), totp),
    err,
    submit,
  );
  if (state.me && state.me.user && reason !== 'logout') user.value = state.me.user.id;
  showOverlay(form, 'Anmelden');
  (user.value ? pass : user).focus();
}

const SETUP_CMD = (u) => `docker exec tandem /tandem-server admin setup ${u || '<kennung>'}`;

function setupInvalid(message) {
  const cmd = SETUP_CMD();
  showOverlay(h('div', { class: 'auth' },
    h('h1', { id: 'auth-title', text: 'Link ungültig oder abgelaufen' }),
    message ? h('p', { class: 'sub', text: message }) : null,
    h('p', { text: 'Einen neuen Link auf dem Server erzeugen:' }),
    h('div', { class: 'cmd' }, h('code', { text: cmd }), h('button', { class: 'btn sm', type: 'button', text: 'Kopieren', onclick: (e) => copyText(cmd, e.currentTarget) })),
    h('p', { class: 'back' }, h('a', { href: '#/', text: 'Zur Anmeldung', onclick: () => hideOverlay() })),
  ), 'Einrichten');
}

async function showSetup(code) {
  showOverlay(h('div', { class: 'auth' }, h('h1', { id: 'auth-title', text: 'Admin-Zugang einrichten' }), loadingEl('Link wird geprüft …')), 'Einrichten');
  let info;
  try { info = await api('setup/check', { method: 'POST', noAuth: true, quiet: true, body: { code } }); }
  catch (ex) {
    if (ex.status === 400 || ex.status === 404) { setupInvalid(); return; }
    replace(overlay, h('div', { class: 'auth' }, h('h1', { id: 'auth-title', text: 'Admin-Zugang einrichten' }), errorEl('Link konnte nicht geprüft werden', ex, () => showSetup(code))));
    return;
  }
  const userId = esc(info && info.user);
  const err = h('div', { class: 'form-error', id: 'auth-error', role: 'alert' });
  const p1 = h('input', { class: 'input', id: 's-p1', type: 'password', autocomplete: 'new-password', minlength: '12', required: true, 'aria-describedby': 'auth-error' });
  const p2 = h('input', { class: 'input', id: 's-p2', type: 'password', autocomplete: 'new-password', minlength: '12', required: true, 'aria-describedby': 'auth-error' });
  const submit = h('button', { class: 'btn primary', type: 'submit', text: 'Weiter' });
  const form = h('form', { class: 'auth', novalidate: true, onsubmit: async (e) => {
    e.preventDefault();
    if (p1.value.length < 12) return markInvalid([p1, p2], p1, err, 'Das Passwort braucht mindestens 12 Zeichen.');
    if (p1.value !== p2.value) return markInvalid([p1, p2], p2, err, 'Die Passwörter stimmen nicht überein.');
    markInvalid([p1, p2], null, err, '');
    await busy(submit, async () => {
      try {
        const r = await api('setup/start', { method: 'POST', noAuth: true, quiet: true, body: { code, password: p1.value } });
        showSetupStep2(code, r || {});
      } catch (ex) {
        if (ex.status === 400 && /ungültig oder abgelaufen/.test(ex.message)) setupInvalid();
        else err.textContent = ex.message;
      }
    });
  } },
    h('h1', { id: 'auth-title', text: 'Admin-Zugang einrichten' }),
    h('div', { class: 'steps' }, h('span', { class: 'cur', text: '1 Passwort' }), h('span', { 'aria-hidden': 'true', text: '›' }), h('span', { text: '2 Authenticator' })),
    h('p', { class: 'sub' }, 'Konto ', h('strong', { text: userId }), info && info.staged ? ' · schon begonnen, der Schlüssel bleibt gleich' : null),
    h('input', { class: 'sr', type: 'text', name: 'username', autocomplete: 'username', tabindex: '-1', 'aria-hidden': 'true', readOnly: true, value: userId }),
    h('div', { class: 'field' }, h('label', { for: 's-p1', text: 'Neues Passwort (mindestens 12 Zeichen)' }), p1),
    h('div', { class: 'field' }, h('label', { for: 's-p2', text: 'Passwort wiederholen' }), p2),
    err,
    submit,
    h('p', { class: 'back' }, h('a', { href: '#/', text: 'Abbrechen', onclick: () => hideOverlay() })),
  );
  for (const f of [p1, p2]) f.addEventListener('input', () => f.removeAttribute('aria-invalid'));
  showOverlay(form, 'Einrichten');
  p1.focus();
}

function showSetupStep2(code, r) {
  const err = h('div', { class: 'form-error', id: 'auth-error', role: 'alert' });
  const totp = totpInput('s-totp');
  const submit = h('button', { class: 'btn primary', type: 'submit', text: 'Einrichtung abschließen' });
  const secret = esc(r.secret);
  const qr = typeof r.qr === 'string' && r.qr.trim().includes('<svg')
    ? h('img', { class: 'qr', alt: 'QR-Code für die Authenticator-App', src: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(r.qr) })
    : h('p', { class: 'sub', text: 'Kein QR-Code erhalten – den Schlüssel von Hand in die App eintragen.' });
  const uri = typeof r.uri === 'string' && r.uri.startsWith('otpauth://') ? r.uri : null;
  const form = h('form', { class: 'auth', novalidate: true, onsubmit: async (e) => {
    e.preventDefault();
    if (!/^\d{6}$/.test(totp.value.trim())) return markInvalid([totp], totp, err, 'Sechsstelligen Code aus der App eingeben.');
    await busy(submit, async () => {
      try {
        const me = await api('setup/finish', { method: 'POST', noAuth: true, quiet: true, body: { code, totp: totp.value.trim() } });
        setMe(me);
        hideOverlay();
        history.replaceState(null, '', location.pathname + location.search + '#/');
        state.hash = '#/';
        toast('Admin-Zugang eingerichtet', 'ok');
        await render();
        main.focus({ preventScroll: true });
      } catch (ex) {
        if (ex.status === 400 && /ungültig oder abgelaufen|verbraucht/.test(ex.message)) { setupInvalid(ex.message); return; }
        err.textContent = ex.message;
        totp.value = '';
        totp.focus();
      }
    });
  } },
    h('h1', { id: 'auth-title', text: 'Admin-Zugang einrichten' }),
    h('div', { class: 'steps' }, h('span', { text: '1 Passwort' }), h('span', { 'aria-hidden': 'true', text: '›' }), h('span', { class: 'cur', text: '2 Authenticator' })),
    h('p', { class: 'sub' }, 'Konto ', h('strong', { text: esc(r.user) }), ': QR-Code scannen oder den Schlüssel eintragen, dann den angezeigten Code bestätigen.'),
    qr,
    uri ? h('p', { class: 'center' }, h('a', { class: 'btn sm', href: uri, rel: 'noreferrer', text: 'In Authenticator-App öffnen' })) : null,
    h('div', { class: 'field' },
      h('span', { class: 'label', text: 'Schlüssel' }),
      h('div', { class: 'secret' }, h('code', { text: secret ? secret.replace(/(.{4})/g, '$1 ').trim() : '–' }), secret ? h('button', { class: 'btn sm', type: 'button', text: 'Kopieren', onclick: (e) => copyText(secret, e.currentTarget) }) : null)),
    h('div', { class: 'field' }, h('label', { for: 's-totp', text: 'Code aus der App' }), totp),
    err,
    submit,
    h('p', { class: 'back' }, h('a', { href: '#/', text: 'Abbrechen', onclick: () => hideOverlay() })),
  );
  showOverlay(form, 'Einrichten');
  totp.focus();
}

// ---------------------------------------------------------------------------
// Dialoge

// openDialog({title, body, buttons:[{label, value, kind, left, default, onClick(close, btn), ref, disabled, busyLabel}], wide, onOpen, cancelValue, lock})
// lock() → true: Esc/× sind gesperrt (z. B. während einer laufenden Anfrage)
function openDialog({ title, body, buttons = [], wide = false, onOpen, cancelValue = null, lock, describedBy }) {
  return new Promise((resolve) => {
    let result = cancelValue;
    let running = false;
    const locked = () => running || (lock && lock());
    const close = (v) => { result = v === undefined ? cancelValue : v; dlg.close(); };
    const foot = h('div', { class: 'dlg-foot' });
    const btnEls = [];
    for (const b of buttons) {
      const btn = h('button', { class: 'btn ' + (b.kind || '') + (b.left ? ' left' : ''), type: 'button', text: b.label, disabled: !!b.disabled });
      btn.addEventListener('click', async () => {
        if (b.onClick) {
          running = true;
          try { await busy(btn, async () => { await b.onClick(close, btn); }, b.busyLabel); } finally { running = false; }
        } else close(b.value);
      });
      if (b.ref) b.ref(btn);
      btnEls.push(btn);
      foot.append(btn);
    }
    const titleId = nextId('dlg-t');
    const xBtn = h('button', { class: 'btn ghost icon', type: 'button', 'aria-label': 'Schließen', text: '×', onclick: () => { if (!locked()) close(cancelValue); } });
    const form = h('form', { method: 'dialog', onsubmit: (e) => {
      e.preventDefault();
      // Enter: Standard-Knopf (default) bzw. Primärknopf, sofern aktiv
      let i = buttons.findIndex((b) => b.default);
      if (i < 0) i = buttons.findIndex((b) => b.kind && b.kind.includes('primary'));
      if (i >= 0 && !btnEls[i].disabled) btnEls[i].click();
    } },
      h('div', { class: 'dlg-head' }, h('h2', { id: titleId, text: title }), xBtn),
      h('div', { class: 'dlg-body' }, body),
      buttons.length ? foot : null,
    );
    // Enter in einem Textfeld bestätigt (auch bei mehreren Feldern, die Knöpfe sind type=button)
    form.addEventListener('keydown', (e) => {
      const t = e.target;
      if (e.key === 'Enter' && !e.isComposing && t.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'file', 'color'].includes(t.type)) { e.preventDefault(); form.requestSubmit(); }
    });
    const dlg = h('dialog', { class: 'dlg' + (wide ? ' wide' : ''), 'aria-labelledby': titleId, 'aria-describedby': describedBy || null }, form);
    dlg.addEventListener('close', () => { dlg.remove(); resolve(result); });
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); if (!locked()) close(cancelValue); });
    if (!onOpen && btnEls[0]) btnEls[0].autofocus = true;
    document.body.append(dlg);
    dlg.showModal();
    raiseToasts();
    if (onOpen) onOpen(dlg, close);
  });
}

function closeDialogs() {
  for (const d of document.querySelectorAll('dialog.dlg[open]')) d.close();
}

function confirmDialog(title, message, { okLabel = 'OK', danger = false } = {}) {
  return openDialog({
    title,
    body: typeof message === 'string' ? h('p', { text: message }) : message,
    buttons: [
      { label: 'Abbrechen', value: false },
      { label: okLabel, value: true, kind: danger ? 'danger solid' : 'primary' },
    ],
    cancelValue: false,
  });
}

// Bestätigung mit Abtippen eines Wortes; Enter bestätigt, sobald es stimmt
function typedConfirm(title, message, word, okLabel) {
  const id = nextId('tc');
  const input = h('input', { class: 'input mono', id, autocomplete: 'off', spellcheck: 'false' });
  let okBtn = null;
  input.addEventListener('input', () => { if (okBtn) okBtn.disabled = input.value !== word; });
  return openDialog({
    title,
    body: frag(
      typeof message === 'string' ? h('p', { text: message }) : message,
      h('div', { class: 'field' }, h('label', { for: id }, 'Zur Bestätigung ', h('code', { text: word }), ' eingeben'), input),
    ),
    buttons: [
      { label: 'Abbrechen', value: false },
      { label: okLabel, value: true, kind: 'danger solid', disabled: true, default: true, ref: (b) => { okBtn = b; } },
    ],
    cancelValue: false,
    onOpen: () => input.focus(),
  });
}

// promptDialog(title, {label, value, placeholder, mono, hint, okLabel, validate(v) → Fehlertext|null, selectBase, intro})
function promptDialog(title, o = {}) {
  const id = nextId('pd');
  const errId = id + '-err';
  const input = h('input', { class: 'input' + (o.mono ? ' mono' : ''), id, value: o.value || '', placeholder: o.placeholder || '', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': errId + (o.hint ? ' ' + id + '-hint' : '') });
  const err = h('div', { class: 'form-error', id: errId, role: 'alert' });
  input.addEventListener('input', () => { err.textContent = ''; input.removeAttribute('aria-invalid'); });
  return openDialog({
    title,
    body: frag(
      o.intro ? (typeof o.intro === 'string' ? h('p', { text: o.intro }) : o.intro) : null,
      h('div', { class: 'field' }, h('label', { for: id, text: o.label || '' }), input, o.hint ? h('span', { class: 'hint', id: id + '-hint', text: o.hint }) : null, err),
    ),
    buttons: [
      { label: 'Abbrechen', value: null },
      { label: o.okLabel || 'OK', kind: 'primary', onClick: async (close) => {
        const v = input.value.trim();
        const problem = o.validate ? o.validate(v) : (v ? null : 'Bitte einen Wert eingeben.');
        if (problem) { err.textContent = problem; input.setAttribute('aria-invalid', 'true'); input.focus(); return; }
        if (o.submit) {
          try { await o.submit(v); } catch (ex) { err.textContent = ex.message; input.focus(); return; }
        }
        close(v);
      } },
    ],
    onOpen: () => {
      input.focus();
      if (o.selectBase && input.value) {
        const b = basename(input.value);
        const start = input.value.length - b.length;
        const dot = b.lastIndexOf('.');
        input.setSelectionRange(start, dot > 0 ? start + dot : input.value.length);
      } else input.select();
    },
  });
}

// Rückfrage beim Verlassen mit ungespeicherten Änderungen → 'discard' | 'save' | null
function leaveDialog() {
  return openDialog({
    title: 'Ungespeicherte Änderungen',
    body: h('p', { text: 'Die geöffnete Notiz hat Änderungen, die noch nicht gespeichert sind.' }),
    buttons: [
      { label: 'Zurück', value: null },
      { label: 'Verwerfen', value: 'discard', kind: 'danger' },
      { label: 'Speichern und weiter', value: 'save', kind: 'primary' },
    ],
    cancelValue: null,
  });
}
// true = darf weiter
async function confirmLeave() {
  if (!isDirty()) return true;
  const c = await leaveDialog();
  if (c === 'discard') { state.dirtyCheck = null; return true; }
  if (c === 'save' && state.saveDirty) return !!(await state.saveDirty());
  return false;
}

// Kontextmenü an einem Element
function showMenu(anchor, items, at) {
  closeMenu();
  const menu = h('div', { class: 'menu', role: 'menu' });
  for (const it of items) {
    if (!it) continue;
    if (it === '-') { menu.append(h('hr')); continue; }
    menu.append(h('button', { type: 'button', role: 'menuitem', class: it.danger ? 'danger' : '', text: it.label, disabled: !!it.disabled, title: it.title || null, onclick: () => { closeMenu(); it.onClick(); } }));
  }
  document.body.append(menu);
  const r = at ? { left: at.x, right: at.x, top: at.y, bottom: at.y } : anchor.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  let left = r.left, top = r.bottom + 2;
  if (left + mw > window.innerWidth - 8) left = Math.max(8, Math.min(r.right, window.innerWidth) - mw);
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 2);
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
  anchor.setAttribute('aria-expanded', 'true');
  activeMenu = { menu, anchor };
  const first = menu.querySelector('button:not([disabled])');
  if (first) first.focus();
  setTimeout(() => {
    document.addEventListener('pointerdown', onMenuOutside, true);
    document.addEventListener('keydown', onMenuKey, true);
  }, 0);
}

// „…“-Knopf, der ein Menü öffnet
function menuButton(label, items, opts = {}) {
  const b = h('button', { class: 'btn ' + (opts.sm === false ? '' : 'sm ') + 'icon more-btn', type: 'button', 'aria-label': label, 'aria-haspopup': 'menu', 'aria-expanded': 'false', title: opts.title || label, text: opts.text || '…' });
  b.addEventListener('click', () => showMenu(b, typeof items === 'function' ? items() : items));
  return b;
}

let activeMenu = null;
function onMenuOutside(e) { if (activeMenu && !activeMenu.menu.contains(e.target)) closeMenu(); }
function onMenuKey(e) {
  if (!activeMenu) return;
  const btns = [...activeMenu.menu.querySelectorAll('button:not([disabled])')];
  const i = btns.indexOf(document.activeElement);
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); const a = activeMenu.anchor; closeMenu(); a.focus(); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); btns[(i + 1) % btns.length].focus(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); btns[(i - 1 + btns.length) % btns.length].focus(); }
  else if (e.key === 'Home') { e.preventDefault(); btns[0].focus(); }
  else if (e.key === 'End') { e.preventDefault(); btns[btns.length - 1].focus(); }
  else if (e.key === 'Tab') closeMenu();
}
function closeMenu() {
  if (!activeMenu) return;
  activeMenu.menu.remove();
  if (activeMenu.anchor) activeMenu.anchor.setAttribute('aria-expanded', 'false');
  activeMenu = null;
  document.removeEventListener('pointerdown', onMenuOutside, true);
  document.removeEventListener('keydown', onMenuKey, true);
}

// ---------------------------------------------------------------------------
// Router

const main = $('#main');
let vaultCtx = null;  // aktive Vault-Ansicht (behält Baum und Editor zwischen Dateiwechseln und Tabs)
let backupCtx = null; // aktive Sicherungs-Detailansicht (behält den Dateivergleich)

const routes = [
  [/^#\/?$/, 'overview', () => viewOverview()],
  [/^#\/vaults\/?$/, 'vaults', () => viewVaults()],
  [/^#\/vault\/([^/?]+)(?:\/([^/?]*))?\/?$/, 'vaults', (m) => viewVault(dec(m[1]), m[2] ? dec(m[2]) : '')],
  [/^#\/users(?:\/([^/?]+))?\/?$/, 'users', (m) => viewUsers(m[1] ? dec(m[1]) : null)],
  [/^#\/backups\/?$/, 'backups', () => viewBackups()],
  [/^#\/backups\/([^/?]+)(?:\/([^/?]+))?(?:\/([^/?]+))?\/?$/, 'backups', (m) => viewBackup(dec(m[1]), m[2] ? dec(m[2]) : null, m[3] ? dec(m[3]) : null)],
  [/^#\/stats\/?$/, 'stats', () => viewStats()],
  [/^#\/audit\/?(?:\?(.*))?$/, 'audit', (m) => viewAudit(new URLSearchParams(m[1] || ''))],
  [/^#\/account\/?$/, 'account', () => viewAccount()],
];

function navigate(hash) { if (location.hash !== hash) location.hash = hash; else render(); }
// Hash ändern ohne neu zu rendern (z. B. Filter im Protokoll)
function setHashQuiet(hash) { if (location.hash !== hash) { history.replaceState(null, '', location.pathname + location.search + hash); state.hash = hash; } }

window.addEventListener('hashchange', async () => {
  const next = location.hash;
  if (!next.startsWith('#/') && !next.startsWith('#setup=')) {
    // z. B. Sprunglink „#main“: keine Route
    if (next === '#main') main.focus();
    history.replaceState(null, '', location.pathname + location.search + state.hash);
    return;
  }
  if (next !== state.hash && isDirty() && !vaultKeepsEditor(next)) {
    // Erst zurück auf die alte Route, dann fragen
    history.replaceState(null, '', location.pathname + location.search + state.hash);
    if (!(await confirmLeave())) return;
    state.hash = next;
    history.replaceState(null, '', location.pathname + location.search + next);
    render();
    return;
  }
  state.hash = next;
  render();
});

// Beim Wechsel zwischen Tabs desselben Vaults bleibt der Editor erhalten.
function vaultKeepsEditor(nextHash) {
  if (!vaultCtx) return false;
  const m = nextHash.match(/^#\/vault\/([^/]+)(?:\/([^/]*))?\/?$/);
  if (!m || dec(m[1]) !== vaultCtx.space) return false;
  const sub = m[2] ? dec(m[2]) : '';
  return VAULT_TABS.includes(sub) || (vaultCtx.doc && sub === vaultCtx.doc.id);
}

function setNav(name) {
  const nav = $('#nav');
  for (const a of nav.children) {
    if (a.dataset.route === name) {
      a.setAttribute('aria-current', 'page');
      // aktiven Eintrag in der (mobil scrollbaren) Navigation sichtbar machen
      if (nav.scrollWidth > nav.clientWidth) a.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    } else a.removeAttribute('aria-current');
  }
  nav.classList.toggle('overflowing', nav.scrollWidth > nav.clientWidth + 1);
}

async function render() {
  closeMenu();
  closeDialogs();
  const hash = state.hash || '#/';
  if (hash.startsWith('#setup=')) {
    showSetup(hash.slice('#setup='.length));
    return;
  }
  if (!state.me) {
    try { setMe(await api('me')); } catch { return; }
  }
  const first = !state.rendered;
  state.rendered = true;
  for (const [re, nav, fn] of routes) {
    const m = hash.match(re);
    if (m) {
      setNav(nav);
      const keepVault = re === routes[2][0] && vaultCtx && dec(m[1]) === vaultCtx.space && main.contains(vaultCtx.root);
      const keepBackup = nav === 'backups' && m[1] !== undefined && backupCtx && backupCtx.name === dec(m[1]) && main.contains(backupCtx.root);
      if (!keepVault) { vaultCtx = null; state.dirtyCheck = null; state.saveDirty = null; }
      if (!keepBackup) backupCtx = null;
      await fn(m);
      // Neue Seite: Fokus auf die Überschrift (Screenreader hören den Wechsel), nicht beim ersten Laden
      const ae = document.activeElement;
      if (!first && !keepVault && !keepBackup && (!ae || ae === document.body || ae === main || !main.contains(ae))) {
        window.scrollTo(0, 0);
        const h1 = main.querySelector('h1');
        if (h1) { h1.tabIndex = -1; h1.focus({ preventScroll: true }); }
      }
      return;
    }
  }
  vaultCtx = null; backupCtx = null;
  state.dirtyCheck = null;
  setNav('');
  clear(main);
  main.append(h('div', { class: 'page' }, h('div', { class: 'page-head' }, h('h1', { text: 'Seite nicht gefunden', tabindex: '-1' })), h('p', {}, h('a', { href: '#/', text: 'Zur Übersicht' }))));
  document.title = 'Nicht gefunden – Tandem Admin';
}

function page(title, headExtra, ...body) {
  clear(main);
  state.stamp = h('span', { class: 'meta stamp', 'aria-live': 'polite' });
  const head = h('div', { class: 'page-head' }, h('h1', { text: title }), state.stamp, headExtra);
  const el = h('div', { class: 'page' }, head, ...body);
  main.append(el);
  document.title = `${title} – Tandem Admin`;
  return el;
}

function refreshButton(fn) {
  const b = h('button', { class: 'btn', type: 'button', text: 'Aktualisieren' });
  b.addEventListener('click', () => busy(b, fn, 'Aktualisiere …'));
  return b;
}

// table(headers, rows, {empty, caption, cls, cols}) – leere Kopfzellen heißen für Screenreader „Aktionen“
function table(headers, rows, opts = {}) {
  const thead = h('thead', {}, h('tr', {}, headers.map((hd) => {
    const o = typeof hd === 'string' ? { text: hd } : hd;
    return h('th', { class: o.class || null, scope: 'col' }, o.text ? o.text : h('span', { class: 'sr', text: o.sr || 'Aktionen' }));
  })));
  const tbody = h('tbody', {}, rows);
  if (!rows.length) tbody.append(h('tr', {}, h('td', { colspan: String(headers.length) }, emptyEl(opts.empty || 'Keine Einträge'))));
  return h('div', { class: 'table-wrap' }, h('table', { class: 'table' + (opts.cls ? ' ' + opts.cls : '') },
    opts.caption ? h('caption', { class: 'sr', text: opts.caption }) : null,
    opts.cols ? h('colgroup', {}, opts.cols.map((c) => h('col', { class: c }))) : null,
    thead, tbody));
}

function stat(v, l, sub, opts = {}) {
  const inner = [h('div', { class: 'v' + (opts.tone ? ' ' + opts.tone : ''), text: v }), h('div', { class: 'l', text: l }), sub ? h('div', { class: 'sub', text: sub, title: sub }) : null];
  return opts.href ? h('a', { class: 'stat link', href: opts.href }, inner) : h('div', { class: 'stat' }, inner);
}

function card(title, extra, ...body) {
  return h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', { text: title }), extra || null), ...body);
}

const ROLES = ['read', 'write', 'owner'];
function roleLabel(r) { return { owner: 'Verwalten', write: 'Schreiben', read: 'Lesen' }[r] || esc(r) || '–'; }
const ROLE_HINT = 'Lesen: nur ansehen · Schreiben: bearbeiten · Verwalten: zusätzlich in Obsidian einladen';
function roleSelect(value, label = 'Rolle') {
  const sel = h('select', { class: 'select', 'aria-label': label, title: ROLE_HINT }, ROLES.map((r) => h('option', { value: r, text: roleLabel(r) })));
  sel.value = ROLES.includes(value) ? value : 'read';
  return sel;
}

// Auswahlfeld, das erst die endgültige Wahl speichert (Pfeiltasten lösen sonst bei jedem Schritt aus)
function commitSelect(sel, commit) {
  let last = sel.value, timer = null, running = false;
  const run = async () => {
    clearTimeout(timer);
    if (running || sel.value === last) return;
    running = true;
    sel.setAttribute('aria-busy', 'true');
    const want = sel.value;
    try { await commit(want, last); last = want; }
    catch { sel.value = last; }
    finally { running = false; sel.removeAttribute('aria-busy'); if (sel.value !== last) run(); }
  };
  sel.addEventListener('change', () => { clearTimeout(timer); timer = setTimeout(run, 700); });
  sel.addEventListener('blur', run);
  sel.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); run(); } });
  return sel;
}

// Mitgliedschaft setzen/ändern (PUT) oder entfernen (DELETE)
function setMember(space, user, role, opts) { return api(`spaces/${enc(space)}/members/${enc(user)}`, { method: 'PUT', body: { role }, ...(opts || {}) }); }
function removeMember(space, user) { return api(`spaces/${enc(space)}/members/${enc(user)}`, { method: 'DELETE' }); }

const KIND_LABEL = { md: 'Notiz', ink: 'Handschrift', blob: 'Anhang', text: 'Notiz' };
const IMG_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'ico']);
const AUDIO_EXT = new Set(['mp3', 'ogg', 'oga', 'wav', 'm4a', 'flac', 'aac', 'opus']);
const VIDEO_EXT = new Set(['mp4', 'webm', 'mov', 'm4v', 'ogv']);
const TEXT_EXT = new Set(['base', 'canvas', 'json', 'yaml', 'yml', 'csv', 'tsv', 'css', 'js', 'mjs', 'ts', 'xml', 'html', 'htm', 'ini', 'toml', 'log', 'txt']);

// ---------------------------------------------------------------------------
// Sicherungs-Zustand (Übersicht und Sicherungsseite)

const DAY = 86400;
function isSafety(b) { return !!(b && b.kind === 'manual' && typeof b.label === 'string' && b.label.startsWith('vor wiederherstellung')); }
function backupTitle(b) {
  if (!b) return '–';
  if (isSafety(b)) return 'Sicherheitskopie';
  if (b.label) return b.label;
  return b.kind === 'auto' ? `Automatisch, ${fmtDateUTC(b.created)}` : `Von Hand, ${fmtAbs(b.created)}`;
}
// Datum einer Sicherung: automatische tragen nur ein Datum (Mitternacht UTC), manuelle eine echte Uhrzeit
function backupWhen(b) { return b.kind === 'auto' ? fmtDateUTC(b.created) : fmtAbs(b.created); }
function backupAge(b) {
  // automatische: ab Ende des Tages gerechnet wäre zu optimistisch – Erstellung kurz nach 0 Uhr UTC
  return Date.now() / 1000 - Number(b.created);
}

// → {text, sub, tone:'ok'|'warn'|'danger', warn:string|null}
function backupHealth(b) {
  if (!b) return null;
  const last = b.last || null, lastAuto = b.lastAuto || null;
  if (!last) return { text: 'Noch keine Sicherung', sub: b.auto ? 'die erste entsteht innerhalb der nächsten Stunde' : 'automatische Sicherung ist aus', tone: 'danger', warn: b.auto ? null : 'Es gibt noch keine Sicherung, und die automatische Sicherung ist aus.' };
  const lastText = last.kind === 'auto' ? `${fmtDateUTC(last.created)} (automatisch)` : `${fmtRel(last.created)} (von Hand)`;
  const countText = plural(b.count, 'Sicherung', 'Sicherungen');
  if (b.auto) {
    if (!lastAuto) return { text: lastText, sub: `automatisch täglich · ${countText}`, tone: 'ok', warn: null };
    const age = backupAge(lastAuto);
    if (age > 26 * 3600) { // created = Mitternacht UTC; die nächste entsteht bis ca. 01:00 UTC des Folgetags
      const days = Math.floor(age / DAY);
      return { text: lastText, sub: `automatisch täglich · ${countText}`, tone: 'warn', warn: `Die letzte automatische Sicherung ist ${days} ${days === 1 ? 'Tag' : 'Tage'} alt. Im Server-Log nach „Sicherung“ suchen.` };
    }
    return { text: lastText, sub: `automatisch täglich · ${countText}`, tone: 'ok', warn: null };
  }
  const age = backupAge(last);
  const days = Math.floor(age / DAY);
  return { text: lastText, sub: `automatische Sicherung aus · ${countText}`, tone: 'warn', warn: age > 7 * DAY ? `Automatische Sicherungen sind aus, die letzte Sicherung ist ${days} Tage alt.` : 'Automatische Sicherungen sind aus.' };
}

async function backupNow(btn, onDone) {
  return busy(btn, async () => {
    const b = await api('backups', { method: 'POST', body: {} });
    toast('Sicherung angelegt', 'ok', { href: `#/backups/${enc(b.name)}`, linkText: 'Ansehen' });
    if (onDone) await onDone(b);
  }, 'Sichere …');
}

// ---------------------------------------------------------------------------
// Übersicht

async function viewOverview() {
  const body = h('div', { class: 'overview' });
  const load = loader(body, async () => {
    const [d, s24] = await Promise.all([api('overview', { quiet: true }), api('stats?range=24h', { quiet: true }).catch(() => null), loadUsers(true).catch(() => []), loadSpaces(true).catch(() => [])]);
    return renderOverview(d || {}, s24, load);
  }, { what: 'Die Übersicht' });
  page('Übersicht', refreshButton(load), body);
  await load();
}

function renderOverview(d, s24, reload) {
  const st = d.store || {};
  const online = Array.isArray(d.online) ? d.online : [];
  const att = d.attention || {};
  const health = backupHealth(d.backup);
  const out = frag();

  // --- Hinweise (nur was Handlung braucht)
  const notes = [];
  for (const v of (att.vaultsWithoutMembers || [])) notes.push(h('li', {}, 'Vault ', h('a', { href: `#/vault/${enc(v.id)}/_members`, text: `„${esc(v.name || v.id)}“` }), ' hat keine Mitglieder'));
  const stale = Array.isArray(att.staleDevices) ? att.staleDevices : [];
  if (stale.length) notes.push(h('li', {}, h('a', { href: '#/users', text: plural(stale.length, 'Gerät', 'Geräte') }), ' seit über 30 Tagen nicht verbunden', h('span', { class: 'dim', text: ` (${stale.slice(0, 3).map((s) => `${esc(s.device) || 'ohne Namen'} · ${esc(s.name || s.user)}`).join(', ')}${stale.length > 3 ? ', …' : ''})` })));
  if (Number(att.revokedDevices) > 0) notes.push(h('li', {}, h('a', { href: '#/users', text: plural(att.revokedDevices, 'gesperrtes Gerät', 'gesperrte Geräte') }), ' – lassen sich unter „Personen“ aufräumen'));
  if (Number(att.failedLogins24h) > 0) notes.push(h('li', {}, h('a', { href: '#/audit?cat=failed&period=1', text: plural(att.failedLogins24h, 'fehlgeschlagene Anmeldung', 'fehlgeschlagene Anmeldungen') }), ' in 24 h'));
  if (health && health.warn) notes.unshift(h('li', {}, health.warn, ' ', h('a', { href: '#/backups', text: 'Sicherungen' })));

  // --- Zustand
  const up = d.startedAt ? Date.now() / 1000 - Number(d.startedAt) : null;
  const backupBtn = health && health.tone !== 'ok' ? h('button', { class: 'btn sm', type: 'button', text: 'Jetzt sichern' }) : null;
  if (backupBtn) backupBtn.addEventListener('click', () => backupNow(backupBtn, reload));
  out.append(h('section', { class: 'card state', 'aria-label': 'Zustand' },
    h('div', { class: 'state-grid' },
      h('div', { class: 'cell' },
        h('div', { class: 'l', text: 'Server' }),
        h('div', { class: 'v' }, h('span', { class: 'tone ok', 'aria-hidden': 'true' }), up != null ? `Läuft seit ${fmtDuration(up)}` : 'Läuft'),
        h('div', { class: 'sub' }, `Version ${esc(d.version) || '–'} · ${d.rssKib != null ? fmtBytes(Number(d.rssKib) * 1024) : '–'} RAM`)),
      h('div', { class: 'cell' },
        h('div', { class: 'l' }, h('a', { href: '#/backups', text: 'Sicherung' })),
        health
          ? frag(h('div', { class: 'v' }, h('span', { class: 'tone ' + health.tone, 'aria-hidden': 'true' }), health.text), h('div', { class: 'sub ' + (health.tone !== 'ok' ? health.tone : '') }, health.sub), backupBtn)
          : h('div', { class: 'v dim', text: '–' })),
      h('div', { class: 'cell' },
        h('div', { class: 'l', text: 'Hinweise' }),
        notes.length
          ? frag(h('div', { class: 'v' }, h('span', { class: 'tone warn', 'aria-hidden': 'true' }), notes.length === 1 ? '1 Hinweis' : `${notes.length} Hinweise`), h('ul', { class: 'notes' }, notes.slice(0, 5)), notes.length > 5 ? h('div', { class: 'sub', text: `und ${notes.length - 5} weitere` }) : null)
          : h('div', { class: 'v' }, h('span', { class: 'tone ok', 'aria-hidden': 'true' }), 'Keine')),
    )));

  // --- Gerade online | Zuletzt geändert
  const recent = s24 && Array.isArray(s24.recent) ? s24.recent : null;
  out.append(h('div', { class: 'grid-2' },
    card(`Gerade online${online.length ? ` (${fmtNum(online.length)})` : ''}`, null,
      online.length ? h('ul', { class: 'rows' }, online.map((o) => onlineRow(o))) : emptyEl('Niemand verbunden')),
    card('Zuletzt geändert', h('a', { href: '#/stats', text: 'Alle' }),
      recent == null ? emptyEl('Nicht verfügbar')
        : recent.length ? h('ul', { class: 'rows' }, recent.slice(0, 6).map((r) => h('li', { class: 'row2' },
          h('div', { class: 'main' }, h('a', { class: 'file-link', href: `#/vault/${enc(r.space)}/${enc(r.doc)}`, title: esc(r.path), text: displayName(esc(r.path) || esc(r.doc)) }),
            h('span', { class: 'dim small ell', text: [dirname(esc(r.path)), spaceName(String(r.space))].filter(Boolean).join(' · ') })),
          h('div', { class: 'side' }, timeEl(r.updated)))))
          : emptyEl('In den letzten 24 Stunden nichts geändert')),
  ));

  // --- Letzte 24 Stunden
  out.append(s24 ? overviewStatsCard(s24) : card('Letzte 24 Stunden', h('a', { href: '#/stats', text: 'Statistik' }), emptyEl('Statistik nicht verfügbar')));

  // --- Server
  out.append(card('Server', null, h('div', { class: 'card-body' }, h('dl', { class: 'kv' },
    h('dt', { text: 'Version' }), h('dd', {}, h('code', { text: esc(d.version) || '–' })),
    h('dt', { text: 'Laufzeit' }), h('dd', {}, up != null ? fmtDuration(up) : '–', d.startedAt ? h('span', { class: 'dim', text: ` · seit ${fmtAbs(d.startedAt)}` }) : null),
    h('dt', { text: 'Arbeitsspeicher' }), h('dd', { text: d.rssKib != null ? fmtBytes(Number(d.rssKib) * 1024) : '–' }),
    h('dt', { text: 'Speicher' }), h('dd', { text: `${fmtBytes(d.dbBytes)} Datenbank · ${fmtBytes(st.blob_bytes)} Anhänge` }),
    h('dt', { text: 'Inhalt' }), h('dd', {},
      h('a', { href: '#/users', text: plural(st.users, 'Person', 'Personen') }), ' · ',
      h('a', { href: '#/vaults', text: plural(st.spaces, 'Vault', 'Vaults') }), ' · ',
      plural(st.docs, 'Dokument', 'Dokumente'), ' · ', plural(st.blobs, 'Anhang', 'Anhänge')),
  ))));
  return out;
}

function onlineRow(o) {
  const files = (Array.isArray(o.files) ? o.files : []).filter((f) => f && f.doc);
  const names = files.map((f) => h('a', { href: `#/vault/${enc(f.space)}/${enc(f.doc)}`, title: `${esc(f.path) || f.doc} · ${spaceName(f.space)}`, text: f.path ? displayName(f.path) : f.doc }));
  const shown = [];
  names.slice(0, 2).forEach((n, i) => { if (i) shown.push(', '); shown.push(n); });
  if (names.length > 2) shown.push(` und ${names.length - 2} weitere`);
  const slow = Number(o.rttMs) > 300;
  return h('li', { class: 'row2' },
    h('div', { class: 'main' },
      h('span', {}, colorDot(o.color), h('span', { title: esc(o.user), text: esc(o.name || o.user) }), h('span', { class: 'dim', text: ` · ${esc(o.device) || 'Gerät ohne Namen'}` }),
        slow ? h('span', { class: 'warn-text', text: ` · ${fmtMs(o.rttMs)}` }) : null),
      h('span', { class: 'dim small ell' }, names.length ? frag('Geöffnet: ', shown) : 'Keine Datei geöffnet')),
    h('div', { class: 'side' }, o.since ? h('span', { class: 'dim', title: fmtAbs(o.since, true), text: 'seit ' + fmtSpan(Date.now() / 1000 - Number(o.since)) }) : null));
}

// Kompakte 24-h-Zusammenfassung (Daten aus GET stats?range=24h)
function overviewStatsCard(s) {
  const k = statsKpis(s);
  const series = Array.isArray(s.series) ? s.series : [];
  const t = s.total || {};
  const now = Number(s.now) || Date.now() / 1000;
  const active = (Array.isArray(s.users) ? s.users : []).filter((u) => u && u.id !== 'admin-web' && Number(u.updates) > 0);
  const activeNames = active.map((u) => { const x = userById(u.id); return x ? (x.name || x.id) : u.id; });
  const head = h('a', { href: '#/stats', text: 'Statistik' });
  if (!(Number(t.updates) > 0) && !(Array.isArray(s.devices) && s.devices.length)) {
    return card('Letzte 24 Stunden', head, h('p', { class: 'card-body quiet', text: 'Keine Aktivität in den letzten 24 Stunden.' }));
  }
  // immer 24 Stundenbalken in Ortszeit (Punkte können unterschiedlich lang sein)
  const end = new Date(now * 1000); end.setMinutes(0, 0, 0);
  const startH = end.getTime() / 1000 - 23 * 3600;
  const buckets = new Array(24).fill(0);
  for (const p of series) {
    const ts = Number(p.ts), dur = Number(p.dur) > 0 ? Number(p.dur) : (Number(s.step) || 60), v = Number(p.updates) || 0;
    if (!v) continue;
    // auf die Stunden verteilen, die der Punkt abdeckt
    const a = ts, b = ts + dur;
    for (let i = 0; i < 24; i++) {
      const ha = startH + i * 3600, hb = ha + 3600;
      const ov = Math.min(b, hb) - Math.max(a, ha);
      if (ov > 0) buckets[i] += v * (ov / dur);
    }
  }
  const peak = buckets.reduce((m, v, i) => (v > buckets[m] ? i : m), 0);
  const ts = buckets.map((_, i) => startH + i * 3600);
  const label = `Änderungen je Stunde, letzte 24 Stunden; Spitze ${fmtNum(buckets[peak])} um ${fmtTime(ts[peak])} Uhr`;
  const spark = chart({ ts, dur: ts.map(() => 3600), from: startH, to: startH + 24 * 3600, kind: 'bar', height: 52, mini: true, format: fmtNum, label,
    series: [{ name: 'Änderungen', slot: 1, values: buckets.map((v) => Math.round(v)) }] });
  return h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', { text: 'Letzte 24 Stunden' }), head),
    h('div', { class: 'stat-grid four', role: 'group', 'aria-label': 'Letzte 24 Stunden' },
      stat(k.updates, 'Änderungen', null),
      stat(k.traffic, 'Datenverkehr', `${fmtBytes(t.bytesIn)} rein · ${fmtBytes(t.bytesOut)} raus`),
      stat(k.rtt, 'Ping-Laufzeit', k.rttNow ? `jetzt ${k.rttNow}` : null),
      stat(fmtNum(active.length), active.length === 1 ? 'Aktive Person' : 'Aktive Personen', activeNames.slice(0, 4).join(', ') + (activeNames.length > 4 ? ' …' : ''))),
    h('a', { class: 'spark', href: '#/stats', 'aria-label': label },
      h('div', { class: 'spark-l dim small', 'aria-hidden': 'true' }, h('span', { text: 'Änderungen je Stunde' })),
      spark,
      h('div', { class: 'spark-x dim small', 'aria-hidden': 'true' }, h('span', { text: 'vor 24 h' }), h('span', { text: 'jetzt' }))));
}

// ---------------------------------------------------------------------------
// Vaults (Liste)

async function viewVaults() {
  const body = h('div', { class: 'card' });
  let list = [];
  let focusKey = null;
  const load = loader(body, async () => {
    const r = await api('spaces', { quiet: true });
    list = (Array.isArray(r) ? r : []).slice().sort((a, b) => coll.compare(a.name || a.id, b.name || b.id));
    state.spaces = list;
    return renderVaultList(list);
  }, { what: 'Die Vault-Liste' });
  const reload = async (key) => { focusKey = key || null; await load(); if (focusKey) refocus(body, focusKey, main.querySelector('h1')); };

  function renderVaultList(rows) {
    if (!rows.length) return emptyEl('Noch keine Vaults.', h('button', { class: 'btn', type: 'button', text: 'Neuer Vault', onclick: () => createBtn.click() }));
    return table(
      ['Vault', 'Mitglieder', { text: 'Dateien', class: 'num hide-sm' }, { text: 'Anhänge', class: 'num hide-sm' }, { text: 'Letzte Änderung', class: 'hide-sm' }, { text: 'Geräte online', class: 'num hide-sm' }, { text: '', class: 'actions' }],
      rows.map((s) => {
        const st = s.stats || {};
        const members = Array.isArray(s.members) ? s.members : [];
        const more = menuButton(`Aktionen für ${esc(s.name || s.id)}`, () => vaultMenu(s, { onChange: (key) => reload(key) }));
        return h('tr', { dataset: { key: s.id } },
          h('td', {},
            h('a', { class: 'row-link', href: `#/vault/${enc(s.id)}` }, nameWithId(s.name || s.id, s.id)),
            h('div', { class: 'dim small show-sm', text: `${plural(st.docs, 'Datei', 'Dateien')} · ${st.updated ? fmtRel(st.updated) : 'noch nie geändert'}` })),
          h('td', {}, members.length
            ? h('span', { class: 'members-cell' }, memberChips(members, 3), h('a', { class: 'manage', href: `#/vault/${enc(s.id)}/_members`, 'aria-label': `Mitglieder von ${esc(s.name || s.id)} verwalten`, text: 'Verwalten' }))
            : h('a', { class: 'warn-link', href: `#/vault/${enc(s.id)}/_members`, text: 'Niemand – Mitglied hinzufügen' })),
          h('td', { class: 'num hide-sm', text: fmtNum(st.docs) }),
          h('td', { class: 'num hide-sm', text: Number(st.blobs) > 0 ? `${fmtNum(st.blobs)} · ${fmtBytes(st.blobBytes)}` : '–' }),
          h('td', { class: 'hide-sm' }, timeEl(st.updated, { none: 'noch nie' })),
          h('td', { class: 'num hide-sm', title: plural(s.online ?? 0, 'Gerät verbunden', 'Geräte verbunden'), text: Number(s.online) > 0 ? fmtNum(s.online) : '–' }),
          h('td', { class: 'actions' }, more),
        );
      }), { caption: 'Vaults', cls: 'vaults' });
  }

  const createBtn = h('button', { class: 'btn primary', type: 'button', text: 'Neuer Vault' });
  createBtn.addEventListener('click', async () => {
    const id = await newVaultDialog(list);
    if (id) { toast('Vault angelegt – jetzt Mitglieder hinzufügen', 'ok'); navigate(`#/vault/${enc(id)}/_members`); }
  });
  page('Vaults', frag(refreshButton(load), createBtn), body);
  await load();
}

// Aktionen für einen ganzen Vault (Liste und Vault-Kopf)
function vaultMenu(s, { onChange, onDelete } = {}) {
  return [
    { label: 'Umbenennen …', onClick: () => renameVault(s, onChange) },
    { label: 'Exportieren (.tar)', onClick: () => exportVault(s.id) },
    { label: 'Aus Sicherung wiederherstellen …', onClick: () => navigate(`#/vault/${enc(s.id)}/_backups`) },
    '-',
    { label: 'Vault löschen …', danger: true, onClick: () => deleteVault(s, onDelete || (() => onChange && onChange(null))) },
  ];
}

async function renameVault(s, onChange) {
  const name = await promptDialog('Vault umbenennen', { label: 'Name', value: s.name || '', okLabel: 'Speichern', hint: `Die Kennung „${s.id}“ bleibt, verbundene Geräte merken nichts.`,
    submit: async (v) => { if (v !== s.name) await api(`spaces/${enc(s.id)}`, { method: 'PATCH', body: { name: v }, quiet: true }); } });
  if (name == null || name === s.name) return;
  s.name = name;
  toast('Umbenannt', 'ok');
  if (onChange) await onChange(s.id);
}

async function deleteVault(s, after) {
  const st = s.stats || {};
  const members = Array.isArray(s.members) ? s.members : [];
  const facts = [];
  if (Number(st.docs) > 0) facts.push(h('dt', { text: 'Dateien' }), h('dd', { text: fmtNum(st.docs) }));
  if (Number(st.blobs) > 0) facts.push(h('dt', { text: 'Anhänge' }), h('dd', { text: `${fmtNum(st.blobs)} · ${fmtBytes(st.blobBytes)}` }));
  if (members.length) facts.push(h('dt', { text: 'Mitglieder' }), h('dd', { text: members.map((m) => m.name || m.id).join(', ') }));
  if (Number(s.online) > 0) facts.push(h('dt', { text: 'Verbunden' }), h('dd', { text: plural(s.online, 'Gerät wird getrennt', 'Geräte werden getrennt') }));
  const ok = await typedConfirm('Vault löschen', frag(
    h('p', {}, h('strong', { text: esc(s.name || s.id) }), ' wird mit allen Notizen und dem gesamten Verlauf vom Server gelöscht. Ältere Sicherungen behalten ihren Stand, die Anhänge bleiben dafür erhalten.'),
    facts.length ? h('dl', { class: 'kv compact' }, facts) : null,
    h('p', {}, h('button', { class: 'linkish', type: 'button', text: 'Vorher exportieren (.tar)', onclick: () => exportVault(s.id) })),
  ), s.id, 'Endgültig löschen');
  if (!ok) return;
  await api(`spaces/${enc(s.id)}`, { method: 'DELETE', body: { confirm: s.id } });
  toast('Vault gelöscht', 'ok');
  if (after) await after();
}

async function newVaultDialog(existing) {
  const name = h('input', { class: 'input', id: 'nv-name', autocomplete: 'off', placeholder: 'z. B. Projekt Y' });
  const id = h('input', { class: 'input mono', id: 'nv-id', autocomplete: 'off', spellcheck: 'false', placeholder: 'z. B. projekt-y', 'aria-describedby': 'nv-id-hint nv-err' });
  const err = h('div', { class: 'form-error', id: 'nv-err', role: 'alert' });
  let idTouched = false;
  name.addEventListener('input', () => { if (!idTouched) id.value = slugify(name.value); err.textContent = ''; });
  id.addEventListener('input', () => { idTouched = id.value !== ''; err.textContent = ''; });
  return openDialog({
    title: 'Neuer Vault',
    body: frag(
      h('div', { class: 'field' }, h('label', { for: 'nv-name', text: 'Name' }), name),
      h('div', { class: 'field' }, h('label', { for: 'nv-id', text: 'Kennung' }), id, h('span', { class: 'hint', id: 'nv-id-hint', text: 'a–z, 0–9, _ und -; wird in Obsidian als „Space“ eingetragen und lässt sich später nicht ändern.' })),
      err,
    ),
    buttons: [
      { label: 'Abbrechen', value: null },
      { label: 'Anlegen', kind: 'primary', onClick: async (close) => {
        const i = id.value.trim(), n = name.value.trim();
        if (!n) { err.textContent = 'Name fehlt.'; name.focus(); return; }
        if (!/^[a-z0-9_-]{1,64}$/.test(i)) { err.textContent = 'Kennung: nur a–z, 0–9, _ und -.'; id.focus(); return; }
        const dup = (existing || []).find((s) => s.id === i);
        if (dup) { err.textContent = `Die Kennung „${i}“ ist schon vergeben (Vault „${dup.name || dup.id}“).`; id.focus(); return; }
        try { await api('spaces', { method: 'POST', body: { id: i, name: n }, quiet: true }); close(i); }
        catch (ex) { err.textContent = ex.status === 409 ? `Die Kennung „${i}“ ist schon vergeben.` : ex.message; }
      } },
    ],
    onOpen: () => name.focus(),
    cancelValue: null,
  });
}

function memberChips(members, max = 99) {
  if (!members.length) return h('span', { class: 'dim', text: '–' });
  const shown = members.slice(0, max);
  return h('span', { class: 'chips' },
    shown.map((m) => h('span', { class: 'chip', title: `${esc(m.name || m.id)} · ${roleLabel(m.role)}` }, m.color ? colorDot(m.color) : null, esc(m.name || m.id), m.role && m.role !== 'write' ? h('span', { class: 'role', text: roleLabel(m.role) }) : null)),
    members.length > max ? h('span', { class: 'chip more', title: members.slice(max).map((m) => m.name || m.id).join(', '), text: `+${members.length - max}` }) : null);
}

// ---------------------------------------------------------------------------
// Personen: Vault-Zugriff, Geräte, Einladungen

const usersUi = { open: new Set(), q: '', filter: 'all' };

function deviceStale(d) { const t = Number(d.lastSeen || d.created); return !d.online && t > 0 && Date.now() / 1000 - t > 30 * DAY; }

async function viewUsers(focusId) {
  const list = h('div', { class: 'people' });
  const box = h('div');
  let users = [], spaces = [];
  if (focusId) usersUi.open.add(focusId);
  const countEl = h('span', { class: 'dim small count', 'aria-live': 'polite' });
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Name, Kennung oder Gerät', 'aria-label': 'Personen filtern', autocomplete: 'off', value: usersUi.q });
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Anzeigen' });
  const FILTERS = [['all', 'Alle'], ['online', 'Online'], ['novault', 'Ohne Vault'], ['devices', 'Alte/gesperrte Geräte']];
  for (const [k, l] of FILTERS) seg.append(h('button', { class: 'btn sm', type: 'button', 'aria-pressed': String(usersUi.filter === k), dataset: { k }, text: l, onclick: () => { usersUi.filter = k; for (const b of seg.children) b.setAttribute('aria-pressed', String(b.dataset.k === k)); renderList(); } }));
  search.addEventListener('input', () => { usersUi.q = search.value; renderList(); });

  const cleanupBtn = h('button', { class: 'btn', type: 'button', text: 'Geräte aufräumen' });
  cleanupBtn.addEventListener('click', async () => { if (await cleanupDialog(users)) await reload(); });

  const matches = (u) => {
    const devs = Array.isArray(u.devices) ? u.devices : [];
    if (usersUi.filter === 'online' && !devs.some((d) => d.online)) return false;
    if (usersUi.filter === 'novault' && (Array.isArray(u.spaces) ? u.spaces : []).length) return false;
    if (usersUi.filter === 'devices' && !devs.some((d) => d.revoked || deviceStale(d) || d.lastSeen == null)) return false;
    const q = usersUi.q.trim().toLowerCase();
    if (!q) return true;
    return [u.id, u.name, ...devs.map((d) => d.device)].some((x) => String(x || '').toLowerCase().includes(q));
  };

  function renderList() {
    const shown = users.filter(matches);
    countEl.textContent = shown.length === users.length ? plural(users.length, 'Person', 'Personen') : `${fmtNum(shown.length)} von ${plural(users.length, 'Person', 'Personen')}`;
    clear(list);
    if (!users.length) { list.append(emptyEl('Noch keine Personen.')); return; }
    if (!shown.length) { list.append(emptyEl('Keine Person passt zum Filter.')); return; }
    for (const u of shown) list.append(personEl(u, spaces, reload));
    // Aufräum-Kandidaten im Knopf zeigen (ohne Netz berechnet)
    const cand = cleanupCandidates(users, true, 90).length;
    cleanupBtn.textContent = cand ? `Geräte aufräumen · ${cand}` : 'Geräte aufräumen';
  }

  const load = loader(box, async () => {
    [users, spaces] = await Promise.all([loadUsers(), loadSpaces()]);
    users = users.slice().sort((a, b) => {
      const me = state.me && state.me.user ? state.me.user.id : null;
      if (a.id === me) return -1;
      if (b.id === me) return 1;
      return coll.compare(a.name || a.id, b.name || b.id);
    });
    renderList();
    return frag(h('div', { class: 'people-tools' }, search, seg, countEl), h('div', { class: 'card' }, list));
  }, { what: 'Die Personenliste' });

  async function reload(key) {
    await load();
    if (key) refocus(list, key, main.querySelector('h1'));
  }

  const createBtn = h('button', { class: 'btn primary', type: 'button', text: 'Neue Person' });
  createBtn.addEventListener('click', async () => {
    const r = await userDialog(null, spaces);
    if (!r) return;
    usersUi.open.add(r.id);
    usersUi.q = ''; search.value = ''; usersUi.filter = 'all';
    for (const b of seg.children) b.setAttribute('aria-pressed', String(b.dataset.k === 'all'));
    await reload('person:' + r.id);
    const el = list.querySelector(`[data-key="person:${CSS.escape(r.id)}"]`);
    if (el) { el.closest('.person').classList.add('fresh'); el.scrollIntoView({ block: 'center' }); }
    if (r.invite) { const u = users.find((x) => x.id === r.id); if (u) await inviteDialog(u, spaces, reload); }
  });
  page('Personen', frag(refreshButton(() => reload()), cleanupBtn, createBtn), box);
  await load();
  if (focusId) {
    const el = list.querySelector(`[data-key="person:${CSS.escape(focusId)}"]`);
    if (el) { el.scrollIntoView({ block: 'start' }); el.focus({ preventScroll: true }); }
  }
}

function personEl(u, spaces, reload) {
  const devices = Array.isArray(u.devices) ? u.devices : [];
  const memberships = Array.isArray(u.spaces) ? u.spaces : [];
  const who = esc(u.name || u.id);
  const isMe = !!(state.me && state.me.user && state.me.user.id === u.id);
  const onlineN = devices.filter((d) => d.online).length;
  const lastSeen = devices.reduce((m, d) => Math.max(m, d.online ? Date.now() / 1000 : Number(d.lastSeen) || 0), 0);
  const open = usersUi.open.has(u.id);
  const detailsId = nextId('person');

  const toggle = h('button', { class: 'person-toggle', type: 'button', 'aria-expanded': String(open), 'aria-controls': detailsId, dataset: { key: 'person:' + u.id } },
    h('span', { class: 'chev', 'aria-hidden': 'true', text: '▸' }),
    avatar(u),
    h('span', { class: 'pw' }, h('span', { class: 'name', text: who }), u.name && u.name.toLowerCase() !== u.id ? h('span', { class: 'dim id', text: esc(u.id) }) : null));
  const badges = h('span', { class: 'badges' },
    u.admin ? h('span', { class: 'badge accent', text: 'Admin' }) : null,
    isMe ? h('span', { class: 'badge', text: 'Das bin ich' }) : null);
  const summary = h('div', { class: 'person-sum' },
    memberships.length ? memberChips(memberships.map((s) => ({ id: s.id, name: s.name || s.id, role: s.role })), 3) : h('span', { class: 'warn-text small', text: 'kein Vault' }),
    h('span', { class: 'dim small' },
      devices.length ? `${plural(devices.length, 'Gerät', 'Geräte')}${onlineN ? ` · ${fmtNum(onlineN)} online` : ''}` : 'kein Gerät',
      lastSeen && !onlineN ? ` · zuletzt ${fmtRel(lastSeen)}` : ''),
    onlineN ? colorDot(null, 'online') : null);

  const details = h('div', { class: 'person-details', id: detailsId, hidden: !open });
  const build = () => {
    if (details.firstChild) return;
    details.append(personDetails(u, spaces, reload, { who, isMe, devices, memberships }));
  };
  if (open) build();
  toggle.addEventListener('click', () => {
    const now = toggle.getAttribute('aria-expanded') !== 'true';
    toggle.setAttribute('aria-expanded', String(now));
    if (now) { build(); usersUi.open.add(u.id); } else usersUi.open.delete(u.id);
    details.hidden = !now;
  });

  const actions = h('div', { class: 'person-actions' },
    h('button', { class: 'btn sm', type: 'button', text: 'Gerät einladen', 'aria-label': `Gerät für ${who} einladen`, onclick: (e) => busy(e.currentTarget, () => inviteDialog(u, spaces, reload)) }),
    menuButton(`Weitere Aktionen für ${who}`, () => [
      { label: 'Bearbeiten …', onClick: async () => { if (await userDialog(u, spaces)) { toast('Gespeichert', 'ok'); await reload('person:' + u.id); } } },
      { label: 'Protokoll dieser Person', onClick: () => navigate(`#/audit?user=${enc(u.id)}`) },
      isMe ? null : '-',
      isMe ? null : { label: 'Person löschen …', danger: true, onClick: () => deletePerson(u, devices, memberships, reload) },
    ]));

  return h('section', { class: 'person', 'aria-label': who, id: 'person-' + u.id },
    h('div', { class: 'person-head' }, toggle, badges, summary, actions),
    details);
}

async function deletePerson(u, devices, memberships, reload) {
  const who = esc(u.name || u.id);
  const parts = [];
  if (devices.length) parts.push(`${plural(devices.length, 'Gerät verliert', 'Geräte verlieren')} den Zugang`);
  if (memberships.length) parts.push(`Zugriff auf ${plural(memberships.length, 'Vault', 'Vaults')} entfällt`);
  const ok = await confirmDialog('Person löschen', h('p', {}, h('strong', { text: who }), ` wird gelöscht${parts.length ? ': ' + parts.join(', ') : ''}. Notizen und Verlauf in den Vaults bleiben erhalten.`), { okLabel: 'Löschen', danger: true });
  if (!ok) return;
  await api(`users/${enc(u.id)}`, { method: 'DELETE' });
  usersUi.open.delete(u.id);
  toast('Person gelöscht', 'ok');
  await reload();
}

function personDetails(u, spaces, reload, { who, isMe, devices, memberships }) {
  const online = devices.some((d) => d.online);
  // --- Vaults: Rolle ändern, entfernen, hinzufügen
  const memberIds = new Set(memberships.map((s) => s.id));
  const vaultRows = memberships.map((s) => {
    const sname = esc(s.name || s.id);
    const sel = commitSelect(roleSelect(s.role, `Rolle in ${sname}`), async (role) => {
      await setMember(s.id, u.id, role);
      s.role = role;
      toast(`${who}: jetzt „${roleLabel(role)}“ in ${sname}${online ? '. Die Geräte verbinden sich neu.' : ''}`, 'ok');
    });
    const rm = h('button', { class: 'btn sm', type: 'button', text: 'Entfernen', 'aria-label': `${who} aus ${sname} entfernen` });
    rm.addEventListener('click', async () => {
      const self = isMe ? ' Deine eigenen Geräte verlieren damit den Zugriff.' : '';
      const ok = await confirmDialog('Zugriff entziehen', `${who} verliert den Zugriff auf „${sname}“, verbundene Geräte werden getrennt. Lokale Kopien bleiben auf den Geräten.${self}`, { okLabel: 'Zugriff entziehen', danger: true });
      if (!ok) return;
      await busy(rm, async () => { await removeMember(s.id, u.id); toast(`${who} aus „${sname}“ entfernt`, 'ok'); await reload('add:' + u.id); });
    });
    return h('tr', {},
      h('td', {}, h('a', { class: 'row-link', href: `#/vault/${enc(s.id)}` }, nameWithId(s.name || s.id, s.id))),
      h('td', {}, sel),
      h('td', { class: 'actions' }, rm));
  });
  const candidates = spaces.filter((s) => s && !memberIds.has(s.id));
  let addRow;
  if (candidates.length) {
    const addSel = h('select', { class: 'select', 'aria-label': 'Vault', dataset: { key: 'add:' + u.id } }, candidates.map((s) => h('option', { value: s.id, text: esc(s.name || s.id) })));
    const addRole = roleSelect('write', 'Rolle im neuen Vault');
    const addBtn = h('button', { class: 'btn sm', type: 'button', text: 'Hinzufügen' });
    addBtn.addEventListener('click', () => busy(addBtn, async () => {
      await setMember(addSel.value, u.id, addRole.value);
      toast(`${who} hat jetzt Zugriff auf „${esc(spaceName(addSel.value, spaces))}“`, 'ok');
      await reload('add:' + u.id);
    }));
    addRow = h('div', { class: 'add-row' }, h('label', { class: 'lbl', text: 'Zugriff geben:' }), addSel, addRole, addBtn);
  } else {
    addRow = h('p', { class: 'dim small' }, spaces.length ? 'Hat Zugriff auf alle Vaults.' : frag('Es gibt noch keinen Vault – unter ', h('a', { href: '#/vaults', text: 'Vaults' }), ' anlegen.'));
  }
  const vaultsSection = h('section', { class: 'person-section', 'aria-label': `Vaults von ${who}` },
    h('h3', { text: `Vaults (${fmtNum(memberships.length)})` }),
    memberships.length
      ? table(['Vault', 'Rolle', { text: '', class: 'actions' }], vaultRows, { cls: 'controls', cols: ['c-name', 'c-role', 'c-act'] })
      : h('p', { class: 'warn-note', text: 'Noch kein Vault-Zugriff. Ohne Vault sieht die Person nach dem Verbinden keine Dateien.' }),
    addRow,
    memberships.length ? h('p', { class: 'dim small', text: ROLE_HINT }) : null);

  // --- Geräte (gestapelte Zeilen, keine Querscroll-Tabelle)
  const devSection = h('section', { class: 'person-section', 'aria-label': `Geräte von ${who}` },
    h('h3', { text: `Geräte (${fmtNum(devices.length)})` }),
    devices.length
      ? h('ul', { class: 'devices' }, devices.slice().sort((a, b) => (b.online - a.online) || (a.revoked - b.revoked) || (Number(b.lastSeen) || 0) - (Number(a.lastSeen) || 0)).map((d) => deviceRow(d, u, reload)))
      : h('p', { class: 'dim small', text: 'Noch kein Gerät verbunden – mit „Gerät einladen“ einen Code erzeugen.' }));

  return h('div', { class: 'person-grid' }, vaultsSection, devSection);
}

function deviceRow(d, u, reload) {
  const name = esc(d.device) || 'Gerät ohne Namen';
  const who = esc(u.name || u.id);
  const key = 'dev:' + d.id;
  const status = d.revoked ? h('span', { class: 'badge', text: 'gesperrt' })
    : d.online ? h('span', { class: 'ok-text', text: `online${d.rttMs != null ? ' · ' + fmtMs(d.rttMs) : ''}`, title: d.rttMs != null ? 'Ping-Laufzeit gerade' : null })
    : d.lastSeen == null ? h('span', { class: 'dim', text: 'noch nie verbunden' })
    : h('span', { class: deviceStale(d) ? 'warn-text' : 'dim' }, 'zuletzt verbunden ', timeEl(d.lastSeen));
  const actions = [];
  if (d.revoked) {
    const un = h('button', { class: 'btn sm', type: 'button', text: 'Sperre aufheben', 'aria-label': `Sperre von ${name} aufheben`, dataset: { key } });
    un.addEventListener('click', () => busy(un, async () => { await api(`devices/${enc(d.id)}/unrevoke`, { method: 'POST' }); toast(`„${name}“ kann sich wieder verbinden`, 'ok'); await reload(key); }));
    actions.push(un);
  }
  const del = h('button', { class: 'btn sm', type: 'button', text: 'Entfernen', 'aria-label': `${name} entfernen`, dataset: d.revoked ? null : { key } });
  del.addEventListener('click', async () => {
    const msg = d.revoked
      ? `Der gesperrte Eintrag „${name}“ von ${who} wird endgültig entfernt.`
      : `„${name}“ von ${who} wird endgültig entfernt${d.online ? ' und sofort getrennt' : ''}. Für einen neuen Zugang braucht es einen Einladungscode.`;
    const choice = await openDialog({
      title: 'Gerät entfernen',
      body: frag(h('p', { text: msg }), d.revoked ? null : h('p', { class: 'dim small', text: '„Nur sperren“ trennt das Gerät ebenfalls, behält aber den Eintrag. Die Sperre lässt sich später aufheben.' })),
      buttons: [
        { label: 'Abbrechen', value: null },
        d.revoked ? null : { label: 'Nur sperren', value: 'revoke' },
        { label: 'Entfernen', value: 'delete', kind: 'danger solid' },
      ].filter(Boolean),
    });
    if (!choice) return;
    await busy(del, async () => {
      if (choice === 'revoke') { await api(`devices/${enc(d.id)}/revoke`, { method: 'POST' }); toast(`„${name}“ gesperrt`, 'ok'); await reload(key); }
      else { await api(`devices/${enc(d.id)}`, { method: 'DELETE' }); toast(`„${name}“ entfernt`, 'ok'); await reload('person:' + u.id); }
    });
  });
  actions.push(del);
  return h('li', { class: 'device' + (d.revoked ? ' revoked' : '') },
    h('div', { class: 'main' },
      h('span', { class: 'name' }, colorDot(null, d.online ? 'online' : 'offline'), h('span', { text: name }), d.online ? h('span', { class: 'sr', text: ' (online)' }) : null),
      h('span', { class: 'small' }, status, h('span', { class: 'dim', title: `Geräte-ID ${esc(d.id)}`, text: ` · eingerichtet ${dfShort.format(new Date(toMs(d.created) || Date.now()))}` }))),
    h('div', { class: 'acts' }, actions));
}

const COLORS = ['#e5534b', '#e66100', '#c88a00', '#2ec27e', '#1a9fb2', '#3584e4', '#6457c8', '#9141ac', '#c64600', '#5e5c64'];

// Person anlegen/bearbeiten; beim Anlegen gleich Vaults zuweisen → {id, invite} | null
async function userDialog(u, spaces) {
  const name = h('input', { class: 'input', id: 'u-name', value: u ? (u.name || '') : '', autocomplete: 'off', placeholder: 'z. B. Anna Schmidt', 'aria-describedby': 'u-err' });
  const id = h('input', { class: 'input mono', id: 'u-id', value: u ? u.id : '', disabled: !!u, autocomplete: 'off', spellcheck: 'false', placeholder: 'z. B. anna', 'aria-describedby': 'u-id-hint u-err' });
  const err = h('div', { class: 'form-error', id: 'u-err', role: 'alert' });
  let idTouched = !!u;
  name.addEventListener('input', () => { if (!idTouched) id.value = slugify(name.value.split(/\s+/)[0] || ''); err.textContent = ''; });
  id.addEventListener('input', () => { idTouched = id.value !== ''; err.textContent = ''; });
  // Farbe: feste Auswahl plus eigene; bei neuen Personen eine noch nicht vergebene vorschlagen
  const used = new Set((state.users || []).map((x) => (x.color || '').toLowerCase()));
  let color = u && /^#[0-9a-f]{6}$/i.test(u.color || '') ? u.color.toLowerCase() : (COLORS.find((c) => !used.has(c)) || COLORS[0]);
  const custom = h('input', { class: 'input', type: 'color', id: 'u-color', value: color, 'aria-label': 'Eigene Farbe' });
  const swatches = h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Farbe' });
  const paint = () => {
    for (const b of swatches.querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.c === color));
    custom.value = color;
  };
  for (const c of COLORS) {
    const b = setColorVar(h('button', { class: 'swatch', type: 'button', role: 'radio', 'aria-label': c, dataset: { c }, onclick: () => { color = c; paint(); } }), c);
    swatches.append(b);
  }
  custom.addEventListener('input', () => { color = custom.value.toLowerCase(); paint(); });
  swatches.append(custom);
  paint();
  const picks = (!u && Array.isArray(spaces) ? spaces : []).map((s) => {
    const cb = h('input', { type: 'checkbox', id: nextId('u-v') });
    const sel = roleSelect('write', `Rolle in ${esc(s.name || s.id)}`);
    sel.disabled = true;
    cb.addEventListener('change', () => { sel.disabled = !cb.checked; });
    return { s, cb, sel, el: h('div', { class: 'pick' }, cb, h('label', { for: cb.id, text: esc(s.name || s.id) }), sel) };
  });
  const vaultField = u ? null : h('fieldset', { class: 'field picks' },
    h('legend', { text: 'Zugriff auf Vaults' }),
    picks.length ? picks.map((p) => p.el) : h('span', { class: 'hint', text: 'Noch kein Vault vorhanden – der Zugriff lässt sich später zuweisen.' }),
    picks.length ? h('span', { class: 'hint', text: ROLE_HINT }) : null);
  let created = null;
  const res = await openDialog({
    title: u ? 'Person bearbeiten' : 'Neue Person',
    body: frag(
      h('div', { class: 'field' }, h('label', { for: 'u-name', text: 'Name' }), name),
      h('div', { class: 'field' }, h('label', { for: 'u-id', text: 'Kennung' }), id, u ? null : h('span', { class: 'hint', id: 'u-id-hint', text: 'a–z, 0–9, _ und -; lässt sich später nicht ändern.' })),
      h('div', { class: 'field' }, h('span', { class: 'label', text: 'Farbe' }), swatches),
      vaultField,
      err,
    ),
    buttons: [
      { label: 'Abbrechen', value: null },
      { label: u ? 'Speichern' : 'Anlegen', kind: 'primary', onClick: async (close) => {
        const i = id.value.trim(), n = name.value.trim();
        if (!n) { err.textContent = 'Name fehlt.'; name.focus(); return; }
        if (!u && !/^[a-z0-9_-]{1,64}$/.test(i)) { err.textContent = 'Kennung: nur a–z, 0–9, _ und -.'; id.focus(); return; }
        if (!u && (state.users || []).some((x) => x.id === i)) { err.textContent = `Die Kennung „${i}“ ist schon vergeben.`; id.focus(); return; }
        const body = { name: n, color };
        try {
          if (u) await api(`users/${enc(u.id)}`, { method: 'PATCH', body, quiet: true });
          else await api('users', { method: 'POST', body: { id: i, ...body }, quiet: true });
        } catch (ex) { err.textContent = ex.status === 409 ? `Die Kennung „${i}“ ist schon vergeben.` : ex.message; return; }
        const failed = [];
        for (const p of picks) {
          if (!p.cb.checked) continue;
          try { await setMember(p.s.id, i, p.sel.value, { quiet: true }); } catch { failed.push(p.s.name || p.s.id); }
        }
        if (u) { close({ id: u.id }); return; }
        created = { id: i, name: n, vaults: picks.filter((p) => p.cb.checked).map((p) => `${p.s.name || p.s.id} · ${roleLabel(p.sel.value)}`), failed };
        close({ id: i });
      } },
    ],
    onOpen: () => name.focus(),
    cancelValue: null,
  });
  if (!res || u) return res;
  // Erfolgsansicht mit dem nächsten Schritt
  const next = await openDialog({
    title: 'Person angelegt',
    body: frag(
      h('p', {}, h('strong', { text: created.name }), ' ist angelegt.'),
      h('dl', { class: 'kv compact' }, h('dt', { text: 'Zugriff' }), h('dd', { text: created.vaults.length ? created.vaults.join(', ') : 'noch kein Vault' })),
      created.failed.length ? h('p', { class: 'warn-note', text: `Zuweisung fehlgeschlagen: ${created.failed.join(', ')}` }) : null,
      h('p', { class: 'dim small', text: 'Damit ein Gerät sich verbinden kann, braucht es einen Einladungscode.' })),
    buttons: [
      { label: 'Fertig', value: 'done' },
      { label: 'Einladungscode erzeugen', value: 'invite', kind: 'primary' },
    ],
    cancelValue: 'done',
  });
  return { id: res.id, invite: next === 'invite' };
}

// Einladungscode; ohne Vault-Zugriff vorher einen Vault zuweisen lassen
async function inviteDialog(u, spaces, reload) {
  const who = esc(u.name || u.id);
  let memberships = Array.isArray(u.spaces) ? u.spaces.slice() : [];
  let changed = false;
  const hoursSel = h('select', { class: 'select', id: 'inv-hours' },
    h('option', { value: '24', text: '1 Tag' }), h('option', { value: '72', text: '3 Tage', selected: true }), h('option', { value: '168', text: '7 Tage' }));
  hoursSel.value = '72';
  const space = h('select', { class: 'select', id: 'inv-space' }, spaces.map((s) => h('option', { value: s.id, text: esc(s.name || s.id) })));
  const role = roleSelect('write'); role.id = 'inv-role';
  const needsVault = !memberships.length && spaces.length;
  const choice = await openDialog({
    title: `Gerät für ${who} einladen`,
    body: frag(
      needsVault ? frag(
        h('p', { class: 'warn-note' }, h('strong', { text: who }), ' hat noch keinen Vault-Zugriff. Ein Gerät könnte sich verbinden, sähe aber keine Dateien.'),
        h('div', { class: 'field' }, h('label', { for: 'inv-space', text: 'Vault' }), space),
        h('div', { class: 'field' }, h('label', { for: 'inv-role', text: 'Rolle' }), role)) : null,
      h('div', { class: 'field' }, h('label', { for: 'inv-hours', text: 'Gültigkeit des Codes' }), hoursSel),
    ),
    buttons: [
      { label: 'Abbrechen', value: null },
      needsVault ? { label: 'Ohne Vault erzeugen', value: 'none', left: true } : null,
      { label: needsVault ? 'Zuweisen und Code erzeugen' : 'Code erzeugen', kind: 'primary', onClick: async (close) => {
        if (needsVault) {
          try { await setMember(space.value, u.id, role.value); } catch { return; }
          memberships = [{ id: space.value, name: spaceName(space.value, spaces), role: role.value }];
          changed = true;
        }
        close('go');
      } },
    ].filter(Boolean),
    onOpen: () => (needsVault ? space : hoursSel).focus(),
  });
  if (choice == null) { if (changed) await reload(); return; }
  let r;
  try { r = await api(`users/${enc(u.id)}/invite`, { method: 'POST', body: { hours: Number(hoursSel.value) } }); }
  catch { if (changed) await reload(); return; }
  const code = esc(r && r.code);
  const hours = Number(r && r.hours) || Number(hoursSel.value);
  const server = location.origin;
  const vaultIds = memberships.map((m) => m.id);
  const guide = `Tandem einrichten:\n1. In Obsidian → Einstellungen → Tandem\n2. Server: ${server}\n3. Einladungscode: ${code} → „Einlösen“\n4. Space: ${vaultIds.join(' oder ') || '(noch kein Vault)'}\nDer Code gilt ${hours >= 48 ? Math.round(hours / 24) + ' Tage' : hours + ' Stunden'} und nur einmal.`;
  await openDialog({
    title: `Einladungscode für ${who}`,
    body: frag(
      h('div', { class: 'code-big', text: code || '–' }),
      h('dl', { class: 'kv compact invite' },
        h('dt', { text: 'Server' }), h('dd', {}, h('code', { text: server })),
        h('dt', { text: 'Space' }), h('dd', {}, memberships.length
          ? memberships.map((m, i) => frag(i ? ', ' : null, h('code', { text: m.id }), h('span', { class: 'dim', text: ` (${(m.name || m.id).toLowerCase() === m.id ? '' : esc(m.name) + ' · '}${roleLabel(m.role)})` })))
          : h('span', { class: 'warn-text', text: 'kein Vault – das Gerät sieht keine Dateien' })),
        h('dt', { text: 'Gültig' }), h('dd', { text: `${hours >= 48 ? Math.round(hours / 24) + ' Tage' : hours + ' Stunden'}, einmal einlösbar` })),
      h('p', { class: 'dim small', text: 'In Obsidian unter Einstellungen → Tandem: Server eintragen, Code einlösen und als „Space“ die Vault-Kennung wählen.' }),
    ),
    buttons: [
      { label: 'Anleitung kopieren', left: true, onClick: (_c, b) => copyText(guide, b) },
      { label: 'Code kopieren', onClick: (_c, b) => copyText(code, b) },
      { label: 'Fertig', kind: 'primary', value: true },
    ],
  });
  if (changed) await reload();
}

// Kandidaten fürs Aufräumen – wie der Server: verbundene, nicht gesperrte Geräte bleiben immer
function cleanupCandidates(users, revoked, days) {
  const cutoff = Date.now() / 1000 - Math.max(1, days || 0) * DAY;
  const out = [];
  for (const u of users) for (const d of (Array.isArray(u.devices) ? u.devices : [])) {
    if (!d) continue;
    if (d.online && !d.revoked) continue;
    if ((revoked && d.revoked) || (days >= 1 && Number(d.lastSeen || d.created) < cutoff)) out.push({ d, u });
  }
  return out;
}

async function cleanupDialog(users) {
  const all = [];
  for (const u of users) for (const d of (Array.isArray(u.devices) ? u.devices : [])) if (d) all.push(d);
  const revokedN = all.filter((d) => d.revoked).length;
  const cbRevoked = h('input', { type: 'checkbox', id: 'cl-revoked', checked: revokedN > 0, disabled: revokedN === 0 });
  const cbInactive = h('input', { type: 'checkbox', id: 'cl-inactive', checked: true, 'aria-label': 'Lange nicht verbundene Geräte' });
  const days = h('input', { class: 'input num-in', id: 'cl-days', type: 'number', min: '1', max: '3650', step: '1', value: '90', inputmode: 'numeric', 'aria-label': 'Anzahl Tage' });
  const preview = h('div', { class: 'preview', 'aria-live': 'polite' });
  let okBtn = null;
  const matching = () => cleanupCandidates(users, cbRevoked.checked, cbInactive.checked ? Math.floor(Number(days.value)) : 0);
  const update = () => {
    days.disabled = !cbInactive.checked;
    const m = matching();
    const n = m.length;
    const kept = all.filter((d) => d.online && !d.revoked && cbInactive.checked && Number(d.lastSeen || d.created) < Date.now() / 1000 - Math.max(1, Number(days.value) || 0) * DAY).length;
    replace(preview,
      h('p', { text: n ? `${plural(n, 'Gerät wird', 'Geräte werden')} entfernt (von ${fmtNum(all.length)}):` : 'Mit dieser Auswahl wird nichts entfernt.' }),
      n ? h('ul', { class: 'plain-list small' }, m.slice(0, 8).map(({ d, u }) => h('li', {}, h('strong', { text: esc(d.device) || 'ohne Namen' }), ` · ${esc(u.name || u.id)} · `,
        d.revoked ? 'gesperrt' : d.lastSeen == null ? 'nie verbunden' : 'zuletzt ' + dfShort.format(new Date(toMs(d.lastSeen))))), n > 8 ? h('li', { class: 'dim', text: `und ${n - 8} weitere` }) : null) : null,
      kept ? h('p', { class: 'dim small', text: `Gerade verbundene Geräte werden nie entfernt (${fmtNum(kept)} ausgenommen).` }) : null);
    if (okBtn) { okBtn.disabled = !n; okBtn.textContent = n ? `${plural(n, 'Gerät', 'Geräte')} entfernen` : 'Entfernen'; }
  };
  for (const el of [cbRevoked, cbInactive]) el.addEventListener('change', update);
  days.addEventListener('input', update);
  return openDialog({
    title: 'Geräte aufräumen',
    body: frag(
      h('p', { text: 'Entfernte Geräte verschwinden aus der Liste und können sich nicht mehr verbinden. Personen und Vaults bleiben unberührt.' }),
      h('div', { class: 'field row' }, cbRevoked, h('label', { for: 'cl-revoked', text: `Gesperrte Geräte (${fmtNum(revokedN)})` })),
      h('div', { class: 'field row wrap' }, cbInactive, h('label', { for: 'cl-inactive', text: 'Geräte, die seit mindestens' }), days, h('span', { text: 'Tagen nicht verbunden waren' })),
      preview,
    ),
    buttons: [
      { label: 'Abbrechen', value: false },
      { label: 'Entfernen', kind: 'danger solid', disabled: true, ref: (b) => { okBtn = b; }, onClick: async (close) => {
        const body = { revoked: cbRevoked.checked };
        if (cbInactive.checked) body.inactiveDays = Math.max(1, Math.floor(Number(days.value)) || 0);
        try {
          const r = await api('devices/cleanup', { method: 'POST', body });
          const n = r && r.removed != null ? Number(r.removed) : 0;
          toast(`${plural(n, 'Gerät', 'Geräte')} entfernt`, 'ok');
          close(true);
        } catch { /* Toast von api() */ }
      } },
    ],
    onOpen: () => { update(); cbInactive.focus(); },
    cancelValue: false,
  });
}

// ---------------------------------------------------------------------------
// Protokoll

// Aktionen auf Deutsch, mit Kategorie (für Filter und Markierung)
const ACTION_LABELS = {
  'login': ['Angemeldet', 'security'],
  'login.failed': ['Anmeldung fehlgeschlagen', 'security'],
  'logout': ['Abgemeldet', 'security'],
  'admin.setup': ['Admin-Zugang eingerichtet', 'security'],
  'sessions.end': ['Sitzungen beendet', 'security'],
  'user.add': ['Person angelegt', 'people'],
  'user.edit': ['Person bearbeitet', 'people'],
  'user.delete': ['Person gelöscht', 'people'],
  'invite': ['Einladungscode erzeugt', 'people'],
  'device.revoke': ['Gerät gesperrt', 'people'],
  'device.unrevoke': ['Sperre aufgehoben', 'people'],
  'device.delete': ['Gerät entfernt', 'people'],
  'device.cleanup': ['Geräte aufgeräumt', 'people'],
  'space.add': ['Vault angelegt', 'vaults'],
  'space.rename': ['Vault umbenannt', 'vaults'],
  'space.delete': ['Vault gelöscht', 'vaults'],
  'member.set': ['Rolle gesetzt', 'vaults'],
  'member.remove': ['Zugriff entzogen', 'vaults'],
  'file.create': ['Datei angelegt', 'files'],
  'file.edit': ['Datei bearbeitet', 'files'],
  'file.upload': ['Datei hochgeladen', 'files'],
  'file.move': ['Verschoben', 'files'],
  'file.delete': ['In den Papierkorb', 'files'],
  'file.undelete': ['Aus dem Papierkorb geholt', 'files'],
  'file.restore': ['Version wiederhergestellt', 'files'],
  'backup.create': ['Sicherung angelegt', 'backups'],
  'backup.delete': ['Sicherung gelöscht', 'backups'],
  'backup.settings': ['Aufbewahrung geändert', 'backups'],
  'backup.download': ['Sicherung heruntergeladen', 'backups'],
  'backup.restore': ['Aus Sicherung wiederhergestellt', 'backups'],
  'export': ['Vault exportiert', 'backups'],
};
const AUDIT_CATS = [['', 'Alle Bereiche', null], ['failed', 'Fehlgeschlagene Anmeldungen', ['login.failed']], ['security', 'Anmeldung & Sitzungen', ['login', 'logout', 'admin.', 'sessions.']], ['people', 'Personen & Geräte', ['user.', 'invite', 'device.']], ['vaults', 'Vaults & Mitglieder', ['space.', 'member.']], ['files', 'Dateien', ['file.']], ['backups', 'Sicherungen', ['backup.', 'export']]];
const AUDIT_PERIODS = [['', 'Gesamter Zeitraum', 0], ['1', 'Letzte 24 h', DAY], ['7', 'Letzte 7 Tage', 7 * DAY], ['30', 'Letzte 30 Tage', 30 * DAY]];

// Details lesbar machen: Rollen übersetzen, Bytes formatieren, Nebensachen dimmen, Vault verlinken
function auditDetail(r) {
  let d = typeof r.detail === 'string' ? r.detail : (r.detail == null ? '' : JSON.stringify(r.detail));
  const a = r.action;
  if (a === 'login') return h('span', { title: d, text: uaLabel(d) });
  if (a === 'user.edit') {
    const m = d.match(/^(\S+) (\{.*\})$/);
    if (m) {
      let o = {};
      try { o = JSON.parse(m[2]); } catch { /* roh */ }
      const parts = [];
      if (o.name) parts.push(`Name „${o.name}“`);
      if (o.color) parts.push(frag('Farbe ', setColorVar(h('span', { class: 'dot inline', 'aria-hidden': 'true' }), o.color), o.color));
      return frag(personLabel(m[1], { link: true }), parts.length ? frag(': ', parts.map((p, i) => frag(i ? ', ' : null, p))) : null);
    }
  }
  const out = [];
  let rest = d;
  // Verbindungszählungen als Nebensache
  let tail = null;
  const tm = rest.match(/\s*\((\d+) Verbindungen? (getrennt|neu)\)\s*$/);
  if (tm) { rest = rest.slice(0, tm.index); if (tm[1] !== '0') tail = ` · ${plural(Number(tm[1]), 'Verbindung', 'Verbindungen')} ${tm[2]}`; }
  rest = rest.replace(/\((\d+) B\)/, (_m, n) => `(${fmtBytes(Number(n))})`);
  rest = rest.replace(/\((\d+) Dateien\)/, (_m, n) => `(${plural(Number(n), 'Datei', 'Dateien')})`);
  rest = rest.replace(/: (owner|write|read)$/, (_m, role) => `: ${roleLabel(role)}`);
  // Vault vorne verlinken (file.*: "<space>: <pfad>")
  const fm = a && a.startsWith('file.') ? rest.match(/^([a-z0-9_-]+): ([\s\S]*)$/) : null;
  if (fm) out.push(h('a', { href: `#/vault/${enc(fm[1])}`, text: spaceName(fm[1]) }), ': ', h('span', { class: 'path', text: fm[2] }));
  else if (a === 'member.set' || a === 'member.remove') {
    const mm = rest.match(/^(\S+) (in|aus) ([a-z0-9_-]+)(.*)$/);
    if (mm) out.push(personLabel(mm[1], { link: true }), ` ${mm[2]} `, h('a', { href: `#/vault/${enc(mm[3])}`, text: spaceName(mm[3]) }), mm[4]);
    else out.push(rest);
  } else if ((a === 'space.add' || a === 'space.rename') && /^[a-z0-9_-]+/.test(rest)) {
    const sm = rest.match(/^([a-z0-9_-]+)(.*)$/);
    out.push(h('a', { href: `#/vault/${enc(sm[1])}`, text: sm[1] }), sm[2]);
  } else if (a && a.startsWith('device.') && /^[0-9a-f]{12}/.test(rest)) {
    const dm = rest.match(/^([0-9a-f]{12})(.*)$/);
    let dev = null, owner = null;
    for (const u of (state.users || [])) for (const x of (u.devices || [])) if (x.id === dm[1]) { dev = x; owner = u; }
    out.push(dev ? frag(h('span', { title: dm[1], text: esc(dev.device) || 'Gerät ohne Namen' }), ' von ', personLabel(owner.id, { link: true, noDot: true })) : h('span', { class: 'mono', title: 'Gerät nicht mehr vorhanden', text: dm[1] }), dm[2]);
  } else if ((a === 'user.add' || a === 'invite') && /^[a-z0-9_-]+/.test(rest)) {
    const um = rest.match(/^([a-z0-9_-]+)(.*)$/);
    out.push(personLabel(um[1], { link: true }), um[2]);
  } else if (a && a.startsWith('backup.') && /^(tandem|manuell)-[\w-]+\.db/.test(rest)) {
    const bm = rest.match(/^(\S+\.db)(.*)$/);
    out.push(a === 'backup.delete' ? h('span', { class: 'mono', text: bm[1] }) : h('a', { class: 'mono', href: `#/backups/${enc(bm[1])}`, text: bm[1] }), bm[2]);
  } else out.push(rest);
  if (tail) out.push(h('span', { class: 'dim', text: tail }));
  return frag(out);
}

async function viewAudit(params) {
  const f = { user: params.get('user') || '', cat: params.get('cat') || '', period: params.get('period') || '', q: params.get('q') || '' };
  if (!AUDIT_CATS.some((c) => c[0] === f.cat)) f.cat = '';
  if (!AUDIT_PERIODS.some((p) => p[0] === f.period)) f.period = '';
  const box = h('div');
  const moreBtn = h('button', { class: 'btn', type: 'button', text: 'Ältere laden' });
  const foot = h('div', { class: 'audit-foot' });
  let rows = [];
  let lastId = null, ended = false;

  // Filterleiste
  const userSel = h('select', { class: 'select', id: 'au-user' }, h('option', { value: '', text: 'Alle Personen' }));
  const catSel = h('select', { class: 'select', id: 'au-cat' }, AUDIT_CATS.map(([k, l]) => h('option', { value: k, text: l })));
  const periodSel = h('select', { class: 'select', id: 'au-period' }, AUDIT_PERIODS.map(([k, l]) => h('option', { value: k, text: l })));
  const qIn = h('input', { class: 'input', type: 'search', id: 'au-q', placeholder: 'Text in Details', autocomplete: 'off', value: f.q });
  catSel.value = f.cat; periodSel.value = f.period;
  const resetBtn = h('button', { class: 'btn ghost sm', type: 'button', text: 'Filter zurücksetzen' });
  const syncHash = () => {
    const p = new URLSearchParams();
    for (const k of ['user', 'cat', 'period', 'q']) if (f[k]) p.set(k, f[k]);
    const s = p.toString();
    setHashQuiet('#/audit' + (s ? '?' + s : ''));
    resetBtn.hidden = !s;
  };
  let qTimer = null;
  const onFilter = () => { syncHash(); load(); };
  userSel.addEventListener('change', () => { f.user = userSel.value; onFilter(); });
  catSel.addEventListener('change', () => { f.cat = catSel.value; onFilter(); });
  periodSel.addEventListener('change', () => { f.period = periodSel.value; onFilter(); });
  qIn.addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(() => { if (f.q !== qIn.value.trim()) { f.q = qIn.value.trim(); onFilter(); } }, 400); });
  qIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(qTimer); f.q = qIn.value.trim(); onFilter(); } });
  resetBtn.addEventListener('click', () => { Object.assign(f, { user: '', cat: '', period: '', q: '' }); userSel.value = ''; catSel.value = ''; periodSel.value = ''; qIn.value = ''; onFilter(); });

  const query = (before) => {
    const p = new URLSearchParams();
    if (before != null) p.set('before', before);
    if (f.user) p.set('user', f.user);
    if (f.q) p.set('q', f.q);
    const per = AUDIT_PERIODS.find((x) => x[0] === f.period);
    if (per && per[2]) p.set('since', String(Math.floor(Date.now() / 1000 - per[2])));
    // Kategorie: genau eine Aktion bzw. ein Präfix serverseitig, sonst clientseitig nachfiltern
    const cat = AUDIT_CATS.find((c) => c[0] === f.cat);
    if (cat && cat[2] && cat[2].length === 1) p.set('action', cat[2][0]);
    return 'audit?' + p.toString();
  };
  const inCat = (r) => {
    const cat = AUDIT_CATS.find((c) => c[0] === f.cat);
    return !cat || !cat[2] || cat[2].some((pre) => String(r.action || '').startsWith(pre));
  };
  // Kategorien mit mehreren Präfixen: Seiten nachladen, bis genug Treffer da sind (begrenzt)
  const fetchPage = async (before) => {
    let got = [], cursor = before, pages = 0, last = [];
    do {
      last = await api(query(cursor), { quiet: true });
      last = Array.isArray(last) ? last : [];
      if (last.length) cursor = last[last.length - 1].id;
      got = got.concat(last.filter(inCat));
      pages++;
    } while (last.length >= 100 && got.length < 50 && pages < 10);
    return { rows: got, cursor, end: last.length < 100 };
  };

  const render = () => {
    const allDirect = rows.length > 0 && rows.every((r) => !r.ip || r.ip === 'direkt');
    const tbody = h('tbody');
    let day = null;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      // gleiche, direkt aufeinanderfolgende Einträge zusammenfassen
      let n = 1;
      while (i + n < rows.length && rows[i + n].action === r.action && rows[i + n].user === r.user && rows[i + n].detail === r.detail && Math.abs(Number(rows[i + n - 1].ts) - Number(rows[i + n].ts)) < 60) n++;
      const dl = fmtDayLabel(r.ts);
      if (dl !== day) { day = dl; tbody.append(h('tr', { class: 'day' }, h('th', { colspan: allDirect ? '4' : '5', scope: 'rowgroup', text: dl }))); }
      const [label, cat] = ACTION_LABELS[r.action] || [r.action, ''];
      const sec = r.action === 'login.failed';
      const u = userById(r.user);
      tbody.append(h('tr', { class: (sec ? 'warn ' : '') + 'c-' + (cat || 'other'), dataset: { id: String(r.id) } },
        h('td', { class: 'c-time' }, h('time', { datetime: new Date(toMs(r.ts)).toISOString(), title: fmtAbs(r.ts, true), text: tfHMS.format(new Date(toMs(r.ts))) })),
        h('td', { class: 'c-user' }, sec
          ? h('span', { class: 'dim', title: 'Eingegebene Kennung – nicht unbedingt eine echte Person' }, 'Versuch: ', h('code', { text: esc(r.user) || '–' }))
          : (r.user ? (u ? personLabel(r.user, { link: true }) : h('code', { text: esc(r.user) })) : h('span', { class: 'dim', text: '–' }))),
        h('td', { class: 'c-action', title: r.action }, sec ? h('span', { class: 'badge warn', text: label }) : label, n > 1 ? h('span', { class: 'dim', text: ` (${n}×)` }) : null),
        h('td', { class: 'c-detail' }, auditDetail(r)),
        allDirect ? null : h('td', { class: 'c-ip' }, !r.ip || r.ip === 'direkt'
          ? h('span', { class: 'dim', title: 'Direkte Verbindung ohne Proxy (keine Client-IP übermittelt)', text: '–' })
          : h('code', { title: r.ip, text: r.ip.length > 22 ? r.ip.slice(0, 9) + '…' + r.ip.slice(-6) : r.ip })),
      ));
      i += n - 1;
    }
    if (!rows.length) tbody.append(h('tr', {}, h('td', { colspan: '5' }, emptyEl(f.user || f.cat || f.period || f.q ? 'Keine Einträge zu diesem Filter.' : 'Noch keine Einträge.'))));
    return h('div', { class: 'card' }, h('div', { class: 'table-wrap' }, h('table', { class: 'table audit' + (allDirect ? ' no-ip' : '') },
      h('caption', { class: 'sr', text: 'Protokoll, neueste zuerst' }),
      h('colgroup', {}, h('col', { class: 'c-time' }), h('col', { class: 'c-user' }), h('col', { class: 'c-action' }), h('col', { class: 'c-detail' }), allDirect ? null : h('col', { class: 'c-ip' })),
      h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: 'Zeit' }), h('th', { scope: 'col', text: 'Person' }), h('th', { scope: 'col', text: 'Aktion' }), h('th', { scope: 'col', text: 'Details' }), allDirect ? null : h('th', { scope: 'col', text: 'IP' }))),
      tbody)));
  };
  const updateFoot = () => {
    replace(foot, h('span', { class: 'dim small', text: `${plural(rows.length, 'Eintrag', 'Einträge')} geladen` }),
      ended ? h('span', { class: 'dim small', text: ' · Ende des Protokolls. Es werden die letzten 5.000 Einträge aufbewahrt.' }) : moreBtn);
  };
  const load = loader(box, async () => {
    const [r] = await Promise.all([fetchPage(null), loadUsers(true).catch(() => [])]);
    rows = r.rows; lastId = r.cursor; ended = r.end;
    // Personen-Auswahl füllen
    const cur = f.user;
    clear(userSel);
    userSel.append(h('option', { value: '', text: 'Alle Personen' }));
    for (const u of (state.users || []).slice().sort((a, b) => coll.compare(a.name || a.id, b.name || b.id))) userSel.append(h('option', { value: u.id, text: esc(u.name || u.id) }));
    if (cur && !(state.users || []).some((u) => u.id === cur)) userSel.append(h('option', { value: cur, text: cur }));
    userSel.value = cur;
    updateFoot();
    return render();
  }, { what: 'Das Protokoll' });
  moreBtn.addEventListener('click', () => busy(moreBtn, async () => {
    const firstNew = rows.length;
    const r = await fetchPage(lastId);
    rows = rows.concat(r.rows); lastId = r.cursor; ended = r.end;
    replace(box, render());
    updateFoot();
    // Fokus auf den ersten neuen Eintrag
    const tr = box.querySelectorAll('tbody tr[data-id]')[firstNew];
    if (tr) { tr.tabIndex = -1; tr.focus(); } else moreBtn.focus();
  }));
  const tools = h('div', { class: 'toolbar filters audit-tools', role: 'search', 'aria-label': 'Protokoll filtern' },
    h('label', { class: 'sr', for: 'au-user', text: 'Person' }), userSel,
    h('label', { class: 'sr', for: 'au-cat', text: 'Bereich' }), catSel,
    h('label', { class: 'sr', for: 'au-period', text: 'Zeitraum' }), periodSel,
    h('label', { class: 'sr', for: 'au-q', text: 'Suche' }), qIn, resetBtn);
  page('Protokoll', refreshButton(load), tools, box, foot);
  syncHash();
  await load();
}

// ---------------------------------------------------------------------------
// Konto

async function viewAccount() {
  const box = h('div');
  const endBtn = h('button', { class: 'btn sm', type: 'button', text: 'Andere Sitzungen beenden' });
  const logoutBtn = h('button', { class: 'btn sm', type: 'button', text: 'Abmelden' });
  const load = loader(box, async () => {
    const [me, list, ov] = await Promise.all([api('me', { quiet: true }), api('sessions', { quiet: true }), api('overview', { quiet: true }).catch(() => null)]);
    if (me) setMe(me);
    const sessions = Array.isArray(list) ? list : [];
    const cur = sessions.find((s) => s.current);
    const others = sessions.filter((s) => !s.current).length;
    endBtn.disabled = others === 0;
    endBtn.title = others ? '' : 'Keine anderen Sitzungen aktiv';
    const u = (me && me.user) || {};
    const latest = cur && cur.created ? Number(cur.created) + 12 * 3600 : null;
    const cmd = SETUP_CMD(u.id);
    const admins = ov && Array.isArray(ov.admins) ? ov.admins : [];
    return frag(
      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', { text: 'Angemeldet' }), logoutBtn),
        h('div', { class: 'card-body' }, h('dl', { class: 'kv' },
          h('dt', { text: 'Person' }), h('dd', {}, colorDot(u.color), nameWithId(u.name || u.id, u.id)),
          h('dt', { text: 'Sitzung' }), h('dd', {}, 'endet nach 30 min ohne Aktivität', latest ? frag(', spätestens ', h('time', { datetime: new Date(latest * 1000).toISOString(), text: fmtWhen(latest) })) : null),
          h('dt', { text: 'Passwort, Authenticator' }), h('dd', {},
            h('div', { text: 'Neu einrichten per Einmal-Link:' }),
            h('div', { class: 'cmd' }, h('code', { text: cmd }), h('button', { class: 'btn sm', type: 'button', text: 'Kopieren', onclick: (e) => copyText(cmd, e.currentTarget) })),
            h('div', { class: 'dim small', text: 'Der alte Zugang gilt bis zum Abschluss, danach enden alle Sitzungen.' }))))),
      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', { text: `Sitzungen (${fmtNum(sessions.length)})` }), endBtn),
        h('ul', { class: 'rows sessions' }, sessions.map((s) => h('li', { class: 'row2' },
          h('div', { class: 'main' },
            h('span', { title: esc(s.agent) }, uaLabel(s.agent), s.current ? h('span', { class: 'badge accent', text: 'diese Sitzung' }) : null),
            h('span', { class: 'dim small' }, 'zuletzt aktiv ', timeEl(s.lastSeen), ' · begonnen ', timeEl(s.created, { abs: true }),
              s.ip && s.ip !== 'direkt' ? frag(' · ', h('code', { text: s.ip })) : null)))))),
      admins.length ? h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', { text: `Admins (${fmtNum(admins.length)})` })),
        table(['Kennung', 'Eingerichtet', 'Letzte Anmeldung'], admins.map((a) => h('tr', {},
          h('td', {}, personLabel(a.user, { link: true })),
          h('td', {}, timeEl(a.created, { abs: true })),
          h('td', {}, timeEl(a.lastLogin, { none: 'noch nie' })))), { caption: 'Admins' })) : null,
    );
  }, { what: 'Das Konto' });
  endBtn.addEventListener('click', () => busy(endBtn, async () => {
    const r = await api('sessions/end-others', { method: 'POST' });
    const n = r && r.ended != null ? Number(r.ended) : 0;
    toast(n ? `${plural(n, 'Sitzung', 'Sitzungen')} beendet` : 'Keine anderen Sitzungen aktiv', 'ok');
    await load();
  }));
  logoutBtn.addEventListener('click', async () => {
    if (!(await confirmLeave())) return;
    await busy(logoutBtn, async () => {
      try { await api('logout', { method: 'POST', noAuth: true, quiet: true }); } catch { /* egal */ }
      state.dirtyCheck = null;
      setMe(null);
      vaultCtx = null;
      clear(main);
      await requireLogin('logout');
      render();
    });
  });
  await loadUsers(true).catch(() => []);
  page('Konto', refreshButton(load), box);
  await load();
}

// ---------------------------------------------------------------------------
// Vault-Detail: Baum, Editor, Vorschau, Mitglieder, Papierkorb, Sicherungen

const VAULT_TABS = ['_members', '_trash', '_backups'];

function rawUrl(space, id, download) { return `${API}spaces/${enc(space)}/raw/${enc(id)}${download ? '?download=1' : ''}`; }

function validatePath(p) {
  if (!p) return 'Pfad fehlt.';
  if (p.startsWith('/') || p.endsWith('/')) return 'Pfad ohne führenden oder abschließenden Schrägstrich.';
  if (p.split('/').some((s) => s === '' || s === '.' || s === '..')) return 'Ungültige Pfadbestandteile.';
  if (/[\u0000-\u001f\u007f]/.test(p)) return 'Steuerzeichen sind nicht erlaubt.';
  return null;
}

const coarse = () => window.matchMedia && matchMedia('(pointer: coarse)').matches;
const narrow = () => window.matchMedia && matchMedia('(max-width: 900px)').matches;

async function viewVault(space, sub) {
  if (!vaultCtx || vaultCtx.space !== space || !main.contains(vaultCtx.root)) {
    vaultCtx = createVaultCtx(space);
    clear(main);
    main.append(vaultCtx.root);
    await vaultCtx.loadAll();
    if (vaultCtx.notFound) return;
  }
  await vaultCtx.show(sub);
}

function createVaultCtx(space) {
  const ctx = {
    space,
    info: null,       // Eintrag aus GET spaces
    infoError: null,
    files: [],        // alle Entries (auch gelöschte)
    filesError: null,
    filesLoaded: false,
    online: [],
    expanded: new Set(),
    filter: '',
    search: null,     // {q, hits} – Trefferliste bleibt stehen, bis man zurück zum Baum geht
    doc: null,        // aktuell geöffnetes Dokument {id, path, kind, entry}
    ed: null,         // Editorzustand
    stash: null,      // Editor-DOM, solange ein anderer Tab offen ist
    pendingLine: null,
    users: null,
    tab: '',
    notFound: false,
  };

  // --- Grundgerüst
  const title = h('h1', { text: space });
  const tabLink = (tab, text) => h('a', { href: `#/vault/${enc(space)}${tab ? '/' + tab : ''}`, dataset: { tab } }, h('span', { text }), h('span', { class: 'n' }));
  const tabs = h('nav', { class: 'tabs', 'aria-label': 'Vault-Bereiche' },
    tabLink('', 'Dateien'), tabLink('_members', 'Mitglieder'), tabLink('_trash', 'Papierkorb'), tabLink('_backups', 'Sicherungen'));
  const drawerBtn = h('button', { class: 'btn drawer-btn', type: 'button', text: 'Ordner', 'aria-expanded': 'false', 'aria-controls': 'tree-' + space, onclick: () => toggleDrawer() });
  const newBtn = h('button', { class: 'btn', type: 'button', text: 'Neue Notiz', onclick: () => newNote(currentFolder()) });
  const upBtn = h('button', { class: 'btn', type: 'button', text: 'Hochladen', title: 'Dateien hochladen', onclick: () => uploadDialog(currentFolder()) });
  const stamp = h('span', { class: 'meta stamp', 'aria-live': 'polite' });
  const refreshBtn = h('button', { class: 'btn', type: 'button', text: 'Aktualisieren' });
  refreshBtn.addEventListener('click', () => busy(refreshBtn, () => ctx.reload(), 'Aktualisiere …'));
  const vaultMore = menuButton('Vault-Aktionen', () => vaultMenu(ctx.info || { id: space, name: space, stats: {}, members: [] }, {
    onChange: async () => { await ctx.loadInfo(); },
    onDelete: async () => { vaultCtx = null; state.dirtyCheck = null; navigate('#/vaults'); },
  }), { sm: false, text: 'Vault …', title: 'Umbenennen, exportieren, wiederherstellen, löschen' });
  vaultMore.classList.remove('icon');
  const toolbar = h('div', { class: 'toolbar' }, drawerBtn, newBtn, upBtn, stamp, refreshBtn, vaultMore);

  const filterInput = h('input', { class: 'input', type: 'search', placeholder: 'Dateien filtern', 'aria-label': 'Dateien filtern', autocomplete: 'off' });
  filterInput.addEventListener('input', () => { ctx.filter = filterInput.value.trim().toLowerCase(); ctx.search = null; renderTree(); });
  filterInput.addEventListener('keydown', (e) => { if (e.key === 'Escape' && filterInput.value) { e.preventDefault(); e.stopPropagation(); filterInput.value = ''; ctx.filter = ''; renderTree(); } });
  const searchInput = h('input', { class: 'input', type: 'search', placeholder: 'Volltext suchen (Enter)', 'aria-label': 'Volltext suchen', autocomplete: 'off' });
  searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); runSearch(searchInput.value.trim()); } });
  searchInput.addEventListener('input', () => { if (!searchInput.value.trim() && ctx.search) { ctx.search = null; renderTree(); } });
  const treeScroll = h('div', { class: 'tree-scroll' });
  const closeDrawerBtn = h('button', { class: 'btn sm drawer-close', type: 'button', text: 'Schließen', onclick: () => toggleDrawer(false) });
  const treePane = h('aside', { class: 'tree-pane', id: 'tree-' + space, 'aria-label': 'Dateien' },
    h('div', { class: 'tree-tools' }, closeDrawerBtn, filterInput, searchInput),
    treeScroll);
  const backdrop = h('div', { class: 'drawer-backdrop', onclick: () => toggleDrawer(false) });
  const filePane = h('section', { class: 'file-pane', 'aria-label': 'Inhalt' });
  const membersPeek = h('a', { class: 'members-peek none', href: `#/vault/${enc(space)}/_members`, hidden: true, text: 'Niemand hat Zugriff' });
  const head = h('div', { class: 'vault-head' },
    h('div', { class: 'vh-title' }, h('span', { class: 'crumb' }, h('a', { href: '#/vaults', text: 'Vaults' }), h('span', { 'aria-hidden': 'true', text: ' / ' })), title, membersPeek),
    tabs, toolbar);
  const root = h('div', { class: 'vault' }, head, h('div', { class: 'vault-body' }, treePane, backdrop, filePane));
  ctx.root = root;

  // Tastenkürzel im Inhaltsbereich (einmal registriert, wirkt auf den aktuellen Editor)
  filePane.addEventListener('keydown', (e) => { if (ctx.edKeys) ctx.edKeys(e); });

  // Drawer (unter 900 px): geschlossen nicht fokussierbar
  function syncInert() { treePane.inert = narrow() && !treePane.classList.contains('open'); }
  function toggleDrawer(open) {
    const o = open === undefined ? !treePane.classList.contains('open') : open;
    const was = treePane.classList.contains('open');
    treePane.classList.toggle('open', o);
    backdrop.classList.toggle('open', o);
    drawerBtn.setAttribute('aria-expanded', String(o));
    syncInert();
    if (o && !was) filterInput.focus();
    else if (!o && was && narrow() && treePane.contains(document.activeElement)) drawerBtn.focus();
  }
  if (window.matchMedia) matchMedia('(max-width: 900px)').addEventListener('change', syncInert);
  syncInert();
  treePane.addEventListener('keydown', (e) => { if (e.key === 'Escape' && treePane.classList.contains('open')) { e.preventDefault(); toggleDrawer(false); } });

  function currentFolder() { return ctx.doc ? dirname(ctx.doc.path) : ''; }
  function liveFiles() { return ctx.files.filter((f) => f && !f.del && typeof f.path === 'string'); }
  function entryById(id) { return ctx.files.find((f) => f && f.id === id) || null; }
  function entryByPath(p) { return liveFiles().find((f) => f.path === p) || null; }
  function onlineInDoc(id) {
    return ctx.online.filter((o) => (Array.isArray(o.files) && o.files.some((f) => f.doc === id && f.space === space)) || (Array.isArray(o.docs) && o.docs.includes(`${space}/${id}`)));
  }
  function members() { return ctx.info && Array.isArray(ctx.info.members) ? ctx.info.members : []; }
  ctx.liveFiles = liveFiles;

  // --- Laden
  ctx.loadInfo = async () => {
    try {
      const list = await loadSpaces(false);
      ctx.info = list.find((s) => s && s.id === space) || null;
      ctx.infoError = null;
      if (!ctx.info) { showNotFound(); return; }
    } catch (e) { ctx.infoError = e; }
    title.textContent = ctx.info && ctx.info.name ? ctx.info.name : space;
    title.title = `Kennung: ${space}`;
    updateTitle();
    renderHeadState();
  };
  function showNotFound() {
    ctx.notFound = true;
    state.dirtyCheck = null;
    replace(root, h('div', { class: 'page' },
      h('div', { class: 'page-head' }, h('h1', { text: 'Vault nicht gefunden', tabindex: '-1' })),
      h('p', {}, 'Einen Vault mit der Kennung ', h('code', { text: space }), ' gibt es nicht (mehr).'),
      h('p', {}, h('a', { href: '#/vaults', text: 'Zu den Vaults' }))));
    document.title = 'Vault nicht gefunden – Tandem Admin';
  }
  function updateTitle() {
    const vn = ctx.info && ctx.info.name ? ctx.info.name : space;
    const tabName = { _members: 'Mitglieder', _trash: 'Papierkorb', _backups: 'Sicherungen' }[ctx.tab];
    const dirty = ctx.ed && ctx.ed.ta.value !== ctx.ed.saved ? '● ' : '';
    document.title = `${dirty}${tabName ? tabName + ' – ' : (ctx.doc ? displayName(ctx.doc.path) + ' – ' : '')}${vn} – Tandem Admin`;
  }
  ctx.updateTitle = updateTitle;
  function renderHeadState() {
    const ms = members();
    membersPeek.hidden = !(ctx.info && !ms.length);
    const trashN = ctx.files.filter((f) => f && f.del).length;
    const counts = { '': null, _members: ctx.info ? ms.length : null, _trash: ctx.filesLoaded ? trashN : null, _backups: null };
    for (const a of tabs.children) {
      const n = counts[a.dataset.tab];
      a.querySelector('.n').textContent = n != null && n > 0 ? String(n) : '';
    }
    const disabled = !ctx.info || !!ctx.filesError;
    newBtn.disabled = disabled; upBtn.disabled = disabled;
  }
  ctx.loadFiles = async () => {
    try {
      const r = await api(`spaces/${enc(space)}/files`, { quiet: true });
      ctx.files = r && Array.isArray(r.files) ? r.files : [];
      ctx.online = r && Array.isArray(r.online) ? r.online : [];
      ctx.filesError = null;
      ctx.filesLoaded = true;
      setStamp(true, stamp);
    } catch (e) {
      ctx.filesError = e;
      setStamp(false, stamp);
    }
    renderHeadState();
    if (ctx.tab === '') renderTree();
    if (ctx.doc) renderOnlineChips();
    if (ctx.filesError) throw ctx.filesError;
  };
  ctx.loadAll = async () => {
    replace(treeScroll, loadingEl());
    await Promise.all([ctx.loadInfo(), ctx.loadFiles().catch(() => {})]);
  };
  ctx.reload = async () => {
    ctx.users = null;
    await Promise.all([ctx.loadInfo(), ctx.loadFiles().catch(() => {})]);
    if (ctx.notFound) return;
    if (ctx.tab === '_members') await renderMembers();
    else if (ctx.tab === '_trash') renderTrash();
    else if (ctx.tab === '_backups') await renderBackupsTab();
    else if (ctx.doc && !ctx.filesError) {
      const e = entryById(ctx.doc.id);
      if (!e || e.del) { toast('Die geöffnete Datei wurde inzwischen gelöscht.'); ctx.doc = null; ctx.ed = null; state.dirtyCheck = null; navigate(`#/vault/${enc(space)}`); return; }
      ctx.doc.path = e.path;
      if (ctx.ed && ctx.ed.ta.value !== ctx.ed.saved) { renderOnlineChips(); toast('Ungespeicherte Änderungen bleiben stehen – erst speichern, dann neu laden.'); return; }
      await openDoc(ctx.doc.id, true);
    } else if (!ctx.doc) renderEmptyPane();
  };

  // --- Navigation innerhalb des Vaults
  ctx.show = async (sub) => {
    const tab = VAULT_TABS.includes(sub) ? sub : '';
    if (ctx.tab === '' && tab !== '' && ctx.doc && filePane.firstChild) {
      ctx.stash = [...filePane.childNodes];
      clear(filePane);
    }
    ctx.tab = tab;
    for (const a of tabs.children) {
      if (a.dataset.tab === ctx.tab) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    }
    // „Dateien“ führt zur zuletzt offenen Datei zurück
    tabs.children[0].href = `#/vault/${enc(space)}${ctx.doc ? '/' + enc(ctx.doc.id) : ''}`;
    root.classList.toggle('no-tree', ctx.tab !== '');
    newBtn.hidden = upBtn.hidden = ctx.tab !== '';
    if (ctx.tab !== '') toggleDrawer(false);
    updateTitle();
    if (ctx.tab === '_members') { await renderMembers(); return; }
    if (ctx.tab === '_trash') { renderTrash(); return; }
    if (ctx.tab === '_backups') { await renderBackupsTab(); return; }
    if (!sub) { ctx.stash = null; closeEditor(); renderEmptyPane(); renderTree(); updateTitle(); return; }
    if (ctx.stash && ctx.doc && ctx.doc.id === sub) {
      replace(filePane, ctx.stash);
      ctx.stash = null;
      renderTree();
      updateTitle();
      return;
    }
    ctx.stash = null;
    await openDoc(sub);
  };

  function closeEditor() {
    ctx.doc = null;
    ctx.ed = null;
    ctx.edKeys = null;
    state.dirtyCheck = null;
    state.saveDirty = null;
    tabs.children[0].href = `#/vault/${enc(space)}`;
  }

  function renderEmptyPane() {
    clear(filePane);
    if (ctx.filesError) { filePane.append(h('div', { class: 'file-body center' }, errorEl('Dateien konnten nicht geladen werden', ctx.filesError, () => ctx.reload()))); return; }
    if (!ctx.filesLoaded) { filePane.append(loadingEl()); return; }
    const files = liveFiles();
    const recent = files.slice().sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0)).slice(0, 5);
    filePane.append(h('div', { class: 'file-body center' },
      h('div', { class: 'empty-pane' },
        h('p', { text: files.length ? 'Datei im Baum auswählen.' : 'Dieser Vault ist noch leer.' }),
        ctx.info && !members().length
          ? h('p', { class: 'warn-note' }, 'Noch niemand hat Zugriff auf diesen Vault. ', h('a', { href: `#/vault/${enc(space)}/_members`, text: 'Mitglieder hinzufügen' }))
          : null,
        recent.length ? frag(h('h3', { text: 'Zuletzt geändert' }), h('ul', { class: 'rows' }, recent.map((f) => h('li', { class: 'row2' },
          h('div', { class: 'main' }, h('a', { href: `#/vault/${enc(space)}/${enc(f.id)}`, title: f.path, text: displayName(f.path) }), h('span', { class: 'dim small ell', text: dirname(f.path) })),
          h('div', { class: 'side' }, timeEl(f.ts)))))) : null,
        !files.length && ctx.info ? h('p', {}, h('button', { class: 'btn', type: 'button', text: 'Neue Notiz', onclick: () => newNote('') }), ' ', h('button', { class: 'btn', type: 'button', text: 'Hochladen', onclick: () => uploadDialog('') })) : null)));
  }

  // --- Baum
  function buildTree(files) {
    const rootNode = { name: '', path: '', dirs: new Map(), files: [] };
    for (const f of files) {
      const parts = f.path.split('/');
      let node = rootNode;
      for (let i = 0; i < parts.length - 1; i++) {
        let d = node.dirs.get(parts[i]);
        if (!d) { d = { name: parts[i], path: node.path ? node.path + '/' + parts[i] : parts[i], dirs: new Map(), files: [] }; node.dirs.set(parts[i], d); }
        node = d;
      }
      node.files.push(f);
    }
    return rootNode;
  }

  function renderTree() {
    if (ctx.search) { renderSearch(); return; }
    clear(treeScroll);
    if (ctx.filesError) { treeScroll.append(errorEl('Dateien konnten nicht geladen werden', ctx.filesError, () => ctx.reload())); return; }
    if (!ctx.filesLoaded) { treeScroll.append(loadingEl()); return; }
    let files = liveFiles();
    if (ctx.filter) files = files.filter((f) => f.path.toLowerCase().includes(ctx.filter));
    if (!files.length) { treeScroll.append(emptyEl(ctx.filter ? 'Keine Treffer' : 'Keine Dateien')); return; }
    if (ctx.doc && ctx.doc.path) {
      let d = dirname(ctx.doc.path);
      while (d) { ctx.expanded.add(d); d = dirname(d); }
    }
    const onlineCount = new Map();
    for (const o of ctx.online) for (const f of (Array.isArray(o.files) ? o.files : [])) {
      if (f && f.space === space) onlineCount.set(f.doc, (onlineCount.get(f.doc) || 0) + 1);
    }
    const tree = h('div', { class: 'tree' }, renderNode(buildTree(files), onlineCount));
    treeScroll.append(tree);
    // Roving Tabindex: nur ein Eintrag im Tab-Fluss, Pfeiltasten bewegen
    const items = [...tree.querySelectorAll('.ti')];
    for (const it of items) it.tabIndex = -1;
    const cur = tree.querySelector('.ti[aria-current="page"]') || items[0];
    if (cur) {
      cur.tabIndex = 0;
      if (cur.getAttribute('aria-current')) cur.scrollIntoView({ block: 'nearest' });
    }
  }

  treeScroll.addEventListener('keydown', (e) => {
    const t = e.target;
    if (!t.classList || !t.classList.contains('ti')) return;
    const visible = [...treeScroll.querySelectorAll('.ti')].filter((x) => x.offsetParent !== null);
    const i = visible.indexOf(t);
    const move = (el) => { if (!el) return; for (const x of visible) x.tabIndex = -1; el.tabIndex = 0; el.focus(); e.preventDefault(); };
    const isFolder = t.classList.contains('folder-btn');
    if (e.key === 'ArrowDown') move(visible[i + 1]);
    else if (e.key === 'ArrowUp') move(visible[i - 1]);
    else if (e.key === 'Home') move(visible[0]);
    else if (e.key === 'End') move(visible[visible.length - 1]);
    else if (e.key === 'ArrowRight' && isFolder) {
      if (t.getAttribute('aria-expanded') !== 'true') { t.click(); e.preventDefault(); } else move(visible[i + 1]);
    } else if (e.key === 'ArrowLeft') {
      if (isFolder && t.getAttribute('aria-expanded') === 'true') { t.click(); e.preventDefault(); return; }
      const parentLi = t.closest('li').parentElement.closest('li');
      if (parentLi) move(parentLi.querySelector(':scope > .row > .ti'));
    } else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      const more = t.parentElement.querySelector('.more');
      if (more) { e.preventDefault(); more.click(); }
    }
  });
  treeScroll.addEventListener('contextmenu', (e) => {
    const row = e.target.closest && e.target.closest('.row');
    const more = row && row.querySelector('.more');
    if (!more) return;
    e.preventDefault();
    showMenu(more, more._items(), { x: e.clientX, y: e.clientY });
  });
  // Dateien auf den Baum ziehen → Hochladen (Ordner unter dem Zeiger als Ziel)
  treePane.addEventListener('dragover', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files') && ctx.info) { e.preventDefault(); treePane.classList.add('drop'); } });
  treePane.addEventListener('dragleave', (e) => { if (!treePane.contains(e.relatedTarget)) treePane.classList.remove('drop'); });
  treePane.addEventListener('drop', (e) => {
    treePane.classList.remove('drop');
    if (!e.dataTransfer || !e.dataTransfer.files.length || !ctx.info) return;
    e.preventDefault();
    const li = e.target.closest && e.target.closest('[data-folder]');
    uploadDialog(li ? li.dataset.folder : '', [...e.dataTransfer.files]);
  });

  function fileMenu(f) {
    const d = { id: f.id, path: f.path, kind: f.kind === 'text' ? 'md' : (f.kind || 'blob'), entry: f };
    return [
      { label: 'Öffnen', onClick: () => navigate(`#/vault/${enc(space)}/${enc(f.id)}`) },
      { label: 'Umbenennen / Verschieben …', onClick: () => moveFile(d) },
      { label: 'Herunterladen', onClick: () => downloadUrl(rawUrl(space, f.id, true), basename(f.path)) },
      { label: d.kind === 'blob' ? 'Ältere Stände …' : 'Verlauf …', onClick: () => historyDialog(d, d.kind === 'blob' ? 'backups' : 'snapshots') },
      '-',
      { label: 'Löschen …', danger: true, onClick: () => deleteFile(d) },
    ];
  }
  function moreFor(label, items) {
    const more = h('button', { class: 'btn ghost icon sm more', type: 'button', tabindex: '-1', 'aria-label': label, 'aria-haspopup': 'menu', text: '…' });
    more._items = items;
    more.addEventListener('click', () => showMenu(more, items()));
    return more;
  }

  function renderNode(node, onlineCount) {
    const ul = h('ul');
    const dirs = [...node.dirs.values()].sort((a, b) => coll.compare(a.name, b.name));
    for (const d of dirs) {
      const open = !!ctx.filter || ctx.expanded.has(d.path);
      const btn = h('button', { class: 'folder-btn ti', type: 'button', 'aria-expanded': String(open), title: d.path },
        h('span', { class: 'chev', 'aria-hidden': 'true', text: '▸' }),
        h('span', { class: 'name', text: d.name }));
      const children = renderNode(d, onlineCount);
      children.hidden = !open;
      btn.addEventListener('click', () => {
        const now = btn.getAttribute('aria-expanded') !== 'true';
        btn.setAttribute('aria-expanded', String(now));
        children.hidden = !now;
        if (now) ctx.expanded.add(d.path); else ctx.expanded.delete(d.path);
      });
      const more = moreFor(`Aktionen für Ordner ${d.name}`, () => [
        { label: 'Neue Notiz hier …', onClick: () => newNote(d.path) },
        { label: 'Hierher hochladen …', onClick: () => uploadDialog(d.path) },
        { label: 'Umbenennen / Verschieben …', onClick: () => moveFolder(d.path) },
        '-',
        { label: 'Ordner löschen …', danger: true, onClick: () => deleteFolder(d.path) },
      ]);
      ul.append(h('li', { dataset: { folder: d.path } }, h('div', { class: 'row' }, btn, more), children));
    }
    const files = node.files.slice().sort((a, b) => coll.compare(basename(a.path), basename(b.path)));
    for (const f of files) {
      const cur = ctx.doc && ctx.doc.id === f.id;
      const n = onlineCount.get(f.id) || 0;
      const ext = extOf(f.path);
      const a = h('a', { class: 'ti', href: `#/vault/${enc(space)}/${enc(f.id)}`, 'aria-current': cur ? 'page' : null, title: f.path },
        h('span', { class: 'file-ind', 'aria-hidden': 'true' }),
        h('span', { class: 'name', text: ext && ext !== 'md' && ext !== 'txt' ? stripExt(basename(f.path)) : displayName(f.path) }),
        ext && ext !== 'md' && ext !== 'txt' ? h('span', { class: 'ext', text: ext.toUpperCase(), title: basename(f.path) }) : null,
        n ? frag(h('span', { class: 'online-n', 'aria-hidden': 'true', title: `Gerade auf ${plural(n, 'Gerät', 'Geräten')} geöffnet`, text: '●' }), h('span', { class: 'sr', text: ' (gerade geöffnet)' })) : null,
      );
      a.addEventListener('click', () => toggleDrawer(false));
      ul.append(h('li', { dataset: { folder: dirname(f.path) } }, h('div', { class: 'row' }, a, moreFor(`Aktionen für ${basename(f.path)}`, () => fileMenu(f)))));
    }
    return ul;
  }

  // --- Volltextsuche (Treffer nach Datei gruppiert, bleiben stehen)
  async function runSearch(q) {
    if (!q) { ctx.search = null; renderTree(); return; }
    replace(treeScroll, loadingEl('Suche …'));
    let hits;
    try { hits = await api(`spaces/${enc(space)}/search?q=${enc(q)}`, { quiet: true }); }
    catch (e) { replace(treeScroll, errorEl('Suche fehlgeschlagen', e, () => runSearch(q))); return; }
    ctx.search = { q, hits: Array.isArray(hits) ? hits : [] };
    renderSearch();
  }
  function renderSearch() {
    const { q, hits } = ctx.search;
    const back = h('button', { class: 'btn sm', type: 'button', text: 'Zurück zum Baum', onclick: () => { searchInput.value = ''; ctx.search = null; renderTree(); } });
    const groups = new Map();
    for (const hit of hits) { if (!groups.has(hit.id)) groups.set(hit.id, { path: hit.path, hits: [] }); groups.get(hit.id).hits.push(hit); }
    replace(treeScroll, h('div', { class: 'search-results' },
      h('div', { class: 'inline' }, back, h('span', { class: 'dim small', role: 'status', text: `${plural(hits.length, 'Treffer', 'Treffer')} in ${plural(groups.size, 'Datei', 'Dateien')}${hits.length >= 200 ? ' (Höchstzahl erreicht)' : ''}` })),
      hits.length ? [...groups.entries()].map(([id, g]) => h('div', { class: 'hit-group' },
        h('div', { class: 'p', title: g.path, text: displayName(esc(g.path)) }, h('span', { class: 'dim', text: dirname(g.path) ? ' · ' + dirname(g.path) : '' })),
        g.hits.map((hit) => {
          const cur = ctx.doc && ctx.doc.id === hit.id && ctx.lastHit === `${hit.id}:${hit.line}`;
          const a = h('a', { class: 'hit', href: `#/vault/${enc(space)}/${enc(hit.id)}`, 'aria-current': cur ? 'true' : null },
            hit.line != null ? h('span', { class: 'ln', text: String(hit.line) }) : null,
            h('span', { class: 't' }, markText(esc(hit.text), q)));
          a.addEventListener('click', () => {
            ctx.pendingLine = Number(hit.line) || null;
            ctx.lastHit = `${hit.id}:${hit.line}`;
            for (const x of treeScroll.querySelectorAll('.hit[aria-current]')) x.removeAttribute('aria-current');
            a.setAttribute('aria-current', 'true');
            toggleDrawer(false);
            if (ctx.doc && ctx.doc.id === hit.id) jumpToLine();
          });
          return a;
        }))) : emptyEl('Keine Treffer'),
    ));
  }

  function markText(text, q) {
    const i = text.toLowerCase().indexOf(q.toLowerCase());
    if (i < 0) return [text];
    return [text.slice(0, i), h('mark', { text: text.slice(i, i + q.length) }), text.slice(i + q.length)];
  }

  // --- Dokument öffnen
  async function openDoc(id, force) {
    if (ctx.doc && ctx.doc.id === id && !force && filePane.firstChild) { renderTree(); jumpToLine(); return; }
    let e = entryById(id);
    if (!e && !ctx.filesLoaded) { try { await ctx.loadFiles(); } catch { /* unten */ } e = entryById(id); }
    clear(filePane);
    if (!e || e.del) {
      closeEditor();
      filePane.append(h('div', { class: 'file-body center' },
        ctx.filesError ? errorEl('Dateien konnten nicht geladen werden', ctx.filesError, () => ctx.reload())
          : h('div', { class: 'empty-pane' }, h('p', {}, e && e.del ? 'Diese Datei liegt im Papierkorb: ' : 'Datei nicht gefunden: ', h('code', { text: e ? e.path : id })),
            e && e.del ? h('p', {}, h('a', { href: `#/vault/${enc(space)}/_trash`, text: 'Zum Papierkorb' })) : null)));
      renderTree();
      return;
    }
    const kind = e.kind === 'text' ? 'md' : (e.kind || 'blob');
    ctx.doc = { id: e.id, path: e.path, kind, entry: e };
    ctx.ed = null; ctx.edKeys = null;
    state.dirtyCheck = null; state.saveDirty = null;
    tabs.children[0].href = `#/vault/${enc(space)}/${enc(e.id)}`;
    renderTree();
    updateTitle();
    if (kind === 'blob') { renderBlob(e); return; }
    filePane.append(loadingEl());
    let d;
    try { d = await api(`spaces/${enc(space)}/docs/${enc(id)}`, { quiet: true }); }
    catch (ex) { if (ctx.doc && ctx.doc.id === id) replace(filePane, h('div', { class: 'file-body center' }, errorEl('Dokument konnte nicht geladen werden', ex, () => openDoc(id, true)))); return; }
    if (!ctx.doc || ctx.doc.id !== id) return; // inzwischen woanders
    d = d || {};
    if (d.path) ctx.doc.path = d.path;
    clear(filePane);
    if (kind === 'ink' || d.kind === 'ink') renderInk(d);
    else renderEditor(d, e.kind === 'text' || extOf(e.path) === 'txt');
    updateTitle();
  }
  ctx.openDoc = openDoc;

  let chipsEl = null, liveNote = null;
  function renderOnlineChips() {
    if (!chipsEl || !ctx.doc) return;
    clear(chipsEl);
    const byUser = new Map();
    for (const o of onlineInDoc(ctx.doc.id)) {
      if (!byUser.has(o.user)) byUser.set(o.user, { o, devices: [] });
      byUser.get(o.user).devices.push(esc(o.device) || 'Gerät');
    }
    if (byUser.size) chipsEl.append(h('span', { class: 'lbl', text: 'Offen bei' }));
    for (const { o, devices } of byUser.values()) {
      chipsEl.append(h('span', { class: 'chip', title: devices.join(', ') }, colorDot(o.color), esc(o.name || o.user), devices.length > 1 ? h('span', { class: 'role', text: `${devices.length} Geräte` }) : null));
    }
    chipsEl.hidden = !byUser.size;
    if (liveNote) liveNote.hidden = !byUser.size || !ctx.ed;
  }

  function pathEl(p) {
    const dir = dirname(p);
    return h('span', { class: 'path', title: p }, dir ? h('span', { class: 'dir', text: dir + '/' }) : null, h('span', { class: 'fname', text: displayName(p) }));
  }

  function fileHead(extra, menuItems) {
    chipsEl = h('span', { class: 'chips live', role: 'group', 'aria-label': 'Gerade geöffnet bei', hidden: true });
    const more = menuButton('Weitere Aktionen', menuItems, { sm: false });
    const head = h('div', { class: 'file-head' },
      pathEl(ctx.doc.path),
      chipsEl,
      h('div', { class: 'actions' }, extra, more));
    return head;
  }

  function commonMenu(withHistory) {
    const d = ctx.doc;
    const items = [
      { label: 'Umbenennen / Verschieben …', onClick: () => moveFile(d) },
      { label: 'Herunterladen', onClick: () => downloadUrl(rawUrl(space, d.id, true), basename(d.path)) },
    ];
    if (withHistory) items.push({ label: 'Verlauf …', onClick: () => historyDialog(d) });
    else items.push({ label: 'Ältere Stände …', onClick: () => historyDialog(d, 'backups') });
    items.push('-', { label: 'Löschen …', danger: true, onClick: () => deleteFile(d) });
    return items;
  }

  // --- Markdown-Editor
  function renderEditor(d, plainText) {
    const mono = readPref('vault.mono') === '1';
    const ta = h('textarea', { class: 'editor' + (mono ? ' mono' : ''), 'aria-label': `Inhalt von ${basename(ctx.doc.path)}`, spellcheck: 'false', autocapitalize: 'off',
      title: 'Strg+S speichert, Strg+E wechselt zur Vorschau. Tab rückt ein; Esc und danach Tab verlässt das Textfeld.' });
    ta.value = typeof d.text === 'string' ? d.text : '';
    const ed = { id: ctx.doc.id, ta, saved: ta.value, version: d.version, mode: 'edit', loadedAt: Date.now(), saving: false };
    ctx.ed = ed;
    state.dirtyCheck = () => ctx.ed === ed && ta.value !== ed.saved;

    const saveBtn = h('button', { class: 'btn sm', type: 'button', text: 'Gespeichert' });
    const unsaved = h('span', { class: 'unsaved', hidden: true, text: 'ungespeichert' });
    const editBtn = h('button', { class: 'btn sm', type: 'button', 'aria-pressed': 'true', text: 'Bearbeiten', title: 'Bearbeiten (Strg+E)' });
    const prevBtn = h('button', { class: 'btn sm', type: 'button', 'aria-pressed': 'false', text: 'Vorschau', title: 'Vorschau (Strg+E)' });
    const preview = h('div', { class: 'md', hidden: true });
    const loadedEl = h('span', { text: fmtTime(ed.loadedAt) });
    liveNote = h('div', { class: 'live-note', hidden: true },
      h('span', {}, 'Auch auf anderen Geräten geöffnet. Angezeigt wird der Stand von ', loadedEl, '; beim Speichern werden Änderungen zusammengeführt.'),
      h('button', { class: 'btn sm', type: 'button', text: 'Neu laden', onclick: async () => {
        if (ta.value !== ed.saved && !(await confirmDialog('Neu laden', 'Deine ungespeicherten Änderungen gehen dabei verloren.', { okLabel: 'Verwerfen und neu laden', danger: true }))) return;
        ed.saved = ta.value; await openDoc(ed.id, true);
      } }));
    const body = h('div', { class: 'file-body' }, liveNote, ta, preview);

    const updateDirty = () => {
      const dirty = ta.value !== ed.saved;
      unsaved.hidden = !dirty;
      saveBtn.className = 'btn sm' + (dirty ? ' primary' : '');
      saveBtn.textContent = ed.saving ? 'Speichere …' : (dirty ? 'Speichern' : 'Gespeichert');
      saveBtn.setAttribute('aria-disabled', String(!dirty));
      saveBtn.title = dirty ? 'Speichern (Strg+S)' : 'Keine ungespeicherten Änderungen';
      updateTitle();
    };
    let escArmed = false;
    ta.addEventListener('input', updateDirty);
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { escArmed = true; return; }
      if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (escArmed) { escArmed = false; return; } // Tab verlässt das Feld
        e.preventDefault();
        const v = ta.value, s = ta.selectionStart, en = ta.selectionEnd;
        const ls = v.lastIndexOf('\n', s - 1) + 1;
        if (e.shiftKey) {
          // Ausrücken: führenden Tab bzw. bis zu 4 Leerzeichen der Zeile entfernen
          const m = v.slice(ls).match(/^(\t| {1,4})/);
          if (m) { ta.setRangeText('', ls, ls + m[1].length, 'preserve'); ta.setSelectionRange(Math.max(ls, s - m[1].length), Math.max(ls, en - m[1].length)); }
        } else if (s !== en && v.slice(s, en).includes('\n')) {
          // mehrere Zeilen einrücken
          const block = v.slice(ls, en).replace(/^/gm, '\t');
          ta.setRangeText(block, ls, en, 'select');
        } else ta.setRangeText('\t', s, en, 'end');
        updateDirty();
        return;
      }
      escArmed = false;
    });
    ctx.edKeys = (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 's') { e.preventDefault(); save(); }
      else if (k === 'e') { e.preventDefault(); setMode(ed.mode === 'edit' ? 'preview' : 'edit'); }
    };

    const setMode = (mode, init) => {
      ed.mode = mode;
      if (!init) writePref('vault.mode', mode);
      editBtn.setAttribute('aria-pressed', String(mode === 'edit'));
      prevBtn.setAttribute('aria-pressed', String(mode === 'preview'));
      ta.hidden = mode !== 'edit';
      preview.hidden = mode !== 'preview';
      if (mode === 'preview') {
        clear(preview);
        const inner = h('div', { class: 'md-inner' });
        if (plainText) inner.append(h('pre', { class: 'plain', text: ta.value }));
        else inner.append(renderMarkdown(ta.value, { resolve: resolveLinkTarget, raw: (id) => rawUrl(space, id), href: (f) => `#/vault/${enc(space)}/${enc(f.id)}` }));
        preview.append(inner);
        if (!init) preview.focus({ preventScroll: true });
      } else if (!init) ta.focus();
    };
    preview.tabIndex = -1;
    editBtn.addEventListener('click', () => setMode('edit'));
    prevBtn.addEventListener('click', () => setMode('preview'));

    async function save() {
      if (ed.saving) return false;
      const text = ta.value;
      if (text === ed.saved) return true;
      ed.saving = true;
      ta.readOnly = true; // während der Anfrage nichts tippen, sonst ginge es beim Zusammenführen verloren
      updateDirty();
      try {
        const r = await api(`spaces/${enc(space)}/docs/${enc(ed.id)}`, { method: 'PUT', body: { text, version: ed.version, base: ed.saved }, expect: [409] });
        ed.version = r && r.version !== undefined ? r.version : ed.version;
        if (r && r.merged && typeof r.text === 'string') {
          adoptText(r.text);
          toast('Gespeichert – mit Änderungen von anderen Geräten zusammengeführt', 'ok');
        } else {
          ed.saved = text;
          toast('Gespeichert', 'ok');
        }
        ed.loadedAt = Date.now();
        loadedEl.textContent = fmtTime(ed.loadedAt);
        return true;
      } catch (ex) {
        if (ex.status === 409) return conflictDialog(ed, text, ex.data || {}, adoptText);
        return false;
      } finally {
        ed.saving = false;
        ta.readOnly = false;
        updateDirty();
      }
    }
    // Text vom Server übernehmen, Cursor ungefähr halten
    function adoptText(next) {
      const old = ta.value;
      const s = ta.selectionStart, en = ta.selectionEnd, top = ta.scrollTop;
      let pre = 0;
      while (pre < old.length && pre < next.length && old[pre] === next[pre]) pre++;
      const shift = next.length - old.length;
      ta.value = next;
      ed.saved = next;
      const fix = (p) => (p <= pre ? p : Math.max(pre, p + shift));
      ta.setSelectionRange(fix(s), fix(en));
      ta.scrollTop = top;
      if (ed.mode === 'preview') setMode('preview', true);
      updateDirty();
    }
    ed.save = save;
    state.saveDirty = save;
    saveBtn.addEventListener('click', () => { if (saveBtn.getAttribute('aria-disabled') !== 'true') save(); });

    // Pfad in den Vorschau-Links auflösen
    function resolveLinkTarget(target) {
      const t = target.replace(/^\.\//, '').replace(/^\//, '');
      const files = liveFiles();
      const cands = [t, t + '.md'];
      const base = dirname(ctx.doc.path);
      if (base) cands.push(base + '/' + t, base + '/' + t + '.md');
      for (const c of cands) { const f = files.find((x) => x.path === c); if (f) return f; }
      const lower = t.toLowerCase();
      return files.find((x) => { const b = basename(x.path).toLowerCase(); return b === lower || stripExt(b) === lower || stripExt(x.path).toLowerCase() === lower; }) || null;
    }

    const monoItem = { label: mono ? 'Proportionalschrift' : 'Schreibmaschinenschrift', onClick: () => { writePref('vault.mono', mono ? '0' : '1'); ta.classList.toggle('mono', !mono); openDoc(ed.id, true); } };
    filePane.append(
      fileHead(frag(unsaved, h('span', { class: 'seg' }, editBtn, prevBtn), saveBtn), () => [...commonMenu(true), '-', monoItem].filter((x, i, a) => !(x === '-' && a[i - 1] === '-'))),
      body,
    );
    renderOnlineChips();
    // Modus merken; auf Touch-Geräten mit Vorschau starten (sonst springt die Tastatur auf)
    const pref = readPref('vault.mode');
    const startMode = ctx.pendingLine ? 'edit' : (pref === 'preview' || pref === 'edit' ? pref : (coarse() ? 'preview' : 'edit'));
    setMode(startMode, true);
    updateDirty();
    jumpToLine();
    if (ctx.pendingLine == null && startMode === 'edit' && !coarse()) ta.focus({ preventScroll: true });
  }

  function jumpToLine() {
    const line = ctx.pendingLine;
    ctx.pendingLine = null;
    if (!line || !ctx.ed) return;
    const ta = ctx.ed.ta;
    if (ta.hidden) { ta.hidden = false; const p = ta.parentElement.querySelector('.md'); if (p) p.hidden = true; }
    const lines = ta.value.split('\n');
    const idx = Math.max(0, Math.min(lines.length - 1, line - 1));
    let start = 0;
    for (let i = 0; i < idx; i++) start += lines[i].length + 1;
    ta.focus();
    ta.setSelectionRange(start, start + lines[idx].length);
    const lh = parseFloat(getComputedStyle(ta).lineHeight) || 20;
    ta.scrollTop = Math.max(0, (idx - 3) * lh);
  }

  // Konflikt (nur bei überlappenden Änderungen): Dialog bleibt bei erneutem Konflikt offen und zeigt den neuen Stand
  async function conflictDialog(ed, mine, server, adopt) {
    let theirs = typeof server.text === 'string' ? server.text : '';
    let newVersion = server.version;
    const diffBox = h('div');
    const legend = h('div', { class: 'diff-legend' }, h('span', { class: 'del', text: '− wird entfernt (von anderen geschrieben)' }), h('span', { class: 'add', text: '+ deine Änderungen' }));
    let overBtn = null;
    const paint = () => {
      replace(diffBox, diffEl(theirs, mine));
      if (overBtn) overBtn.hidden = !lineDiff(theirs, mine).some((o) => o[0] === '-');
    };
    const ok = await openDialog({
      title: 'Konflikt beim Speichern',
      wide: true,
      body: frag(
        h('p', { text: 'Jemand hat inzwischen an denselben Stellen geschrieben, deshalb ließ sich nicht automatisch zusammenführen.' }),
        legend, diffBox),
      buttons: [
        { label: 'Weiter bearbeiten', value: false },
        { label: 'Meine Änderungen verwerfen', onClick: (close) => { ed.version = newVersion; adopt(theirs); close(true); toast('Stand vom Server übernommen'); } },
        { label: 'Trotzdem überschreiben', kind: 'danger solid', ref: (b) => { overBtn = b; }, busyLabel: 'Speichere …', onClick: async (close) => {
          try {
            const r = await api(`spaces/${enc(space)}/docs/${enc(ed.id)}`, { method: 'PUT', body: { text: mine, version: newVersion, base: theirs }, expect: [409] });
            ed.version = r && r.version !== undefined ? r.version : newVersion;
            if (r && r.merged && typeof r.text === 'string') adopt(r.text); else { ed.saved = mine; adopt(mine); }
            close(true); toast('Gespeichert', 'ok');
          } catch (ex) {
            if (ex.status === 409) { theirs = typeof ex.data.text === 'string' ? ex.data.text : theirs; newVersion = ex.data.version; paint(); toast('Inzwischen erneut geändert – Vergleich aktualisiert.', 'error'); }
          }
        } },
      ],
      onOpen: paint,
      cancelValue: false,
    });
    return !!ok;
  }

  // --- Anhang
  function renderBlob(e) {
    const ext = extOf(e.path);
    const url = rawUrl(space, e.id);
    let view = null;
    if (IMG_EXT.has(ext)) view = h('img', { src: url, alt: basename(e.path) });
    else if (ext === 'pdf') view = h('iframe', { src: url, title: basename(e.path) });
    else if (AUDIO_EXT.has(ext)) view = h('audio', { src: url, controls: true, preload: 'metadata' });
    else if (VIDEO_EXT.has(ext)) view = h('video', { src: url, controls: true, preload: 'metadata' });
    else if (TEXT_EXT.has(ext) && Number(e.size) <= 256 * 1024) {
      view = h('pre', { class: 'text-preview' }, loadingEl());
      fetch(url, { credentials: 'same-origin' }).then((r) => (r.ok ? r.text() : Promise.reject(new Error(`Fehler ${r.status}`)))).then((t) => {
        if (ext === 'json' || ext === 'canvas') { try { t = JSON.stringify(JSON.parse(t), null, 2); } catch { /* roh */ } }
        view.textContent = t;
      }).catch((ex) => { view.textContent = 'Vorschau nicht möglich: ' + ex.message; });
    }
    const replaceBtn = h('button', { class: 'btn sm', type: 'button', text: 'Ersetzen …' });
    const fileInput = h('input', { type: 'file', hidden: true, 'aria-hidden': 'true', tabindex: '-1' });
    replaceBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      const f = fileInput.files && fileInput.files[0];
      if (!f) return;
      const ok = await confirmDialog('Anhang ersetzen', `„${basename(e.path)}“ wird durch „${f.name}“ (${fmtBytes(f.size)}) ersetzt. Der Pfad bleibt gleich; der alte Stand bleibt in den Sicherungen.`, { okLabel: 'Ersetzen' });
      if (!ok) { fileInput.value = ''; return; }
      await busy(replaceBtn, async () => {
        try { await xhrUpload(`${API}spaces/${enc(space)}/upload?path=${enc(e.path)}`, f, () => {}); toast('Anhang ersetzt', 'ok'); await ctx.loadFiles(); await openDoc(e.id, true); }
        catch (ex) { toast(ex.message, 'error'); }
      });
    });
    const by = e.by ? personLabel(e.by, { noDot: true }) : null;
    filePane.append(
      fileHead(frag(replaceBtn, h('button', { class: 'btn sm', type: 'button', text: 'Herunterladen', onclick: () => downloadUrl(rawUrl(space, e.id, true), basename(e.path)) })), commonMenu(false)),
      h('div', { class: 'blob-view' },
        view || h('p', { class: 'dim', text: 'Für diesen Dateityp gibt es keine Vorschau.' }),
        h('p', { class: 'dim small' }, `${fmtBytes(e.size)} · geändert `, timeEl(e.ts, { abs: true }), by ? frag(' von ', by) : null),
        e.hash ? h('details', { class: 'hash' }, h('summary', { text: 'Prüfsumme' }), h('code', { text: esc(e.hash) })) : null,
        fileInput),
    );
    renderOnlineChips();
  }

  // --- Handschrift
  function renderInk(d) {
    const strokes = Array.isArray(d.strokes) ? d.strokes.length : (Number.isFinite(Number(d.strokes)) ? Number(d.strokes) : null);
    const lines = Array.isArray(d.lines) ? d.lines.length : (Number.isFinite(Number(d.lines)) ? Number(d.lines) : null);
    let headText = '';
    try { headText = d.head == null ? '' : (typeof d.head === 'string' ? d.head : JSON.stringify(d.head, null, 2)); } catch { headText = String(d.head); }
    filePane.append(
      fileHead(h('span', { class: 'badge', text: 'Handschrift' }), commonMenu(true)),
      h('div', { class: 'ink-info' },
        h('p', { class: 'dim', text: 'Handschrift-Fläche aus Obsidian Ink Blocks. Hier nur lesbar; bearbeitet wird sie in Obsidian.' }),
        h('dl', { class: 'kv' },
          h('dt', { text: 'Striche' }), h('dd', { text: strokes == null ? '–' : fmtNum(strokes) }),
          h('dt', { text: 'Zeilen' }), h('dd', { text: lines == null ? '–' : fmtNum(lines) }),
          h('dt', { text: 'Geändert' }), h('dd', {}, timeEl(ctx.doc.entry.ts, { abs: true }), ctx.doc.entry.by ? frag(' von ', personLabel(ctx.doc.entry.by, { noDot: true })) : ''),
        ),
        headText ? h('details', {}, h('summary', { text: 'Kopfdaten' }), h('pre', { text: headText })) : null,
      ),
    );
    renderOnlineChips();
  }

  // --- Dateiaktionen
  async function moveFile(d) {
    const to = await promptDialog('Umbenennen / Verschieben', { label: 'Neuer Pfad', value: d.path, mono: true, okLabel: 'Verschieben', selectBase: true, validate: (v) => validatePath(v) || (v !== d.path && entryByPath(v) ? 'Dieser Pfad ist schon belegt.' : null) });
    if (to == null || to === d.path) return;
    try {
      await api(`spaces/${enc(space)}/move`, { method: 'POST', body: { from: d.path, to } });
      toast('Verschoben', 'ok');
      if (ctx.doc && ctx.doc.id === d.id) { ctx.doc.path = to; const p = filePane.querySelector('.file-head .path'); if (p) p.replaceWith(pathEl(to)); }
      await ctx.loadFiles();
      updateTitle();
    } catch { /* Toast kam aus api() */ }
  }

  async function deleteFile(d) {
    const open = onlineInDoc(d.id).map((o) => o.name || o.user);
    const ok = await confirmDialog('Datei löschen', frag(
      h('p', {}, h('code', { text: d.path }), ' kommt in den Papierkorb und lässt sich von dort wiederherstellen. Verbundene Geräte löschen die Datei sofort.'),
      open.length ? h('p', { class: 'warn-note', text: `Gerade geöffnet bei ${[...new Set(open)].join(' und ')}.` }) : null), { okLabel: 'Löschen', danger: true });
    if (!ok) return;
    try {
      await api(`spaces/${enc(space)}/delete`, { method: 'POST', body: { path: d.path } });
      toast('In den Papierkorb verschoben', 'ok', { href: `#/vault/${enc(space)}/_trash`, linkText: 'Papierkorb' });
      if (ctx.doc && ctx.doc.id === d.id) closeEditor();
      await ctx.loadFiles();
      navigate(`#/vault/${enc(space)}`);
    } catch { /* Toast kam aus api() */ }
  }

  function freePath(folder, base, ext) {
    const pre = folder ? folder + '/' : '';
    let p = `${pre}${base}.${ext}`;
    for (let i = 1; entryByPath(p) && i < 1000; i++) p = `${pre}${base} ${i}.${ext}`;
    return p;
  }

  async function newNote(folder) {
    const p = await promptDialog('Neue Notiz', { label: 'Pfad', value: freePath(folder, 'Unbenannt', 'md'), mono: true, okLabel: 'Anlegen', selectBase: true, hint: 'Ohne Endung wird „.md“ angehängt.',
      validate: (v) => {
        const full = /\.(md|txt)$/i.test(v) ? v : v + '.md';
        return validatePath(full) || (entryByPath(full) ? 'Dieser Pfad ist schon belegt.' : null);
      } });
    if (p == null) return;
    const full = /\.(md|txt)$/i.test(p) ? p : p + '.md';
    try {
      const r = await api(`spaces/${enc(space)}/files`, { method: 'POST', body: { path: full, text: '' } });
      toast('Notiz angelegt', 'ok');
      await ctx.loadFiles();
      if (r && r.id) { writePref('vault.mode', 'edit'); navigate(`#/vault/${enc(space)}/${enc(r.id)}`); }
    } catch { /* Toast kam aus api() */ }
  }

  async function moveFolder(folder) {
    const to = await promptDialog('Ordner umbenennen / verschieben', { label: 'Neuer Ordnerpfad', value: folder, mono: true, okLabel: 'Verschieben', validate: validatePath });
    if (to == null || to === folder) return;
    try {
      const r = await api(`spaces/${enc(space)}/move`, { method: 'POST', body: { from: folder, to } });
      toast(`${plural(r && r.moved != null ? r.moved : 0, 'Datei', 'Dateien')} verschoben`, 'ok');
      ctx.expanded.add(to);
      await ctx.loadFiles();
      if (ctx.doc) { const e = entryById(ctx.doc.id); if (e) { ctx.doc.path = e.path; const p = filePane.querySelector('.file-head .path'); if (p) p.replaceWith(pathEl(e.path)); } }
    } catch { /* Toast */ }
  }

  async function deleteFolder(folder) {
    const n = liveFiles().filter((f) => f.path.startsWith(folder + '/')).length;
    const ok = await confirmDialog('Ordner löschen', h('p', {}, 'Der Ordner ', h('code', { text: folder }), ` mit ${plural(n, 'Datei', 'Dateien')} kommt in den Papierkorb.`), { okLabel: 'Löschen', danger: true });
    if (!ok) return;
    try {
      const r = await api(`spaces/${enc(space)}/delete`, { method: 'POST', body: { path: folder } });
      toast(`${plural(r && r.deleted != null ? r.deleted : n, 'Datei', 'Dateien')} in den Papierkorb verschoben`, 'ok', { href: `#/vault/${enc(space)}/_trash`, linkText: 'Papierkorb' });
      const inside = ctx.doc && ctx.doc.path.startsWith(folder + '/');
      if (inside) closeEditor();
      await ctx.loadFiles();
      if (inside) navigate(`#/vault/${enc(space)}`);
    } catch { /* Toast */ }
  }

  // --- Verlauf: Snapshots (stündlich) und Sicherungen (täglich/von Hand)
  async function historyDialog(d, startMode = 'snapshots') {
    const kind = d.kind;
    let mode = kind === 'blob' ? 'backups' : startMode;
    const listEl = h('div', { class: 'list', role: 'listbox', 'aria-label': 'Stände' });
    const view = h('div', { class: 'view' });
    let restoreBtn = null, selected = null;
    let snaps = null, backups = null;
    const editorText = () => (ctx.ed && ctx.ed.id === d.id ? ctx.ed.ta.value : null);
    const loadedAt = ctx.ed && ctx.ed.id === d.id ? fmtTime(ctx.ed.loadedAt) : null;
    let liveText = null;
    const getLive = async () => {
      if (editorText() != null) return editorText();
      if (liveText == null) { const r = await api(`spaces/${enc(space)}/docs/${enc(d.id)}`, { quiet: true }); liveText = r && typeof r.text === 'string' ? r.text : ''; }
      return liveText;
    };
    const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Quelle' },
      h('button', { class: 'btn sm', type: 'button', dataset: { m: 'snapshots' }, text: 'Snapshots' }),
      h('button', { class: 'btn sm', type: 'button', dataset: { m: 'backups' }, text: 'Sicherungen' }));
    seg.hidden = kind === 'blob';
    for (const b of seg.children) b.addEventListener('click', () => { if (mode !== b.dataset.m) { mode = b.dataset.m; fill(); } });
    let viewMode = 'diff';

    async function fill() {
      for (const b of seg.children) b.setAttribute('aria-pressed', String(b.dataset.m === mode));
      selected = null;
      if (restoreBtn) { restoreBtn.disabled = true; restoreBtn.textContent = mode === 'snapshots' ? 'Diese Version wiederherstellen' : 'Diesen Stand wiederherstellen'; restoreBtn.hidden = mode === 'snapshots' && kind !== 'md'; }
      replace(listEl, loadingEl());
      replace(view, h('p', { class: 'dim', text: mode === 'snapshots' ? 'Snapshot links auswählen.' : 'Sicherung links auswählen.' }));
      try {
        if (mode === 'snapshots') {
          if (!snaps) { const r = await api(`spaces/${enc(space)}/history/${enc(d.id)}`, { quiet: true }); snaps = Array.isArray(r) ? r : []; }
          clear(listEl);
          if (!snaps.length) { listEl.append(h('p', { class: 'dim pad', text: 'Noch keine Snapshots. Sie entstehen höchstens stündlich.' })); return; }
          for (const s of snaps) listEl.append(item(h('span', {}, h('span', { class: 'when', text: fmtAbs(s.ts) }), h('span', { class: 'dim small', text: fmtRel(s.ts) })), fmtBytes(s.size), () => showSnap(s)));
        } else {
          if (!backups) { const r = await api('backups', { quiet: true }); backups = r && Array.isArray(r.backups) ? r.backups : []; }
          clear(listEl);
          if (!backups.length) { listEl.append(h('p', { class: 'dim pad' }, 'Noch keine Sicherungen. ', h('a', { href: '#/backups', text: 'Sicherungen' }))); return; }
          for (const b of backups) listEl.append(item(h('span', {}, h('span', { class: 'when', text: backupTitle(b) }), h('span', { class: 'dim small', text: b.kind === 'auto' ? 'automatisch' : fmtAbs(b.created) })), null, () => showBackup(b)));
        }
      } catch (e) { replace(listEl, errorEl('Liste konnte nicht geladen werden', e, fill)); }
    }
    function item(label, side, onClick) {
      const b = h('button', { type: 'button', role: 'option', 'aria-selected': 'false' }, label, side ? h('span', { class: 'sz', text: side }) : null);
      b.addEventListener('click', () => {
        for (const x of listEl.querySelectorAll('button')) x.setAttribute('aria-selected', 'false');
        b.setAttribute('aria-selected', 'true');
        onClick();
      });
      return b;
    }
    const viewSeg = () => {
      const s = h('div', { class: 'seg', role: 'group', 'aria-label': 'Darstellung' },
        h('button', { class: 'btn sm', type: 'button', 'aria-pressed': String(viewMode === 'diff'), text: 'Unterschiede', onclick: () => { viewMode = 'diff'; if (selected) selected.show(); } }),
        h('button', { class: 'btn sm', type: 'button', 'aria-pressed': String(viewMode === 'text'), text: 'Text', onclick: () => { viewMode = 'text'; if (selected) selected.show(); } }));
      return s;
    };
    async function mdView(text, legendOld) {
      const cur = viewMode === 'diff' ? await getLive() : null;
      replace(view, h('div', { class: 'view-tools' }, viewSeg()),
        viewMode === 'diff'
          ? frag(h('div', { class: 'diff-legend' }, h('span', { class: 'del', text: `− ${legendOld}` }), h('span', { class: 'add', text: editorText() != null ? `+ Editor (geladen ${loadedAt})` : '+ heute' })), diffEl(text, cur))
          : h('div', { class: 'md snap-md' }, renderMarkdown(text, {})));
    }
    async function showSnap(s) {
      replace(view, loadingEl());
      try {
        const snap = await api(`spaces/${enc(space)}/history/${enc(d.id)}/${enc(s.ts)}`, { quiet: true });
        selected = { kind: 'snap', ts: s.ts, show: () => showSnapData(snap, s) };
        if (restoreBtn) restoreBtn.disabled = kind !== 'md';
        await showSnapData(snap, s);
      } catch (e) { replace(view, errorEl('Snapshot konnte nicht geladen werden', e, () => showSnap(s))); }
    }
    async function showSnapData(snap, s) {
      if (kind === 'md') await mdView(typeof (snap && snap.text) === 'string' ? snap.text : '', `Snapshot ${fmtAbs(s.ts)}`);
      else replace(view, h('dl', { class: 'kv' }, h('dt', { text: 'Striche' }), h('dd', { text: snap && Array.isArray(snap.strokes) ? fmtNum(snap.strokes.length) : '–' })));
    }
    async function showBackup(b) {
      replace(view, loadingEl());
      let r;
      try { r = await api(`backups/${enc(b.name)}/spaces/${enc(space)}/docs/${enc(d.id)}`, { quiet: true, expect: [404] }); }
      catch (e) {
        selected = null; if (restoreBtn) restoreBtn.disabled = true;
        if (e.status === 404) replace(view, h('p', { class: 'dim', text: 'In dieser Sicherung gab es die Datei noch nicht.' }));
        else replace(view, errorEl('Stand konnte nicht geladen werden', e, () => showBackup(b)));
        return;
      }
      selected = { kind: 'backup', backup: b, entry: r, show: () => showBackupData(b, r) };
      if (restoreBtn) restoreBtn.disabled = false;
      await showBackupData(b, r);
    }
    async function showBackupData(b, r) {
      if (kind === 'md') await mdView(typeof r.text === 'string' ? r.text : '', `Sicherung ${backupWhen(b)}`);
      else if (kind === 'blob') {
        const e = entryById(d.id) || {};
        const same = e.hash && r.hash === e.hash;
        const isImg = IMG_EXT.has(extOf(d.path));
        replace(view,
          h('dl', { class: 'kv' },
            h('dt', { text: 'Größe' }), h('dd', { text: `${fmtBytes(r.size)} (Sicherung) · ${fmtBytes(e.size)} (heute)` }),
            h('dt', { text: 'Inhalt' }), h('dd', { text: same ? 'gleich wie heute' : 'anders als heute' })),
          isImg ? h('div', { class: 'compare' },
            h('figure', {}, h('img', { src: `${API}backups/${enc(b.name)}/spaces/${enc(space)}/raw/${enc(d.id)}`, alt: 'Stand der Sicherung' }), h('figcaption', { text: 'Sicherung' })),
            h('figure', {}, h('img', { src: rawUrl(space, d.id), alt: 'Heute' }), h('figcaption', { text: 'Heute' }))) : null);
      } else {
        replace(view, h('dl', { class: 'kv' }, h('dt', { text: 'Striche' }), h('dd', { text: Array.isArray(r.strokes) ? fmtNum(r.strokes.length) : '–' })));
      }
    }

    await openDialog({
      title: `${kind === 'blob' ? 'Ältere Stände' : 'Verlauf'}: ${basename(d.path)}`,
      wide: true,
      body: frag(seg, h('div', { class: 'history' }, listEl, view)),
      buttons: [
        { label: 'Schließen', value: false },
        { label: 'Wiederherstellen', kind: 'primary', disabled: true, ref: (b) => { restoreBtn = b; }, busyLabel: 'Stelle wieder her …', onClick: async (close) => {
          if (!selected) return;
          const dirty = ctx.ed && ctx.ed.id === d.id && ctx.ed.ta.value !== ctx.ed.saved;
          if (dirty && !(await confirmDialog('Ungespeicherte Änderungen', 'Ungespeicherte Änderungen im Editor gehen dabei verloren.', { okLabel: 'Verwerfen und wiederherstellen', danger: true }))) return;
          if (selected.kind === 'snap') {
            try {
              await api(`spaces/${enc(space)}/history/${enc(d.id)}/${enc(selected.ts)}/restore`, { method: 'POST' });
              close(true);
              toast('Version wiederhergestellt', 'ok');
            } catch { return; }
          } else {
            close(true);
            const res = await restoreDialog({ backup: selected.backup, space, entries: [{ id: d.id, path: selected.entry.path || d.path, kind, status: 'changed', livePath: d.path !== selected.entry.path ? d.path : null }], online: ctx.online });
            if (!res) return;
            toast(res.restored ? 'Stand aus der Sicherung wiederhergestellt' : 'Nichts zu ändern – entsprach schon der Sicherung', 'ok', { href: `#/backups/${enc(res.safety)}/${enc(space)}`, linkText: 'Sicherheitskopie' });
          }
          if (ctx.ed) ctx.ed.saved = ctx.ed.ta.value; // Guard freigeben, Inhalt kommt gleich neu
          await ctx.loadFiles().catch(() => {});
          if (ctx.doc && ctx.doc.id === d.id) await openDoc(d.id, true);
        } },
      ],
      onOpen: fill,
      cancelValue: false,
    });
  }

  // --- Hochladen
  function uploadDialog(folder, preset) {
    const folderInput = h('input', { class: 'input mono', id: 'up-folder', value: folder || '', placeholder: '(oberste Ebene)', autocomplete: 'off', spellcheck: 'false' });
    const fileInput = h('input', { class: 'sr', id: 'up-files', type: 'file', multiple: true });
    const pickBtn = h('button', { class: 'btn', type: 'button', text: 'Dateien auswählen …', onclick: () => fileInput.click() });
    const drop = h('div', { class: 'dropzone' }, pickBtn, h('span', { class: 'dim small', text: 'oder hierher ziehen · je max. 100 MiB' }));
    const list = h('div', { class: 'upload-list', 'aria-live': 'polite' });
    const err = h('div', { class: 'form-error', role: 'alert' });
    let files = preset ? preset.slice() : [];
    let running = false, finished = false, xhr = null;
    let goBtn = null, cancelBtn = null;
    const target = (f) => { const dir = folderInput.value.trim().replace(/^\/+|\/+$/g, ''); return (dir ? dir + '/' : '') + f.name; };
    const paintList = () => {
      clear(list);
      for (const f of files) {
        const p = target(f);
        const exists = entryByPath(p);
        f._row = h('div', { class: 'u' }, h('span', { class: 'n', text: p }), h('span', { class: 'st' + (exists ? ' warn' : ''), text: exists ? `${fmtBytes(f.size)} · ersetzt vorhandene Datei` : fmtBytes(f.size) }));
        list.append(f._row);
      }
      if (goBtn) { goBtn.disabled = !files.length; goBtn.textContent = files.length ? `${plural(files.length, 'Datei', 'Dateien')} hochladen` : 'Hochladen'; }
    };
    fileInput.addEventListener('change', () => { files = [...(fileInput.files || [])]; err.textContent = ''; paintList(); });
    folderInput.addEventListener('input', paintList);
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); if (running || finished) return; files = [...e.dataTransfer.files]; paintList(); });
    return openDialog({
      title: 'Dateien hochladen',
      body: frag(
        h('div', { class: 'field' }, h('label', { for: 'up-folder', text: 'Zielordner' }), folderInput),
        h('div', { class: 'field' }, h('label', { for: 'up-files', text: 'Dateien' }), fileInput, drop),
        err, list,
      ),
      lock: () => running,
      buttons: [
        { label: 'Abbrechen', ref: (b) => { cancelBtn = b; }, onClick: (close) => { if (running && xhr) xhr.abort(); else close(finished); } },
        { label: 'Hochladen', kind: 'primary', disabled: !files.length, ref: (b) => { goBtn = b; }, onClick: async (close, btn) => {
          if (finished) { close(true); return; }
          if (!files.length) { err.textContent = 'Keine Dateien ausgewählt.'; return; }
          const dir = folderInput.value.trim().replace(/^\/+|\/+$/g, '');
          if (dir) { const p = validatePath(dir); if (p) { err.textContent = p; return; } }
          err.textContent = '';
          running = true;
          folderInput.disabled = true; pickBtn.disabled = true;
          cancelBtn.textContent = 'Abbrechen';
          let okCount = 0, aborted = false;
          for (const f of files) {
            if (aborted) break;
            const path = target(f);
            const prog = h('progress', { max: '1', value: '0' });
            const st = f._row.querySelector('.st');
            f._row.append(prog);
            try {
              await xhrUpload(`${API}spaces/${enc(space)}/upload?path=${enc(path)}`, f, (p) => { prog.value = p; }, (x) => { xhr = x; });
              prog.value = 1; st.textContent = 'fertig'; st.className = 'st ok'; okCount++;
            } catch (ex) {
              st.textContent = ex.message; st.className = 'st err';
              if (ex.data && ex.data.error === 'Abgebrochen') aborted = true;
            }
          }
          running = false; finished = true; xhr = null;
          cancelBtn.hidden = true;
          btn.textContent = 'Fertig';
          toast(`${fmtNum(okCount)} von ${plural(files.length, 'Datei', 'Dateien')} hochgeladen`, okCount === files.length ? 'ok' : 'error');
          if (dir) ctx.expanded.add(dir);
          try { await ctx.loadFiles(); } catch { /* Toast */ }
          btn.focus();
        } },
      ],
      onOpen: () => { paintList(); (files.length ? goBtn : pickBtn).focus(); },
      cancelValue: false,
    });
  }

  // --- Mitglieder
  async function renderMembers() {
    if (!filePane.querySelector('.members-page')) replace(filePane, loadingEl());
    if (!ctx.info && !ctx.infoError) await ctx.loadInfo();
    if (ctx.notFound) return;
    if (!ctx.users) { try { ctx.users = await loadUsers(); } catch (e) { replace(filePane, h('div', { class: 'page' }, errorEl('Personen konnten nicht geladen werden', e, () => ctx.reload()))); return; } }
    if (ctx.tab !== '_members') return;
    if (!ctx.info) { replace(filePane, h('div', { class: 'page' }, errorEl('Mitglieder konnten nicht geladen werden', ctx.infoError, () => ctx.reload()))); return; }
    const ms = members();
    const users = Array.isArray(ctx.users) ? ctx.users : [];
    const memberIds = new Set(ms.map((m) => m.id));
    const meId = state.me && state.me.user ? state.me.user.id : null;
    const owners = ms.filter((m) => m.role === 'owner');
    const onlineUsers = new Map();
    for (const o of ctx.online) onlineUsers.set(o.user, (onlineUsers.get(o.user) || 0) + 1);
    const consequence = (m, removing) => {
      const out = [];
      if (m.id === meId) out.push('Deine eigenen Geräte verlieren damit ' + (removing ? 'den Zugriff auf diesen Vault.' : 'Rechte in diesem Vault.'));
      if (m.role === 'owner' && owners.length === 1) out.push('Danach kann niemand mehr aus Obsidian heraus einladen.');
      return out.join(' ');
    };
    const rows = ms.map((m) => {
      const name = esc(m.name || m.id);
      const sel = commitSelect(roleSelect(m.role, `Rolle von ${name}`), async (role, prev) => {
        const extra = role !== 'owner' && prev === 'owner' ? consequence(m, false) : (m.id === meId && role === 'read' ? consequence(m, false) : '');
        if (extra && !(await confirmDialog('Rolle ändern', `${name}: ${roleLabel(prev)} → ${roleLabel(role)}. ${extra}`, { okLabel: 'Ändern' }))) throw new Error('abgebrochen');
        await setMember(space, m.id, role);
        m.role = role;
        toast(`${name}: jetzt „${roleLabel(role)}“${onlineUsers.get(m.id) ? '. Die Geräte verbinden sich neu.' : ''}`, 'ok');
      });
      const rm = h('button', { class: 'btn sm', type: 'button', text: 'Entfernen', 'aria-label': `${name} entfernen` });
      rm.addEventListener('click', async () => {
        const extra = consequence(m, true);
        const ok = await confirmDialog('Zugriff entziehen', `${name} verliert den Zugriff auf diesen Vault, verbundene Geräte werden getrennt. Lokale Kopien bleiben auf den Geräten.${extra ? ' ' + extra : ''}`, { okLabel: 'Zugriff entziehen', danger: true });
        if (!ok) return;
        await busy(rm, async () => {
          await removeMember(space, m.id);
          toast(`${name} hat keinen Zugriff mehr`, 'ok');
          await ctx.loadInfo();
          await renderMembers();
          refocus(filePane, 'add', filePane.querySelector('h2'));
        });
      });
      const n = onlineUsers.get(m.id) || 0;
      return h('tr', { dataset: { key: 'm:' + m.id } },
        h('td', {},
          h('a', { class: 'plain-link', href: `#/users/${enc(m.id)}` }, colorDot(m.color), nameWithId(m.name || m.id, m.id)),
          m.id === meId ? h('span', { class: 'badge', text: 'du' }) : null,
          n ? h('span', { class: 'ok-text small', title: plural(n, 'Gerät verbunden', 'Geräte verbunden'), text: ' ● ' + plural(n, 'Gerät', 'Geräte') }) : null),
        h('td', {}, sel),
        h('td', { class: 'actions' }, rm));
    });
    const candidates = users.filter((u) => u && !memberIds.has(u.id)).sort((a, b) => coll.compare(a.name || a.id, b.name || b.id));
    let addRow = null;
    if (candidates.length) {
      const addSel = h('select', { class: 'select', id: 'mem-add', dataset: { key: 'add' } }, candidates.map((u) => h('option', { value: u.id, text: esc(u.name || u.id) + (u.name && slugify(u.name) !== u.id ? ` (${u.id})` : '') })));
      const addRole = roleSelect('write', 'Rolle');
      const addBtn = h('button', { class: 'btn sm', type: 'button', text: 'Hinzufügen' });
      addBtn.addEventListener('click', () => busy(addBtn, async () => {
        const who = users.find((u) => u.id === addSel.value);
        await setMember(space, addSel.value, addRole.value);
        toast(`${esc(who ? who.name || who.id : addSel.value)} hat jetzt Zugriff („${roleLabel(addRole.value)}“)`, 'ok');
        await ctx.loadInfo();
        await renderMembers();
        refocus(filePane, 'add', filePane.querySelector('h2'));
      }));
      addRow = h('div', { class: 'add-row' }, h('label', { class: 'lbl', for: 'mem-add', text: 'Person hinzufügen:' }), addSel, addRole, addBtn);
    } else {
      addRow = h('p', { class: 'dim small' }, users.length ? 'Alle Personen haben schon Zugriff. ' : 'Es gibt noch keine Personen. ', h('a', { href: '#/users', text: 'Personen verwalten' }));
    }
    const onlineN = ctx.online.length;
    replace(filePane, h('div', { class: 'page members-page' },
      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', { text: `Mitglieder (${fmtNum(ms.length)})`, tabindex: '-1' }), onlineN ? h('span', { class: 'dim small', text: plural(onlineN, 'Gerät verbunden', 'Geräte verbunden') }) : null),
        ms.length ? table(['Person', 'Rolle', { text: '', class: 'actions' }], rows, { cls: 'controls', caption: 'Mitglieder' }) : h('p', { class: 'card-body warn-note flat', text: 'Noch niemand hat Zugriff auf diesen Vault.' }),
        h('div', { class: 'card-body' }, addRow, h('p', { class: 'dim small', text: ROLE_HINT }))),
    ));
    if (!ms.length) { const s = filePane.querySelector('#mem-add'); if (s) s.focus({ preventScroll: true }); }
    renderHeadState();
  }

  // --- Papierkorb (nach Ordner gruppiert)
  function renderTrash() {
    if (ctx.filesError) { replace(filePane, h('div', { class: 'page' }, errorEl('Papierkorb konnte nicht geladen werden', ctx.filesError, () => ctx.reload()))); return; }
    if (!ctx.filesLoaded) { replace(filePane, loadingEl()); return; }
    const gone = ctx.files.filter((f) => f && f.del && typeof f.path === 'string').sort((a, b) => coll.compare(a.path, b.path));
    const groups = new Map();
    for (const f of gone) { const d = dirname(f.path); if (!groups.has(d)) groups.set(d, []); groups.get(d).push(f); }
    const conflicts = ctx.trashConflicts || (ctx.trashConflicts = new Set());
    const restoreOne = async (f) => {
      try {
        await api(`spaces/${enc(space)}/undelete`, { method: 'POST', body: { doc: f.id }, expect: [409], quiet: true });
        conflicts.delete(f.id);
        return { ok: true };
      } catch (ex) { if (ex.status === 409) conflicts.add(f.id); return { ok: false, ex }; }
    };
    const after = async (key) => { await ctx.loadFiles().catch(() => {}); renderTrash(); refocus(filePane, key, filePane.querySelector('h2')); };
    const rows = [];
    for (const [dir, list] of [...groups.entries()].sort((a, b) => coll.compare(a[0], b[0]))) {
      if (list.length > 1 || dir) {
        const all = h('button', { class: 'btn sm', type: 'button', text: list.length > 1 ? `Alle ${fmtNum(list.length)} wiederherstellen` : 'Wiederherstellen', 'aria-label': `Alle Dateien in ${dir || 'oberster Ebene'} wiederherstellen` });
        all.addEventListener('click', () => busy(all, async () => {
          let ok = 0; const bad = [];
          for (const f of list) { const r = await restoreOne(f); if (r.ok) ok++; else bad.push(f.path); }
          if (bad.length) await openDialog({ title: 'Teilweise wiederhergestellt', body: frag(h('p', { text: `${plural(ok, 'Datei', 'Dateien')} wiederhergestellt. Bei ${plural(bad.length, 'Datei', 'Dateien')} ist der Pfad inzwischen belegt:` }), h('ul', { class: 'plain-list mono small' }, bad.map((p) => h('li', { text: p }))), h('p', { class: 'dim small', text: 'Diese einzeln über „Wiederherstellen“ unter anderem Namen zurückholen.' })), buttons: [{ label: 'OK', kind: 'primary', value: true }] });
          else toast(`${plural(ok, 'Datei', 'Dateien')} wiederhergestellt`, 'ok');
          await after('grp:' + dir);
        }));
        rows.push(h('tr', { class: 'group', dataset: { key: 'grp:' + dir } }, h('td', { colspan: '2' }, h('span', { class: 'path', text: (dir || '(oberste Ebene)') + (dir ? '/' : '') }), h('span', { class: 'dim small', text: ' · ' + plural(list.length, 'Datei', 'Dateien') })), h('td', { class: 'actions' }, list.length > 1 ? all : null)));
      }
      for (const f of list) {
        const btn = h('button', { class: 'btn sm', type: 'button', text: 'Wiederherstellen', 'aria-label': `${basename(f.path)} wiederherstellen` });
        btn.addEventListener('click', () => busy(btn, async () => {
          const r = await restoreOne(f);
          if (r.ok) { toast(`„${basename(f.path)}“ wiederhergestellt`, 'ok', { href: `#/vault/${enc(space)}/${enc(f.id)}` }); await after('t:' + (gone[gone.indexOf(f) + 1] || {}).id); return; }
          if (r.ex.status !== 409) { toast(r.ex.message, 'error'); return; }
          await trashConflict(f);
          await after('t:' + f.id);
        }));
        const by = f.by ? personLabel(f.by, { noDot: true }) : null;
        rows.push(h('tr', { class: dir || list.length > 1 ? 'sub' : null, dataset: { key: 't:' + f.id } },
          h('td', {}, h('span', { class: 'name', title: f.path, text: basename(f.path) }), conflicts.has(f.id) ? h('span', { class: 'badge warn', text: 'Pfad belegt' }) : null,
            h('div', { class: 'dim small' }, KIND_LABEL[f.kind] || 'Datei', by ? frag(' · gelöscht von ', by) : null)),
          h('td', {}, timeEl(f.ts)),
          h('td', { class: 'actions' }, btn)));
      }
    }
    replace(filePane, h('div', { class: 'page' },
      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', { text: `Papierkorb (${fmtNum(gone.length)})`, tabindex: '-1' })),
        gone.length ? table(['Datei', 'Gelöscht', { text: '', class: 'actions' }], rows, { caption: 'Papierkorb', cls: 'trash' }) : emptyEl('Der Papierkorb ist leer.')),
      h('p', { class: 'dim small' }, 'Älteres oder endgültig Verlorenes: ', h('a', { href: `#/vault/${enc(space)}/_backups`, text: 'Aus einer Sicherung wiederherstellen' })),
    ));
    renderHeadState();
  }

  async function trashConflict(f) {
    const occupant = entryByPath(f.path);
    const choice = await openDialog({
      title: 'Pfad ist belegt',
      body: frag(
        h('p', {}, 'Unter ', h('code', { text: f.path }), ' liegt inzwischen eine andere Datei.'),
        h('p', { class: 'dim small', text: 'Die gelöschte Datei lässt sich unter einem anderen Namen zurückholen.' })),
      buttons: [
        { label: 'Abbrechen', value: null },
        occupant ? { label: 'Vorhandene öffnen', value: 'open' } : null,
        { label: 'Unter anderem Namen …', value: 'rename', kind: 'primary' },
      ].filter(Boolean),
    });
    if (choice === 'open' && occupant) { navigate(`#/vault/${enc(space)}/${enc(occupant.id)}`); return; }
    if (choice !== 'rename') return;
    const ext = extOf(f.path);
    const base = stripExt(basename(f.path));
    const dir = dirname(f.path);
    let suggestion = (dir ? dir + '/' : '') + `${base} (wiederhergestellt)${ext ? '.' + ext : ''}`;
    for (let i = 2; entryByPath(suggestion) && i < 100; i++) suggestion = (dir ? dir + '/' : '') + `${base} (wiederhergestellt ${i})${ext ? '.' + ext : ''}`;
    const p = await promptDialog('Unter anderem Namen wiederherstellen', { label: 'Neuer Pfad', value: suggestion, mono: true, selectBase: true, okLabel: 'Wiederherstellen',
      validate: (v) => validatePath(v) || (entryByPath(v) ? 'Dieser Pfad ist auch belegt.' : null) || (extOf(v) !== ext ? `Die Endung muss „.${ext}“ bleiben.` : null),
      submit: (v) => api(`spaces/${enc(space)}/undelete`, { method: 'POST', body: { doc: f.id, path: v }, quiet: true }) });
    if (p == null) return;
    (ctx.trashConflicts || new Set()).delete(f.id);
    toast(`Als „${basename(p)}“ wiederhergestellt`, 'ok', { href: `#/vault/${enc(space)}/${enc(f.id)}` });
  }

  // --- Sicherungen (Export und Einstieg in die Wiederherstellung)
  async function renderBackupsTab() {
    const box = h('div');
    const exportBtn = h('button', { class: 'btn', type: 'button', text: 'Heutigen Stand exportieren (.tar)', onclick: () => exportVault(space) });
    replace(filePane, h('div', { class: 'page' },
      card('Export', null, h('div', { class: 'card-body' },
        h('p', {}, exportBtn),
        h('p', { class: 'dim small', text: 'Notizen, Handschrift und Anhänge als Ordnerstruktur, z. B. zum Einchecken in Git.' }))),
      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', { text: 'Aus einer Sicherung wiederherstellen' }), h('a', { href: '#/backups', text: 'Alle Sicherungen' })),
        box)));
    const load = loader(box, async () => {
      const r = await api('backups', { quiet: true });
      const list = r && Array.isArray(r.backups) ? r.backups : [];
      if (!list.length) return emptyEl('Noch keine Sicherungen.', h('a', { href: '#/backups', text: 'Zu den Sicherungen' }));
      return h('ul', { class: 'rows' }, list.slice(0, 10).map((b) => h('li', { class: 'row2' },
        h('div', { class: 'main' }, h('a', { href: `#/backups/${enc(b.name)}/${enc(space)}`, text: backupTitle(b) }),
          h('span', { class: 'dim small' }, b.kind === 'auto' ? 'automatisch' : (isSafety(b) ? 'Sicherheitskopie' : 'von Hand'), ' · ', backupWhen(b))),
        h('div', { class: 'side' }, h('a', { class: 'btn sm', href: `#/backups/${enc(b.name)}/${enc(space)}`, text: 'Vergleichen' })))));
    }, { what: 'Die Liste der Sicherungen' });
    await load();
  }

  return ctx;
}

// Upload mit Fortschritt; bei 401 einmal anmelden und wiederholen
async function xhrUpload(url, file, onProgress, onXhr) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      if (onXhr) onXhr(x);
      x.open('POST', url);
      x.setRequestHeader('X-Tandem-Admin', '1');
      x.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
      x.setRequestHeader('Accept', 'application/json');
      x.upload.addEventListener('progress', (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); });
      x.addEventListener('load', () => {
        let data = null;
        try { data = x.responseText ? JSON.parse(x.responseText) : null; } catch { data = { error: x.responseText.slice(0, 200) }; }
        resolve({ status: x.status, data });
      });
      x.addEventListener('error', () => reject(new ApiError(0, null)));
      x.addEventListener('abort', () => reject(new ApiError(0, { error: 'Abgebrochen' })));
      x.send(file);
    });
    if (res.status === 401) { await requireLogin('expired'); continue; }
    if (res.status < 200 || res.status >= 300) throw new ApiError(res.status, res.data);
    return res.data;
  }
  throw new ApiError(401, { error: 'Nicht angemeldet' });
}

// ---------------------------------------------------------------------------
// Markdown-Vorschau: baut ausschließlich DOM-Knoten (kein HTML-Parsing), Links nur http(s)/mailto/intern.
// Obsidian-Eigenheiten: Frontmatter als Eigenschaften, Tabellen, Callouts, einfache Zeilenumbrüche,
// %%Kommentare%%, #tags, ![[bild|breite]], Fußnoten, $Formeln$ (als Text).

const CALLOUT_LABELS = { note: 'Hinweis', info: 'Info', tip: 'Tipp', hint: 'Tipp', important: 'Wichtig', success: 'Erledigt', check: 'Erledigt', done: 'Erledigt',
  question: 'Frage', help: 'Frage', faq: 'Frage', warning: 'Warnung', caution: 'Achtung', attention: 'Achtung', failure: 'Fehlgeschlagen', fail: 'Fehlgeschlagen',
  missing: 'Fehlt', danger: 'Gefahr', error: 'Fehler', bug: 'Fehler', example: 'Beispiel', quote: 'Zitat', cite: 'Zitat', abstract: 'Zusammenfassung', summary: 'Zusammenfassung', tldr: 'Zusammenfassung', todo: 'Aufgabe' };
const CALLOUT_TONE = { warning: 'warn', caution: 'warn', attention: 'warn', danger: 'danger', error: 'danger', bug: 'danger', failure: 'danger', fail: 'danger', missing: 'danger', success: 'ok', check: 'ok', done: 'ok', tip: 'ok', hint: 'ok' };

function renderMarkdown(src, opts = {}) {
  let text = String(src || '').replace(/\r\n?/g, '\n');
  // %%Kommentare%% ausblenden (auch mehrzeilig)
  text = text.replace(/%%[\s\S]*?%%/g, '');
  let lines = text.split('\n');
  const out = document.createDocumentFragment();
  const notes = opts.footnotes || new Map();
  const top = !opts.footnotes;
  const o = { ...opts, footnotes: notes };
  let i = 0;
  // Frontmatter (nur ganz oben)
  if (top && lines[0] === '---') {
    const end = lines.indexOf('---', 1);
    if (end > 0) {
      out.append(frontmatterEl(lines.slice(1, end)));
      i = end + 1;
    }
  }
  // Fußnoten-Definitionen einsammeln
  if (top) {
    lines = lines.filter((l, k) => {
      if (k < i) return true;
      const m = l.match(/^\[\^([^\]\s]+)\]:\s*(.*)$/);
      if (m) { notes.set(m[1], { text: m[2], n: 0 }); return false; }
      return true;
    });
  }
  let para = [];
  const flush = () => {
    if (!para.length) return;
    const p = h('p');
    para.forEach((l, k) => { if (k) p.append(h('br')); append(p, inline(l, o)); });
    out.append(p);
    para = [];
  };
  while (i < lines.length) {
    const line = lines[i];
    let m;
    if ((m = line.match(/^\s*(```+|~~~+)\s*([\w+-]*)/))) {
      flush();
      const fence = m[1];
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence)) buf.push(lines[i++]);
      i++;
      if (m[2] === 'math') out.append(h('pre', { class: 'math' }, h('code', { text: buf.join('\n') })));
      else out.append(h('pre', {}, h('code', { class: m[2] ? 'lang-' + m[2].replace(/[^\w-]/g, '') : null, text: buf.join('\n') })));
      continue;
    }
    if (/^\s*\$\$\s*$/.test(line)) {
      flush();
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*\$\$\s*$/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.append(h('pre', { class: 'math' }, h('code', { text: buf.join('\n') })));
      continue;
    }
    if (!line.trim()) { flush(); i++; continue; }
    if ((m = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/))) { flush(); out.append(h('h' + m[1].length, {}, inline(m[2], o))); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out.append(h('hr')); i++; continue; }
    if (/^\s*>/.test(line)) {
      flush();
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      const cm = buf[0].match(/^\[!(\w+)\]([+-]?)\s*(.*)$/);
      if (cm) {
        const type = cm[1].toLowerCase();
        const titleText = cm[3] || CALLOUT_LABELS[type] || cm[1];
        const content = renderMarkdown(buf.slice(1).join('\n'), o);
        const box = h('div', { class: 'callout ' + (CALLOUT_TONE[type] || 'accent'), dataset: { type } });
        if (cm[2]) {
          box.append(h('details', { open: cm[2] === '+' ? true : null }, h('summary', { class: 'callout-title' }, inline(titleText, o)), h('div', { class: 'callout-body' }, content)));
        } else box.append(h('div', { class: 'callout-title' }, inline(titleText, o)), h('div', { class: 'callout-body' }, content));
        out.append(box);
      } else out.append(h('blockquote', {}, renderMarkdown(buf.join('\n'), o)));
      continue;
    }
    // Tabelle: Kopfzeile + Trennzeile
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      flush();
      const cells = (l) => { let s = l.trim(); if (s.startsWith('|')) s = s.slice(1); if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1); return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|')); };
      const head = cells(line);
      const align = cells(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'c' : c.endsWith(':') ? 'r' : null));
      i += 2;
      const body = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) body.push(cells(lines[i++]));
      out.append(h('div', { class: 'table-wrap md-table' }, h('table', { class: 'table' },
        h('thead', {}, h('tr', {}, head.map((c, k) => h('th', { class: align[k] ? 'al-' + align[k] : null }, inline(c, o))))),
        h('tbody', {}, body.map((r) => h('tr', {}, head.map((_, k) => h('td', { class: align[k] ? 'al-' + align[k] : null }, inline(r[k] || '', o)))))))));
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      flush();
      const r = parseList(lines, i, o);
      out.append(r.el);
      i = r.next;
      continue;
    }
    para.push(line);
    i++;
  }
  flush();
  // Fußnoten am Ende
  if (top && [...notes.values()].some((n) => n.n)) {
    const used = [...notes.entries()].filter(([, n]) => n.n).sort((a, b) => a[1].n - b[1].n);
    out.append(h('section', { class: 'footnotes', 'aria-label': 'Fußnoten' }, h('hr'), h('ol', {}, used.map(([, n]) => h('li', {}, inline(n.text, o))))));
  }
  return out;
}

function frontmatterEl(lines) {
  const dl = h('dl', { class: 'kv props' });
  let lastDd = null;
  for (const l of lines) {
    const m = l.match(/^([\w ._-]+):\s*(.*)$/);
    if (m) {
      let v = m[2].trim();
      const dd = h('dd');
      if (/^\[.*\]$/.test(v)) v = v.slice(1, -1).split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
      if (Array.isArray(v)) dd.append(h('span', { class: 'chips' }, v.map((x) => h('span', { class: 'chip', text: x }))));
      else dd.textContent = v.replace(/^["']|["']$/g, '');
      dl.append(h('dt', { text: m[1] }), dd);
      lastDd = dd;
    } else if (lastDd && /^\s*-\s+/.test(l)) {
      let chips = lastDd.querySelector('.chips');
      if (!chips) { chips = h('span', { class: 'chips' }); lastDd.append(chips); }
      chips.append(h('span', { class: 'chip', text: l.replace(/^\s*-\s+/, '').replace(/^["']|["']$/g, '') }));
    }
  }
  return h('div', { class: 'props-box', role: 'group', 'aria-label': 'Eigenschaften' }, dl);
}

function parseList(lines, i, opts) {
  const items = [];
  while (i < lines.length) {
    const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (m) { items.push({ indent: m[1].replace(/\t/g, '    ').length, ordered: /\d/.test(m[2]), start: parseInt(m[2], 10), text: m[3] }); i++; continue; }
    if (items.length && lines[i].trim() && /^\s+/.test(lines[i])) { items[items.length - 1].text += '\n' + lines[i].trim(); i++; continue; }
    break;
  }
  const top = items[0].indent;
  for (const it of items) if (it.indent < top) it.indent = top;
  const build = (start, indent) => {
    const list = h(items[start].ordered ? 'ol' : 'ul', items[start].ordered && items[start].start > 1 ? { start: String(items[start].start) } : null);
    let k = start;
    while (k < items.length && items[k].indent >= indent) {
      if (items[k].indent > indent && list.lastChild) {
        const r = build(k, items[k].indent);
        list.lastChild.append(r.el);
        k = r.next;
        continue;
      }
      const it = items[k];
      const li = h('li');
      const tm = it.text.match(/^\[([ xX/-])\]\s+([\s\S]*)$/);
      const lineParts = (t) => t.split('\n').map((l, n) => frag(n ? h('br') : null, inline(l, opts)));
      if (tm) { li.className = 'task' + (tm[1] !== ' ' ? ' done' : ''); li.append(h('input', { type: 'checkbox', disabled: true, checked: tm[1] !== ' ', tabindex: '-1', 'aria-label': tm[1] !== ' ' ? 'erledigt' : 'offen' }), ...lineParts(tm[2])); }
      else li.append(...lineParts(it.text));
      list.append(li);
      k++;
    }
    return { el: list, next: k };
  };
  return { el: build(0, top).el, next: i };
}

const INLINE_RE = /(`+)([\s\S]*?[^`])\1(?!`)|!\[\[([^\]\n]+)\]\]|\[\[([^\]\n]+)\]\]|!\[([^\]\n]*)\]\(((?:[^()\s]|\([^()\s]*\))+)(?:\s+"[^"]*")?\)|\[([^\]\n]+)\]\(((?:[^()\s]|\([^()\s]*\))+)(?:\s+"[^"]*")?\)|(\*\*|__)(?=\S)([\s\S]*?\S)\9|(\*|_)(?=\S)([^*_\n]*?\S)\11|~~(?=\S)([\s\S]*?\S)~~|<(https?:\/\/[^\s>]+)>|==(?=\S)([\s\S]*?\S)==|\[\^([^\]\s]+)\]|(^|[\s(])#([\p{L}\p{N}_/-]*\p{L}[\p{L}\p{N}_/-]*)|\$(?=\S)([^$\n]*?\S)\$(?!\d)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?"'])/gu;

function inline(text, opts) {
  const out = [];
  let last = 0;
  const re = new RegExp(INLINE_RE.source, INLINE_RE.flags);
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    last = re.lastIndex;
    if (m[2] !== undefined) out.push(h('code', { text: m[2].replace(/^ (.*) $/, '$1') }));
    else if (m[3] !== undefined) out.push(embedNode(m[3], opts));
    else if (m[4] !== undefined) out.push(wikilinkNode(m[4], opts));
    else if (m[6] !== undefined) out.push(imageNode(m[5], m[6], opts));
    else if (m[8] !== undefined) out.push(linkNode(m[7], m[8], opts));
    else if (m[10] !== undefined) out.push(h('strong', {}, inline(m[10], opts)));
    else if (m[12] !== undefined) out.push(h('em', {}, inline(m[12], opts)));
    else if (m[13] !== undefined) out.push(h('del', {}, inline(m[13], opts)));
    else if (m[14] !== undefined) out.push(linkNode(m[14], m[14], opts));
    else if (m[15] !== undefined) out.push(h('mark', {}, inline(m[15], opts)));
    else if (m[16] !== undefined) {
      const n = opts.footnotes && opts.footnotes.get(m[16]);
      if (n) { if (!n.n) n.n = Math.max(0, ...[...opts.footnotes.values()].map((x) => x.n)) + 1; out.push(h('sup', { class: 'fn', title: n.text, text: String(n.n) })); }
      else out.push(m[0]);
    } else if (m[18] !== undefined) out.push(m[17], h('span', { class: 'tag', text: '#' + m[18] }));
    else if (m[19] !== undefined) out.push(h('span', { class: 'math', text: m[19] }));
    else if (m[20] !== undefined) out.push(linkNode(m[20], m[20], opts));
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// Linkziel einordnen: extern (http/https/mailto), interne Datei oder nichts (javascript:, data:, unbekannt)
function classifyHref(url, opts) {
  url = String(url || '').trim();
  if (!url) return null;
  if (/^(https?:|mailto:)/i.test(url)) return { ext: url };
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//') || url.startsWith('#')) return null;
  let d = url.split('#')[0];
  try { d = decodeURI(d); } catch { /* roh lassen */ }
  const f = opts.resolve ? opts.resolve(d) : null;
  return f ? { file: f } : null;
}

function fileHref(f, opts) { return opts.href ? opts.href(f) : `#/vault/${enc(vaultCtx ? vaultCtx.space : '')}/${enc(f.id)}`; }

function linkNode(text, url, opts) {
  const c = classifyHref(url, opts);
  const content = inline(text, opts);
  if (!c) return h('span', { class: 'deadlink', title: 'Link nicht erlaubt oder Ziel nicht gefunden' }, content);
  if (c.ext) return h('a', { class: 'ext', href: c.ext, target: '_blank', rel: 'noopener noreferrer' }, content);
  return h('a', { href: fileHref(c.file, opts) }, content);
}

function wikilinkNode(inner, opts) {
  const [targetRaw, alias] = inner.split('|');
  const target = targetRaw.split('#')[0].trim();
  const label = (alias || targetRaw).trim();
  const f = target && opts.resolve ? opts.resolve(target) : null;
  if (!f) return h('span', { class: 'wikilink dead', title: 'Datei nicht gefunden', text: label });
  return h('a', { class: 'wikilink', href: fileHref(f, opts), title: f.path, text: label });
}

function embedNode(inner, opts) {
  const [targetRaw, size] = inner.split('|');
  const target = targetRaw.split('#')[0].trim();
  const f = target && opts.resolve ? opts.resolve(target) : null;
  if (!f) return h('span', { class: 'embed-missing', text: `![[${inner}]]` });
  if (IMG_EXT.has(extOf(f.path)) && opts.raw) {
    const img = h('img', { src: opts.raw(f.id), alt: basename(f.path), loading: 'lazy' });
    const w = size && size.match(/^\s*(\d{1,4})(?:x(\d{1,4}))?\s*$/);
    if (w) img.style.width = Math.min(2000, Number(w[1])) + 'px'; // CSSOM ist unter der CSP erlaubt
    return img;
  }
  return h('a', { class: 'embed-note', href: fileHref(f, opts), title: f.path }, h('span', { class: 'dim small', text: 'Eingebettet: ' }), displayName(f.path));
}

function imageNode(alt, url, opts) {
  const c = classifyHref(url, opts);
  if (c && c.file && IMG_EXT.has(extOf(c.file.path)) && opts.raw) return h('img', { src: opts.raw(c.file.id), alt: alt || basename(c.file.path), loading: 'lazy' });
  if (c && c.ext) return h('a', { class: 'ext', href: c.ext, target: '_blank', rel: 'noopener noreferrer', text: alt || url });
  return h('span', { class: 'embed-missing', text: `![${alt}](${url})` });
}

// ---------------------------------------------------------------------------
// Zeilen-Diff (LCS mit gemeinsamem Vor-/Nachspann; große Eingaben werden grob gezeigt)

function lineDiff(a, b) {
  const A = String(a).split('\n'), B = String(b).split('\n');
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const a2 = A.slice(pre, A.length - suf), b2 = B.slice(pre, B.length - suf);
  const ops = [];
  for (let i = 0; i < pre; i++) ops.push(['=', A[i]]);
  const n = a2.length, m = b2.length;
  if (n * m > 4000000) {
    for (const l of a2) ops.push(['-', l]);
    for (const l of b2) ops.push(['+', l]);
  } else {
    const W = m + 1;
    const dp = new Uint32Array((n + 1) * W);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * W + j] = a2[i] === b2[j] ? dp[(i + 1) * W + j + 1] + 1 : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
      }
    }
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a2[i] === b2[j]) { ops.push(['=', a2[i]]); i++; j++; }
      else if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) ops.push(['-', a2[i++]]);
      else ops.push(['+', b2[j++]]);
    }
    while (i < n) ops.push(['-', a2[i++]]);
    while (j < m) ops.push(['+', b2[j++]]);
  }
  for (let i = A.length - suf; i < A.length; i++) ops.push(['=', A[i]]);
  return ops;
}

function diffEl(a, b) {
  const ops = lineDiff(a, b);
  const box = h('div', { class: 'diff', role: 'region', 'aria-label': 'Unterschiede', tabindex: '0' });
  if (ops.every((o) => o[0] === '=')) { box.append(h('div', { class: 'l gap', text: 'Kein Unterschied' })); return box; }
  const ctxN = 3;
  let i = 0;
  while (i < ops.length) {
    if (ops[i][0] === '=') {
      let j = i;
      while (j < ops.length && ops[j][0] === '=') j++;
      const run = j - i;
      if (run > ctxN * 2 + 2) {
        const head = i === 0 ? 0 : ctxN;
        const tail = j === ops.length ? 0 : ctxN;
        for (let k = i; k < i + head; k++) box.append(diffLine(ops[k]));
        box.append(h('div', { class: 'l gap', text: `… ${plural(run - head - tail, 'gleiche Zeile', 'gleiche Zeilen')} …` }));
        for (let k = j - tail; k < j; k++) box.append(diffLine(ops[k]));
      } else for (let k = i; k < j; k++) box.append(diffLine(ops[k]));
      i = j;
    } else { box.append(diffLine(ops[i])); i++; }
  }
  return box;
}

function diffLine([t, text]) {
  const cls = t === '+' ? 'l add' : t === '-' ? 'l del' : 'l';
  return h('div', { class: cls }, h('span', { class: 's', 'aria-label': t === '+' ? 'hinzugefügt' : t === '-' ? 'entfernt' : null, text: t === '=' ? ' ' : t }), h('span', { class: 't', text: text || ' ' }));
}

// ---------------------------------------------------------------------------
// Statistik: Zeitreihen aus GET stats, Diagramme als Inline-SVG (keine Bibliothek).
// Punkte können unterschiedlich lang sein (`dur`): Mengen werden auf eine feste Einheit normiert.

const RANGES = [['1h', '1 h', 3600], ['6h', '6 h', 6 * 3600], ['24h', '24 h', 86400], ['48h', '48 h', 2 * 86400], ['7d', '7 T', 7 * 86400], ['30d', '30 T', 30 * 86400], ['90d', '90 T', 90 * 86400]];
const RANGE_LONG = { '7d': '7 Tage', '30d': '30 Tage', '90d': '90 Tage' };

async function viewStats() {
  let range = readPref('stats.range');
  if (!RANGES.some((r) => r[0] === range)) range = '24h';
  const seg = h('div', { class: 'seg ranges', role: 'group', 'aria-label': 'Zeitraum' });
  const body = h('div');
  const paint = () => { for (const b of seg.children) b.setAttribute('aria-pressed', String(b.dataset.r === range)); };
  let shown = range;
  for (const [r, label] of RANGES) {
    seg.append(h('button', { class: 'btn', type: 'button', text: label, title: RANGE_LONG[r] || null, dataset: { r }, onclick: () => { if (r !== range) { range = r; paint(); load(); } } }));
  }
  paint();
  const load = loader(body, async () => {
    const want = range;
    try {
      const [s, users, spaces] = await Promise.all([api('stats?range=' + enc(want), { quiet: true }), loadUsers(true).catch(() => []), loadSpaces(true).catch(() => [])]);
      shown = want;
      writePref('stats.range', want); // erst nach Erfolg merken
      return renderStats(s || {}, users, spaces, want);
    } catch (e) {
      range = shown; paint(); // Knopf zeigt wieder, was zu sehen ist
      throw e;
    }
  }, { what: 'Die Statistik' });
  page('Statistik', frag(seg, refreshButton(load)), body);
  await load();
}

function weightedRtt(s) {
  const t = s.total || {};
  if (Number(t.rttMs) > 0) return { v: Number(t.rttMs), n: Number(t.rttN) || 0 };
  let sum = 0, n = 0;
  for (const p of (Array.isArray(s.series) ? s.series : [])) {
    const v = Number(p.rttMs), w = Number(p.rttN) || 0;
    if (v > 0 && w > 0) { sum += v * w; n += w; }
  }
  return n ? { v: sum / n, n } : null;
}

// Kennzahlen als fertige Texte (für Statistik und Übersicht)
function statsKpis(s) {
  const t = s.total || {};
  const devices = Array.isArray(s.devices) ? s.devices : [];
  const bytesIn = Number(t.bytesIn) || 0, bytesOut = Number(t.bytesOut) || 0;
  const up = Number(s.now) - Number(s.startedAt);
  const rtt = weightedRtt(s);
  const now = devices.map((d) => Number(d.rttMs)).filter((v) => Number.isFinite(v) && v >= 0 && v !== null);
  const rttNow = now.length ? (Math.min(...now) === Math.max(...now) ? fmtMs(now[0]) : `${fmtMs(Math.min(...now))}–${fmtMs(Math.max(...now))}`) : null;
  const persons = new Set(devices.map((d) => d.user)).size;
  return {
    updates: fmtNum(t.updates || 0),
    traffic: fmtBytes(bytesIn + bytesOut), trafficSub: `${fmtBytes(bytesIn)} rein · ${fmtBytes(bytesOut)} raus`,
    blobUp: fmtNum(t.blobUp || 0), blobUpSub: fmtBytes(t.blobUpBytes || 0),
    blobDown: fmtNum(t.blobDown || 0), blobDownSub: fmtBytes(t.blobDownBytes || 0),
    conns: fmtNum(t.conns || 0),
    rtt: rtt ? fmtMs(rtt.v) : '–', rttNow, rttSub: rtt ? `gemittelt über ${plural(rtt.n, 'Messminute', 'Messminuten')}` : 'noch keine Messung',
    p50: Number(t.procP50Us) > 0 ? fmtMs(Number(t.procP50Us) / 1000) : '–',
    p95: Number(t.procP95Us) > 0 ? fmtMs(Number(t.procP95Us) / 1000) : '–',
    ram: s.rssKib != null ? fmtBytes(Number(s.rssKib) * 1024) : '–',
    uptime: Number.isFinite(up) && up >= 0 ? fmtDuration(up) : '–',
    online: fmtNum(devices.length), onlineLabel: devices.length === 1 ? 'Gerät online' : 'Geräte online',
    onlineSub: devices.length ? plural(persons, 'Person', 'Personen') : '',
  };
}

const shortDur = (d) => (d < 3600 ? `${Math.round(d / 60)} min` : d < 86400 ? `${nf1.format(d / 3600)} h` : `${nf1.format(d / 86400)} Tage`);
const tfDM = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit' });
const tfWDM = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' });
function intervalLabel(ts, dur) {
  const a = new Date(ts * 1000), b = new Date((ts + dur) * 1000);
  const datePart = sameLocalDay(a, new Date()) ? '' : tfWDM.format(a) + ', ';
  if (dur <= 60) return `${datePart}${tfHM.format(a)} (1 min)`;
  if (dur >= 86400) return `${tfWDM.format(a)} ${tfHM.format(a)} – ${tfWDM.format(b)} ${tfHM.format(b)}`;
  return `${datePart}${tfHM.format(a)}–${tfHM.format(b)} (${shortDur(dur)})`;
}

// Minutenpunkte (z. B. nach einem Neustart) zu Stundenpunkten bündeln, damit alle Balken gleich lang sind
const SUM_KEYS = ['updates', 'awareness', 'bytesIn', 'bytesOut', 'blobUp', 'blobUpBytes', 'blobDown', 'blobDownBytes'];
const PEAK_KEYS = ['conns', 'rssKib', 'procP95Us', 'procMaxUs'];
function rebucketHours(series, step) {
  const out = [], map = new Map();
  for (const p of series) {
    const d = Number(p.dur) > 0 ? Number(p.dur) : step;
    if (d > 3600) { out.push(p); continue; }
    const key = Math.floor(Number(p.ts) / 3600) * 3600;
    let b = map.get(key);
    if (!b) { b = { ts: key, _end: key, _rw: 0, _rs: 0, _pw: 0, _ps: 0 }; map.set(key, b); out.push(b); }
    for (const k of SUM_KEYS) b[k] = (b[k] || 0) + (Number(p[k]) || 0);
    for (const k of PEAK_KEYS) b[k] = Math.max(b[k] || 0, Number(p[k]) || 0);
    const w = Number(p.rttN) || (Number(p.rttMs) > 0 ? 1 : 0);
    if (Number(p.rttMs) > 0 && w) { b._rs += Number(p.rttMs) * w; b._rw += w; }
    const u = Number(p.updates) || 0;
    if (u && Number(p.procP50Us) > 0) { b._ps += Number(p.procP50Us) * u; b._pw += u; }
    for (const m of ['users', 'spaces']) if (p[m] && typeof p[m] === 'object') { b[m] = b[m] || {}; for (const [id, v] of Object.entries(p[m])) b[m][id] = (b[m][id] || 0) + (Number(v) || 0); }
    b._end = Math.max(b._end, Number(p.ts) + d);
  }
  for (const b of map.values()) {
    b.dur = Math.max(60, Math.min(3600, b._end - b.ts));
    b.rttMs = b._rw ? b._rs / b._rw : 0; b.rttN = b._rw;
    b.procP50Us = b._pw ? b._ps / b._pw : 0;
  }
  return out.sort((a, b) => Number(a.ts) - Number(b.ts));
}

function renderStats(s, users, spaces, range) {
  let series = (Array.isArray(s.series) ? s.series : []).filter((p) => p && Number.isFinite(Number(p.ts))).sort((a, b) => Number(a.ts) - Number(b.ts));
  const step = Number(s.step) === 3600 ? 3600 : 60;
  const now = Number(s.now) || Math.floor(Date.now() / 1000);
  const rangeSecs = (RANGES.find((r) => r[0] === range) || RANGES[2])[2];
  if (rangeSecs > 6 * 3600) series = rebucketHours(series, step);
  const from = now - rangeSecs;
  const k = statsKpis(s);
  const ts = series.map((p) => Number(p.ts));
  const dur = series.map((p) => (Number(p.dur) > 0 ? Number(p.dur) : step));
  // Mengen auf eine feste Einheit normieren (Minute bis 6 h, sonst Stunde)
  const unit = rangeSecs <= 6 * 3600 ? 60 : 3600;
  const unitName = unit === 60 ? 'Minute' : 'Stunde';
  const unitShort = unit === 60 ? 'min' : 'h';
  const sums = (key, scale = 1) => series.map((p) => (Number(p[key]) || 0) * scale);
  const rate = (arr) => arr.map((v, i) => v * unit / dur[i]);
  const common = { ts, dur, from, to: now, unitShort };
  const out = h('div', { class: 'stats' });

  // Hinweis, wenn die Aufzeichnung erst nach Beginn des Zeitraums einsetzt
  if (series.length && ts[0] > from + Math.max(2 * step, dur[0])) {
    const restart = s.startedAt && Math.abs(Number(s.startedAt) - ts[0]) <= dur[0] + 120;
    out.append(h('p', { class: 'notice-line' }, `Die Aufzeichnung beginnt am ${fmtAbs(ts[0])}`, restart ? ` (Server-Start ${fmtRel(s.startedAt)})` : '', '. Für die Zeit davor gibt es keine Messwerte.'));
  }

  const devices = Array.isArray(s.devices) ? s.devices : [];
  out.append(h('div', { class: 'kpi-groups' },
    h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', { text: 'Tempo' })),
      h('div', { class: 'stat-grid three', role: 'group', 'aria-label': 'Tempo' },
        stat(k.rtt, 'Ping-Laufzeit', k.rttNow ? `jetzt ${k.rttNow}` : k.rttSub),
        stat(k.p50, 'Verarbeitung typisch', 'Median je Änderung'),
        stat(k.p95, 'Verarbeitung Spitze', 'p95, Höchstwert'))),
    h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', { text: 'Nutzung' })),
      h('div', { class: 'stat-grid four', role: 'group', 'aria-label': 'Nutzung' },
        stat(k.updates, 'Änderungen', 'aller Geräte'),
        stat(k.traffic, 'Datenverkehr', k.trafficSub),
        stat(`${k.blobUp} / ${k.blobDown}`, 'Anhänge ↑ / ↓', `${k.blobUpSub} / ${k.blobDownSub}`),
        stat(k.online, k.onlineLabel, k.onlineSub || 'jetzt'))),
  ));
  out.append(h('p', { class: 'server-line dim small' }, `Server: ${k.ram} Arbeitsspeicher · läuft seit ${k.uptime} · höchstens ${plural(Number(s.total && s.total.conns) || 0, 'Verbindung', 'Verbindungen')} gleichzeitig`));

  if (!series.length) {
    out.append(h('section', { class: 'card' }, emptyEl('Noch keine Daten – Messwerte entstehen minütlich.')));
  } else {
    const anyUpd = series.map((p) => Number(p.updates) > 0);
    out.append(h('div', { class: 'grid-2' },
      chartCard('Ping-Laufzeit', chart({ ...common, kind: 'line', format: fmtMs, name: 'Ping-Laufzeit',
        series: [{ name: 'Mittel der Geräte', slot: 1, values: series.map((p) => (Number(p.rttMs) > 0 ? Number(p.rttMs) : null)) }] }), 'Lücken: keine Messung (kein Gerät verbunden)'),
      chartCard('Server-Verarbeitung je Änderung', chart({ ...common, kind: 'line', format: fmtMs, name: 'Verarbeitung',
        series: [{ name: 'typisch (p50)', slot: 1, values: series.map((p, i) => (anyUpd[i] ? Number(p.procP50Us) / 1000 : null)) },
          { name: 'Spitze (p95)', slot: 2, values: series.map((p, i) => (anyUpd[i] ? Number(p.procP95Us) / 1000 : null)) }] }), 'Lücken: keine Änderungen'),
    ));
    out.append(updatesCard(series, ts, dur, common, rate, sums, unitName, users, spaces));
    out.append(chartCard(`Datenverkehr je ${unitName}`, chart({ ...common, kind: 'line', format: fmtBytes, name: 'Datenverkehr', perUnit: unitName,
      series: [{ name: 'rein (Geräte → Server)', slot: 1, values: rate(sums('bytesIn')), sums: sums('bytesIn') }, { name: 'raus (Server → Geräte)', slot: 2, values: rate(sums('bytesOut')), sums: sums('bytesOut') }] }), 'Mittel je ' + unitName));
    out.append(h('div', { class: 'grid-2' },
      chartCard('Verbindungen', chart({ ...common, kind: 'step', format: fmtNum, integer: true, name: 'Verbindungen',
        series: [{ name: 'Spitze', slot: 1, values: sums('conns') }] }), 'Höchstwert je Abschnitt'),
      chartCard('Arbeitsspeicher', chart({ ...common, kind: 'line', format: fmtBytes, name: 'Arbeitsspeicher',
        series: [{ name: 'Spitze', slot: 1, values: sums('rssKib', 1024) }] }), 'Höchstwert je Abschnitt'),
    ));
    if (rangeSecs >= 7 * DAY) out.append(heatmapCard(series, dur));
  }

  // --- Nutzung nach Person / Vault
  const userName = (id) => {
    if (id === 'admin-web') return { name: 'Admin-Oberfläche', color: null, admin: true };
    const u = (Array.isArray(users) ? users : []).find((x) => x && x.id === id);
    return { name: u ? (u.name || u.id) : id, color: u ? u.color : null, known: !!u };
  };
  const usageRows = (list, label) => {
    list = Array.isArray(list) ? list : [];
    const max = list.reduce((m, r) => Math.max(m, Number(r.updates) || 0), 0);
    return list.map((r) => {
      const n = Number(r.updates) || 0;
      const bar = h('span', { class: 'bar s1' });
      bar.style.width = (max > 0 ? Math.max(2, (n / max) * 100) : 0) + '%';
      return h('tr', {}, h('td', {}, label(r)), h('td', { class: 'num', text: fmtNum(n) }), h('td', { class: 'usage hide-sm' }, h('span', { class: 'track', 'aria-hidden': 'true' }, bar)));
    });
  };
  out.append(h('div', { class: 'grid-2' },
    card('Nutzung nach Person', null, table(['Person', { text: 'Änderungen', class: 'num' }, { text: '', class: 'usage hide-sm', sr: 'Anteil' }], usageRows(s.users, (r) => {
      const u = userName(String(r.id));
      return u.admin ? h('span', { class: 'dim', text: u.name }) : (u.known ? h('a', { class: 'plain-link', href: `#/users/${enc(r.id)}` }, colorDot(u.color), nameWithId(u.name, r.id)) : nameWithId(u.name, r.id));
    }), { empty: 'Keine Änderungen im Zeitraum', caption: 'Nutzung nach Person' })),
    card('Nutzung nach Vault', null, table(['Vault', { text: 'Änderungen', class: 'num' }, { text: '', class: 'usage hide-sm', sr: 'Anteil' }], usageRows(s.spaces, (r) =>
      h('a', { class: 'row-link', href: `#/vault/${enc(r.id)}` }, nameWithId(spaceName(String(r.id), spaces), String(r.id)))), { empty: 'Keine Änderungen im Zeitraum', caption: 'Nutzung nach Vault' })),
  ));

  // --- Geräte jetzt
  out.append(card(`Geräte jetzt (${fmtNum(devices.length)})`, null, table(['Person · Gerät', { text: 'Ping', class: 'num' }, { text: 'rein', class: 'num hide-sm' }, { text: 'raus', class: 'num hide-sm' }, { text: 'Änderungen', class: 'num' }, { text: 'Verbunden', class: 'hide-sm' }, 'Geöffnet'],
    devices.map((d) => {
      const files = (Array.isArray(d.files) ? d.files : []).filter((f) => f && f.doc);
      return h('tr', {},
        h('td', {}, colorDot(d.color), h('span', { title: esc(d.user), text: esc(d.name || d.user) }), h('div', { class: 'dim small', text: esc(d.device) || 'Gerät ohne Namen' })),
        h('td', { class: 'num', text: d.rttMs != null ? fmtMs(d.rttMs) : '–' }),
        h('td', { class: 'num hide-sm', text: fmtBytes(d.bytesIn) }),
        h('td', { class: 'num hide-sm', text: fmtBytes(d.bytesOut) }),
        h('td', { class: 'num', text: fmtNum(d.updates) }),
        h('td', { class: 'hide-sm' }, timeEl(d.since)),
        h('td', {}, files.length ? files.map((f, i) => frag(i ? ', ' : null, h('a', { href: `#/vault/${enc(f.space)}/${enc(f.doc)}`, title: f.path || f.doc, text: f.path ? displayName(f.path) : f.doc }))) : h('span', { class: 'dim', text: '–' })));
    }), { empty: 'Gerade ist kein Gerät verbunden', caption: 'Verbundene Geräte' })));

  // --- Zuletzt geändert
  const recent = Array.isArray(s.recent) ? s.recent : [];
  const recentBody = h('tbody');
  const recentRow = (r) => h('tr', {},
    h('td', {}, h('a', { href: `#/vault/${enc(r.space)}/${enc(r.doc)}`, title: esc(r.path), text: displayName(esc(r.path) || esc(r.doc)) }), dirname(esc(r.path)) ? h('div', { class: 'dim small', text: dirname(r.path) }) : null),
    h('td', {}, h('a', { href: `#/vault/${enc(r.space)}`, text: esc(spaceName(String(r.space), spaces)) })),
    h('td', {}, timeEl(r.updated)));
  const showN = (n) => { replace(recentBody, recent.slice(0, n).map(recentRow)); };
  showN(10);
  const moreRecent = recent.length > 10 ? h('button', { class: 'btn sm', type: 'button', text: `Alle ${fmtNum(recent.length)} anzeigen`, onclick: (e) => { showN(recent.length); e.currentTarget.remove(); } }) : null;
  out.append(card('Zuletzt geändert', moreRecent, recent.length
    ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('caption', { class: 'sr', text: 'Zuletzt geänderte Dateien' }), h('thead', {}, h('tr', {}, h('th', { text: 'Datei' }), h('th', { text: 'Vault' }), h('th', { text: 'Wann' }))), recentBody))
    : emptyEl('Noch nichts geändert')));

  return out;
}

// Änderungen: Gesamt oder gestapelt nach Person/Vault (nur Stundenpunkte tragen die Aufteilung)
function updatesCard(series, ts, dur, common, rate, sums, unitName, users, spaces) {
  const withMaps = series.filter((p) => p.users && typeof p.users === 'object').length;
  const canSplit = withMaps >= Math.max(1, series.length * 0.5);
  const body = h('div');
  let mode = canSplit ? (readPref('stats.split') || 'all') : 'all';
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Aufteilung' });
  const nameOf = (kind, id) => (kind === 'users' ? (id === 'admin-web' ? 'Admin-Oberfläche' : ((users || []).find((u) => u.id === id) || {}).name || id) : spaceName(id, spaces));
  const paint = () => {
    for (const b of seg.children) b.setAttribute('aria-pressed', String(b.dataset.m === mode));
    clear(body);
    if (mode === 'all') {
      body.append(chart({ ...common, kind: 'bar', format: fmtNum, axisFormat: fmtCompact, name: 'Änderungen', perUnit: unitName,
        series: [{ name: 'Änderungen', slot: 1, values: rate(sums('updates')), sums: sums('updates') }] }));
      return;
    }
    // höchstens drei benannte Reihen, Rest „Andere“; Farben nach stabiler Sortierung der IDs
    const totals = new Map();
    for (const p of series) for (const [id, v] of Object.entries(p[mode] || {})) totals.set(id, (totals.get(id) || 0) + (Number(v) || 0));
    const top = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map((x) => x[0]).sort();
    const named = top.map((id, i) => {
      const raw = series.map((p) => Number((p[mode] || {})[id]) || 0);
      return { name: nameOf(mode, id), slot: i + 1, values: rate(raw), sums: raw };
    });
    const restRaw = series.map((p) => Math.max(0, (Number(p.updates) || 0) - top.reduce((a, id) => a + (Number((p[mode] || {})[id]) || 0), 0)));
    const list = restRaw.some((v) => v > 0) ? [...named, { name: 'Andere', slot: 0, values: rate(restRaw), sums: restRaw }] : named;
    body.append(chart({ ...common, kind: 'stack', format: fmtNum, axisFormat: fmtCompact, name: 'Änderungen', perUnit: unitName, series: list }));
  };
  for (const [m, l] of [['all', 'Gesamt'], ['users', 'nach Person'], ['spaces', 'nach Vault']]) {
    seg.append(h('button', { class: 'btn sm', type: 'button', dataset: { m }, text: l, disabled: m !== 'all' && !canSplit, title: m !== 'all' && !canSplit ? 'Aufteilung gibt es nur für Stundenwerte (ab 24 h)' : null,
      onclick: () => { mode = m; writePref('stats.split', m); paint(); } }));
  }
  paint();
  return h('section', { class: 'card chart-card' },
    h('div', { class: 'card-head' }, h('h2', { text: `Änderungen je ${unitName}` }), seg),
    h('div', { class: 'card-body' }, body, h('p', { class: 'dim small cap', text: `Mittel je ${unitName}; der Tooltip zeigt zusätzlich die Summe des Abschnitts.` })));
}

// Wann wird synchronisiert: Wochentag × Stunde (Ortszeit)
function heatmapCard(series, dur) {
  const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (let i = 0; i < series.length; i++) {
    const v = Number(series[i].updates) || 0;
    if (!v) continue;
    const ts = Number(series[i].ts), d = dur[i];
    const parts = Math.max(1, Math.round(d / 3600));
    for (let k = 0; k < parts; k++) {
      const t = new Date((ts + k * 3600) * 1000);
      grid[(t.getDay() + 6) % 7][t.getHours()] += v / parts;
    }
  }
  const max = Math.max(1, ...grid.flat());
  const days = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
  const daysLong = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];
  const box = h('div', { class: 'heat', role: 'img', 'aria-label': 'Änderungen nach Wochentag und Uhrzeit; Werte in der Tabelle darunter' });
  box.append(h('span'), ...Array.from({ length: 24 }, (_, hh) => h('span', { class: 'hh', text: hh % 3 === 0 ? String(hh) : '' })));
  grid.forEach((row, d) => {
    box.append(h('span', { class: 'dd', text: days[d] }));
    for (let hh = 0; hh < 24; hh++) {
      const c = h('span', { class: 'cell', title: `${daysLong[d]} ${hh}–${hh + 1} Uhr: ${fmtNum(Math.round(row[hh]))} Änderungen` });
      c.style.setProperty('--a', String(row[hh] > 0 ? 0.12 + 0.88 * (row[hh] / max) : 0));
      box.append(c);
    }
  });
  const det = h('details', { class: 'chart-table' }, h('summary', { text: 'Als Tabelle' }));
  det.addEventListener('toggle', () => {
    if (!det.open || det.children.length > 1) return;
    det.append(h('div', { class: 'scroll' }, table(['Wochentag', ...Array.from({ length: 24 }, (_, i) => ({ text: String(i), class: 'num' }))],
      grid.map((row, d) => h('tr', {}, h('th', { scope: 'row', text: days[d] }), row.map((v) => h('td', { class: 'num', text: v ? fmtNum(Math.round(v)) : '' })))), { caption: 'Änderungen nach Wochentag und Stunde' })));
  });
  return h('section', { class: 'card chart-card' }, h('div', { class: 'card-head' }, h('h2', { text: 'Wann wird synchronisiert' })), h('div', { class: 'card-body' }, box, det));
}

function chartCard(title, chartEl, note) {
  return h('section', { class: 'card chart-card' },
    h('div', { class: 'card-head' }, h('h2', { text: title })),
    h('div', { class: 'card-body' }, chartEl, note ? h('p', { class: 'dim small cap', text: note }) : null));
}

// chart({ ts, dur, from, to, kind:'line'|'bar'|'step'|'stack', series:[{name, slot, values, sums?}], format, axisFormat, height, mini, label, name, perUnit, integer })
// Jeder Punkt deckt [ts, ts+dur) ab. Gezeichnet wird nur in der Plotfläche (clipPath). Neu gezeichnet beim Einhängen
// und bei Breitenänderung (ResizeObserver, kein Netz). Tooltip per Zeiger und Tastatur.
let chartSeq = 0;
function chart(o) {
  const ts = o.ts, n = ts.length;
  const dur = o.dur || ts.map(() => 60);
  const series = o.series.filter((s) => Array.isArray(s.values));
  const fmt = o.format || fmtNum;
  const axisFmt = o.axisFormat || fmt;
  const mini = !!o.mini;
  const stack = o.kind === 'stack';
  const H = o.height || 180;
  const id = 'c' + (++chartSeq);
  const minDur = n ? Math.min(...dur) : 60;
  // Zeitfenster: ab Zeitraumbeginn bzw. erstem Punkt (wenn die Daten später einsetzen), bis zum Ende des letzten Abschnitts
  const firstStart = n ? ts[0] : o.from;
  const x0 = Math.max(o.from, firstStart);
  const x1 = Math.max(o.to, n ? ts[n - 1] + dur[n - 1] : x0 + 60, x0 + 60);
  const visible = (i) => ts[i] + dur[i] > x0;
  let max = 0;
  for (let i = 0; i < n; i++) {
    if (!visible(i)) continue;
    if (stack) { let sum = 0; for (const s of series) sum += Number(s.values[i]) || 0; max = Math.max(max, sum); }
    else for (const s of series) { const v = s.values[i]; if (v != null && v > max) max = v; }
  }
  const allZero = max <= 0;
  const yTicks = o.integer && max <= 4 ? Array.from({ length: Math.max(2, Math.ceil(max) + 1) }, (_, i) => i) : niceTicks(max, fmt === fmtBytes);
  const yMax = yTicks[yTicks.length - 1] || 1;
  const pad = mini ? { l: 0, r: 0, t: 2, b: 1 } : { l: 52, r: 12, t: 10, b: 24 };

  // Zusammenfassung für Screenreader
  let peakI = -1, lastI = -1;
  const main0 = series[0];
  for (let i = 0; i < n; i++) {
    if (!visible(i) || !main0) continue;
    const v = stack ? series.reduce((a, s) => a + (Number(s.values[i]) || 0), 0) : main0.values[i];
    if (v == null) continue;
    lastI = i;
    if (peakI < 0 || v > (stack ? series.reduce((a, s) => a + (Number(s.values[peakI]) || 0), 0) : main0.values[peakI])) peakI = i;
  }
  const valAt = (i) => (stack ? series.reduce((a, s) => a + (Number(s.values[i]) || 0), 0) : main0.values[i]);
  const summary = o.label || (n && main0 ? `${o.name || main0.name}${o.perUnit ? ' je ' + o.perUnit : ''}, ${fmtAbs(x0)} bis ${fmtAbs(Math.min(x1, o.to))}` +
    (peakI >= 0 ? `; höchster Wert ${fmt(valAt(peakI))} (${intervalLabel(ts[peakI], dur[peakI])}); zuletzt ${fmt(valAt(lastI))}` : '; keine Werte') : 'Keine Daten');
  const hintId = id + '-hint';
  const fig = h('figure', { class: 'chart' + (mini ? ' mini' : ''), tabindex: mini ? null : '0', role: mini ? null : 'group', 'aria-label': mini ? null : summary, 'aria-describedby': mini ? null : hintId });
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('aria-hidden', 'true');
  const tip = h('div', { class: 'tip', hidden: true });
  const hint = mini ? null : h('span', { class: 'kbd-hint', id: hintId, text: 'Pfeiltasten, Pos1/Ende: Werte durchgehen' });
  append(fig, [series.length > 1 && !mini ? legend(series) : null, svg, tip, hint, mini ? null : tableView(o, series, fmt)]);

  let W = 0, cur = -1, kbd = false;
  const SVG = (tag, attrs) => { const e = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [k, v] of Object.entries(attrs || {})) if (v != null) e.setAttribute(k, String(v)); return e; };
  const sx = (t) => pad.l + ((t - x0) / (x1 - x0)) * (W - pad.l - pad.r);
  const sy = (v) => pad.t + (1 - v / yMax) * (H - pad.t - pad.b);
  let hover = null;

  function draw() {
    W = Math.max(120, Math.floor(fig.clientWidth || 0));
    if (!W) return;
    clear(svg);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('width', W);
    svg.setAttribute('height', H);
    const plotW = W - pad.l - pad.r, plotH = H - pad.t - pad.b;
    const defs = SVG('defs');
    const cp = SVG('clipPath', { id: id + '-clip' });
    cp.append(SVG('rect', { x: pad.l, y: pad.t - 4, width: plotW, height: plotH + 4 }));
    defs.append(cp);
    svg.append(defs);
    const clip = `url(#${id}-clip)`;
    if (!mini) {
      const g = SVG('g', { class: 'grid' });
      for (const v of yTicks) {
        const y = sy(v);
        g.append(SVG('line', { x1: pad.l, x2: W - pad.r, y1: y, y2: y, class: v === 0 ? 'base' : null }));
        const t = SVG('text', { x: pad.l - 6, y: y + 3.5, class: 'ylab' }); t.textContent = axisFmt(v); g.append(t);
      }
      const ticks = timeTicks(x0, x1);
      let lastRight = -Infinity;
      for (const t of ticks) {
        const x = sx(t.t);
        if (x < pad.l - 1 || x > W - pad.r + 1) continue;
        const approxW = t.label.length * 6.2;
        if (x - approxW / 2 < lastRight + 6) continue;
        lastRight = x + approxW / 2;
        const tx = SVG('text', { x: Math.min(W - approxW / 2 - 2, Math.max(pad.l + approxW / 2, x)), y: H - 6, class: 'xlab' + (t.major ? ' major' : '') }); tx.textContent = t.label; g.append(tx);
        g.append(SVG('line', { x1: x, x2: x, y1: H - pad.b, y2: H - pad.b + 3 }));
      }
      svg.append(g);
    } else {
      svg.append(SVG('line', { class: 'mini-base', x1: 0, x2: W, y1: H - 0.5, y2: H - 0.5 }));
    }
    const gap = (i) => i > 0 && ts[i] > ts[i - 1] + dur[i - 1] + 0.5 * minDur;
    if (o.kind === 'bar' || stack) {
      const base = new Array(n).fill(0);
      const order = stack ? series.slice().sort((a, b) => (a.slot || 9) - (b.slot || 9)) : series;
      for (const s of order) {
        const g = SVG('g', { class: 'bars s' + s.slot, 'clip-path': clip });
        for (let i = 0; i < n; i++) {
          const v = Number(s.values[i]) || 0;
          if (!visible(i) || v <= 0) continue;
          const xa0 = sx(Math.max(ts[i], x0)), xb0 = sx(ts[i] + dur[i]);
          const wFull = xb0 - xa0;
          const gp = wFull > 6 ? 1.5 : wFull > 3 ? 0.5 : 0;
          const xa = xa0 + gp / 2, bw = Math.max(0.8, wFull - gp);
          const y0 = sy(base[i]), y = sy(base[i] + v);
          const hgt = Math.max(stack ? 0.5 : 1, y0 - y);
          const r = stack ? 0 : Math.min(3, bw / 2, hgt);
          g.append(SVG('path', { d: r ? `M${xa},${y0}V${y0 - hgt + r}Q${xa},${y0 - hgt} ${xa + r},${y0 - hgt}H${xa + bw - r}Q${xa + bw},${y0 - hgt} ${xa + bw},${y0 - hgt + r}V${y0}Z` : `M${xa},${y0}V${y0 - hgt}H${xa + bw}V${y0}Z` }));
          if (stack) base[i] += v;
        }
        svg.append(g);
      }
    } else {
      for (const s of series) {
        let d = '', area = '', open = false, segLen = 0, segX = 0, segY = 0;
        const dots = [];
        let lastX = null, lastY = null;
        const closeSeg = () => { if (open) { area += `V${sy(0)}Z`; if (segLen === 1) dots.push([segX, segY]); } open = false; segLen = 0; };
        for (let i = 0; i < n; i++) {
          const v = s.values[i];
          if (!visible(i)) continue;
          if (v == null || gap(i)) { closeSeg(); if (v == null) continue; }
          const y = sy(v);
          if (o.kind === 'step') {
            const xa = sx(Math.max(ts[i], x0)), xb = sx(ts[i] + dur[i]);
            if (!open) { d += `M${xa},${y}`; area += `M${xa},${sy(0)}L${xa},${y}`; open = true; } else { d += `V${y}`; area += `V${y}`; }
            d += `H${xb}`; area += `H${xb}`;
            segLen += 2; lastX = xb; lastY = y;
          } else {
            const x = sx(Math.max(ts[i] + dur[i] / 2, x0));
            if (!open) { d += `M${x},${y}`; area += `M${x},${sy(0)}L${x},${y}`; open = true; } else { d += `L${x},${y}`; area += `L${x},${y}`; }
            segLen++; segX = x; segY = y; lastX = x; lastY = y;
          }
        }
        closeSeg();
        const g = SVG('g', { class: 'lines s' + s.slot, 'clip-path': clip });
        if (series.length === 1 && area) g.append(SVG('path', { class: 'area', d: area }));
        if (d) g.append(SVG('path', { class: 'line', d }));
        for (const [x, y] of dots) g.append(SVG('circle', { class: 'dotpt', cx: x, cy: y, r: 2.5 }));
        if (lastX != null && !mini) g.append(SVG('circle', { class: 'end', cx: lastX, cy: lastY, r: 3.5 }));
        svg.append(g);
      }
    }
    if (allZero && !mini) {
      const t = SVG('text', { x: pad.l + plotW / 2, y: pad.t + plotH / 2, class: 'nodata' });
      t.textContent = 'Keine Werte im Zeitraum';
      svg.append(t);
    }
    hover = SVG('g', { class: 'hover', visibility: 'hidden' });
    svg.append(hover);
    if (cur >= 0) showAt(cur);
  }

  // Punkt, dessen Intervall die Zeigerzeit enthält, sonst der nächste
  function indexAt(px) {
    if (!n) return -1;
    const t = x0 + ((px - pad.l) / Math.max(1, W - pad.l - pad.r)) * (x1 - x0);
    let best = -1, bd = Infinity;
    for (let i = 0; i < n; i++) {
      if (!visible(i)) continue;
      if (t >= ts[i] && t < ts[i] + dur[i]) return i;
      const d = Math.abs(ts[i] + dur[i] / 2 - t);
      if (d < bd) { bd = d; best = i; }
    }
    return best >= 0 && bd <= dur[best] * 1.5 ? best : -1;
  }

  function showAt(i) {
    cur = i;
    if (i < 0 || !hover) { hide(); return; }
    clear(hover);
    const x = sx(Math.max(ts[i] + dur[i] / 2, x0));
    hover.append(SVG('line', { x1: x, x2: x, y1: pad.t, y2: H - pad.b }));
    let acc = 0;
    for (const s of (stack ? series.slice().sort((a, b) => (a.slot || 9) - (b.slot || 9)) : series)) {
      const v = s.values[i];
      if (v == null) continue;
      const yv = stack ? (acc += Number(v) || 0) : v;
      hover.append(SVG('circle', { class: 's' + s.slot, cx: x, cy: sy(yv), r: 4 }));
    }
    hover.setAttribute('visibility', 'visible');
    clear(tip);
    tip.setAttribute('role', kbd ? 'status' : 'presentation');
    tip.append(h('div', { class: 'tip-t', text: intervalLabel(ts[i], dur[i]) }));
    for (const s of series) {
      const v = s.values[i];
      const val = v == null ? 'keine Messung' : (s.sums ? fmt(s.sums[i]) : fmt(v));
      tip.append(h('div', { class: 'tip-r' }, h('span', { class: 'key s' + s.slot, 'aria-hidden': 'true' }), h('strong', { text: val }), h('span', { class: 'dim', text: s.name }),
        s.sums && v != null && o.unitShort ? h('span', { class: 'dim', text: ` · Ø ${fmt(v)}/${o.unitShort}` }) : null));
    }
    if (stack) tip.append(h('div', { class: 'tip-r sum' }, h('span', { class: 'key', 'aria-hidden': 'true' }), h('strong', { text: fmt(series.reduce((a, s) => a + (Number(s.sums ? s.sums[i] : s.values[i]) || 0), 0)) }), h('span', { class: 'dim', text: 'zusammen' })));
    tip.hidden = false;
    const tw = tip.offsetWidth;
    const left = x + 12 + tw > W ? x - 12 - tw : x + 12;
    tip.style.left = Math.max(0, left) + 'px';
    tip.style.top = pad.t + 'px';
  }
  function hide() { if (hover) hover.setAttribute('visibility', 'hidden'); tip.hidden = true; }

  if (!mini) {
    svg.addEventListener('pointermove', (e) => { kbd = false; const r = svg.getBoundingClientRect(); const i = indexAt(e.clientX - r.left); if (i !== cur) showAt(i); });
    svg.addEventListener('pointerleave', () => { cur = -1; hide(); });
    fig.addEventListener('keydown', (e) => {
      if (!n) return;
      const vis = []; for (let i = 0; i < n; i++) if (visible(i)) vis.push(i);
      if (!vis.length) return;
      const p = vis.indexOf(cur);
      let i = cur;
      if (e.key === 'ArrowRight') i = vis[p < 0 ? vis.length - 1 : Math.min(vis.length - 1, p + 1)];
      else if (e.key === 'ArrowLeft') i = vis[p < 0 ? vis.length - 1 : Math.max(0, p - 1)];
      else if (e.key === 'Home') i = vis[0];
      else if (e.key === 'End') i = vis[vis.length - 1];
      else if (e.key === 'Escape') { cur = -1; hide(); return; }
      else return;
      e.preventDefault();
      kbd = true;
      showAt(i);
    });
    fig.addEventListener('blur', () => { cur = -1; hide(); });
  }

  if (typeof ResizeObserver === 'function') {
    let lastW = -1;
    const ro = new ResizeObserver(() => {
      if (!fig.isConnected) { ro.disconnect(); return; }
      const w = Math.floor(fig.clientWidth);
      if (w && w !== lastW) { lastW = w; draw(); }
    });
    ro.observe(fig);
  } else {
    requestAnimationFrame(draw);
  }
  return fig;
}

function legend(series) {
  return h('ul', { class: 'legend', 'aria-label': 'Reihen' }, series.map((s) => h('li', {}, h('span', { class: 'key s' + s.slot, 'aria-hidden': 'true' }), s.name)));
}

// Datentabelle zum Diagramm, erst beim Aufklappen gebaut
function tableView(o, series, fmt) {
  const det = h('details', { class: 'chart-table' }, h('summary', { text: 'Als Tabelle' }));
  det.addEventListener('toggle', () => {
    if (!det.open || det.children.length > 1) return;
    const dur = o.dur || o.ts.map(() => 60);
    const rows = o.ts.map((t, i) => h('tr', {}, h('td', { text: intervalLabel(t, dur[i]) }), series.map((s) => {
      const v = s.sums ? s.sums[i] : s.values[i];
      return h('td', { class: 'num', text: v == null ? '–' : fmt(v) });
    })));
    det.append(h('div', { class: 'scroll' }, table(['Zeitraum', ...series.map((s) => ({ text: s.name + (s.sums ? ' (Summe)' : ''), class: 'num' }))], rows.reverse(), { empty: 'Keine Messpunkte', caption: o.name || 'Messwerte' })));
  });
  return det;
}

// Schöne Y-Ticks: 0 … Max in 3–4 Schritten; `binary` für Bytes (1, 2, 4 … KiB statt 1.000 B)
function niceTicks(max, binary) {
  if (!(max > 0)) return [0, 1];
  const raw = max / 3;
  let stepV;
  if (binary && max >= 1024) {
    const unit = Math.pow(1024, Math.floor(Math.log(raw) / Math.log(1024)));
    const m = raw / unit;
    stepV = ([1, 2, 4, 8, 16, 32, 64, 128, 256, 512].find((k) => k >= m) || 1024) * unit;
  } else {
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const m = raw / p;
    stepV = (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
  }
  const out = [];
  for (let v = 0; v < max + stepV; v += stepV) out.push(Math.round(v * 1e6) / 1e6);
  if (out[out.length - 1] < max) out.push(out[out.length - 1] + stepV);
  return out;
}

// Zeitachse in Ortszeit mit Kalenderarithmetik (stimmt auch über die Zeitumstellung hinweg)
function timeTicks(x0, x1) {
  const span = x1 - x0;
  const want = 6;
  const steps = [60, 120, 300, 600, 900, 1800, 3600, 2 * 3600, 3 * 3600, 6 * 3600, 12 * 3600, 86400, 2 * 86400, 7 * 86400, 14 * 86400, 30 * 86400];
  const stepS = steps.find((s) => span / s <= want + 1) || steps[steps.length - 1];
  const out = [];
  if (stepS < 3600) {
    for (let t = Math.ceil(x0 / stepS) * stepS; t <= x1 && out.length < 14; t += stepS) {
      const d = new Date(t * 1000);
      out.push({ t, label: tfHM.format(d), major: d.getHours() === 0 && d.getMinutes() === 0 });
    }
    return out;
  }
  if (stepS < 86400) {
    const nh = stepS / 3600;
    const d = new Date(x0 * 1000);
    d.setMinutes(0, 0, 0);
    if (d.getTime() / 1000 < x0) d.setHours(d.getHours() + 1);
    while (d.getHours() % nh !== 0) d.setHours(d.getHours() + 1);
    for (let k = 0; d.getTime() / 1000 <= x1 && k < 40; k++) {
      const midnight = d.getHours() === 0;
      out.push({ t: d.getTime() / 1000, label: midnight ? tfWDM.format(d) : tfHM.format(d), major: midnight });
      d.setHours(d.getHours() + nh);
    }
    return out;
  }
  const nd = Math.round(stepS / 86400);
  const d = new Date(x0 * 1000);
  d.setHours(0, 0, 0, 0);
  if (d.getTime() / 1000 < x0) d.setDate(d.getDate() + 1);
  for (let k = 0; d.getTime() / 1000 <= x1 && k < 40; k++) {
    out.push({ t: d.getTime() / 1000, label: span <= 8 * 86400 ? tfWDM.format(d) : tfDM.format(d), major: d.getDate() === 1 });
    d.setDate(d.getDate() + nd);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sicherungen

// 1:1-Port von backup::to_keep (server/src/backup.rs) – liefert zusätzlich die Gründe je Sicherung.
// autos: nur automatische, neueste zuerst. Woche = floor((Tag + 3) / 7) (Wochen ab Montag), Monat = UTC-Jahr/Monat.
function retentionKeep(autos, cfg) {
  const keep = new Map();
  const add = (name, why) => { if (!keep.has(name)) keep.set(name, new Set()); keep.get(name).add(why); };
  for (const b of autos.slice(0, Math.max(0, cfg.keepDaily | 0))) add(b.name, 'Tag');
  const weeks = new Set(), months = new Set();
  for (const b of autos) {
    const day = Math.floor(Number(b.created) / 86400);
    const week = Math.floor((day + 3) / 7);
    const d = new Date(day * 86400000);
    const ym = d.getUTCFullYear() * 100 + d.getUTCMonth();
    if (weeks.size < (cfg.keepWeekly | 0) && !weeks.has(week)) { weeks.add(week); add(b.name, 'Woche'); }
    if (months.size < (cfg.keepMonthly | 0) && !months.has(ym)) { months.add(ym); add(b.name, 'Monat'); }
  }
  return keep;
}
// Was beim Speichern gelöscht würde (wie backup::prune: nur bei eingeschalteter Automatik)
function retentionDoomed(autos, cfg) {
  if (!cfg.auto) return [];
  const keep = retentionKeep(autos, cfg);
  return autos.filter((b) => !keep.has(b.name));
}

function nextAutoText(nextAuto) {
  if (nextAuto == null) return 'aus';
  const t = Number(nextAuto);
  if (t <= Date.now() / 1000 + 120) return 'innerhalb der nächsten Stunde';
  // stündliche Prüfung: kurz nach 0 Uhr UTC, spätestens eine Stunde danach
  return `${fmtWhen(t)}–${fmtTime(t + 3600)}`;
}

async function viewBackups() {
  const box = h('div');
  let data = null, draft = null, freshName = null, showAllAuto = false, showAllSafety = false;
  const createBtn = h('button', { class: 'btn primary', type: 'button', text: 'Jetzt sichern' });
  const load = loader(box, async () => {
    const r = await api('backups', { quiet: true });
    data = r || {};
    draft = { ...(data.settings || { auto: true, keepDaily: 7, keepWeekly: 4, keepMonthly: 6 }) };
    return render();
  }, { what: 'Die Liste der Sicherungen' });

  function render() {
    const list = Array.isArray(data.backups) ? data.backups : [];
    const autos = list.filter((b) => b.kind === 'auto');
    const manual = list.filter((b) => b.kind !== 'auto');
    const settings = data.settings || {};
    const health = backupHealth({ auto: settings.auto, count: list.length, last: list[0] || null, lastAuto: autos[0] || null });
    const total = list.reduce((a, b) => a + (Number(b.size) || 0), 0);
    const blobs = data.blobs || {};
    const out = frag();
    out.append(h('section', { class: 'card' }, h('div', { class: 'stat-grid four', role: 'group', 'aria-label': 'Zustand der Sicherungen' },
      stat(list[0] ? (list[0].kind === 'auto' ? fmtDateUTC(list[0].created) : fmtRel(list[0].created)) : 'keine', 'Letzte Sicherung', list[0] ? (list[0].kind === 'auto' ? 'automatisch' : 'von Hand') : null, { tone: health && health.tone !== 'ok' ? health.tone : null }),
      stat(nextAutoText(data.nextAuto), 'Nächste automatische', settings.auto ? 'täglich kurz nach 0 Uhr UTC' : 'automatische Sicherung ist aus'),
      stat(`${fmtNum(list.length)} · ${fmtBytes(total)}`, 'Sicherungen gesamt', `Datenbank heute ${fmtBytes(data.dbBytes)}`),
      stat(`${fmtNum(blobs.count || 0)} · ${fmtBytes(blobs.bytes || 0)}`, 'Anhänge', 'separat gespeichert, werden nie gelöscht'))));
    if (health && health.warn) out.append(h('p', { class: 'warn-note', role: 'status', text: health.warn }));

    const explain = h('details', { class: 'explain', open: readPref('backups.explain') === '1' },
      h('summary', { text: 'So funktionieren Sicherungen' }),
      h('div', {},
        h('p', { text: 'Eine Sicherung ist eine vollständige Kopie der Datenbank: alle Notizen, Handschrift-Flächen, der Verlauf, Personen und Einstellungen. Anhänge liegen getrennt nach Inhalt und werden nie gelöscht, deshalb passen sie zu jeder Sicherung.' }),
        h('p', { text: 'Automatische Sicherungen werden nach der Aufbewahrung ausgedünnt. Sicherungen von Hand bleiben, bis du sie löschst. Vor jedem Wiederherstellen sichert der Server den aktuellen Stand selbst („Sicherheitskopie“).' }),
        h('p', { text: 'Alle Sicherungen liegen auf demselben Server. Für eine Kopie anderswo: Vault exportieren (.tar, lässt sich entpacken und z. B. in ein Git-Repository einchecken) oder die Sicherung herunterladen (.db).' }),
        h('p', {}, 'Notfall – ganze Datenbank zurückspielen: Container stoppen, die .db nach ', h('code', { text: '/data/tandem.db' }), ' kopieren, Container starten.')));
    explain.addEventListener('toggle', () => writePref('backups.explain', explain.open ? '1' : '0'));
    out.append(explain);

    // --- Von Hand
    const safeties = manual.filter(isSafety);
    const hiddenSafety = !showAllSafety && safeties.length >= 3 ? new Set(safeties.slice(1).map((b) => b.name)) : new Set();
    const manualShown = manual.filter((b) => !hiddenSafety.has(b.name));
    const cleanBtn = safeties.length >= 2 ? h('button', { class: 'btn sm', type: 'button', text: 'Sicherheitskopien aufräumen …', onclick: () => cleanupSafety(safeties) }) : null;
    out.append(h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Von Hand ', h('span', { class: 'dim', text: fmtNum(manual.length) })), cleanBtn),
      manual.length ? h('ul', { class: 'bk-rows', 'aria-label': 'Sicherungen von Hand' },
        h('li', { class: 'bk-row head', 'aria-hidden': 'true' }, h('span', { text: 'Angelegt' }), h('span', { text: 'Bezeichnung' }), h('span', { class: 'num', text: 'Größe' }), h('span')),
        manualShown.map((b) => backupRow(b, {
          when: timeEl(b.created, { abs: true }),
          label: isSafety(b) ? frag(h('span', { text: 'vor Wiederherstellung' }), h('span', { class: 'badge', text: 'Sicherheitskopie' })) : (b.label ? h('span', { class: 'ell', title: b.label, text: b.label }) : h('span', { class: 'dim', text: 'ohne Bezeichnung' })),
          fresh: b.name === freshName,
        })),
        hiddenSafety.size ? h('li', { class: 'bk-more' }, h('button', { class: 'btn ghost sm', type: 'button', text: `${plural(hiddenSafety.size, 'ältere Sicherheitskopie', 'ältere Sicherheitskopien')} anzeigen`, onclick: () => { showAllSafety = true; replace(box, render()); } })) : null)
        : emptyEl('Noch keine Sicherung von Hand. „Jetzt sichern“ legt eine an.'),
    ));

    // --- Automatisch (mit Vorschau der Aufbewahrung)
    const keepSaved = retentionKeep(autos, settings);
    const changed = ['auto', 'keepDaily', 'keepWeekly', 'keepMonthly'].some((k) => draft[k] !== settings[k]);
    const allZero = !draft.keepDaily && !draft.keepWeekly && !draft.keepMonthly;
    const keepDraft = retentionKeep(autos, draft);
    const doomed = new Set(changed && draft.auto ? autos.filter((b) => !keepDraft.has(b.name)).map((b) => b.name) : []);
    const autosShown = showAllAuto || autos.length <= 20 ? autos : autos.slice(0, 20);
    const rows = [];
    let month = null;
    for (const b of autosShown) {
      const ym = new Date(Number(b.created) * 1000).toLocaleDateString('de-DE', { month: 'long', year: 'numeric', timeZone: 'UTC' });
      if (autos.length > 20 && ym !== month) { month = ym; rows.push(h('li', { class: 'bk-month', text: ym })); }
      const reasons = changed ? keepDraft.get(b.name) : keepSaved.get(b.name);
      rows.push(backupRow(b, {
        when: h('span', { class: doomed.has(b.name) ? 'strike' : null, title: fmtRel(b.created), text: fmtDateUTC(b.created) }),
        label: doomed.has(b.name) ? h('span', { class: 'badge danger', text: 'wird gelöscht' }) : h('span', { class: 'dim', text: reasons ? [...reasons].join(' · ') : (settings.auto ? '–' : 'bleibt (Automatik aus)') }),
        doomed: doomed.has(b.name),
      }));
    }
    out.append(h('section', { class: 'card', id: 'bk-auto' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Automatisch ', h('span', { class: 'dim', text: fmtNum(autos.length) })), autos.length > 10 ? h('button', { class: 'btn ghost sm', type: 'button', text: 'Aufbewahrung', onclick: () => document.getElementById('bk-settings').scrollIntoView({ block: 'center' }) }) : null),
      autos.length ? h('ul', { class: 'bk-rows', 'aria-label': 'Automatische Sicherungen' },
        h('li', { class: 'bk-row head', 'aria-hidden': 'true' }, h('span', { text: 'Datum (UTC)' }), h('span', { text: 'Behalten als' }), h('span', { class: 'num', text: 'Größe' }), h('span')),
        rows,
        autos.length > autosShown.length ? h('li', { class: 'bk-more' }, h('button', { class: 'btn sm', type: 'button', text: `Alle ${fmtNum(autos.length)} anzeigen`, onclick: () => { showAllAuto = true; replace(box, render()); } })) : null)
        : emptyEl(settings.auto ? 'Noch keine automatische Sicherung. Die erste entsteht innerhalb der nächsten Stunde.' : 'Keine automatischen Sicherungen.'),
      settingsForm(autos, settings, changed, allZero, doomed)));
    return out;
  }

  function settingsForm(autos, settings, changed, allZero, doomed) {
    const auto = h('input', { type: 'checkbox', id: 'bk-auto-cb', checked: !!draft.auto });
    const num = (key, id, label, max) => {
      const el = h('input', { class: 'input num-in', type: 'number', id, min: '0', max: String(max), step: '1', inputmode: 'numeric', value: String(draft[key] ?? 0) });
      el.addEventListener('input', () => { const v = Math.max(0, Math.min(max, Math.floor(Number(el.value) || 0))); draft[key] = v; repaint(id); });
      return h('span', { class: 'kf' }, h('label', { for: id, class: 'sr', text: label }), el);
    };
    auto.addEventListener('change', () => { draft.auto = auto.checked; repaint('bk-auto-cb'); });
    const localStart = fmtTime(Date.UTC(2026, 0, 1, 0, 0) / 1000);
    let preview;
    if (draft.auto && allZero) preview = h('p', { class: 'form-error', text: 'Mindestens eine automatische Sicherung aufbewahren.' });
    else if (!draft.auto) preview = h('p', { class: 'preview', text: autos.length ? `Automatik aus: Die ${plural(autos.length, 'vorhandene automatische Sicherung bleibt', 'vorhandenen automatischen Sicherungen bleiben')} liegen.` : 'Automatik aus.' });
    else if (doomed.size) {
      const names = autos.filter((b) => doomed.has(b.name)).map((b) => dfUTCShort.format(new Date(Number(b.created) * 1000)));
      preview = h('p', { class: 'preview danger-text', text: `Bleiben ${fmtNum(autos.length - doomed.size)} von ${fmtNum(autos.length)}. Beim Speichern ${doomed.size === 1 ? 'wird 1 gelöscht' : `werden ${fmtNum(doomed.size)} gelöscht`}: ${names.slice(0, 6).join(', ')}${names.length > 6 ? ' …' : ''}` });
    } else preview = h('p', { class: 'preview', text: autos.length ? `Bleiben ${fmtNum(autos.length)} von ${fmtNum(autos.length)}. Nichts wird gelöscht.` : 'Nichts wird gelöscht.' });
    // Vorausschau: was nach der nächsten automatischen Sicherung entfällt
    let ahead = null;
    if (draft.auto && !allZero && data.nextAuto != null) {
      const day = Math.floor(Number(data.nextAuto) / 86400);
      if (!autos.some((b) => Math.floor(Number(b.created) / 86400) === day)) {
        const future = [{ name: '__next', created: day * 86400 }, ...autos];
        const k = retentionKeep(future, draft);
        const gone = autos.filter((b) => !doomed.has(b.name) && !k.has(b.name));
        if (gone.length) ahead = h('p', { class: 'dim small', text: `Nach der nächsten automatischen Sicherung entfällt: ${gone.map((b) => fmtDateUTC(b.created)).join(', ')}` });
      }
    }
    const saveBtn = h('button', { class: 'btn primary sm', type: 'button', text: 'Speichern', disabled: !changed || (draft.auto && allZero) });
    saveBtn.addEventListener('click', () => saveSettings(saveBtn, autos, doomed));
    const resetBtn = changed ? h('button', { class: 'btn ghost sm', type: 'button', text: 'Verwerfen', onclick: () => { draft = { ...settings }; repaint('bk-auto-cb'); } }) : null;
    return h('div', { class: 'card-body bk-settings', id: 'bk-settings' },
      h('div', { class: 'field row' }, auto, h('label', { for: 'bk-auto-cb', text: 'Täglich automatisch sichern' }), h('span', { class: 'dim small', text: `(kurz nach 0 Uhr UTC, hier ${localStart})` })),
      h('fieldset', { class: 'keep', disabled: !draft.auto },
        h('legend', { text: 'Behalten' }),
        h('span', { class: 'kl' }, 'die neuesten', num('keepDaily', 'bk-d', 'Tage behalten', 365), 'Tage'), h('span', { class: 'sep', 'aria-hidden': 'true', text: '·' }),
        h('span', { class: 'kl' }, 'je Woche die neueste für', num('keepWeekly', 'bk-w', 'Wochen behalten', 260), 'Wochen'), h('span', { class: 'sep', 'aria-hidden': 'true', text: '·' }),
        h('span', { class: 'kl' }, 'je Monat die neueste für', num('keepMonthly', 'bk-m', 'Monate behalten', 120), 'Monate')),
      h('div', { 'aria-live': 'polite' }, preview, ahead),
      h('div', { class: 'toolbar' }, saveBtn, resetBtn));
  }

  // Nach jeder Eingabe neu zeichnen, Fokus im selben Feld halten
  function repaint(focusId) {
    const pos = document.activeElement && document.activeElement.id === focusId && document.activeElement.type === 'number' ? document.activeElement.value.length : null;
    replace(box, render());
    const el = document.getElementById(focusId);
    if (el) { el.focus({ preventScroll: true }); if (pos != null) { try { el.setSelectionRange(pos, pos); } catch { /* number-Felder */ } } }
  }

  async function saveSettings(btn, autos, doomed) {
    const settings = data.settings || {};
    if (doomed.size) {
      const dates = autos.filter((b) => doomed.has(b.name)).map((b) => fmtDateUTC(b.created));
      const all = doomed.size === autos.length;
      const ok = await confirmDialog('Aufbewahrung ändern', frag(
        h('p', { text: all ? `Mit dieser Einstellung werden alle ${fmtNum(autos.length)} automatischen Sicherungen sofort gelöscht:` : `Mit der neuen Aufbewahrung ${doomed.size === 1 ? 'wird sofort 1 automatische Sicherung' : `werden sofort ${fmtNum(doomed.size)} automatische Sicherungen`} gelöscht:` }),
        h('ul', { class: 'plain-list small' }, dates.slice(0, 10).map((d) => h('li', { text: d })), dates.length > 10 ? h('li', { class: 'dim', text: `und ${dates.length - 10} weitere` }) : null)),
      { okLabel: all ? 'Speichern und alle löschen' : `Speichern und ${fmtNum(doomed.size)} löschen`, danger: true });
      if (!ok) return;
    }
    await busy(btn, async () => {
      const r = await api('backups/settings', { method: 'PUT', body: { auto: !!draft.auto, keepDaily: draft.keepDaily | 0, keepWeekly: draft.keepWeekly | 0, keepMonthly: draft.keepMonthly | 0 } });
      const pruned = r && Array.isArray(r.pruned) ? r.pruned.length : 0;
      toast(settings.auto && !draft.auto && !pruned ? 'Automatische Sicherung ausgeschaltet' : pruned ? `Aufbewahrung gespeichert – ${plural(pruned, 'Sicherung', 'Sicherungen')} gelöscht` : 'Aufbewahrung gespeichert', 'ok');
      await load();
      const s = document.getElementById('bk-auto-cb');
      if (s) s.focus({ preventScroll: true });
    }, 'Speichere …');
  }

  function backupRow(b, { when, label, doomed, fresh }) {
    const more = menuButton(`Aktionen für ${backupTitle(b)}`, () => [
      { label: 'Herunterladen (.db) …', onClick: () => downloadBackup(b) },
      { label: 'Vault exportieren …', onClick: () => navigate(`#/backups/${enc(b.name)}`) },
      '-',
      { label: 'Löschen …', danger: true, onClick: () => deleteBackup(b, list(), async () => { await load(); refocus(box, null, main.querySelector('h1')); }) },
    ]);
    return h('li', { class: 'bk-row' + (doomed ? ' doomed' : '') + (fresh ? ' fresh' : ''), dataset: { key: 'bk:' + b.name } },
      h('span', { class: 'when' }, when),
      h('span', { class: 'lbl' }, label),
      h('span', { class: 'num dim', text: fmtBytes(b.size) }),
      h('span', { class: 'acts' }, h('a', { class: 'btn sm', href: `#/backups/${enc(b.name)}`, text: 'Ansehen', 'aria-label': `${backupTitle(b)} ansehen` }), more));
  }
  const list = () => (data && Array.isArray(data.backups) ? data.backups : []);

  async function cleanupSafety(safeties) {
    const daysIn = h('input', { class: 'input num-in', type: 'number', id: 'sc-days', min: '1', max: '3650', value: '30', 'aria-label': 'Tage' });
    const rAll = h('input', { type: 'radio', name: 'sc', id: 'sc-all', checked: true });
    const rOld = h('input', { type: 'radio', name: 'sc', id: 'sc-old' });
    const preview = h('p', { class: 'preview', 'aria-live': 'polite' });
    const progress = h('p', { class: 'dim small', 'aria-live': 'polite' });
    let okBtn = null;
    const pick = () => (rAll.checked ? safeties.slice(1) : safeties.filter((b) => Date.now() / 1000 - Number(b.created) > Math.max(1, Number(daysIn.value) || 0) * DAY));
    const update = () => {
      const p = pick();
      preview.textContent = p.length ? `${plural(p.length, 'Sicherheitskopie wird', 'Sicherheitskopien werden')} gelöscht (zusammen ${fmtBytes(p.reduce((a, b) => a + (Number(b.size) || 0), 0))}).` : 'Mit dieser Auswahl wird nichts gelöscht.';
      if (okBtn) { okBtn.disabled = !p.length; okBtn.textContent = p.length ? `${fmtNum(p.length)} löschen` : 'Löschen'; }
    };
    for (const el of [rAll, rOld]) el.addEventListener('change', update);
    daysIn.addEventListener('input', () => { rOld.checked = true; update(); });
    await openDialog({
      title: 'Sicherheitskopien aufräumen',
      body: frag(
        h('p', { text: 'Vor jedem Wiederherstellen legt der Server eine Sicherheitskopie an. Sie werden nie automatisch gelöscht.' }),
        h('div', { class: 'field row' }, rAll, h('label', { for: 'sc-all', text: `Alle bis auf die neueste löschen (${fmtNum(safeties.length - 1)})` })),
        h('div', { class: 'field row wrap' }, rOld, h('label', { for: 'sc-old', text: 'Alle älter als' }), daysIn, h('span', { text: 'Tage löschen' })),
        preview, progress),
      buttons: [
        { label: 'Abbrechen', value: false },
        { label: 'Löschen', kind: 'danger solid', ref: (b) => { okBtn = b; }, onClick: async (close) => {
          const p = pick();
          let done = 0, err = null;
          for (const b of p) {
            progress.textContent = `Lösche ${done + 1} von ${p.length} …`;
            try { await api(`backups/${enc(b.name)}`, { method: 'DELETE', quiet: true }); done++; } catch (e) { err = e; }
          }
          close(true);
          if (err) toast(`${fmtNum(done)} von ${fmtNum(p.length)} gelöscht – ${err.message}`, 'error');
          else toast(`${plural(done, 'Sicherheitskopie', 'Sicherheitskopien')} gelöscht`, 'ok');
          await load();
        } },
      ],
      onOpen: () => { update(); rAll.focus(); },
      cancelValue: false,
    });
  }

  createBtn.addEventListener('click', async () => {
    const b = await createBackupDialog();
    if (!b) return;
    freshName = b.name;
    await load();
    refocus(box, 'bk:' + b.name);
  });
  page('Sicherungen', frag(refreshButton(load), createBtn), box);
  await load();
}

async function createBackupDialog() {
  const input = h('input', { class: 'input', id: 'bk-label', maxlength: '80', placeholder: 'z. B. vor dem Umbau', autocomplete: 'off' });
  const err = h('div', { class: 'form-error', role: 'alert' });
  return openDialog({
    title: 'Jetzt sichern',
    body: frag(h('div', { class: 'field' }, h('label', { for: 'bk-label', text: 'Bezeichnung (optional)' }), input), err),
    buttons: [
      { label: 'Abbrechen', value: null },
      { label: 'Sichern', kind: 'primary', busyLabel: 'Sichere …', onClick: async (close) => {
        try {
          const b = await api('backups', { method: 'POST', body: input.value.trim() ? { label: input.value.trim() } : {}, quiet: true });
          toast('Sicherung angelegt', 'ok');
          close(b);
        } catch (e) { err.textContent = e.message; }
      } },
    ],
    onOpen: () => input.focus(),
  });
}

async function deleteBackup(b, all, after) {
  const only = all.length === 1;
  const ok = await confirmDialog('Sicherung löschen', frag(
    h('p', {}, h('strong', { text: backupTitle(b) }), ` (${backupWhen(b)}, ${fmtBytes(b.size)}) wird vom Server gelöscht. Das lässt sich nicht rückgängig machen.`),
    isSafety(b) ? h('p', { text: `Sie hält den Stand vor der Wiederherstellung am ${fmtAbs(b.created)} fest.` }) : null,
    only ? h('p', { class: 'warn-note', text: 'Danach gibt es keine Sicherung mehr.' }) : null), { okLabel: 'Löschen', danger: true });
  if (!ok) return false;
  try { await api(`backups/${enc(b.name)}`, { method: 'DELETE' }); }
  catch (e) { if (e.status === 404 && after) await after(); return false; }
  toast('Sicherung gelöscht', 'ok');
  if (after) await after();
  return true;
}

async function downloadBackup(b) {
  const ok = await confirmDialog('Sicherung herunterladen', 'Die Datei enthält die ganze Datenbank, also auch Passwort-Hashes, Geräte-Zugänge und die TOTP-Geheimnisse der Admins. Bitte sicher aufbewahren.', { okLabel: 'Herunterladen' });
  if (ok && await downloadUrl(`${API}backups/${enc(b.name)}/download`, b.name)) toast('Download gestartet');
}

const STATUS = {
  changed: ['Geändert', 'warn'],
  moved: ['Verschoben', 'accent'],
  missing: ['Fehlt heute', 'danger'],
  added: ['Neu seit Sicherung', ''],
  same: ['Unverändert', ''],
};
function statusBadge(s) { const x = STATUS[s]; return x && s !== 'same' ? h('span', { class: 'badge ' + x[1], text: x[0] }) : null; }

// Wiederherstellen (einzelne/mehrere Dateien oder ganzer Vault) → API-Antwort oder null
async function restoreDialog({ backup, space, entries = [], all = false, added = [], online = [], spaceTitle, counts }) {
  const when = backupWhen(backup);
  const ids = new Set(entries.map((e) => e.id));
  const openHere = online.filter((o) => (Array.isArray(o.files) ? o.files : []).some((f) => f.space === space && (all || ids.has(f.doc))));
  const conn = online.length;
  let prune = null, running = false;
  const body = frag();
  if (all) {
    body.append(h('p', {}, h('strong', { text: spaceTitle || space }), ` wird auf den Stand vom ${when} zurückgesetzt.`));
    const facts = [];
    if (counts.changed) facts.push(h('dt', { text: 'Inhalt geändert' }), h('dd', { text: fmtNum(counts.changed) }));
    if (counts.moved) facts.push(h('dt', { text: 'Verschoben' }), h('dd', { text: fmtNum(counts.moved) }));
    if (counts.missing) facts.push(h('dt', { text: 'Wiederhergestellt (heute gelöscht)' }), h('dd', { text: fmtNum(counts.missing) }));
    if (facts.length) body.append(h('dl', { class: 'kv compact' }, facts));
    if (added.length) {
      prune = h('input', { type: 'checkbox', id: 'rs-prune' });
      const listEl = h('ul', { class: 'plain-list mono small', hidden: true }, added.slice(0, 50).map((a) => h('li', { text: a.path })), added.length > 50 ? h('li', { class: 'dim', text: `und ${added.length - 50} weitere` }) : null);
      const show = h('button', { class: 'linkish small', type: 'button', text: 'anzeigen', 'aria-expanded': 'false', onclick: () => { listEl.hidden = !listEl.hidden; show.setAttribute('aria-expanded', String(!listEl.hidden)); show.textContent = listEl.hidden ? 'anzeigen' : 'ausblenden'; } });
      body.append(h('div', { class: 'field row wrap' }, prune, h('label', { for: 'rs-prune', text: `Seit der Sicherung neu angelegte Dateien in den Papierkorb legen (${fmtNum(added.length)})` }), show), listEl);
    }
    if (conn) body.append(h('p', { class: 'dim small', text: `${plural(conn, 'Gerät ist', 'Geräte sind')} mit diesem Vault verbunden und ${conn === 1 ? 'übernimmt' : 'übernehmen'} den Stand sofort.` }));
  } else {
    const n = entries.length;
    body.append(h('p', { text: `${n === 1 ? 'Diese Datei wird' : `${plural(n, 'Datei', 'Dateien')} werden`} auf den Stand vom ${when} zurückgesetzt:` }));
    body.append(h('ul', { class: 'plain-list mono small' }, entries.slice(0, 8).map((e) => h('li', { text: e.path })), n > 8 ? h('li', { class: 'dim', text: `und ${n - 8} weitere` }) : null));
    const miss = entries.filter((e) => e.status === 'missing').length;
    const moved = entries.filter((e) => e.livePath && e.status !== 'missing');
    const changed = entries.filter((e) => e.status === 'changed').length;
    const cons = [];
    if (miss) cons.push(h('li', { text: miss === 1 ? '1 gelöschte Datei wird wiederhergestellt.' : `${fmtNum(miss)} gelöschte Dateien werden wiederhergestellt.` }));
    if (moved.length === 1) cons.push(h('li', {}, '1 Datei wird an ihren alten Pfad zurückverschoben (heute: ', h('code', { text: moved[0].livePath }), ').'));
    else if (moved.length) cons.push(h('li', { text: `${fmtNum(moved.length)} Dateien werden an ihre alten Pfade zurückverschoben.` }));
    if (changed) cons.push(h('li', { text: changed === 1 ? '1 Datei bekommt ihren alten Inhalt.' : `${fmtNum(changed)} Dateien bekommen ihren alten Inhalt.` }));
    if (cons.length) body.append(h('ul', { class: 'plain-list' }, cons));
    if (n > 200) body.append(h('p', { class: 'dim small', text: 'Für viele Dateien ist „Ganzen Vault zurücksetzen“ einfacher.' }));
    if (openHere.length) body.append(h('p', { class: 'warn-note', text: `Gerade geöffnet bei ${[...new Set(openHere.map((o) => `${o.name || o.user} (${o.device || 'Gerät'})`))].join(', ')}. Die Änderung kommt dort sofort an; was danach getippt wird, bleibt erhalten.` }));
    else if (conn) body.append(h('p', { class: 'dim small', text: `${plural(conn, 'verbundenes Gerät übernimmt', 'verbundene Geräte übernehmen')} die Änderung sofort.` }));
  }
  const foot = h('p', { class: 'dim small', text: 'Vorher wird der aktuelle Stand automatisch gesichert.' });
  if (prune) prune.addEventListener('change', () => { foot.textContent = 'Vorher wird der aktuelle Stand automatisch gesichert.' + (prune.checked ? ' Dateien im Papierkorb lassen sich im Vault wiederherstellen.' : ''); });
  body.append(foot);
  return openDialog({
    title: all ? 'Vault zurücksetzen' : (entries.length === 1 ? 'Datei wiederherstellen' : 'Dateien wiederherstellen'),
    body,
    lock: () => running,
    buttons: [
      { label: 'Abbrechen', value: null },
      { label: all ? 'Vault zurücksetzen' : (entries.length === 1 ? 'Wiederherstellen' : `${plural(entries.length, 'Datei', 'Dateien')} wiederherstellen`), kind: all ? 'danger solid' : 'primary', busyLabel: 'Stelle wieder her …', onClick: async (close) => {
        running = true;
        try {
          const req = all ? { space, all: true, prune: !!(prune && prune.checked) } : { space, docs: entries.map((e) => e.id) };
          const r = await api(`backups/${enc(backup.name)}/restore`, { method: 'POST', body: req });
          running = false;
          close(r || {});
        } catch { running = false; }
      } },
    ],
    cancelValue: null,
  });
}

// Detail: #/backups/<name>[/<space>[/<doc>]]
async function viewBackup(name, space, doc) {
  if (backupCtx && backupCtx.name === name && main.contains(backupCtx.root)) {
    await backupCtx.go(space, doc);
    return;
  }
  backupCtx = createBackupCtx(name);
  replace(main, backupCtx.root);
  await backupCtx.init(space, doc);
}

function createBackupCtx(name) {
  const ctx = { name, info: null, spaces: [], live: [], space: null, doc: null, data: null, sel: new Set(), filter: null, query: '', cache: new Map(), online: [], shown: 300, result: null };
  const headBox = h('div', { class: 'bk-head' });
  const tabsBox = h('div', { class: 'bk-vaults' });
  const resultBox = h('div', { class: 'bk-result' });
  const toolsBox = h('div', { class: 'bk-tools' });
  const listBox = h('div', { class: 'bk-list', role: 'region', 'aria-label': 'Dateien der Sicherung' });
  const previewBox = h('section', { class: 'bk-preview', 'aria-label': 'Vorschau' });
  const selbar = h('div', { class: 'selbar', role: 'region', 'aria-label': 'Auswahl', hidden: true });
  const bodyEl = h('div', { class: 'bk-body' }, listBox, previewBox);
  const content = h('div', { class: 'bk-content' }, tabsBox, resultBox, toolsBox, bodyEl, selbar);
  const root = h('div', { class: 'page wide bk-detail' }, headBox, content);
  ctx.root = root;
  const path = (s, d) => `#/backups/${enc(name)}${s ? '/' + enc(s) : ''}${d ? '/' + enc(d) : ''}`;

  function notFound(msg) {
    replace(root, h('div', { class: 'page-head' }, h('h1', { text: 'Diese Sicherung gibt es nicht mehr', tabindex: '-1' })),
      h('p', { text: msg || 'Sie wurde gelöscht oder beim Ausdünnen entfernt.' }), h('p', {}, h('a', { href: '#/backups', text: 'Zu den Sicherungen' })));
    document.title = 'Sicherung nicht gefunden – Tandem Admin';
  }

  ctx.init = async (space, doc) => {
    replace(headBox, h('span', { class: 'crumb' }, h('a', { href: '#/backups', text: 'Sicherungen' }), ' / '), h('h1', { text: name }));
    replace(content.firstChild, loadingEl('Lade Vaults …'));
    clear(toolsBox); clear(listBox); clear(previewBox);
    document.title = `${name} – Sicherungen – Tandem Admin`;
    let r, sp, live;
    try {
      [r, sp, live] = await Promise.all([api('backups', { quiet: true }), api(`backups/${enc(name)}/spaces`, { quiet: true, expect: [404] }), loadSpaces(false).catch(() => [])]);
    } catch (e) {
      if (e.status === 404) { notFound(); return; }
      replace(tabsBox, errorEl('Sicherung konnte nicht geöffnet werden', e, () => ctx.init(space, doc)));
      return;
    }
    ctx.info = (r && Array.isArray(r.backups) ? r.backups : []).find((b) => b.name === name) || null;
    if (!ctx.info) { notFound(); return; }
    ctx.all = r.backups;
    ctx.spaces = Array.isArray(sp) ? sp : [];
    ctx.live = live || [];
    renderHead();
    if (!space) {
      const pref = readPref('backups.space');
      const pick = ctx.spaces.find((s) => s.id === pref) || ctx.spaces.find((s) => Number(s.files) > 0) || ctx.spaces[0];
      if (pick) { const h2 = path(pick.id); history.replaceState(null, '', location.pathname + location.search + h2); state.hash = h2; space = pick.id; }
    }
    await ctx.go(space, doc, true);
  };

  function renderHead() {
    const b = ctx.info;
    const kind = isSafety(b) ? 'Sicherheitskopie' : b.kind === 'auto' ? 'automatisch' : 'von Hand';
    replace(headBox,
      h('span', { class: 'crumb' }, h('a', { href: '#/backups', text: 'Sicherungen' }), h('span', { 'aria-hidden': 'true', text: ' / ' })),
      h('h1', { text: backupTitle(b) }),
      h('span', { class: 'badge', text: kind }),
      h('span', { class: 'meta', text: `${backupWhen(b)} · ${fmtBytes(b.size)}` }),
      h('span', { class: 'acts' },
        h('button', { class: 'btn', type: 'button', text: 'Herunterladen (.db)', onclick: () => downloadBackup(b) }),
        menuButton('Weitere Aktionen für diese Sicherung', () => [
          { label: 'Sicherung löschen …', danger: true, onClick: async () => { if (await deleteBackup(b, ctx.all || [b], null)) navigate('#/backups'); } },
        ], { sm: false })));
    document.title = `${backupTitle(b)} – Sicherungen – Tandem Admin`;
  }

  function renderTabs() {
    if (!ctx.spaces.length) { replace(tabsBox, emptyEl('Diese Sicherung enthält keine Vaults.')); return; }
    const later = ctx.live.filter((l) => !ctx.spaces.some((s) => s.id === l.id));
    const items = ctx.spaces.map((s) => ({ s, deleted: !ctx.live.some((l) => l.id === s.id) }));
    if (items.length + later.length >= 6) {
      const sel = h('select', { class: 'select', id: 'bk-space' }, items.map(({ s, deleted }) => h('option', { value: s.id, text: `${esc(s.name || s.id)} (${fmtNum(s.files)})${deleted ? ' – heute gelöscht' : ''}` })));
      sel.value = ctx.space || '';
      sel.addEventListener('change', () => navigate(path(sel.value)));
      replace(tabsBox, h('div', { class: 'field row' }, h('label', { for: 'bk-space', text: 'Vault' }), sel));
      return;
    }
    replace(tabsBox, h('nav', { class: 'tabs', 'aria-label': 'Vault in der Sicherung' },
      items.map(({ s, deleted }) => h('a', { href: path(s.id), 'aria-current': s.id === ctx.space ? 'page' : null }, esc(s.name || s.id), ' ', h('span', { class: 'n', text: fmtNum(s.files) }), deleted ? h('span', { class: 'badge warn', text: 'gelöscht' }) : null)),
      later.map((l) => h('span', { class: 'tab-disabled', 'aria-disabled': 'true', title: 'Gab es zum Zeitpunkt der Sicherung noch nicht' }, esc(l.name || l.id), ' ', h('span', { class: 'dim small', text: 'später angelegt' })))));
  }

  ctx.go = async (space, doc, first) => {
    const spaceChanged = space !== ctx.space || first;
    ctx.space = space; ctx.doc = doc;
    renderTabs();
    if (!space) { clear(listBox); clear(toolsBox); clear(previewBox); return; }
    if (!ctx.spaces.some((s) => s.id === space)) {
      const live = ctx.live.find((l) => l.id === space);
      clear(toolsBox); clear(previewBox); clear(resultBox);
      replace(listBox, emptyEl(`${live ? `„${live.name || live.id}“` : `Den Vault „${space}“`} gab es zum Zeitpunkt dieser Sicherung (${backupWhen(ctx.info)}) noch nicht.`, h('a', { href: '#/backups', text: 'Andere Sicherung wählen' })));
      return;
    }
    writePref('backups.space', space);
    bodyEl.classList.toggle('show-preview', !!doc);
    if (spaceChanged) {
      ctx.sel.clear(); ctx.filter = null; ctx.query = ''; ctx.shown = 300; ctx.cache.clear();
      if (!first) ctx.result = null;
      renderResult();
      await loadFiles();
    } else {
      renderList();
      renderPreview();
    }
  };

  async function loadFiles() {
    const sp = ctx.spaces.find((s) => s.id === ctx.space);
    const had = !!ctx.data && listBox.dataset.space === ctx.space;
    if (had) listBox.classList.add('reloading');
    else { clear(toolsBox); clear(previewBox); replace(listBox, loadingEl(sp && Number(sp.files) > 50 ? `Vergleiche ${fmtNum(sp.files)} Dateien mit dem heutigen Stand …` : 'Vergleiche mit dem heutigen Stand …')); }
    listBox.setAttribute('aria-busy', 'true');
    try {
      const live = ctx.live.some((l) => l.id === ctx.space);
      const [r, files] = await Promise.all([api(`backups/${enc(name)}/spaces/${enc(ctx.space)}/files`, { quiet: true, expect: [404] }),
        live ? api(`spaces/${enc(ctx.space)}/files`, { quiet: true }).catch(() => null) : null]);
      ctx.data = { files: Array.isArray(r && r.files) ? r.files : [], added: Array.isArray(r && r.added) ? r.added : [] };
      ctx.online = files && Array.isArray(files.online) ? files.online : [];
      ctx.liveFiles = files && Array.isArray(files.files) ? files.files : [];
      listBox.dataset.space = ctx.space;
    } catch (e) {
      if (e.status === 404) { notFound(); return; }
      replace(listBox, errorEl('Dateien konnten nicht geladen werden', e, loadFiles));
      return;
    } finally { listBox.classList.remove('reloading'); listBox.removeAttribute('aria-busy'); }
    renderTools();
    renderList();
    renderPreview();
  }
  ctx.reload = loadFiles;

  const counts = () => {
    const c = { changed: 0, moved: 0, missing: 0, same: 0, added: ctx.data.added.length };
    for (const f of ctx.data.files) c[f.status] = (c[f.status] || 0) + 1;
    c.diff = c.changed + c.moved + c.missing;
    c.all = ctx.data.files.length + c.added;
    return c;
  };
  const isDeleted = () => !ctx.live.some((l) => l.id === ctx.space);
  const selectable = (f) => !isDeleted() && (f.status === 'changed' || f.status === 'moved' || f.status === 'missing');

  function renderTools() {
    const c = counts();
    if (!ctx.filter) ctx.filter = c.diff > 0 ? 'diff' : 'all';
    const sp = ctx.spaces.find((s) => s.id === ctx.space) || { id: ctx.space };
    const title = sp.name || sp.id;
    if (isDeleted()) {
      replace(toolsBox, h('div', { class: 'warn-note' },
        h('p', { text: `Den Vault „${ctx.space}“ gibt es heute nicht mehr. Er lässt sich aus dieser Sicherung exportieren oder neu anlegen und wiederherstellen.` }),
        h('div', { class: 'toolbar' },
          h('button', { class: 'btn sm', type: 'button', text: 'Exportieren (.tar)', onclick: () => exportVault(ctx.space, name) }),
          h('button', { class: 'btn sm', type: 'button', text: 'Vault neu anlegen und wiederherstellen …', onclick: (e) => recreateVault(e.currentTarget, sp) }))));
      return;
    }
    const filters = [['diff', 'Abweichend', c.diff], ['changed', 'Geändert', c.changed], ['moved', 'Verschoben', c.moved], ['missing', 'Fehlt heute', c.missing], ['added', 'Neu seit Sicherung', c.added], ['all', 'Alle', c.all]];
    const seg = h('div', { class: 'seg filters', role: 'group', 'aria-label': 'Anzeigen' }, filters.map(([k, l, n]) =>
      h('button', { class: 'btn sm', type: 'button', 'aria-pressed': String(ctx.filter === k), disabled: !n && k !== 'all' && ctx.filter !== k, dataset: { k },
        onclick: () => { ctx.filter = k; ctx.shown = 300; for (const b of seg.children) b.setAttribute('aria-pressed', String(b.dataset.k === k)); renderList(); } },
      l, ' ', h('span', { class: 'n', text: fmtNum(n) }))));
    const q = h('input', { class: 'input', type: 'search', placeholder: 'Pfad filtern', 'aria-label': 'Pfad filtern', value: ctx.query, autocomplete: 'off' });
    q.addEventListener('input', () => { ctx.query = q.value.trim().toLowerCase(); ctx.shown = 300; renderList(); });
    const resetBtn = h('button', { class: 'btn', type: 'button', text: 'Ganzen Vault zurücksetzen …', disabled: !c.diff && !c.added, title: !c.diff && !c.added ? 'Der Vault entspricht bereits dieser Sicherung.' : null });
    resetBtn.addEventListener('click', async () => {
      const res = await restoreDialog({ backup: ctx.info, space: ctx.space, all: true, added: ctx.data.added, online: ctx.online, spaceTitle: title, counts: c });
      if (res) await afterRestore(res, ctx.data.files.filter((f) => f.status !== 'same'));
    });
    replace(toolsBox, seg, h('div', { class: 'bk-actions' }, q,
      h('button', { class: 'btn', type: 'button', text: 'Vault exportieren (.tar)', title: `Vault im Stand der Sicherung herunterladen`, onclick: () => exportVault(ctx.space, name) }),
      resetBtn));
  }

  function visibleEntries() {
    const c = ctx.filter;
    let list = c === 'added' ? [] : ctx.data.files.filter((f) => c === 'all' || (c === 'diff' ? f.status !== 'same' : f.status === c));
    if (c === 'added' || c === 'all') list = list.concat(ctx.data.added.map((a) => ({ ...a, status: 'added' })));
    if (ctx.query) list = list.filter((f) => String(f.path).toLowerCase().includes(ctx.query) || String(f.livePath || '').toLowerCase().includes(ctx.query));
    return list.sort((a, b) => coll.compare(a.path, b.path));
  }

  function renderList() {
    if (!ctx.data) return;
    if (isDeleted()) {
      const files = ctx.data.files.slice().sort((a, b) => coll.compare(a.path, b.path));
      replace(listBox, files.length ? h('ul', { class: 'bk-files' }, files.slice(0, ctx.shown).map((f) => h('li', { class: 'row' }, h('a', { class: 'nm', href: path(ctx.space, f.id), title: f.path, text: f.path })))) : emptyEl('Der Vault war zum Zeitpunkt der Sicherung leer.'));
      return;
    }
    const all = visibleEntries();
    if (!ctx.data.files.length && !ctx.data.added.length) { replace(listBox, emptyEl('Der Vault war zum Zeitpunkt der Sicherung leer.')); renderSelbar(); return; }
    if (!all.length) {
      replace(listBox, emptyEl(counts().diff === 0 && ctx.filter === 'diff' ? 'Dieser Vault entspricht dem Stand der Sicherung.' : 'Keine Dateien in diesem Filter.'));
      renderSelbar();
      return;
    }
    const sel = all.filter(selectable);
    const nSel = sel.filter((f) => ctx.sel.has(f.id)).length;
    const allCb = h('input', { type: 'checkbox', id: 'bk-all', checked: sel.length > 0 && nSel === sel.length, indeterminate: nSel > 0 && nSel < sel.length, disabled: !sel.length });
    allCb.addEventListener('change', () => { for (const f of sel) { if (allCb.checked) ctx.sel.add(f.id); else ctx.sel.delete(f.id); } renderList(); document.getElementById('bk-all')?.focus(); });
    const ul = h('ul', { class: 'bk-files' });
    let dir = null;
    for (const f of all.slice(0, ctx.shown)) {
      const d = dirname(f.path);
      if (d !== dir) { dir = d; if (d) ul.append(h('li', { class: 'folder', 'aria-hidden': 'true', text: d + '/' })); }
      const cb = selectable(f) ? h('input', { type: 'checkbox', checked: ctx.sel.has(f.id), 'aria-label': f.path }) : h('span', { class: 'cb-space', 'aria-hidden': 'true' });
      if (cb.tagName === 'INPUT') cb.addEventListener('change', () => { if (cb.checked) ctx.sel.add(f.id); else ctx.sel.delete(f.id); updateAllCb(); renderSelbar(); });
      const ext = extOf(f.path);
      ul.append(h('li', { class: 'row' + (f.status === 'same' ? ' same' : '') + (d ? ' in' : '') },
        cb,
        h('a', { class: 'nm', href: path(ctx.space, f.id), 'aria-current': ctx.doc === f.id ? 'page' : null, title: f.path },
          h('span', { class: 'name', text: displayName(f.path) }), ext && ext !== 'md' ? h('span', { class: 'ext', text: ext.toUpperCase() }) : null),
        statusBadge(f.status),
        f.livePath && f.status !== 'added' ? h('span', { class: 'live dim small', title: f.livePath, text: 'heute: ' + f.livePath }) : null));
    }
    function updateAllCb() {
      const n = sel.filter((f) => ctx.sel.has(f.id)).length;
      allCb.checked = sel.length > 0 && n === sel.length; allCb.indeterminate = n > 0 && n < sel.length;
    }
    replace(listBox,
      h('div', { class: 'bk-all' }, allCb, h('label', { for: 'bk-all', text: all.length > ctx.shown && sel.length ? `Alle ${fmtNum(sel.length)} auswählen` : `Alle sichtbaren auswählen (${fmtNum(sel.length)})` })),
      ul,
      all.length > ctx.shown ? h('button', { class: 'btn sm more-rows', type: 'button', text: `Weitere ${fmtNum(all.length - ctx.shown)} anzeigen`, onclick: () => { ctx.shown = all.length; renderList(); } }) : null);
    const curEl = listBox.querySelector('[aria-current="page"]');
    if (curEl) curEl.scrollIntoView({ block: 'nearest' });
    renderSelbar();
  }

  function renderSelbar() {
    const n = ctx.sel.size;
    selbar.hidden = !n;
    if (!n) { clear(selbar); return; }
    replace(selbar,
      h('span', { 'aria-live': 'polite', text: `${fmtNum(n)} ausgewählt` }),
      h('button', { class: 'btn primary sm', type: 'button', text: 'Auswahl wiederherstellen …', onclick: async () => {
        const entries = ctx.data.files.filter((f) => ctx.sel.has(f.id));
        const res = await restoreDialog({ backup: ctx.info, space: ctx.space, entries, online: ctx.online });
        if (res) await afterRestore(res, entries);
      } }),
      h('button', { class: 'btn ghost sm', type: 'button', text: 'Auswahl aufheben', onclick: () => { ctx.sel.clear(); renderList(); } }));
  }

  async function afterRestore(res, entries) {
    ctx.sel.clear();
    ctx.cache.clear();
    const skipped = Array.isArray(res.skipped) ? res.skipped : [];
    ctx.result = { res, entries, skipped };
    await loadFiles();
    // seitdem schon wieder bearbeitet?
    const again = entries.filter((e) => !skipped.some((s) => s.path === e.path)).filter((e) => { const f = ctx.data.files.find((x) => x.id === e.id); return f && f.status !== 'same'; }).length;
    ctx.result.again = again;
    renderResult();
    const n = Number(res.restored) || 0;
    if (skipped.length) toast(`${fmtNum(n)} wiederhergestellt, ${fmtNum(skipped.length)} übersprungen`, 'error');
    else toast(n ? `${plural(n, 'Datei', 'Dateien')} wiederhergestellt` : 'Nichts zu ändern', 'ok');
    const note = resultBox.querySelector('.result-note');
    if (note) note.focus();
    // Sicherheitskopie ist eine neue Sicherung → Liste für Kopf/Löschen auffrischen
    try { const r = await api('backups', { quiet: true }); ctx.all = r && r.backups; } catch { /* egal */ }
  }

  function renderResult() {
    clear(resultBox);
    const R = ctx.result;
    if (!R || !ctx.data) return;
    const { res, skipped } = R;
    const n = Number(res.restored) || 0;
    const live = ctx.liveFiles || [];
    const closeBtn = h('button', { class: 'btn ghost icon sm', type: 'button', 'aria-label': 'Hinweis schließen', text: '×', onclick: () => { ctx.result = null; renderResult(); } });
    const safety = res.safety ? h('a', { href: `#/backups/${enc(res.safety)}/${enc(ctx.space)}`, text: 'Sicherheitskopie ansehen' }) : null;
    const parts = [];
    if (n) parts.push(h('strong', { text: `${plural(n, 'Datei', 'Dateien')} wiederhergestellt` }), ` aus „${backupTitle(ctx.info)}“.`);
    else parts.push(h('strong', { text: 'Nichts zu ändern' }), ' – die Dateien entsprachen bereits der Sicherung.');
    if (Number(res.trashed) > 0) parts.push(' ', `${plural(res.trashed, 'neue Datei', 'neue Dateien')} in den `, h('a', { href: `#/vault/${enc(ctx.space)}/_trash`, text: 'Papierkorb' }), ' gelegt.');
    if (R.again) parts.push(' ', `${plural(R.again, 'Datei wurde', 'Dateien wurden')} seitdem schon wieder bearbeitet.`);
    const reason = (s) => {
      const m = String(s.reason || '').match(/^Pfad belegt \(heute andere Datei, ([^)]+)\)$/);
      if (m) {
        const occ = live.find((f) => f.id === m[1]) || ctx.data.added.find((f) => f.id === m[1]);
        return occ ? frag('Unter diesem Pfad liegt heute eine andere Datei: ', h('a', { href: `#/vault/${enc(ctx.space)}/${enc(occ.id)}`, text: occ.path })) : s.reason;
      }
      if (/Anhangs fehlt/.test(s.reason)) return `${s.reason} (z. B. mit dem Vault gelöscht)`;
      return s.reason;
    };
    resultBox.append(h('div', { class: (skipped.length ? 'warn-note ' : '') + 'result-note', role: 'status', tabindex: '-1' },
      h('div', { class: 'rn-head' }, h('p', {}, parts, safety ? frag(' Den vorherigen Stand hält die Sicherheitskopie fest: ', safety, '.') : null), closeBtn),
      skipped.length ? frag(
        table(['Übersprungen', 'Grund'], skipped.map((s) => h('tr', {}, h('td', { class: 'path', text: s.path }), h('td', {}, reason(s)))), { caption: 'Übersprungene Dateien' }),
        skipped.some((s) => /Pfad belegt/.test(s.reason)) ? h('p', { class: 'small', text: 'Tipp: Die belegende Datei im Vault umbenennen und dann erneut wiederherstellen.' }) : null) : null));
  }

  async function recreateVault(btn, sp) {
    const ok = await confirmDialog('Vault wiederherstellen', `Legt den Vault „${sp.id}“ mit dem Namen „${sp.name || sp.id}“ neu an und stellt alle ${fmtNum(sp.files)} Dateien aus dieser Sicherung wieder her. Mitglieder werden nicht wiederhergestellt – bitte danach unter „Mitglieder“ zuweisen.`, { okLabel: 'Anlegen und wiederherstellen' });
    if (!ok) return;
    await busy(btn, async () => {
      try { await api('spaces', { method: 'POST', body: { id: sp.id, name: sp.name || sp.id } }); } catch { return; }
      const r = await api(`backups/${enc(name)}/restore`, { method: 'POST', body: { space: sp.id, all: true } });
      ctx.live = await loadSpaces(false).catch(() => ctx.live.concat([{ id: sp.id, name: sp.name }]));
      ctx.result = { res: r || {}, entries: ctx.data.files, skipped: Array.isArray(r && r.skipped) ? r.skipped : [] };
      renderTabs();
      await loadFiles();
      renderResult();
      resultBox.querySelector('.result-note')?.append(h('p', {}, h('a', { href: `#/vault/${enc(sp.id)}/_members`, text: 'Mitglieder zuweisen' })));
      toast('Vault wiederhergestellt', 'ok');
    }, 'Stelle wieder her …');
  }

  // --- Vorschau einer Datei: Vergleich mit heute
  async function renderPreview() {
    const id = ctx.doc;
    if (!id || !ctx.data) {
      replace(previewBox, h('div', { class: 'center dim' }, h('p', { text: 'Datei links auswählen, um sie mit heute zu vergleichen.' })));
      return;
    }
    let f = ctx.data.files.find((x) => x.id === id);
    const added = !f && ctx.data.added.find((x) => x.id === id);
    if (added) f = { ...added, status: 'added' };
    const back = h('a', { class: 'back-link', href: path(ctx.space), text: '‹ Zurück zur Liste' });
    if (!f) { replace(previewBox, back, emptyEl('Diese Datei gibt es in der Sicherung nicht.')); return; }
    const head = h('div', { class: 'pv-head' }, h('span', { class: 'path', title: f.path, text: f.path }), statusBadge(f.status),
      f.livePath && f.status !== 'added' ? h('span', { class: 'dim small' }, 'heute unter ', h('code', { text: f.livePath })) : null);
    if (f.status === 'added') {
      replace(previewBox, back, head, h('p', { text: 'Diese Datei gab es zum Zeitpunkt der Sicherung noch nicht.' }), h('p', {}, h('a', { href: `#/vault/${enc(ctx.space)}/${enc(f.id)}`, text: 'Im Vault öffnen' })));
      return;
    }
    replace(previewBox, back, head, loadingEl());
    const kind = f.kind === 'text' ? 'md' : f.kind;
    const deleted = isDeleted();
    let data = ctx.cache.get(id);
    if (!data) {
      try {
        const [b, l] = await Promise.all([
          api(`backups/${enc(name)}/spaces/${enc(ctx.space)}/docs/${enc(id)}`, { quiet: true }),
          f.status === 'missing' || deleted || kind === 'blob' ? null : api(`spaces/${enc(ctx.space)}/docs/${enc(id)}`, { quiet: true, expect: [404] }).catch(() => null)]);
        data = { b, l };
        ctx.cache.set(id, data);
        if (ctx.cache.size > 20) ctx.cache.delete(ctx.cache.keys().next().value);
      } catch (e) {
        if (ctx.doc === id) replace(previewBox, back, head, errorEl('Datei konnte nicht geladen werden', e, renderPreview));
        return;
      }
    }
    if (ctx.doc !== id) return;
    const body = h('div', { class: 'pv-body' });
    if (kind === 'md') {
      const bt = typeof data.b.text === 'string' ? data.b.text : '';
      const lt = data.l && typeof data.l.text === 'string' ? data.l.text : null;
      let mode = f.status === 'missing' || lt == null ? 'backup' : 'diff';
      const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Darstellung' });
      const modes = [['diff', 'Vergleich'], ['backup', 'Stand der Sicherung'], ['live', 'Heute']];
      const paint = () => {
        for (const b of seg.children) b.setAttribute('aria-pressed', String(b.dataset.m === mode));
        clear(body);
        if (mode === 'diff') body.append(h('div', { class: 'diff-legend' }, h('span', { class: 'del', text: `− Sicherung (${backupWhen(ctx.info)})` }), h('span', { class: 'add', text: '+ Heute' })), diffEl(bt, lt));
        else body.append(h('div', { class: 'md' }, renderMarkdown(mode === 'backup' ? bt : lt, {})));
      };
      for (const [m, l] of modes) seg.append(h('button', { class: 'btn sm', type: 'button', dataset: { m }, text: l, disabled: (m !== 'backup' && lt == null), onclick: () => { mode = m; paint(); } }));
      paint();
      previewBox.lastChild.replaceWith(h('div', { class: 'pv-tools' }, seg));
      previewBox.append(body);
    } else if (kind === 'blob') {
      const live = (ctx.liveFiles || []).find((x) => x.id === id && !x.del);
      const isImg = IMG_EXT.has(extOf(f.path));
      body.append(h('dl', { class: 'kv' },
        h('dt', { text: 'Größe' }), h('dd', { text: `${fmtBytes(data.b.size)} (Sicherung)${live ? ` · ${fmtBytes(live.size)} (heute)` : ''}` }),
        h('dt', { text: 'Prüfsumme' }), h('dd', {}, h('code', { title: esc(data.b.hash), text: String(data.b.hash || '–').slice(0, 7) }), live ? frag(' · ', h('code', { title: esc(live.hash), text: String(live.hash || '–').slice(0, 7) })) : null)),
        isImg ? h('div', { class: 'compare' },
          h('figure', {}, h('img', { src: `${API}backups/${enc(name)}/spaces/${enc(ctx.space)}/raw/${enc(id)}`, alt: 'Stand der Sicherung' }), h('figcaption', { text: 'Sicherung' })),
          live ? h('figure', {}, h('img', { src: rawUrl(ctx.space, id), alt: 'Heute' }), h('figcaption', { text: 'Heute' })) : null) : null);
      previewBox.lastChild.replaceWith(body);
    } else {
      const sN = Array.isArray(data.b.strokes) ? data.b.strokes.length : null;
      const lN = data.l && Array.isArray(data.l.strokes) ? data.l.strokes.length : null;
      body.append(h('dl', { class: 'kv' },
        h('dt', { text: 'Striche' }), h('dd', { text: `${sN == null ? '–' : fmtNum(sN)} (Sicherung)${lN != null ? ` · ${fmtNum(lN)} (heute)` : ''}` })),
        h('p', { class: 'dim small', text: 'Handschrift lässt sich hier nicht anzeigen. Wiederherstellen geht trotzdem.' }));
      previewBox.lastChild.replaceWith(body);
    }
    // Fuß: wer hat die Datei offen, Wiederherstellen
    const open = ctx.online.filter((o) => (Array.isArray(o.files) ? o.files : []).some((x) => x.doc === id && x.space === ctx.space));
    const foot = h('div', { class: 'pv-foot' },
      open.length ? h('span', { class: 'chips', role: 'group', 'aria-label': 'Gerade geöffnet bei' }, h('span', { class: 'lbl', text: 'Bearbeitet gerade' }), open.map((o) => h('span', { class: 'chip', title: o.device || '' }, colorDot(o.color), esc(o.name || o.user)))) : null);
    if (selectable(f)) {
      foot.append(h('button', { class: 'btn primary', type: 'button', text: 'Diesen Stand wiederherstellen', onclick: async () => {
        const res = await restoreDialog({ backup: ctx.info, space: ctx.space, entries: [f], online: ctx.online });
        if (res) await afterRestore(res, [f]);
      } }));
    } else if (f.status === 'same') foot.append(h('span', { class: 'dim', text: 'Unverändert seit der Sicherung.' }));
    previewBox.append(foot);
  }

  return ctx;
}

// ---------------------------------------------------------------------------
// Start

(function init() {
  if (!location.hash || location.hash === '#') {
    history.replaceState(null, '', location.pathname + location.search + '#/');
  }
  state.hash = location.hash;
  $('#skip').addEventListener('click', (e) => { e.preventDefault(); main.focus(); });
  // Navigation: Kantenverlauf nur, solange sie überläuft (bei Größenänderung lokal neu bewerten, ohne Netz)
  // „/“ springt in das Filter- bzw. Suchfeld der Seite (nicht, solange ein Eingabefeld fokussiert ist)
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
    const a = document.activeElement;
    if (a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) || document.querySelector('dialog[open]')) return;
    const f = main.querySelector('input[type="search"]');
    if (f && f.offsetParent !== null) { e.preventDefault(); f.focus(); f.select(); }
  });
  window.addEventListener('resize', () => { const nav = $('#nav'); nav.classList.toggle('overflowing', nav.scrollWidth > nav.clientWidth + 1); });
  render();
})();
