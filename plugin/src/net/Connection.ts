/**
 * Eine WebSocket-Verbindung pro Gerät, multiplexed über Doc-Namen.
 * Kümmert sich um HELLO/WELCOME, Ping, Wiederverbinden mit Backoff und meldet den Status.
 * Kein Puffern während der Trennung: Nach dem Wiederverbinden synchronisieren die Abonnenten
 * über Step1/State-Vector neu (siehe DocSession.resubscribe).
 */
import { decodeFrame, encodeFrame, Msg, PROTOCOL_VERSION, type Frame, type WelcomeInfo } from "./protocol";

export type ConnStatus = "offline" | "connecting" | "online" | "unauthorized";

export interface DocHandler {
	onSync(sub: number, data: Uint8Array): void;
	onAwareness(data: Uint8Array): void;
	onError?(code: number, message: string): void;
}

export interface ConnectionOptions {
	url: string;
	token: string;
	device: string;
	/** Nur für Tests: eigene WebSocket-Implementierung. */
	WebSocketImpl?: typeof WebSocket;
	pingInterval?: number;
	pongTimeout?: number;
}

const BACKOFF = [500, 1000, 2000, 5000, 10000, 20000, 30000];

export class Connection {
	status: ConnStatus = "offline";
	welcome: WelcomeInfo | null = null;
	private ws: WebSocket | null = null;
	private handlers = new Map<string, DocHandler>();
	private statusListeners = new Set<(s: ConnStatus) => void>();
	private changesListeners = new Set<(space: string, seq: number, docs: string[]) => void>();
	private errorListeners = new Set<(code: number, doc: string, msg: string) => void>();
	private attempt = 0;
	private reconnectTimer: number | null = null;
	private pingTimer: number | null = null;
	private pongTimer: number | null = null;
	private stopped = true;

	constructor(private opts: ConnectionOptions) {}

	start() {
		if (!this.stopped) return;
		this.stopped = false;
		this.open();
	}

	/** Trennt und verbindet nicht wieder (z. B. App im Hintergrund, Plugin entladen). */
	stop() {
		this.stopped = true;
		this.clearTimers();
		const ws = this.ws;
		this.ws = null;
		if (ws) {
			ws.onclose = ws.onerror = ws.onmessage = ws.onopen = null;
			try {
				ws.close();
			} catch {}
		}
		this.setStatus("offline");
	}

	/** Sofort neu verbinden (z. B. Netz zurück, App wieder im Vordergrund). */
	kick() {
		if (this.stopped) return;
		if (this.status === "online" || this.status === "connecting") return;
		this.attempt = 0;
		if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
		this.reconnectTimer = null;
		this.open();
	}

	register(doc: string, h: DocHandler) {
		this.handlers.set(doc, h);
	}
	unregister(doc: string) {
		this.handlers.delete(doc);
	}

	onStatus(fn: (s: ConnStatus) => void) {
		this.statusListeners.add(fn);
		return () => this.statusListeners.delete(fn);
	}
	onChanges(fn: (space: string, seq: number, docs: string[]) => void) {
		this.changesListeners.add(fn);
		return () => this.changesListeners.delete(fn);
	}
	onError(fn: (code: number, doc: string, msg: string) => void) {
		this.errorListeners.add(fn);
		return () => this.errorListeners.delete(fn);
	}

	send(f: Frame): boolean {
		if (this.status !== "online" || !this.ws || this.ws.readyState !== 1) return false;
		this.ws.send(encodeFrame(f) as Uint8Array<ArrayBuffer>);
		return true;
	}

	private open() {
		this.clearTimers();
		this.setStatus("connecting");
		const WS = this.opts.WebSocketImpl ?? WebSocket;
		let ws: WebSocket;
		try {
			ws = new WS(this.opts.url);
		} catch (e) {
			console.warn("[tandem] WebSocket-URL ungültig", e);
			this.scheduleReconnect();
			return;
		}
		ws.binaryType = "arraybuffer";
		this.ws = ws;
		ws.onopen = () => {
			ws.send(encodeFrame({ type: Msg.Hello, version: PROTOCOL_VERSION, token: this.opts.token, device: this.opts.device }) as Uint8Array<ArrayBuffer>);
		};
		ws.onmessage = (ev) => {
			if (!(ev.data instanceof ArrayBuffer)) return;
			let f: Frame;
			try {
				f = decodeFrame(new Uint8Array(ev.data));
			} catch (e) {
				console.warn("[tandem] ungültiger Frame vom Server", e);
				return;
			}
			this.onFrame(f);
		};
		ws.onclose = () => {
			if (this.ws !== ws) return;
			this.ws = null;
			this.clearTimers();
			if (this.status === "unauthorized" || this.stopped) return;
			this.setStatus("offline");
			this.scheduleReconnect();
		};
		ws.onerror = () => {
			/* onclose folgt */
		};
	}

	private onFrame(f: Frame) {
		switch (f.type) {
			case Msg.Welcome:
				this.welcome = f.info;
				this.attempt = 0;
				this.setStatus("online");
				this.startPing();
				break;
			case Msg.Sync:
				this.handlers.get(f.doc)?.onSync(f.sub, f.data);
				break;
			case Msg.Awareness:
				this.handlers.get(f.doc)?.onAwareness(f.data);
				break;
			case Msg.Changes:
				for (const fn of this.changesListeners) fn(f.space, f.seq, f.docs);
				break;
			case Msg.Pong:
				if (this.pongTimer !== null) window.clearTimeout(this.pongTimer);
				this.pongTimer = null;
				break;
			case Msg.Error:
				if (f.code === 401) {
					this.setStatus("unauthorized");
					this.stopped = true;
					this.ws?.close();
				}
				if (f.doc) this.handlers.get(f.doc)?.onError?.(f.code, f.message);
				for (const fn of this.errorListeners) fn(f.code, f.doc, f.message);
				break;
		}
	}

	private startPing() {
		const every = this.opts.pingInterval ?? 25000;
		this.pingTimer = window.setInterval(() => {
			if (!this.send({ type: Msg.Ping })) return;
			if (this.pongTimer !== null) return;
			this.pongTimer = window.setTimeout(() => {
				// Halbtote Verbindung (z. B. WLAN-Wechsel): hart neu aufbauen.
				this.pongTimer = null;
				this.ws?.close();
			}, this.opts.pongTimeout ?? 10000);
		}, every);
	}

	private scheduleReconnect() {
		if (this.stopped) return;
		const base = BACKOFF[Math.min(this.attempt++, BACKOFF.length - 1)];
		const delay = base * (0.75 + Math.random() * 0.5);
		this.reconnectTimer = window.setTimeout(() => {
			this.reconnectTimer = null;
			this.open();
		}, delay);
	}

	private clearTimers() {
		if (this.pingTimer !== null) window.clearInterval(this.pingTimer);
		if (this.pongTimer !== null) window.clearTimeout(this.pongTimer);
		if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
		this.pingTimer = this.pongTimer = this.reconnectTimer = null;
	}

	private setStatus(s: ConnStatus) {
		if (this.status === s) return;
		this.status = s;
		for (const fn of this.statusListeners) fn(s);
	}
}
