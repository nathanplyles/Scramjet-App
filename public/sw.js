importScripts("/scram/scramjet.all.js");

const { ScramjetServiceWorker } = $scramjetLoadWorker();
const scramjet = new ScramjetServiceWorker();

self.addEventListener("install", (event) => {
	self.skipWaiting();
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		caches.keys().then((keys) =>
			Promise.all(keys.map((key) => caches.delete(key)))
		).then(() => self.clients.claim())
	);
});

async function handleRequest(event) {
	await scramjet.loadConfig();

	const url = event.request.url;
	if (
		url.includes("youtube.com/iframe_api") ||
		url.includes("ytimg.com") ||
		url.includes("youtube.com/embed") ||
		url.includes("cdn.jsdelivr.net") ||
		url.includes("googlevideo.com") ||
		url.includes("googleusercontent.com") ||
		url.startsWith(self.location.origin + "/api/")
	) {
		return fetch(event.request);
	}

	if (scramjet.route(event)) {
		return scramjet.fetch(event);
	}
	return fetch(event.request);
}

self.addEventListener("fetch", (event) => {
	event.respondWith(handleRequest(event));
});
