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

// ── Music search + stream via YouTube scrape ──────────────────────────
const YT_HEADERS = {
	"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
	"Accept-Language": "en-US,en;q=0.9",
	"Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
};

// Search: scrape YouTube search results page for video metadata
fastify.get("/api/invidious/search", async (request, reply) => {
	try {
		const q = (request.query.q || "") + " lyrics";
		const url = "https://www.youtube.com/results?search_query=" + encodeURIComponent(q) + "&sp=EgIQAQ%3D%3D"; // music filter
		const res = await fetch(url, { headers: YT_HEADERS, signal: AbortSignal.timeout(8000) });
		const html = await res.text();
		// Extract ytInitialData JSON
		const match = html.match(/var ytInitialData = ({.+?});<\/script>/s) ||
		              html.match(/ytInitialData = ({.+?});/s);
		if (!match) throw new Error("no ytInitialData");
		const data = JSON.parse(match[1]);
		const contents = data?.contents?.twoColumnSearchResultsRenderer?.primaryContents
			?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents || [];
		const items = contents
			.filter(i => i.videoRenderer)
			.map(i => {
				const v = i.videoRenderer;
				const dur = v.lengthText?.simpleText || "";
				const parts = dur.split(":").map(Number);
				const secs = parts.length === 3 ? parts[0]*3600+parts[1]*60+parts[2] : parts.length === 2 ? parts[0]*60+parts[1] : 0;
				const thumb = v.thumbnail?.thumbnails?.slice(-1)[0]?.url || "";
				return {
					videoId: v.videoId,
					title: v.title?.runs?.[0]?.text || "",
					author: v.ownerText?.runs?.[0]?.text || "",
					lengthSeconds: secs,
					thumb,
				};
			})
			.filter(i => i.videoId && i.lengthSeconds > 0 && i.lengthSeconds < 1200); // skip >20min
		reply.header("content-type", "application/json").send(JSON.stringify(items));
	} catch (err) {
		console.error("[search]", err.message);
		reply.code(502).send(JSON.stringify({ error: err.message }));
	}
});

// Stream: use yt-dlp style innertube API to get audio URL
fastify.get("/api/invidious/streams/:videoId", async (request, reply) => {
	try {
		const { videoId } = request.params;
		if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
			return reply.code(400).send({ error: "invalid videoId" });
		}
		// Use YouTube's own innertube API — no key needed for this endpoint
		const body = JSON.stringify({
			videoId,
			context: {
				client: {
					clientName: "ANDROID",
					clientVersion: "19.09.37",
					androidSdkVersion: 30,
					hl: "en",
					gl: "US",
				},
			},
		});
		const res = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"User-Agent": "com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip",
				"X-YouTube-Client-Name": "3",
				"X-YouTube-Client-Version": "19.09.37",
				"Origin": "https://www.youtube.com",
			},
			body,
			signal: AbortSignal.timeout(10000),
		});
		const json = await res.json();
		const formats = json?.streamingData?.adaptiveFormats || [];
		const audioFormats = formats.filter(f => f.mimeType?.startsWith("audio") && f.url);
		if (!audioFormats.length) throw new Error("no audio formats");
		reply.header("content-type", "application/json").send(JSON.stringify({
			adaptiveFormats: audioFormats,
			formatStreams: [],
		}));
	} catch (err) {
		console.error("[streams]", err.message);
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
