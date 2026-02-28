importScripts("/scram/scramjet.all.js");

const { ScramjetServiceWorker } = $scramjetLoadWorker();
const scramjet = new ScramjetServiceWorker();

async function handleRequest(event) {
	await scramjet.loadConfig();

	// Don't intercept YouTube iframe API or other trusted external scripts
	const url = event.request.url;
	if (
		url.includes("youtube.com/iframe_api") ||
		url.includes("ytimg.com") ||
		url.includes("youtube.com/embed") ||
		url.includes("cdn.jsdelivr.net") ||
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
