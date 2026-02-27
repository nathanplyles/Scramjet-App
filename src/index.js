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

// ── YouTube audio extraction + stream proxy ────────────────────────────
// Extracts direct audio URL from YouTube using the TV client (most reliable,
// returns unthrottled URLs), then proxies the audio through our server so
// the browser can play it with a plain <audio> element — no iframe needed.

async function getYouTubeAudioUrl(videoId) {
	// Try multiple innertube clients — TV client is most reliable for audio
	// WEB_EMBEDDED client gives browser-playable URLs (no c=ANDROID that gets 403'd)
	const clients = [
		{
			clientName: "WEB_EMBEDDED_PLAYER",
			clientVersion: "2.20240101.09.00",
			clientNameNum: "56",
			userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
			extraHeaders: {
				"Origin": "https://www.youtube.com",
				"Referer": "https://www.youtube.com/embed/" + videoId,
			},
		},
		{
			clientName: "WEB",
			clientVersion: "2.20240101.09.00",
			clientNameNum: "1",
			userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
			extraHeaders: {
				"Origin": "https://www.youtube.com",
				"Referer": "https://www.youtube.com/watch?v=" + videoId,
			},
		},
		{
			clientName: "TVHTML5_SIMPLY_EMBEDDED_PLAYER",
			clientVersion: "2.0",
			clientNameNum: "85",
			userAgent: "Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/6.0 TV Safari/538.1",
			extraHeaders: {
				"Origin": "https://www.youtube.com",
				"Referer": "https://www.youtube.com/",
			},
		},
	];

	for (const client of clients) {
		try {
			const body = {
				videoId,
				context: {
					client: {
						clientName: client.clientName,
						clientVersion: client.clientVersion,
						hl: "en",
						gl: "US",
					},
				},
			};
			const res = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"User-Agent": client.userAgent,
					"X-YouTube-Client-Name": client.clientNameNum,
					"X-YouTube-Client-Version": client.clientVersion,
					...client.extraHeaders,
				},
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(10000),
			});

			if (!res.ok) { console.log(`[yt] ${client.clientName} HTTP ${res.status}`); continue; }

			const data = await res.json();
			const status = data?.playabilityStatus?.status;
			if (status !== "OK") { console.log(`[yt] ${client.clientName} status: ${status}`); continue; }

			const formats = data?.streamingData?.adaptiveFormats || [];
			const audioFormats = formats
				.filter(f => f.mimeType?.startsWith("audio") && f.url)
				.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

			if (audioFormats.length) {
				console.log(`[yt] got audio via ${client.clientName}, bitrate: ${audioFormats[0].bitrate}`);
				return audioFormats[0].url;
			}
			console.log(`[yt] ${client.clientName} no direct URL`);
		} catch (e) {
			console.log(`[yt] ${client.clientName} error: ${e.message}`);
		}
	}
	return null;
}

// Returns the direct audio URL (browser fetches it directly or via proxy)
fastify.get("/api/ytAudio/:videoId", async (request, reply) => {
	const { videoId } = request.params;
	if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
		return reply.code(400).send({ error: "invalid videoId" });
	}
	try {
		const url = await getYouTubeAudioUrl(videoId);
		if (!url) return reply.code(404).send({ error: "no audio stream found" });
		reply.send({ url });
	} catch (err) {
		console.error("[ytAudio]", err.message);
		reply.code(502).send({ error: err.message });
	}
});

// Proxy audio bytes from googlevideo — must use exact same headers YouTube expects
fastify.get("/api/ytProxy", async (request, reply) => {
	const url = request.query.url;
	if (!url || !url.includes("googlevideo.com")) {
		return reply.code(400).send("invalid url");
	}
	try {
		const fetchHeaders = {
			"User-Agent": "com.google.android.youtube/19.30.36 (Linux; U; Android 11) gzip",
			"Origin": "https://www.youtube.com",
			"Referer": "https://www.youtube.com/",
		};
		if (request.headers["range"]) {
			fetchHeaders["Range"] = request.headers["range"];
		}
		const upstream = await fetch(url, {
			headers: fetchHeaders,
			signal: AbortSignal.timeout(30000),
		});
		const ct = upstream.headers.get("content-type") || "audio/mp4";
		const cl = upstream.headers.get("content-length");
		const cr = upstream.headers.get("content-range");
		reply
			.code(upstream.status)
			.header("content-type", ct)
			.header("accept-ranges", "bytes")
			.header("access-control-allow-origin", "*")
			.header("cross-origin-resource-policy", "cross-origin");
		if (cl) reply.header("content-length", cl);
		if (cr) reply.header("content-range", cr);
		// Stream directly without buffering entire file
		reply.send(Buffer.from(await upstream.arrayBuffer()));
	} catch (err) {
		console.error("[ytProxy]", err.message);
		reply.code(502).send();
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
