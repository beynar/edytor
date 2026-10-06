/**
 * The Worker in front of the SHIPPED room (`edytor/cloudflare`, from
 * source): the deployment shape the site's server quick start documents.
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
	closedSocket,
	requestedReplica,
	routeDocumentSocket,
	type AuthorizeDocumentSocket,
	type DocumentRoomEnv,
	type LoadedDocument,
	type SavedDocument
} from '../../src/lib/cloudflare/index.js';
import { Y } from '../../src/lib/crdt/engine.js';
import {
	bindCrdt,
	defaultSemantics,
	type DocumentSemanticsConfig,
	type JSONDoc
} from '../../src/lib/crdt/index.js';

export { DocumentRoom };

export const LOADED: JSONDoc = {
	children: [{ id: 'seed', type: 'paragraph', content: [{ text: 'from onLoad' }] }]
};

/** The newest `onSave` mirror (`hooked-restore*` rooms load it back), or `undefined`. */
const lastSaved = (sql: SqlStorage) => {
	sql.exec(
		'CREATE TABLE IF NOT EXISTS mirror (json TEXT, size INTEGER, bytes BLOB, replicas TEXT)'
	);
	const row = sql
		.exec<{
			bytes: ArrayBuffer;
			replicas: string;
		}>('SELECT bytes, replicas FROM mirror ORDER BY rowid DESC LIMIT 1')
		.toArray()[0];
	return row && { update: new Uint8Array(row.bytes), replicas: JSON.parse(row.replicas) };
};

/**
 * The extension points under test (rooms named `hooked-*`): `onLoad` seeds
 * `LOADED` as JSON; by name prefix it instead returns a v14 update
 * (`hooked-bytes*`), nothing (`hooked-empty*`), throws at its first call
 * (`hooked-flaky*`), returns undecodable bytes (`hooked-badbytes*`) or a
 * refused JSON shape (`hooked-badjson*`), or loads the last `onSave` back —
 * `{ update, replicas }` (`hooked-restore*`) or the bare update
 * (`hooked-restore-bare*`), or nothing at its first call and `LOADED` with
 * a registry naming client id 7777 unowned after (`hooked-late*`), or
 * `LOADED` with document data (`hooked-data*`). Each call
 * is counted in `load_calls`. `onSave` mirrors into a `mirror` table.
 */
export class HookedRoom extends DocumentRoom<Env> {
	protected override async onLoad(): Promise<LoadedDocument | null | undefined> {
		const name = this.ctx.id.name ?? '';
		const sql = this.ctx.storage.sql;
		sql.exec('CREATE TABLE IF NOT EXISTS load_calls (at INTEGER)');
		sql.exec('INSERT INTO load_calls VALUES (?)', Date.now());
		const calls = sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM load_calls').one().n;
		if (name.startsWith('hooked-empty')) return undefined;
		if (name.startsWith('hooked-flaky') && calls === 1) throw new Error('store unavailable');
		if (name.startsWith('hooked-late') && calls === 1) return undefined;
		if (name.startsWith('hooked-badbytes')) return Uint8Array.of(0xff, 0xff, 0xff, 0x01);
		if (name.startsWith('hooked-badjson')) return { children: 'x' } as unknown as JSONDoc;
		if (name.startsWith('hooked-data'))
			return { ...LOADED, data: { title: 'Loaded', meta: { v: 1 } } };
		if (name.startsWith('hooked-restore')) {
			const saved = lastSaved(sql);
			if (saved) return name.startsWith('hooked-restore-bare') ? saved.update : saved;
		}
		if (!name.startsWith('hooked-bytes') && !name.startsWith('hooked-late')) return LOADED;
		const crdt = bindCrdt(Y);
		const doc = crdt.createDoc();
		const facade = crdt.doc.create(doc as never);
		facade.seed(LOADED.children);
		facade.dispose();
		const update = Y.encodeStateAsUpdate(doc);
		return name.startsWith('hooked-late')
			? { update, replicas: [{ replica: 7777, user: '' }] }
			: update;
	}

	protected override async onSave({ value, update, replicas }: SavedDocument) {
		lastSaved(this.ctx.storage.sql);
		this.ctx.storage.sql.exec(
			'INSERT INTO mirror VALUES (?, ?, ?, ?)',
			JSON.stringify(value),
			update.length,
			update,
			JSON.stringify(replicas)
		);
	}
}

/**
 * `semantics()` returns a subclass field (rooms `fields-*`): the room must
 * read it once the subclass's fields exist, not in its own constructor.
 */
export class FieldRoom extends DocumentRoom<Env> {
	private readonly roles: DocumentSemanticsConfig = { ...defaultSemantics, defaultType: 'heading' };
	protected override semantics(): DocumentSemanticsConfig {
		return this.roles;
	}
}

/**
 * A room with low quotas (rooms `quota-*`), set the way a host sets them:
 * the `EDYTOR_MAX_*` vars.
 */
export class QuotaRoom extends DocumentRoom<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, {
			...env,
			EDYTOR_MAX_DOCUMENT_BYTES: '20000',
			EDYTOR_MAX_INBOUND_FRAME_BYTES: '30000',
			EDYTOR_MAX_UPDATES_PER_SECOND: '2'
		});
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
	FIELDS: DurableObjectNamespace<FieldRoom>;
	QUOTA: DurableObjectNamespace<QuotaRoom>;
};

export const ROOM_ROUTE = /^\/rooms\/([^/]+)(\/compact)?\/?$/;

export const authorizeFromQuery: AuthorizeDocumentSocket = (request) => {
	const query = new URL(request.url).searchParams;
	const userId = query.get('user') ?? 'anon';
	if (userId === 'denied') return null;
	if (userId === 'expired') return { expired: true };
	return {
		userId,
		replica: requestedReplica(request),
		readOnly: query.get('access') === 'read'
	};
};

/** The room id the provider encoded into the path, or `null` when it does not decode. */
const roomOf = (encoded: string): string | null => {
	try {
		return decodeURIComponent(encoded);
	} catch {
		return null;
	}
};

export const routeRoom = async (request: Request, env: Env): Promise<Response> => {
	const url = new URL(request.url);
	if (url.pathname === '/health') return new Response('ready');
	if (url.pathname.startsWith('/echo/')) {
		return env.HOST.getByName(url.pathname.slice('/echo/'.length)).fetch(request);
	}
	const match = ROOM_ROUTE.exec(url.pathname);
	if (!match) return new Response('not found', { status: 404 });
	const name = roomOf(match[1]);
	if (name === null) return closedSocket(4400, 'invalid document id');
	if (match[2]) {
		if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
		return Response.json(await env.ROOM.getByName(name).compact());
	}
	if (name.startsWith('hooked-')) {
		return routeDocumentSocket(request, env.HOOKED, name, authorizeFromQuery);
	}
	if (name.startsWith('quota-')) {
		return routeDocumentSocket(request, env.QUOTA, name, authorizeFromQuery);
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
