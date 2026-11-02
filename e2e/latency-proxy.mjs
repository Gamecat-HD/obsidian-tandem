// TCP-Proxy mit künstlicher Verzögerung (simuliert Internet/Cloudflare zwischen Client und Server).
import { createServer, connect } from "node:net";

export function latencyProxy(target, delayMs) {
	const { hostname, port } = new URL(target);
	const sockets = new Set();
	const srv = createServer((c) => {
		const s = connect(Number(port), hostname);
		sockets.add(c).add(s);
		const pipe = (from, to) => from.on("data", (d) => setTimeout(() => to.writable && to.write(d), delayMs));
		pipe(c, s);
		pipe(s, c);
		const end = () => {
			c.destroy();
			s.destroy();
		};
		c.on("close", end).on("error", end);
		s.on("close", end).on("error", end);
	});
	return new Promise((ok) =>
		srv.listen(0, "127.0.0.1", () =>
			ok({
				url: `http://127.0.0.1:${srv.address().port}`,
				close: () => new Promise((r) => {
					for (const x of sockets) x.destroy();
					srv.close(() => r());
				}),
			}),
		),
	);
}
