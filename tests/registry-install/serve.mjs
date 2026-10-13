// A static server for the built registry (`<dir>/r/*.json`), as the docs
// site serves it at https://edytor.dev/r/. usage: node serve.mjs <dir> <port>
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const [dir, port] = process.argv.slice(2);
createServer(async (request, response) => {
	const file = path.join(dir, decodeURIComponent(new URL(request.url, 'http://x').pathname));
	if (!file.startsWith(path.resolve(dir))) return response.writeHead(403).end();
	try {
		const body = await readFile(file);
		response.writeHead(200, { 'content-type': 'application/json' }).end(body);
	} catch {
		response.writeHead(404).end();
	}
}).listen(Number(port), () => console.log(`registry served on http://localhost:${port}/r/`));
