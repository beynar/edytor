/**
 * The soak's Worker (WU-16): the shipped room (`edytor/cloudflare`) under
 * a production configuration, plus the operator routes the soak drives.
 * Dev-only; never part of the package.
 *
 * - `GET /health` → `ready`
 * - `/rooms/<name>` (WebSocket upgrade) → `routeDocumentSocket` to a
 *   {@link SoakRoom}. `authorize` trusts `?user=` (the soak's clients are
 *   synthetic users), and when `SOAK_TOKEN` is set every request must carry
 *   `?token=<SOAK_TOKEN>` (a staging deployment sets it as a secret).
 * - `GET /rooms/<name>/metrics` → `metrics()` and the newest log entries;
 * - `GET /rooms/<name>/json` → the room's document (`read()`);
 * - `POST /rooms/<name>/compact` → a forced compaction (timed inside the
 *   object, which the clock only advances across I/O, so the soak also
 *   times the round trip);
 * - `POST /rooms/<name>/fault?kind=append|compaction&on=1|0` → a storage
 *   fault: a SQLite trigger that fails every update append (or every
 *   compaction) until it is dropped;
 * - `POST /rooms/<name>/abort` → `ctx.abort()`: the object is reset as on
 *   an exceeded limit or a deploy, its sockets dropped.
 *
 * `local.ts` adds the eviction route Miniflare offers (`workerd:unsafe`).
 */
import {
	DocumentRoom,
	requestedReplica,
	routeDocumentSocket,
	closedSocket,
	type AuthorizeDocumentSocket,
	type DocumentRoomEnv,
	type RoomLogEntry
} from '../../src/lib/cloudflare/index.js';

/** The triggers a fault installs, on the room's `rows` table. */
const FAULTS = {
	append:
		"CREATE TRIGGER IF NOT EXISTS soak_fail_append BEFORE INSERT ON rows WHEN NEW.kind = 'update' BEGIN SELECT RAISE(ABORT, 'soak: injected append failure'); END",
	compaction:
		"CREATE TRIGGER IF NOT EXISTS soak_fail_compaction BEFORE DELETE ON rows BEGIN SELECT RAISE(ABORT, 'soak: injected compaction failure'); END"
} as const;
type Fault = keyof typeof FAULTS;

/** How many log entries the room keeps for `/metrics` (the newest). */
const KEPT_LOG = 200;

export class SoakRoom extends DocumentRoom<Env> {
	/** The newest log entries (compactions, quota hits, faults), numbered, printed too. */
	readonly logged: Array<RoomLogEntry & { n: number }> = [];
	private entries = 0;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		// Every start of the object, and the sockets it found: a wake from
		// hibernation finds its sockets, a reset or a first start none.
		ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS soak_starts (at INTEGER, sockets INTEGER)');
		ctx.storage.sql.exec(
			'INSERT INTO soak_starts VALUES (?, ?)',
			Date.now(),
			ctx.getWebSockets().length
		);
	}

	protected override log(entry: RoomLogEntry): void {
		this.logged.push({ ...entry, n: ++this.entries });
		if (this.logged.length > KEPT_LOG) this.logged.splice(0, this.logged.length - KEPT_LOG);
		super.log(entry);
	}

	/** `metrics()` and the newest log entries, over RPC. */
	report() {
		const starts = this.ctx.storage.sql
			.exec<{ at: number; sockets: number }>('SELECT at, sockets FROM soak_starts ORDER BY at')
			.toArray();
		return {
			metrics: this.metrics(),
			log: this.logged.slice(),
			failure: this.failure?.message,
			starts
		};
	}

	/** The room's document (`read()`) as JSON text, over RPC. */
	json(): string {
		return JSON.stringify(this.read());
	}

	/** Install (`on`) or drop a storage fault, over RPC. */
	fault(kind: Fault, on: boolean): { kind: Fault; on: boolean } {
		const sql = this.ctx.storage.sql;
		// The room's tables exist once it started: a read starts it.
		this.read();
		if (on) sql.exec(FAULTS[kind]);
		else sql.exec(`DROP TRIGGER IF EXISTS soak_fail_${kind}`);
		return { kind, on };
	}

	/** Reset the object (`ctx.abort`), over RPC: it answers before it goes. */
	abort(): { aborted: true } {
		const ctx = this.ctx as DurableObjectState & { abort?: (reason?: string) => void };
		setTimeoutless(() => ctx.abort?.('soak: injected abort'));
		return { aborted: true };
	}
}

/** Run `fn` after the current RPC returned (a microtask chain: the room forbids timers). */
const setTimeoutless = (fn: () => void) => {
	void Promise.resolve()
		.then(() => Promise.resolve())
		.then(() => {
			try {
				fn();
			} catch {
				// `abort` throws into the caller by design.
			}
		});
};

export type Env = DocumentRoomEnv & {
	ROOM: DurableObjectNamespace<SoakRoom>;
	SOAK_TOKEN?: string;
};

const authorize: AuthorizeDocumentSocket = (request) => {
	const query = new URL(request.url).searchParams;
	return {
		userId: query.get('user') ?? 'anon',
		replica: requestedReplica(request),
		readOnly: query.get('access') === 'read'
	};
};

export const ROOM_ROUTE = /^\/rooms\/([^/]+)(?:\/(metrics|json|compact|fault|abort|evict))?\/?$/;

const roomOf = (encoded: string): string | null => {
	try {
		return decodeURIComponent(encoded);
	} catch {
		return null;
	}
};

/** Every route but the eviction (`local.ts`); `null` when the path is not a room's. */
export const routeSoak = async (request: Request, env: Env): Promise<Response | null> => {
	const url = new URL(request.url);
	if (url.pathname === '/health') return new Response('ready');
	const match = ROOM_ROUTE.exec(url.pathname);
	if (!match) return new Response('not found', { status: 404 });
	const name = roomOf(match[1]);
	const action = match[2];
	if (env.SOAK_TOKEN && url.searchParams.get('token') !== env.SOAK_TOKEN) {
		return action ? new Response('forbidden', { status: 403 }) : closedSocket(4403, 'forbidden');
	}
	if (name === null) return closedSocket(4400, 'invalid document id');
	if (!action) return routeDocumentSocket(request, env.ROOM, name, authorize);
	const stub = env.ROOM.getByName(name);
	switch (action) {
		case 'metrics':
			return Response.json(await stub.report());
		case 'json':
			return new Response(await stub.json(), { headers: { 'content-type': 'application/json' } });
		case 'evict':
			return null;
	}
	if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
	switch (action) {
		case 'compact':
			return Response.json(await stub.compact());
		case 'fault': {
			const kind = url.searchParams.get('kind');
			if (kind !== 'append' && kind !== 'compaction') {
				return new Response('unknown fault', { status: 400 });
			}
			return Response.json(await stub.fault(kind, url.searchParams.get('on') !== '0'));
		}
		case 'abort':
			try {
				return Response.json(await stub.abort());
			} catch (error) {
				return Response.json({ aborted: true, error: String(error) });
			}
	}
	return new Response('not found', { status: 404 });
};

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		return (await routeSoak(request, env)) ?? new Response('not found', { status: 404 });
	}
} satisfies ExportedHandler<Env>;
