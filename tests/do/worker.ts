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
	kvHistory,
	r2History,
	roomHistory,
	type LockOptions,
	type MoveNamespace,
	type HistoryOptions,
	type KVLike,
	type R2BucketLike,
	type AuthorizeDocumentSocket,
	type DocumentRoomEnv,
	type RoomLogEntry,
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
 * A room with its own quotas (rooms `quota-*`), set the way a host sets
 * them: the `EDYTOR_MAX_*` vars. Low by default (2 presence messages a
 * second too); by name, `quota-buffer-*`
 * takes 30,000-byte frames into a 40,000-byte room-wide chunk buffer (a
 * 200,000-byte document, the default rate), and `quota-big-*` raises the
 * document and frame quotas to 64 MiB (an operator's large documents).
 */
export class QuotaRoom extends DocumentRoom<Env> {
	/** Its log entries (H14), kept instead of printed. */
	readonly logged: RoomLogEntry[] = [];
	protected override log(entry: RoomLogEntry) {
		this.logged.push(entry);
	}
	constructor(ctx: DurableObjectState, env: Env) {
		const name = ctx.id.name ?? '';
		super(
			ctx,
			name.startsWith('quota-big-')
				? {
						...env,
						EDYTOR_MAX_DOCUMENT_BYTES: String(64 * 1024 * 1024),
						EDYTOR_MAX_INBOUND_FRAME_BYTES: String(64 * 1024 * 1024)
					}
				: name.startsWith('quota-buffer-')
					? {
							...env,
							EDYTOR_MAX_DOCUMENT_BYTES: '200000',
							EDYTOR_MAX_INBOUND_FRAME_BYTES: '30000',
							EDYTOR_MAX_BUFFERED_BYTES: '40000'
						}
					: {
							...env,
							EDYTOR_MAX_DOCUMENT_BYTES: '20000',
							EDYTOR_MAX_INBOUND_FRAME_BYTES: '30000',
							EDYTOR_MAX_UPDATES_PER_SECOND: '2',
							EDYTOR_MAX_PRESENCE_PER_SECOND: '2'
						}
		);
	}
}

/**
 * Per-block locks (rooms `locked-*`), the shipped helper (`lockedBlocks`,
 * through `locks()`): a block whose `data.lockedBy` names a user is that
 * user's alone. A frame touching it from anyone else — its text, data,
 * type, place or its deletion — is denied, and so is one locking a block
 * for someone else; the room then writes the frame's inverse. By name:
 * `locked-tree-*` locks subtrees, `locked-admin-*` lets `admin` through,
 * `locked-env-*` reads the `EDYTOR_LOCKS` var (`lockedBy`).
 */
export class LockedRoom extends DocumentRoom<Env> {
	/** Its log entries (H14), kept instead of printed. */
	readonly logged: RoomLogEntry[] = [];
	constructor(ctx: DurableObjectState, env: Env) {
		const name = ctx.id.name ?? '';
		super(ctx, name.startsWith('locked-env-') ? { ...env, EDYTOR_LOCKS: 'lockedBy' } : env);
	}
	protected override log(entry: RoomLogEntry) {
		this.logged.push(entry);
	}
	protected override locks(): LockOptions | undefined {
		const name = this.ctx.id.name ?? '';
		if (name.startsWith('locked-env-')) return super.locks();
		return {
			key: 'lockedBy',
			subtree: name.startsWith('locked-tree-'),
			bypass: name.startsWith('locked-admin-') ? (user) => user === 'admin' : undefined
		};
	}
}

/**
 * Rooms that move blocks between them (`moving-*`, H10): late edits are
 * forwarded by the room itself, through the `MOVES` namespace (`rooms()`),
 * on its alarm; a fake clock (`test_clock`) drives the grace period, and
 * the log is kept.
 */
export class MoveRoom extends DocumentRoom<Env> {
	readonly logged: RoomLogEntry[] = [];
	constructor(ctx: DurableObjectState, env: Env) {
		fakeAlarms(ctx);
		super(ctx, env);
	}
	protected override log(entry: RoomLogEntry) {
		this.logged.push(entry);
	}
	protected override now(): number {
		return fakeNow(this.ctx.storage.sql);
	}
	protected override rooms(): MoveNamespace {
		return this.env.MOVES as unknown as MoveNamespace;
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
				// KV lists a key's expiry in seconds since the epoch.
				...(r.expires === null ? {} : { expiration: Math.floor(r.expires / 1000) }),
				metadata: r.metadata === null ? undefined : JSON.parse(r.metadata)
			})),
			list_complete: complete,
			cursor: complete ? undefined : String(from + limit)
		};
	}

	async delete(key: string) {
		this.sql.exec('DELETE FROM fake_kv WHERE key = ?', key);
	}
}

/**
 * An in-memory R2 bucket (the {@link R2BucketLike} subset) over the
 * object's own SQLite storage: custom metadata (at most R2's 2,048 bytes),
 * prefix listings two objects a page, and no expiry of its own (the room
 * deletes). A row in `fake_r2_fail` makes the next puts throw.
 */
export class FakeR2 implements R2BucketLike {
	constructor(private readonly sql: SqlStorage) {
		sql.exec(
			'CREATE TABLE IF NOT EXISTS fake_r2 (key TEXT PRIMARY KEY, value BLOB, custom TEXT NOT NULL)'
		);
		sql.exec('CREATE TABLE IF NOT EXISTS fake_r2_fail (n INTEGER)');
	}

	async put(
		key: string,
		value: ArrayBuffer | ArrayBufferView,
		options: { customMetadata?: Record<string, string> } = {}
	) {
		const failing = this.sql.exec<{ n: number }>('SELECT n FROM fake_r2_fail').toArray()[0];
		if (failing && failing.n > 0) {
			this.sql.exec('UPDATE fake_r2_fail SET n = n - 1');
			throw new Error('R2 put failed (injected)');
		}
		const custom = JSON.stringify(options.customMetadata ?? {});
		const size = Object.entries(options.customMetadata ?? {}).reduce(
			(n, [k, v]) => n + new TextEncoder().encode(k + v).length,
			0
		);
		if (size > 2048) throw new Error('R2 custom metadata too large');
		const bytes =
			value instanceof ArrayBuffer
				? new Uint8Array(value)
				: new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
		this.sql.exec(
			'INSERT OR REPLACE INTO fake_r2 (key, value, custom) VALUES (?, ?, ?)',
			key,
			bytes,
			custom
		);
	}

	async get(key: string) {
		const row = this.sql
			.exec<{
				value: ArrayBuffer;
				custom: string;
			}>('SELECT value, custom FROM fake_r2 WHERE key = ?', key)
			.toArray()[0];
		if (!row) return null;
		return {
			arrayBuffer: async () => row.value.slice(0),
			customMetadata: JSON.parse(row.custom) as Record<string, string>
		};
	}

	async list(
		options: {
			prefix?: string;
			cursor?: string;
			include?: Array<'httpMetadata' | 'customMetadata'>;
		} = {}
	) {
		const all = this.sql
			.exec<{ key: string; custom: string }>('SELECT key, custom FROM fake_r2 ORDER BY key')
			.toArray()
			.filter((r) => r.key.startsWith(options.prefix ?? ''));
		const from = options.cursor ? Number(options.cursor) : 0;
		const page = all.slice(from, from + 2);
		const truncated = from + 2 < all.length;
		return {
			objects: page.map((r) => ({
				key: r.key,
				// Without `include`, R2 lists no custom metadata.
				...(options.include?.includes('customMetadata')
					? { customMetadata: JSON.parse(r.custom) as Record<string, string> }
					: {})
			})),
			truncated,
			cursor: truncated ? String(from + 2) : undefined
		};
	}

	async delete(keys: string | string[]) {
		for (const key of Array.isArray(keys) ? keys : [keys])
			this.sql.exec('DELETE FROM fake_r2 WHERE key = ?', key);
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

/**
 * Alarms on a fake clock: the room arms its alarm at times of its fake
 * clock, which the runtime would fire at once whenever they are past the
 * real clock. The real alarm is set far ahead instead (tests fire it with
 * `runDurableObjectAlarm`), and `getAlarm` answers the time the room asked
 * for, kept in `test_alarm` (it survives an eviction).
 */
const fakeAlarms = (ctx: DurableObjectState) => {
	const storage = ctx.storage;
	const sql = storage.sql;
	sql.exec('CREATE TABLE IF NOT EXISTS test_alarm (at INTEGER)');
	const setAlarm = storage.setAlarm.bind(storage);
	const getAlarm = storage.getAlarm.bind(storage);
	Object.assign(storage, {
		setAlarm: async (at: number | Date) => {
			sql.exec('DELETE FROM test_alarm');
			sql.exec('INSERT INTO test_alarm VALUES (?)', Number(at));
			return setAlarm(Date.now() + 10 * 365 * 86_400_000);
		},
		getAlarm: async () => {
			if ((await getAlarm()) === null) return null;
			return sql.exec<{ at: number }>('SELECT at FROM test_alarm').toArray()[0]?.at ?? null;
		}
	});
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
 * The history store a `timed-*` room's name asks for (`room.history.store`):
 * `-r2-` an R2 bucket ({@link FakeR2} through `r2History`), `-sqlite-` the
 * room's own storage (`roomHistory`; `-sqlite-small-` caps its table at
 * 4,000 bytes), `-kvstore-` `kvHistory` over a {@link FakeKV}; else a bare
 * {@link FakeKV} (the deprecated `KVLike` store, wrapped by the room).
 */
const storeOf = (name: string, sql: SqlStorage, now: () => number): HistoryOptions['store'] =>
	name.includes('-r2-')
		? r2History(new FakeR2(sql))
		: name.includes('-sqlite-small-')
			? roomHistory({ maxBytes: 4000 })
			: name.includes('-sqlite-')
				? roomHistory()
				: name.includes('-kvstore-')
					? kvHistory(new FakeKV(sql, now))
					: new FakeKV(sql, now);

/**
 * Rooms with a fake clock (`timed-*`, Phase 3): history in the store their
 * name asks for ({@link storeOf}; none for `timed-nohistory-*`; the
 * `EDYTOR_HISTORY` var's for `timed-env-*`: `-env-r2-` the `HISTORY_R2`
 * bucket, `-env-room-` the string `room`, `-env-kv-` the `HISTORY`
 * namespace), its time zone by name (`-paris-`, `-ny-`, `-kolkata-`, else
 * UTC), a 600-byte value cap for `timed-cap-*`, purge after 30 days (the
 * retention). Log entries are kept.
 */
export class TimedRoom extends DocumentRoom<Env> {
	readonly logged: RoomLogEntry[] = [];
	constructor(ctx: DurableObjectState, env: Env) {
		const name = ctx.id.name ?? '';
		fakeAlarms(ctx);
		super(
			ctx,
			name.startsWith('timed-env-')
				? {
						...env,
						EDYTOR_HISTORY: name.includes('-env-r2-')
							? env.HISTORY_R2
							: name.includes('-env-room-')
								? 'room'
								: env.HISTORY
					}
				: env
		);
	}
	protected override log(entry: RoomLogEntry) {
		this.logged.push(entry);
	}
	protected override now(): number {
		return fakeNow(this.ctx.storage.sql);
	}
	protected override history(): HistoryOptions | undefined {
		const name = this.ctx.id.name ?? '';
		if (name.startsWith('timed-nohistory')) return undefined;
		if (name.startsWith('timed-env-')) return super.history();
		return {
			store: storeOf(name, this.ctx.storage.sql, () => this.now()),
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
	MOVES: DurableObjectNamespace<MoveRoom>;
	TIMED: DurableObjectNamespace<TimedRoom>;
	DEMO: DurableObjectNamespace<DocumentRoom>;
	HISTORY: KVNamespace;
	HISTORY_R2: R2Bucket;
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
		readOnly: query.get('access') === 'read',
		// `?expires=<ms since the epoch>`: when the credential expires (WU-06).
		...(query.has('expires') ? { expiresAt: Number(query.get('expires')) } : {})
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

/** `origin-*` rooms accept browser requests from the test origin only (WU-07). */
const originsOf = (name: string) =>
	name.startsWith('origin-') ? { allowedOrigins: ['https://edytor-do.test'] } : undefined;

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
			authorizeFromQuery,
			originsOf(name)
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
	if (name.startsWith('moving-')) {
		return routeDocumentSocket(request, env.MOVES, name, authorizeFromQuery);
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
	return routeDocumentSocket(request, env.ROOM, name, authorizeFromQuery, originsOf(name));
};

export default {
	fetch: (request: Request, env: Env) => routeRoom(request, env)
} satisfies ExportedHandler<Env>;
