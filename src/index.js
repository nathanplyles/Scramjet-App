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

// ── Last.fm proxy ──────────────────────────────────────────────────────
fastify.get("/api/lastfm", async (request, reply) => {
	const key = process.env.LASTFM_API_KEY;
	if (!key) return reply.code(503).send({ error: "LASTFM_API_KEY not set" });
	try {
		const qs = request.raw.url.slice("/api/lastfm?".length);
		const url = "https://ws.audioscrobbler.com/2.0/?" + qs + "&api_key=" + key + "&format=json";
		const res = await fetch(url);
		const text = await res.text();
		reply.code(res.status).header("content-type", "application/json").send(text);
	} catch (err) {
		reply.code(502).send(JSON.stringify({ error: err.message }));
	}
});

// ── iTunes proxy ───────────────────────────────────────────────────────
fastify.get("/api/itunes", async (request, reply) => {
	try {
		const qs = request.raw.url.slice("/api/itunes?".length);
		const res = await fetch("https://itunes.apple.com/search?" + qs, {
			headers: {
				"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
				"Accept": "application/json",
				"Accept-Language": "en-US,en;q=0.9",
			}
		});
		const text = await res.text();
		reply.code(res.status).header("content-type", "application/json").send(text);
	} catch (err) {
		reply.code(502).send(JSON.stringify({ error: err.message }));
	}
});

// ── YouTube search ─────────────────────────────────────────────────────
fastify.get("/api/ytSearch", async (request, reply) => {
	try {
		const q = request.query.q || "";
		const res = await fetch("https://www.youtube.com/results?search_query=" + encodeURIComponent(q), {
			headers: {
				"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
				"Accept-Language": "en-US,en;q=0.9",
			},
			signal: AbortSignal.timeout(8000),
		});
		const html = await res.text();
		const m = html.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
		reply.send({ videoId: m ? m[1] : null });
	} catch (err) {
		reply.code(502).send({ videoId: null });
	}
});

// ── YouTube audio via Piped API ───────────────────────────────────────
// Piped is an open-source YouTube frontend with its own proxy network.
// Audio URLs are already proxied through Piped's servers — no IP issues.

const _urlCache = new Map();

const PIPED_INSTANCES = [
	"https://pipedapi.kavin.rocks",
	"https://piped-api.garudalinux.org",
	"https://api.piped.yt",
	"https://pipedapi.adminforge.de",
	"https://piped-api.cateran.social",
];

async function pipedGetAudio(videoId) {
	const cached = _urlCache.get(videoId);
	if (cached && cached.expires > Date.now()) {
		console.log(`[piped] cache hit for ${videoId}`);
		return cached;
	}

	let lastErr;
	for (const instance of PIPED_INSTANCES) {
		try {
			console.log(`[piped] trying ${instance}`);
			const res = await fetch(`${instance}/streams/${videoId}`, {
				headers: { "User-Agent": "Mozilla/5.0" },
				signal: AbortSignal.timeout(8000),
			});
			if (!res.ok) { console.log(`[piped] ${instance} returned ${res.status}`); continue; }
			const data = await res.json();
			if (data.error) { console.log(`[piped] ${instance} error: ${data.error}`); continue; }

			const audioStreams = (data.audioStreams || [])
				.filter(s => s.url && !s.videoOnly)
				.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

			if (!audioStreams.length) { console.log(`[piped] ${instance} no audio streams`); continue; }

			const best = audioStreams[0];
			console.log(`[piped] ✓ ${instance} quality=${best.quality} mime=${best.mimeType}`);

			const result = {
				url: best.url,
				mime: best.mimeType || "audio/mp4",
				expires: Date.now() + 5 * 60 * 60 * 1000,
			};
			_urlCache.set(videoId, result);
			return result;
		} catch(e) {
			console.log(`[piped] ${instance} failed: ${e.message}`);
			lastErr = e;
		}
	}
	throw lastErr || new Error("all Piped instances failed");
}

fastify.get("/api/ytAudio/:videoId", async (request, reply) => {
	const { videoId } = request.params;
	if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
		return reply.code(400).send({ error: "invalid videoId" });
	}
	try {
		const { url: cdnUrl, mime } = await pipedGetAudio(videoId);
		const rangeHeader = request.headers["range"];
		const cdnRes = await fetch(cdnUrl, {
			headers: {
				"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
				"Accept": "*/*",
				"Accept-Encoding": "identity",
				"Origin": "https://www.youtube.com",
				"Referer": "https://www.youtube.com/",
				...(rangeHeader ? { "Range": rangeHeader } : {}),
			},
			signal: AbortSignal.timeout(30000),
		});

		if (!cdnRes.ok && cdnRes.status !== 206) {
			// URL may have expired — clear cache and return error
			_urlCache.delete(videoId);
			return reply.code(502).send({ error: "CDN " + cdnRes.status });
		}

		const ct = cdnRes.headers.get("content-type") || mime;
		const cl = cdnRes.headers.get("content-length");
		const cr = cdnRes.headers.get("content-range");
		reply.code(cdnRes.status)
			.header("content-type", ct)
			.header("accept-ranges", "bytes")
			.header("cache-control", "no-cache")
			.header("cross-origin-resource-policy", "same-origin");
		if (cl) reply.header("content-length", cl);
		if (cr) reply.header("content-range", cr);
		return reply.send(cdnRes.body);
	} catch (err) {
		console.error("[ytAudio] error:", err.message);
		reply.code(502).send({ error: err.message });
	}
});

fastify.get("/api/ytProxy", async (request, reply) => {
	reply.code(410).send({ error: "deprecated" });
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

// ── LRCLIB lyrics proxy ────────────────────────────────────────────────
fastify.get("/api/lyrics", async (request, reply) => {
	try {
		const { track, artist, album, duration } = request.query;
		if (!track) return reply.code(400).send({ error: "track is required" });
		const params = new URLSearchParams({ track_name: track });
		if (artist) params.set("artist_name", artist);
		if (album) params.set("album_name", album);
		if (duration) params.set("duration", duration);
		const res = await fetch("https://lrclib.net/api/get?" + params.toString(), {
			headers: { "User-Agent": "oblivion/1.0 (https://github.com/nathanplyles/oblivion)" },
			signal: AbortSignal.timeout(8000),
		});
		if (res.status === 404) return reply.code(404).send({ error: "not found" });
		const data = await res.json();
		reply.code(res.status).send({
			synced: data.syncedLyrics || null,
			plain: data.plainLyrics || null,
			instrumental: data.instrumental || false,
		});
	} catch (err) {
		reply.code(502).send({ error: err.message });
	}
});

// ── AI proxy (Cerebras → Groq → Gemini Flash-Lite fallback chain) ──────
const AI_PROVIDERS = [
	{
		name: "cerebras",
		envKey: "CEREBRAS_API_KEY",
		url: "https://api.cerebras.ai/v1/chat/completions",
		model: "llama-3.3-70b",
	},
	{
		name: "groq",
		envKey: "GROQ_API_KEY",
		url: "https://api.groq.com/openai/v1/chat/completions",
		model: "llama-3.3-70b-versatile",
	},
	{
		name: "gemini",
		envKey: "GEMINI_API_KEY",
		url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
		model: "gemini-2.0-flash-lite",
	},
];

async function tryAIProvider(provider, messages, maxTokens) {
	const key = process.env[provider.envKey];
	if (!key) throw new Error("no key configured");
	const res = await fetch(provider.url, {
		method: "POST",
		headers: {
			"Authorization": "Bearer " + key,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ model: provider.model, messages, max_tokens: maxTokens, stream: false }),
		signal: AbortSignal.timeout(20000),
	});
	if (res.status === 429 || res.status === 503) throw new Error("quota/" + res.status);
	if (!res.ok) throw new Error("http/" + res.status);
	const data = await res.json();
	const content = data?.choices?.[0]?.message?.content;
	if (!content) throw new Error("empty response");
	return { content, provider: provider.name };
}

fastify.post("/api/ai", async (request, reply) => {
	try {
		const body = request.body;
		if (!body || !body.messages) return reply.code(400).send({ error: "messages required" });
		const maxTokens = Math.min(body.max_tokens || 1024, 4096);
		let lastErr;
		for (const provider of AI_PROVIDERS) {
			try {
				console.log(`[ai] trying ${provider.name}...`);
				const result = await tryAIProvider(provider, body.messages, maxTokens);
				console.log(`[ai] success via ${provider.name}`);
				return reply.send({ content: result.content, provider: result.provider });
			} catch (e) {
				console.log(`[ai] ${provider.name} failed: ${e.message}`);
				lastErr = e;
			}
		}
		reply.code(502).send({ error: "all AI providers failed", detail: lastErr?.message });
	} catch (err) {
		reply.code(502).send({ error: err.message });
	}
});

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
