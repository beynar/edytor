/**
 * Provider stack for the vendored v14 engine — bound entry point.
 *
 * `bindProviders(Y)` produces the whole provider surface for one engine
 * instance: the provider classes plus `EdytorSync`-shaped factories matching
 * the `{ doc, awareness, synced }` contract. THE single implementation —
 * `src/lib/collaboration/providers.ts` re-exports these bound to the
 * vendored engine (U1 consolidation; the contract itself is unchanged).
 */
import type { EngineApi, YDoc } from '../engine-api.js';
import type { JSONDoc } from '../../utils/json.js';
import type { Awareness } from '../protocols/awareness.js';
import { keepingReplaced } from '../incarnations.js';
import { bindIndexeddbProvider, type IndexeddbProvider } from './indexeddb.js';
import { assertRoomId, SyncRefusedError } from './room.js';
import { bindWebsocketProvider, type WebsocketProviderEvents } from './websocket.js';

/**
 * Payload a sync factory receives — the v13 contract plus `failed`:
 * the terminal half of the sync lifecycle. A provider that can never reach
 * `synced` (destroyed before syncing, persistence load failure, refused
 * hydration, denied auth) reports it here exactly once; a transient
 * disconnect or a provider that already synced never does. A
 * `SyncRefusedError` is the exception: the server refused this
 * client for good, reported synced or not, and an empty document does not
 * seed over it.
 */
export type EdytorSyncPayload = {
	doc: YDoc;
	awareness: Awareness;
	synced: (provider?: unknown) => void;
	failed?: (error: unknown, provider: unknown) => void;
	/**
	 * (Re)start this provider's readiness bound (`DEFAULT_READINESS_BOUND`
	 * ms from now) — for a factory whose `bound` is `Infinity` because only
	 * its transport knows when waiting starts to count (the websocket sync:
	 * from the socket's open, or its first failed dial). A no-op once the
	 * provider settled.
	 */
	armBound?: () => void;
	/**
	 * Stop this provider's readiness bound: an empty document waits for it
	 * to settle (or for the next `armBound()`), as the websocket sync does
	 * after expired credentials on a first visit.
	 */
	holdBound?: () => void;
	/**
	 * Attach another sync to the same document as its own provider (its own
	 * target, bound and settle): how a sync brings a companion, e.g. the
	 * websocket sync's local store. `document.attachSync` passes it.
	 */
	attach?: (sync: EdytorSync) => EdytorSyncCleanup | void;
};

export type EdytorSyncCleanup = () => void | Promise<void>;
export type EdytorSync = ((payload: EdytorSyncPayload) => void | EdytorSyncCleanup) & {
	/**
	 * ms an empty document waits for this provider to settle before it
	 * decides without it; `Infinity` for a provider that always
	 * reports `synced` or `failed`, or arms its bound itself (`armBound`).
	 * Default: `DEFAULT_READINESS_BOUND`, counted from the attach.
	 */
	bound?: number;
	/**
	 * The transport target (database, server + room): a document keeps one
	 * provider per target, whatever factory instance attaches it.
	 * Without it the factory itself is the target.
	 */
	target?: string;
};

export type IndexeddbSyncOptions = {
	awareness?: Awareness;
};

/**
 * The factory-owned provider always dials (`connect` is retired,
 * `protocols` and `resyncInterval` here). Cross-tab sync is on by default.
 */
/** Where the socket dials: `<server>/<room>`, the names `<Edytor server room>` uses. */
export type WebsocketTarget =
	| {
			/** The sync server's base URL (`wss://…/rooms`). */
			server: string;
			/** The room (document) id. */
			room: string;
	  }
	| {
			/** @deprecated Use `server`. */
			serverUrl: string;
			/** @deprecated Use `room`. */
			roomName: string;
	  };

export type WebsocketSyncOptions = WebsocketTarget & {
	/** Query parameters (auth tokens), read at every dial. */
	params?: Record<string, string>;
	WebSocketPolyfill?: import('./websocket.js').WebsocketPolyfill;
	maxBackoffTime?: number;
	/**
	 * ms a dial may take to open before it is closed like a failed one, which
	 * starts the readiness bound (default 10 000; `Infinity`: no limit).
	 */
	connectTimeout?: number;
	/**
	 * The room closed the socket with `4401` (expired credentials): put a
	 * fresh token in `params` before the redial, due in `nextRetryMs`.
	 */
	onExpired?: (state: Parameters<WebsocketProviderEvents['expired']>[0]) => void;
	/** Opt out of cross-tab sync over the BroadcastChannel (on by default). */
	disableBc?: boolean;
	/** Largest frame sent whole (default 32 MiB); larger ones are chunked. */
	maxFrameBytes?: number;
	/**
	 * Keep a local copy in IndexedDB (default `true`; skipped where there is
	 * no `indexedDB`). Edits survive offline reloads and reach the server on
	 * reconnect.
	 */
	persist?: boolean;
	/** The local database name. Default: `edytor:<server>/<room>`. */
	persistName?: string;
};

/** A websocket sync; `persistName` names its local store (for `clearDocument`), unset without one. */
export type WebsocketSync = EdytorSync & { persistName?: string };

/** What {@link bindProviders}' `prefetch` takes: a websocket sync's target and options. */
export type PrefetchOptions = (WebsocketSyncOptions extends infer O
	? O extends unknown
		? Omit<O, 'onExpired' | 'persist' | 'disableBc'>
		: never
	: never) & {
	/** ms before it gives up (default 30 000). */
	timeout?: number;
};

/** What `prefetch` found: whether the room sent the store anything it lacked. */
export type PrefetchResult = { updated: boolean };

/** What `lastUpdated` takes: the room it asks, and the `params` (a token) its dial would carry. */
export type LastUpdatedOptions = WebsocketTarget & {
	params?: Record<string, string>;
	/** The fetch to use (default the global one). */
	fetch?: typeof fetch;
};

export type ProviderStack = ReturnType<typeof bindProviders>;

export const bindProviders = (Y: EngineApi) => {
	const idb = bindIndexeddbProvider(Y);
	const ws = bindWebsocketProvider(Y);

	// Local hydration always ends in `synced` or `failed`: no bound.
	const localSync = (
		name: string,
		options: { disableBc?: boolean; convertPrevious?: boolean } = {}
	): EdytorSync =>
		Object.assign(
			({ doc, awareness, synced, failed }: EdytorSyncPayload) => {
				const provider = new idb.IndexeddbPersistence(name, doc, { awareness, ...options });
				provider.on('synced', () => synced(provider));
				if (failed) provider.on('failed', failed);
				return () => provider.destroy();
			},
			{ bound: Infinity, target: `indexeddb:${name}` }
		);

	/** A document stored only here: a generation-4 store of `name` converts into it (the cutover). */
	const createIndexeddbSync = (name: string): EdytorSync =>
		localSync(name, { convertPrevious: true });

	/**
	 * The socket, and by default a local store beside it. The store is its
	 * own provider on the document (`attach`), so the document's readiness
	 * rules see two: stored content decides at once (offline start), and an
	 * empty store holds the seed until it answered, then the server's answer
	 * or the socket's bound decides. While the store exists it carries the
	 * cross-tab channel (the socket's BroadcastChannel leg is off): a tab
	 * applies another tab's edit under the store's origin and relays it to
	 * the server, without storing it twice. Restored edits reach the server
	 * by the join rule on every (re)connect.
	 *
	 * The socket's bound runs from transport state, not from the attach: a
	 * dial still in flight (a cold room holds the upgrade) never counts, so
	 * a slow room hydrates the document instead of racing the seed, up to
	 * `connectTimeout`. Expired credentials (`4401`) before the first sync
	 * hold the bound: the room may hold content, so an empty document waits
	 * for a dial that gets in.
	 */
	const createWebsocketSync = (options: WebsocketSyncOptions): WebsocketSync => {
		const [server, roomName] =
			'server' in options ? [options.server, options.room] : [options.serverUrl, options.roomName];
		assertRoomId(roomName);
		const serverUrl = server.replace(/\/+$/, '');
		const room = `${serverUrl}/${roomName}`;
		const persistName =
			options.persist === false ? undefined : (options.persistName ?? `edytor:${room}`);
		const sync = (payload: EdytorSyncPayload) => {
			const { doc, awareness, synced, failed, attach, armBound, holdBound } = payload;
			const {
				params,
				WebSocketPolyfill,
				maxBackoffTime,
				connectTimeout,
				disableBc,
				onExpired,
				maxFrameBytes
			} = options;
			const local =
				persistName !== undefined && typeof indexedDB !== 'undefined'
					? localSync(persistName, { disableBc })
					: undefined;
			const provider = new ws.WebsocketProvider(serverUrl, roomName, doc, {
				awareness,
				params,
				WebSocketPolyfill,
				maxBackoffTime,
				connectTimeout,
				disableBc: disableBc || local !== undefined,
				maxFrameBytes
			});
			if (onExpired) provider.on('expired', (state) => onExpired(state));
			provider.on('synced', (isSynced) => {
				if (isSynced) synced(provider);
			});
			if (failed) {
				provider.on('failed', failed);
				// `failed` fires only before a sync; a refusal is terminal after one too.
				provider.on('refused', (refusal) => provider.hasSynced && failed(refusal, provider));
			}
			if (armBound) {
				// The bound counts from the socket's open, or from the first
				// failed dial since the last open (offline starts decide as fast).
				// Expired credentials before the first sync hold it for good.
				let armedOffline = false;
				let held = false;
				const arm = () => held || armBound();
				provider.on('status', ({ status }) => {
					if (status !== 'connected') return;
					armedOffline = false;
					arm();
				});
				const armOffline = () => {
					if (armedOffline) return;
					armedOffline = true;
					arm();
				};
				provider.on('connection-close', armOffline);
				provider.on('connection-error', armOffline);
				provider.on('expired', () => {
					if (provider.hasSynced) return;
					held = true;
					holdBound?.();
				});
			}
			let release: EdytorSyncCleanup | void = undefined;
			try {
				// Called directly (no `attach`), the store only persists: readiness is the socket's.
				release = local && (attach ? attach(local) : local({ doc, awareness, synced: () => {} }));
			} catch (error) {
				provider.destroy();
				throw error;
			}
			return () => {
				provider.destroy();
				return release?.();
			};
		};
		return Object.assign(sync, { bound: Infinity, target: `websocket:${room}`, persistName });
	};

	/** `[serverUrl (no trailing slash), room]` of a target, the room id checked. */
	const targetOf = (options: WebsocketTarget): [string, string] => {
		const [server, room] =
			'server' in options ? [options.server, options.room] : [options.serverUrl, options.roomName];
		assertRoomId(room);
		return [server.replace(/\/+$/, ''), room];
	};

	/**
	 * Keep a document fresh without opening it (H12): load its local store
	 * (the one `createWebsocketSync` keeps, `edytor:<server>/<room>` unless
	 * `persistName` names another), dial the room once, take what it lacks
	 * and hand it what the store holds that the room lacks, wait until the
	 * room stored it, then close. Resolves with whether the room sent
	 * anything new; rejects with the room's refusal (`SyncRefusedError`),
	 * after `timeout`, or where there is no IndexedDB.
	 */
	const prefetch = (options: PrefetchOptions): Promise<PrefetchResult> => {
		const [serverUrl, room] = targetOf(options);
		if (typeof indexedDB === 'undefined') {
			return Promise.reject(new TypeError('prefetch needs IndexedDB to keep the document'));
		}
		const doc = keepingReplaced(new Y.Doc());
		const local = new idb.IndexeddbPersistence(
			options.persistName ?? `edytor:${serverUrl}/${room}`,
			doc,
			{ disableBc: true }
		);
		let socket: InstanceType<typeof ws.WebsocketProvider> | null = null;
		/** Prefetch's one timer: its deadline (`timeout`), cleared when it closes. */
		let deadline: ReturnType<typeof setTimeout> | undefined;
		const close = async () => {
			clearTimeout(deadline);
			socket?.destroy();
			await local.destroy();
			doc.destroy();
		};
		return new Promise<PrefetchResult>((resolve, reject) => {
			const fail = (error: unknown) => void close().then(() => reject(error));
			deadline = setTimeout(
				() => fail(new Error(`prefetch of ${room} timed out`)),
				options.timeout ?? 30_000
			);
			local.whenSynced.then(() => {
				const before = Y.encodeStateVector(doc);
				const provider = (socket = new ws.WebsocketProvider(serverUrl, room, doc, {
					params: options.params,
					WebSocketPolyfill: options.WebSocketPolyfill,
					maxBackoffTime: options.maxBackoffTime,
					connectTimeout: options.connectTimeout,
					maxFrameBytes: options.maxFrameBytes,
					disableBc: true
				}));
				// A prefetch is nobody's presence.
				provider.awareness.setLocalState(null);
				const done = () => {
					if (!provider.synced || !provider.saved) return;
					const after = Y.encodeStateVector(doc);
					const updated = after.length !== before.length || after.some((b, i) => b !== before[i]);
					void close().then(() => resolve({ updated }));
				};
				provider.on('synced', done);
				provider.on('saved', done);
				provider.on('refused', (refusal: SyncRefusedError) => fail(refusal));
				done();
			}, fail);
		});
	};

	/**
	 * When the room last stored a change (ms since the epoch), or `null`
	 * (H12): one authorized HTTP `GET <server>/<room>?lastUpdated`, which
	 * `routeDocumentSocket` answers without opening the document. Compare
	 * it with when a document was last fetched to decide whether to
	 * `prefetch` it. Throws on an HTTP error (`403` refused, `401` expired).
	 */
	const lastUpdated = async (options: LastUpdatedOptions): Promise<number | null> => {
		const [serverUrl, room] = targetOf(options);
		const url = new URL(`${serverUrl.replace(/^ws/, 'http')}/${encodeURIComponent(room)}`);
		for (const [key, value] of Object.entries(options.params ?? {}))
			url.searchParams.set(key, value);
		url.searchParams.set('lastUpdated', '1');
		const response = await (options.fetch ?? fetch)(url.toString());
		if (!response.ok) {
			throw new Error(`lastUpdated of ${room}: ${response.status} ${await response.text()}`);
		}
		const { lastUpdated: at } = (await response.json()) as { lastUpdated: number | null };
		return typeof at === 'number' ? at : null;
	};

	/**
	 * The room's document as JSON, or `null` when it stores nothing yet
	 * (P8): one authorized HTTP `GET <server>/<room>?snapshot`, which
	 * `routeDocumentSocket` answers from the room's live document. Show it
	 * while a view's own copy hydrates: `<Edytor snapshot>`. Throws on an
	 * HTTP error (`403` refused, `401` expired).
	 */
	const documentSnapshot = async (options: LastUpdatedOptions): Promise<JSONDoc | null> => {
		const [serverUrl, room] = targetOf(options);
		const url = new URL(`${serverUrl.replace(/^ws/, 'http')}/${encodeURIComponent(room)}`);
		for (const [key, value] of Object.entries(options.params ?? {}))
			url.searchParams.set(key, value);
		url.searchParams.set('snapshot', '1');
		const response = await (options.fetch ?? fetch)(url.toString());
		if (!response.ok) {
			throw new Error(`snapshot of ${room}: ${response.status} ${await response.text()}`);
		}
		const { lastUpdated: at, document } = (await response.json()) as {
			lastUpdated: number | null;
			document: JSONDoc;
		};
		return typeof at === 'number' ? document : null;
	};

	return {
		prefetch,
		lastUpdated,
		documentSnapshot,
		IndexeddbPersistence: idb.IndexeddbPersistence,
		WebsocketProvider: ws.WebsocketProvider,
		watchComments: ws.watchComments,
		storeState: idb.storeState,
		clearDocument: idb.clearDocument,
		PREFERRED_TRIM_SIZE: idb.PREFERRED_TRIM_SIZE,
		createIndexeddbSync,
		createWebsocketSync
	};
};

export type { IndexeddbProvider };
