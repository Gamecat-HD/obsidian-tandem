// Startet den echten tandem-server (Release-Build) mit frischem Datenverzeichnis für E2E-Tests.
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const SERVER = resolve(import.meta.dirname, "../server");
export const BIN = process.env.TANDEM_BIN ?? join(SERVER, "target/release/tandem-server");

function freePort() {
	return new Promise((ok) => {
		const s = createServer();
		s.listen(0, "127.0.0.1", () => {
			const { port } = s.address();
			s.close(() => ok(port));
		});
	});
}

export async function startRustServer({ build = true } = {}) {
	if (build && !process.env.TANDEM_BIN) execFileSync("cargo", ["build", "--release", "-q"], { cwd: SERVER, stdio: "inherit" });
	const data = await mkdtemp(join(tmpdir(), "tandem-srv-"));
	const cli = (...args) => execFileSync(BIN, ["--data", data, ...args], { encoding: "utf8" }).trim();
	cli("space", "add", "test", "Test");
	const tokens = {};
	for (const [u, role] of [["alice", "owner"], ["bob", "write"], ["carol", "write"], ["reader", "read"]]) {
		cli("user", "add", u, u[0].toUpperCase() + u.slice(1));
		cli("space", "member", "test", u, role);
		tokens[u] = cli("token", "issue", u, "e2e");
	}
	const port = await freePort();
	const log = [];
	const url = `http://127.0.0.1:${port}`;
	let proc;
	const up = async () => {
		proc = spawn(BIN, ["--data", data, "serve", "--listen", `127.0.0.1:${port}`], {
			env: { ...process.env, RUST_LOG: process.env.RUST_LOG ?? "tandem_server=info" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		proc.stdout.on("data", (d) => log.push(String(d)));
		proc.stderr.on("data", (d) => log.push(String(d)));
		for (let i = 0; i < 100; i++) {
			try {
				if ((await fetch(`${url}/health`)).ok) break;
			} catch {}
			await sleep(50);
		}
	};
	const down = async () => {
		if (!proc || proc.exitCode !== null) return;
		proc.kill("SIGTERM");
		await new Promise((ok) => proc.once("exit", ok));
	};
	await up();
	return {
		stop: down,
		start: up,
		kind: "rust",
		url,
		space: "test",
		tokens,
		data,
		log,
		get pid() {
			return proc.pid;
		},
		cli,
		rssKib: async () => {
			const s = await (await import("node:fs/promises")).readFile(`/proc/${proc.pid}/status`, "utf8");
			return Number(/VmRSS:\s+(\d+)/.exec(s)[1]);
		},
		close: async () => {
			await down();
			if (!process.env.KEEP) await rm(data, { recursive: true, force: true });
		},
	};
}
