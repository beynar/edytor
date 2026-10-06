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
	routeDocumentHistory,
	routeDocumentSocket,
	type HistoryOptions,
	type KVLike,
	type AuthorizeDocumentSocket,
	type DocumentRoomEnv,
	type FrameValidation,
	type RoomLogEntry,
	type ValidatedBlock,
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
// The site's demo room (site/room): its history in the `HISTORY` KV binding.
export { DocumentRoom as DemoRoom } from '../../site/room/src/worker';

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
	/** Its log entries (H14), kept instead of printed. */
	readonly logged: RoomLogEntry[] = [];
	protected override log(entry: RoomLogEntry) {
		this.logged.push(entry);
	}
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, {
			...env,
			EDYTOR_MAX_DOCUMENT_BYTES: '20000',
			EDYTOR_MAX_INBOUND_FRAME_BYTES: '30000',
			EDYTOR_MAX_UPDATES_PER_SECOND: '2'
		});
	}
}

/**
 * Per-block locks through `validate` (rooms `locked-*`): a block whose
 * `data.lockedBy` names a user is that user's alone. A frame touching it
 * from anyone else — its text, data, type, place or its deletion — is
 * denied, and so is one locking a block for someone else; the room then
 * writes the frame's inverse.
 */
export class LockedRoom extends DocumentRoom<Env> {
	/** Its log entries (H14), kept instead of printed. */
	readonly logged: RoomLogEntry[] = [];
	protected override log(entry: RoomLogEntry) {
		this.logged.push(entry);
	}
	protected override validate({ user, touched, before, after }: FrameValidation) {
		const owner = (block: ValidatedBlock | null) => block?.data.lockedBy as string | undefined;
		return touched.every((id) => {
			const was = owner(before(id));
			const now = owner(after(id));
			return (was === undefined || was === user) && (now === undefined || now === user);
		});
	}
}

/**
 * An in-memory KV namespace (the `KVLike` subset) over the object's own
 * SQLite storage, so it survives an eviction like the real one: KV's
 * limits (512-byte keys, 25 MiB values, 1,024-byte metadata, a TTL of at
 * least 60 s) are enforced and expiry follows the room's clock. A row in
 * `fake_kv_fail` makes the next puts throw.
 */
export class FakeKV implements KVLike {
	constructor(
		private readonly sql: SqlStorage,
		private readonly now: () => number
	) {
		sql.exec(
			'CREATE TABLE IF NOT EXISTS fake_kv (key TEXT PRIMARY KEY, value BLOB, expires INTEGER, metadata TEXT, ttl INTEGER)'
		);
		sql.exec('CREATE TABLE IF NOT EXISTS fake_kv_fail (n INTEGER)');
	}

	async put(
		key: string,
		value: ArrayBuffer | ArrayBufferView | string,
		options: { expirationTtl?: number; metadata?: unknown } = {}
	) {
		const failing = this.sql.exec<{ n: number }>('SELECT n FROM fake_kv_fail').toArray()[0];
		if (failing && failing.n > 0) {
			this.sql.exec('UPDATE fake_kv_fail SET n = n - 1');
			throw new Error('KV put failed (injected)');
		}
		const bytes =
			typeof value === 'string'
				? new TextEncoder().encode(value)
				: value instanceof ArrayBuffer
					? new Uint8Array(value)
					: new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
		if (new TextEncoder().encode(key).length > 512) throw new Error('KV key too long');
		if (bytes.length > 25 * 1024 * 1024) throw new Error('KV value too large');
		const metadata = options.metadata === undefined ? null : JSON.stringify(options.metadata);
		if (metadata !== null && new TextEncoder().encode(metadata).length > 1024) {
			throw new Error('KV metadata too large');
		}
		const ttl = options.expirationTtl;
		if (ttl !== undefined && ttl < 60) throw new Error('KV expirationTtl below 60 s');
		this.sql.exec(
			'INSERT OR REPLACE INTO fake_kv (key, value, expires, metadata, ttl) VALUES (?, ?, ?, ?, ?)',
			key,
			bytes,
			ttl === undefined ? null : this.now() + ttl * 1000,
			metadata,
			ttl ?? null
		);
	}

	private live() {
		return this.sql
			.exec<{
				key: string;
				value: ArrayBuffer;
				expires: number | null;
				metadata: string | null;
			}>('SELECT key, value, expires, metadata FROM fake_kv ORDER BY key')
			.toArray()
			.filter((row) => row.expires === null || row.expires > this.now());
	}

	async get(key: string, _type: 'arrayBuffer'): Promise<ArrayBuffer | null> {
		const row = this.live().find((r) => r.key === key);
		return row ? row.value.slice(0) : null;
	}

	async list(options: { prefix?: string; cursor?: string; limit?: number } = {}) {
		const limit = options.limit ?? 2;
		const all = this.live().filter((r) => r.key.startsWith(options.prefix ?? ''));
		const from = options.cursor ? Number(options.cursor) : 0;
		const page = all.slice(from, from + limit);
		const complete = from + limit >= all.length;
		return {
			keys: page.map((r) => ({
				name: r.key,
				metadata: r.metadata === null ? undefined : JSON.parse(r.metadata)
			})),
			list_complete: complete,
			cursor: complete ? undefined : String(from + limit)
		};
	}
}

/** The fake clock of a `timed-*` room (`test_clock`), or the real one. */
export const fakeNow = (sql: SqlStorage): number => {
	sql.exec('CREATE TABLE IF NOT EXISTS test_clock (now INTEGER)');
	return sql.exec<{ now: number }>('SELECT now FROM test_clock').toArray()[0]?.now ?? Date.now();
};

/** Set the fake clock of a `timed-*` room. */
export const setNow = (sql: SqlStorage, now: number) => {
	sql.exec('CREATE TABLE IF NOT EXISTS test_clock (now INTEGER)');
	sql.exec('DELETE FROM test_clock');
	sql.exec('INSERT INTO test_clock VALUES (?)', now);
};

/** The time zone a `timed-*` room's name asks for. */
const zoneOf = (name: string): string =>
	name.includes('-paris-')
		? 'Europe/Paris'
		: name.includes('-ny-')
			? 'America/New_York'
			: name.includes('-kolkata-')
				? 'Asia/Kolkata'
				: name.includes('-badzone-')
					? 'Mars/Olympus_Mons'
					: 'UTC';

/**
 * Rooms with a fake clock (`timed-*`, Phase 3): history in a {@link FakeKV}
 * (none for `timed-nohistory-*`), its time zone by name (`-paris-`, `-ny-`,
 * `-kolkata-`, else UTC), a 600-byte value cap for `timed-cap-*`, purge
 * after 30 days (the retention). Log entries are kept.
 */
export class TimedRoom extends DocumentRoom<Env> {
	readonly logged: RoomLogEntry[] = [];
	protected override log(entry: RoomLogEntry) {
		this.logged.push(entry);
	}
	protected override now(): number {
		return fakeNow(this.ctx.storage.sql);
	}
	protected override history(): HistoryOptions | undefined {
		const name = this.ctx.id.name ?? '';
		if (name.startsWith('timed-nohistory')) return undefined;
		return {
			store: new FakeKV(this.ctx.storage.sql, () => this.now()),
			timeZone: zoneOf(name),
			maxValueBytes: name.startsWith('timed-cap') ? 600 : undefined
		};
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
	LOCKED: DurableObjectNamespace<LockedRoom>;
	TIMED: DurableObjectNamespace<TimedRoom>;
	DEMO: DurableObjectNamespace<DocumentRoom>;
	HISTORY: KVNamespace;
};

export const ROOM_ROUTE = /^\/rooms\/([^/]+)(\/compact)?\/?$/;
/** `/history/<name>`: the room's version history (`routeDocumentHistory`). */
export const HISTORY_ROUTE = /^\/history\/([^/]+)\/?$/;

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
	const history = HISTORY_ROUTE.exec(url.pathname);
	if (history) {
		const name = roomOf(history[1]);
		if (name === null) return new Response('invalid document id', { status: 400 });
		return routeDocumentHistory(
			request,
			name.startsWith('timed-') ? env.TIMED : env.ROOM,
			name,
			authorizeFromQuery
		);
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
	if (name.startsWith('timed-')) {
		return routeDocumentSocket(request, env.TIMED, name, authorizeFromQuery);
	}
	if (name.startsWith('locked-')) {
		return routeDocumentSocket(request, env.LOCKED, name, authorizeFromQuery);
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
