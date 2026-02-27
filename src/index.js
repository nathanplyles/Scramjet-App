import { createServer } from "node:http";
import { fileURLToPath } from "url";
import { hostname } from "node:os";
import { server as wisp, logging } from "@mercuryworkshop/wisp-js/server";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";

import { scramjetPath } from "@mercuryworkshop/scramjet/path";
import { libcurlPath } from "@mercuryworkshop/libcurl-transport";
import { baremuxPath } from "@mercuryworkshop/bare-mux/node";

const publicPath = fileURLToPath(new URL("../public/", import.meta.url));

logging.set_level(logging.NONE);
Object.assign(wisp.options, {
	allow_udp_streams: false,
	hostname_blacklist: [/example\.com/],
	dns_servers: ["1.1.1.3", "1.0.0.3"],
});

const fastify = Fastify({
	serverFactory: (handler) => {
		return createServer()
			.on("request", (req, res) => {
				res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
				res.setHeader("Cross-Origin-Embedder-Policy", "credentialless");
				handler(req, res);
			})
			.on("upgrade", (req, socket, head) => {
				if (req.url.endsWith("/wisp/")) wisp.routeRequest(req, socket, head);
				else socket.end();
			});
	},
});

fastify.register(fastifyStatic, { root: publicPath, decorateReply: true });
fastify.register(fastifyStatic, { root: scramjetPath, prefix: "/scram/", decorateReply: false });
fastify.register(fastifyStatic, { root: libcurlPath, prefix: "/libcurl/", decorateReply: false });
fastify.register(fastifyStatic, { root: baremuxPath, prefix: "/baremux/", decorateReply: false });

// ── Saavn search/stream proxy ──────────────────────────────────────────
// Proxies saavn.dev so the browser doesn't hit cross-origin issues.
fastify.get("/api/saavn", async (request, reply) => {
	try {
		const qs = new URLSearchParams(request.query).toString();
		const url = "https://saavn.dev/api/search/songs?" + qs;
		const res = await fetch(url, {
			headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" },
		});
		const text = await res.text();
		reply.code(res.status).header("content-type", "application/json").send(text);
	} catch (err) {
		reply.code(502).send(JSON.stringify({ error: err.message }));
	}
});

// ── iTunes proxy (album art 600x600) ──────────────────────────────────
fastify.get("/api/itunes", async (request, reply) => {
	try {
		const qs = request.raw.url.slice("/api/itunes?".length);
		const url = "https://itunes.apple.com/search?" + qs;
		const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
		const text = await res.text();
		reply.code(res.status).header("content-type", "application/json").send(text);
	} catch (err) {
		reply.code(502).send(JSON.stringify({ error: err.message }));
	}
});

// ── Image proxy ────────────────────────────────────────────────────────
fastify.get("/api/img/*", async (request, reply) => {
	try {
		const imgPath = request.raw.url.slice("/api/img/".length);
		const url = "https://" + imgPath;
		const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
		if (!res.ok) return reply.code(res.status).send();
		const buf = Buffer.from(await res.arrayBuffer());
		const ct = res.headers.get("content-type") || "image/jpeg";
		reply
			.header("content-type", ct)
			.header("cache-control", "public, max-age=86400")
			.header("cross-origin-resource-policy", "cross-origin")
			.send(buf);
	} catch (err) {
		reply.code(502).send();
	}
});

// ──────────────────────────────────────────────────────────────────────

fastify.setNotFoundHandler((req, reply) => {
	return reply.code(404).type("text/html").sendFile("404.html");
});

fastify.server.on("listening", () => {
	const address = fastify.server.address();
	console.log("Listening on:");
	console.log(`\thttp://localhost:${address.port}`);
	console.log(`\thttp://${hostname()}:${address.port}`);
	console.log(`\thttp://${address.family === "IPv6" ? `[${address.address}]` : address.address}:${address.port}`);
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
function shutdown() { console.log("SIGTERM signal received: closing HTTP server"); fastify.close(); process.exit(0); }

let port = parseInt(process.env.PORT || "");
if (isNaN(port)) port = 8080;
fastify.listen({ port, host: "0.0.0.0" });
