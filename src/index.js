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
				res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
				handler(req, res);
			})
			.on("upgrade", (req, socket, head) => {
				if (req.url.endsWith("/wisp/")) wisp.routeRequest(req, socket, head);
				else socket.end();
			});
	},
});

fastify.register(fastifyStatic, {
	root: publicPath,
	decorateReply: true,
});

fastify.register(fastifyStatic, {
	root: scramjetPath,
	prefix: "/scram/",
	decorateReply: false,
});

fastify.register(fastifyStatic, {
	root: libcurlPath,
	prefix: "/libcurl/",
	decorateReply: false,
});

fastify.register(fastifyStatic, {
	root: baremuxPath,
	prefix: "/baremux/",
	decorateReply: false,
});

// ── Spotify proxy ─────────────────────────────────────────────────────
// All Spotify API calls are routed through the server to avoid COEP
// blocking external fetches in the browser. Credentials never leave
// the server. Token is cached for its full lifetime (~1 hour).
let cachedToken = null;
let cachedTokenExp = 0;

async function getSpotifyToken() {
	const clientId = process.env.SPOTIFY_CLIENT_ID;
	const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
	if (!clientId || !clientSecret) throw new Error("missing credentials");
	if (cachedToken && Date.now() < cachedTokenExp) return cachedToken;

	const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
	const res = await fetch("https://accounts.spotify.com/api/token", {
		method: "POST",
		headers: {
			Authorization: `Basic ${credentials}`,
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: "grant_type=client_credentials",
	});
	if (!res.ok) throw new Error("spotify auth failed: " + await res.text());
	const data = await res.json();
	cachedToken = data.access_token;
	cachedTokenExp = Date.now() + (data.expires_in - 60) * 1000;
	return cachedToken;
}

fastify.get("/api/spotify/*", async (request, reply) => {
	if (!process.env.SPOTIFY_CLIENT_ID) {
		return reply.code(503).send({ error: "Spotify not configured." });
	}
	try {
		const token = await getSpotifyToken();
		const path = request.params["*"];
		const qs = new URLSearchParams(request.query).toString();
		const url = `https://api.spotify.com/v1/${path}${qs ? "?" + qs : ""}`;
		const res = await fetch(url, {
			headers: { Authorization: `Bearer ${token}` },
		});
		const data = await res.json();
		reply.code(res.status).send(data);
	} catch (err) {
		console.error("Spotify proxy error:", err.message);
		reply.code(502).send({ error: err.message });
	}
});
// ──────────────────────────────────────────────────────────────────────

fastify.setNotFoundHandler((res, reply) => {
	return reply.code(404).type("text/html").sendFile("404.html");
});

fastify.server.on("listening", () => {
	const address = fastify.server.address();
	console.log("Listening on:");
	console.log(`\thttp://localhost:${address.port}`);
	console.log(`\thttp://${hostname()}:${address.port}`);
	console.log(
		`\thttp://${
			address.family === "IPv6" ? `[${address.address}]` : address.address
		}:${address.port}`
	);
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function shutdown() {
	console.log("SIGTERM signal received: closing HTTP server");
	fastify.close();
	process.exit(0);
}

let port = parseInt(process.env.PORT || "");
if (isNaN(port)) port = 8080;

fastify.listen({
	port: port,
	host: "0.0.0.0",
});
