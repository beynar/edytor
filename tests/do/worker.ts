/**
 * The Worker in front of the SHIPPED room (`edytor/cloudflare`, from
 * source): the deployment shape README "Server coordinator" documents.
 *
 * - `GET /health` → `ready`
 * - `/rooms/<name>` (WebSocket upgrade) → `routeDocumentSocket` to the
 *   room's Durable Object (`env.ROOM.getByName(name)`) — the URL shape the
 *   shipped `WebsocketProvider` dials (`serverUrl = ws://host/rooms`).
 * - `POST /rooms/<name>/compact` → `DocumentRoom.compact()` over RPC.
 *
 * TEST-ONLY `authorize`: it trusts the query string (`?user=` — default
 * `anon`, `denied` is refused —, `?replica=`, `?access=read`). A real host
 * verifies a session or token here.
 */
import { DurableObject } from 'cloudflare:workers';
import {
	DocumentRoom,
	attachDocument,
	requestedReplica,
	routeDocumentSocket,
	type AuthorizeDocumentSocket,
	type DocumentRoomEnv,
	type SavedDocument
} from '../../src/lib/cloudflare/index.js';
import { Y } from '../../src/lib/crdt/engine.js';
import { bindCrdt, type JSONDoc } from '../../src/lib/crdt/index.js';

export { DocumentRoom };

export const LOADED: JSONDoc = {
	children: [{ id: 'seed', type: 'paragraph', content: [{ text: 'from onLoad' }] }]
};

/**
 * The extension points under test (rooms named `hooked-*`): `onLoad` seeds
 * `LOADED` as JSON (as a v14 update for `hooked-bytes*`, nothing for
 * `hooked-empty*`); `onSave` mirrors into a `mirror` table.
 */
export class HookedRoom extends DocumentRoom<Env> {
	protected override async onLoad() {
		const name = this.ctx.id.name ?? '';
		if (name.startsWith('hooked-empty')) return undefined;
		if (!name.startsWith('hooked-bytes')) return LOADED;
		const crdt = bindCrdt(Y);
		const doc = crdt.createDoc();
		const facade = crdt.doc.create(doc as never);
		facade.seed(LOADED.children);
		facade.dispose();
		return Y.encodeStateAsUpdate(doc);
	}

	protected override async onSave({ value, update }: SavedDocument) {
		this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS mirror (json TEXT, size INTEGER)');
		this.ctx.storage.sql.exec(
			'INSERT INTO mirror VALUES (?, ?)',
			JSON.stringify(value),
			update.length
		);
	}
}

/** Any Durable Object: `attachDocument` installs every handler (rooms `plain-*`). */
export class PlainObject extends DurableObject<Env> {
	document = attachDocument(this, { onLoad: () => LOADED });
}

/**
 * A Durable Object with its own fetch, sockets and message handler beside
 * the document (rooms `host-*`; `/echo/<name>` opens one of its own sockets).
 */
export class HostObject extends DurableObject<Env> {
	document = attachDocument(this, {
		onLoad: () => LOADED,
		onSave: ({ value }) => {
			this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS mirror (json TEXT)');
			this.ctx.storage.sql.exec('INSERT INTO mirror VALUES (?)', JSON.stringify(value));
		}
	});

	async fetch(request: Request): Promise<Response> {
		if (new URL(request.url).pathname.startsWith('/echo/')) {
			const [client, server] = Object.values(new WebSocketPair());
			this.ctx.acceptWebSocket(server);
			return new Response(null, { status: 101, webSocket: client });
		}
		return this.document.fetch(request);
	}

	webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
		if (!this.document.webSocketMessage(ws, message)) ws.send(`echo:${String(message)}`);
	}
}

export type Env = DocumentRoomEnv & {
	ROOM: DurableObjectNamespace<DocumentRoom>;
	HOOKED: DurableObjectNamespace<HookedRoom>;
	PLAIN: DurableObjectNamespace<PlainObject>;
	HOST: DurableObjectNamespace<HostObject>;
};

export const ROOM_ROUTE = /^\/rooms\/([^/]+)(\/compact)?\/?$/;

export const authorizeFromQuery: AuthorizeDocumentSocket = (request) => {
	const query = new URL(request.url).searchParams;
	const userId = query.get('user') ?? 'anon';
	if (userId === 'denied') return null;
	return {
		userId,
		replica: requestedReplica(request),
		readOnly: query.get('access') === 'read'
	};
};

export const routeRoom = async (request: Request, env: Env): Promise<Response> => {
	const url = new URL(request.url);
	if (url.pathname === '/health') return new Response('ready');
	if (url.pathname.startsWith('/echo/')) {
		return env.HOST.getByName(url.pathname.slice('/echo/'.length)).fetch(request);
	}
	const match = ROOM_ROUTE.exec(url.pathname);
	if (!match) return new Response('not found', { status: 404 });
	const name = decodeURIComponent(match[1]);
	if (match[2]) {
		if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
		return Response.json(await env.ROOM.getByName(name).compact());
	}
	if (name.startsWith('hooked-')) {
		return routeDocumentSocket(request, env.HOOKED, name, authorizeFromQuery);
	}
	if (name.startsWith('plain-')) {
		return routeDocumentSocket(request, env.PLAIN, name, authorizeFromQuery);
	}
	if (name.startsWith('host-')) {
		return routeDocumentSocket(request, env.HOST, name, authorizeFromQuery);
	}
	return routeDocumentSocket(request, env.ROOM, name, authorizeFromQuery);
};

export default {
	fetch: (request: Request, env: Env) => routeRoom(request, env)
} satisfies ExportedHandler<Env>;
