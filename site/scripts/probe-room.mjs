// Dial a room the way the landing page's live editor does (a WebSocket with
// the docs Origin) and require the close code the room must answer with.
// Usage: node probe-room.mjs <ws url> <origin> <expected close code>
// A refusal at the HTTP upgrade reaches a client as a bare 1006, so only a
// build that accepts and closes (`closedSocket`) passes a 4404 probe.
const [url, origin, expected] = process.argv.slice(2);
const socket = new WebSocket(url, { headers: { Origin: origin } });
const timer = setTimeout(() => fail('no close within 10 s'), 10_000);
socket.addEventListener('close', ({ code }) => {
	if (String(code) !== expected) fail(`closed with ${code}, want ${expected}`);
	clearTimeout(timer);
});
socket.addEventListener('error', () => {});

function fail(reason) {
	console.error(`probe-room: ${url}: ${reason}`);
	process.exit(1);
}
