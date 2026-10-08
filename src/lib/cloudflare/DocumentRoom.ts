/**
 * `DocumentRoom` — the Cloudflare Durable Object that coordinates ONE
 * edytor document (one object per document) over hibernatable
 * WebSockets. Clients are the shipped `WebsocketProvider` /
 * `createWebsocketSync`; the host Worker reaches the room only through
 * {@link routeDocumentSocket}, which authorizes the request and forwards
 * the verified identity in the `X-Edytor-*` headers (and nothing the
 * client sent).
 *
 * Built on the Worker-safe CRDT entry only (`crdt/index.ts` + the vendored
 * engine). Entry point by entry point:
 *
 * - `fetch` (upgrade): read the verified identity, bind the socket's
 *   replica to its user (a replica another user owns is accepted, then
 *   closed `4409`), `ctx.acceptWebSocket` with the identity in the
 *   attachment, then our SyncStep1 (a read-only socket gets the
 *   read-only notice instead) and every present peer.
 * - `webSocketMessage`: ADMIT first — the generation word, then the
 *   identity: a read-only socket's Step2/Update is refused (permission
 *   denied, the socket stays), and new structs under a client id its user
 *   does not own are stripped from the frame (a relay of an id the room
 *   holds nothing of is kept, unowned) — no attribution spoofing, and the
 *   sender's own edits still land. Then the inbound schema refusal
 *   (`sync.applyRemote`, which also judges what the engine holds pending:
 *   a pending forged stamp the update would release is discarded, never
 *   integrated). A refused frame
 *   is never applied, stored or relayed. Every sync message is answered
 *   with `messageSaved` (the room's state vector, and the deletes of the
 *   message it stored), sent after the write (store-before-ack). Presence
 *   is relayed through the instance-free codec, only for the socket's own
 *   replica. Only bytes that do not decode are refused `malformed`
 *   (1008); a storage or engine fault closes the socket 1011 (its
 *   provider redials), after rebuilding the document where it may hold
 *   what storage does not.
 * - every INTEGRATED update is appended to SQLite as one record split into
 *   rows ≤ `maxRowBytes` (2 MB row cap) in one `transactionSync`, then
 *   broadcast; after `compactAfter` update records the rows are replaced
 *   by one snapshot record of the live document's state (its healed
 *   state, deleted content collected), after the message is
 *   acknowledged — never inside the engine's `update` observer, where one
 *   throw would silence every later emit. Memory never runs ahead of
 *   storage: when an append fails, nothing is relayed or acknowledged, the
 *   live doc is rebuilt from the stored rows and the sender's socket is
 *   closed (1011) so its provider reconnects and resends.
 * - a delete of an item the room lacks waits in the engine and is stored
 *   as a `pending` record (not the entries its frame's waiting rewrites
 *   replace: those deletes wait with them, in memory); compaction keeps
 *   the pending records apart, and rewrites them as the deletes still
 *   waiting; a frame that discards a forged stamp drops them. At most
 *   {@link MAX_WAITING_DELETES} ranges wait, stored or in memory: a frame
 *   that would pass it has its waiting deletes dropped (refusal `waiting`,
 *   left out of the ack), the rest applied. Compaction reclaims the
 *   waiting deletes of client ids no user registered and no socket holds;
 *   `dropWaitingDeletes()` every one.
 * - storage format: the generation record says `storage: 'v2'` —
 *   snapshots in the v2 encoding, compressed in place after they are
 *   stored (`compressLater`), inflated at start (`inflate`); update and
 *   pending records stay v1. A container without `storage` (0.1.0-next.22)
 *   is all v1, and its next compaction rewrites it.
 * - a Step2 serves the STORED state: the engine's pending structs (waiting
 *   for a dependency, never stored) are not served.
 * - a frame larger than `maxFrameBytes` (32 MiB) goes out as chunks the
 *   client applies only when complete (`chunkFrame`).
 * - `webSocketClose`/`webSocketError`: the departure the client may not
 *   have announced, read from the attachment (survives hibernation).
 * - constructor: restore from SQLite alone under `blockConcurrencyWhile`
 *   (verify the generation record, merge, `admission.admitUpdate`); a
 *   container that cannot be restored (another generation, a torn record,
 *   a refused `onLoad` payload) refuses every socket (1008); a read of the
 *   rows that fails is the storage's fault, retried at the next dial
 *   (1011). It never throws out of the constructor (the platform would
 *   reset the object on every request).
 *
 * No entry point schedules a timer: each runs under {@link noTimers}
 * (a Durable Object with a pending timer never hibernates). Keepalive is
 * the runtime's: a text `ping` is answered `pong` without waking the
 * object (`ctx.setWebSocketAutoResponse`, installed unless the host set
 * its own pair; `webSocketMessage` answers it otherwise).
 *
 * Extending (subclass it, export the subclass):
 *
 * - `onLoad()` — retrieve: seed a room that stores nothing yet from your
 *   own store (JSON, a v14 update, or `{ update, replicas }` from
 *   `onSave`). Runs before any socket is served; nothing is stored until
 *   it settles.
 * - `onSave(document)` — save: mirror the document to your own store,
 *   `saveAfter` ms after the first unsaved change (a Durable Object alarm,
 *   so hibernation is unaffected; a throw is retried by the platform).
 *   SQLite stays the room's source of truth: acks never wait on `onSave`.
 * - `transact(fn)` — manipulate: edit through the document facade on the
 *   server; persisted and broadcast to every socket like a client's edit
 *   (one transaction, not a rollback: a throw from `fn` keeps its writes).
 *   `read()` returns the document as JSON (both RPC-callable wrappers are
 *   yours to define).
 *
 * The room's parts live in `room/`, one module each, sharing one explicit
 * context (`room/context.ts`): storage and compaction (`storage.ts`), the
 * admission of client frames (`admission.ts`, with the replica registry
 * `replicas.ts`, the forged-write checks `forged.ts` and `validation.ts`),
 * the alarm's scheduler (`scheduler.ts`), the version history
 * (`history.ts`), the purge (`purge.ts`), moves (`moves.ts`), presence
 * (`presence.ts`), access (`access.ts`) and the comment threads
 * (`comments.ts`). This module keeps the public
 * types and constants, and `AttachedDocument` wires the parts.
 */
import { DurableObject } from 'cloudflare:workers';
import * as E from '../crdt/protocol.js';
import { defaultSemantics } from '../crdt/semantics.js';
import type { PurgeReport } from '../crdt/purge.js';
import {
	isR2Bucket,
	kvHistory,
	r2History,
	roomHistory,
	type HistoryEntry,
	type HistoryOptions,
	type KVLike,
	type R2BucketLike
} from './history.js';
import { CLOSE } from '../crdt/providers/room.js';
import type { LockOptions } from './locks.js';
import type {
	CommitResult,
	ExportedBlocks,
	ImportReceipt,
	ImportRequest,
	LateEditBatch,
	MoveNamespace
} from './move.js';
import type { AwarenessEntry } from '../crdt/protocol.js';
import type {
	DocumentSemanticsConfig,
	DocumentOperations,
	JSONBlock,
	JSONDoc,
	YDoc
} from '../crdt/index.js';
import type {
	CommentActor,
	CommentChange,
	CommentOutcome,
	CommentRequest,
	CommentSnapshot
} from '../crdt/protocols/comments.js';
import { RoomAccess } from './room/access.js';
import { RoomComments } from './room/comments.js';
import { Admission, PING, PONG } from './room/admission.js';
import { RoomContext, knob } from './room/context.js';
import { RoomHistory } from './room/history.js';
import { RoomMoves } from './room/moves.js';
import { RoomPresence } from './room/presence.js';
import { RoomPurge } from './room/purge.js';
import { ReplicaRegistry } from './room/replicas.js';
import { Scheduler } from './room/scheduler.js';
import { RoomStorage } from './room/storage.js';
import { RoomValidation } from './room/validation.js';

/** Under SQLite-backed Durable Objects' 2 MB row cap, with room for the other columns. */
export const DEFAULT_MAX_ROW_BYTES = 2_000_000 - 4096;
/** Update records before the rows are merged into one snapshot. */
export const DEFAULT_COMPACT_AFTER = 500;
/** ms between the first unsaved change and `onSave`. */
export const DEFAULT_SAVE_AFTER = 2000;
/**
 * Room quotas, each refused with `4413` (`quota: <name>`). The
 * document's size: what its records hold (uncompressed) and the updates the
 * engine holds waiting. An isolate has 128 MB, and the live document takes
 * 18 to 46 bytes of heap per stored byte (prose to one short line per
 * block, its index included; `bench/room-memory.mjs`): 2 MiB is
 * about 100 MB at worst. Raise it for documents of long text.
 */
export const DEFAULT_MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
/**
 * The largest frame a socket may send, reassembled from chunks: room for a
 * whole document at the default quota (a client seeding an empty room).
 * Raise it with the document quota.
 */
export const DEFAULT_MAX_INBOUND_FRAME_BYTES = 4 * 1024 * 1024;
/**
 * The chunk sequences in flight on all of a room's sockets together, by
 * default twice the frame quota (never less than one frame): each is one
 * buffer of its announced size, allocated at its start.
 */
export const DEFAULT_MAX_BUFFERED_BYTES = 2 * DEFAULT_MAX_INBOUND_FRAME_BYTES;
/**
 * Sync messages a socket may send per second, sustained; a burst of ten
 * seconds' worth is allowed (a reconnect, a paste). Far above typing
 * speed: a script should batch its edits into transactions.
 */
export const DEFAULT_MAX_UPDATES_PER_SECOND = 50;
/**
 * The largest presence state a socket may publish, as JSON (a caret, a
 * name, a color: a few hundred bytes). A larger entry is ignored.
 */
export const DEFAULT_MAX_PRESENCE_BYTES = 16 * 1024;
/**
 * Presence messages (entries and queries) a socket may send per second,
 * sustained, on a bucket of its own (a ten-second burst): a view
 * publishes at most every 50 ms (`presence.throttle`), and renews every
 * 15 s. Past it, entries are coalesced and queries dropped.
 */
export const DEFAULT_MAX_PRESENCE_PER_SECOND = 50;
/**
 * Presence frames the room sends a second, over all its sockets together
 * (a one-second burst). Within it each entry goes out at once; past it the
 * entries wait per recipient, the newest of each replica, and go out
 * together in one frame per recipient (`room.presence.fanout`). Ten
 * editors each moving a caret at the client's 20 Hz stay within it; fifty
 * would send 50,000 frames a second.
 */
export const DEFAULT_MAX_PRESENCE_FANOUT = 2000;
/** Seconds of the update rate a socket may spend at once. */
/** The ceiling of a quota knob (a host may raise the defaults up to it). */
const QUOTA_CEILING = 2 ** 40;

/**
 * Delete ranges the room keeps waiting for items it does not hold (a
 * relayer's delete of an author's edit a restore lost). Every update the
 * engine applies re-reads them, so they are capped.
 */
export const MAX_WAITING_DELETES = 1024;

/** Refusals kept in `refusals` (the newest); `refusalCounts` counts every one. */
export const MAX_REFUSALS = 100;

/**
 * A client id and the user who owns it (the room's replica registry). An
 * empty `user` marks an id a restore without a registry left unowned: its
 * first authenticated writer claims it.
 */
export type ReplicaOwner = { replica: number; user: string };

/** What `restoreHistory` did (`room.history.restore`): `refused` when the room holds no such version. */
export type RestoreResult = {
	status: 'applied' | 'noop' | 'refused';
	key: string;
	revived?: number;
	moved?: number;
	rewritten?: number;
	created?: number;
	deleted?: number;
};

/** The document as `onSave` receives it. */
export type SavedDocument = {
	/** The document as JSON. */
	value: JSONDoc;
	/** The full v14 state (`onLoad` takes it back). */
	update: Uint8Array;
	/**
	 * Who owns each client id, read with `update`. Store it beside `update`
	 * and return both from `onLoad`: without it, a restored room cannot
	 * tell which user wrote under which id.
	 */
	replicas: ReplicaOwner[];
};

/** What `onLoad` may return: JSON, a bare v14 update, or `{ update, replicas }` (a `SavedDocument`). */
export type LoadedDocument = JSONDoc | Uint8Array | Pick<SavedDocument, 'update' | 'replicas'>;

/** The header `routeDocumentSocket` sets on an authorized probe: `lastUpdated` or `snapshot`. */
export const PROBE_HEADER = 'X-Edytor-Probe';

/** The transaction origin of the room's own edits (`transact`, `onLoad` seeds). */
export const ROOM_ORIGIN = Symbol('edytor-room');
/** The transaction origin of a history restore: the room's restore history tracks it. */
export const RESTORE_ORIGIN = Symbol('edytor-restore');
/** The transaction origin of the room's purge: tracked by no history. */
export const PURGE_ORIGIN = Symbol('edytor-purge');
/** The header `routeDocumentHistory` sets on an authorized history request. */
export const HISTORY_HEADER = 'X-Edytor-History';
/** The version key of a history `read` or `restore` request. */
export const HISTORY_KEY_HEADER = 'X-Edytor-History-Key';
/** The header `routeDocumentComments` sets on an authorized comments request: `list` or `post`. */
export const COMMENTS_HEADER = 'X-Edytor-Comments';

/**
 * Headers carrying the identity `routeDocumentSocket` verified — never the
 * client's. The user id is percent-encoded (`encodeURIComponent`): a header
 * value is trimmed and cannot carry every character, and a user id is any
 * string.
 */
export const IDENTITY_HEADERS = {
	user: 'X-Edytor-User',
	replica: 'X-Edytor-Replica',
	access: 'X-Edytor-Access',
	/** When the credential expires, ms since the epoch (absent: never). */
	expires: 'X-Edytor-Expires'
} as const;

/**
 * Optional knobs (strings, as `vars` arrive): row size, outgoing frame
 * limit and compaction threshold. The defaults are the platform limits.
 */
export type DocumentRoomEnv = {
	EDYTOR_MAX_ROW_BYTES?: string | number;
	EDYTOR_MAX_FRAME_BYTES?: string | number;
	EDYTOR_COMPACT_AFTER?: string | number;
	EDYTOR_SAVE_AFTER?: string | number;
	EDYTOR_MAX_DOCUMENT_BYTES?: string | number;
	EDYTOR_MAX_INBOUND_FRAME_BYTES?: string | number;
	EDYTOR_MAX_BUFFERED_BYTES?: string | number;
	EDYTOR_MAX_UPDATES_PER_SECOND?: string | number;
	EDYTOR_MAX_PRESENCE_BYTES?: string | number;
	EDYTOR_MAX_PRESENCE_PER_SECOND?: string | number;
	EDYTOR_MAX_PRESENCE_FANOUT?: string | number;
	/** `off`: the room logs nothing (default: one JSON line per compaction, quota hit, denial, fault). */
	EDYTOR_LOG?: string;
	/**
	 * Days after which deleted content is purged (default: the history
	 * retention, else 30); `off` never purges.
	 */
	EDYTOR_PURGE_AFTER_DAYS?: string | number;
	/**
	 * Where the room keeps its version history (`history()`): a KV
	 * namespace or an R2 bucket binding, or the string `room` (the room's own
	 * storage, {@link roomHistory}). Unset: no history.
	 */
	EDYTOR_HISTORY?: KVLike | R2BucketLike | 'room';
	/** Days a version is kept (default 30). */
	EDYTOR_HISTORY_RETENTION_DAYS?: string | number;
	/** The IANA time zone of the history's half-day slots (default `UTC`). */
	EDYTOR_HISTORY_TIME_ZONE?: string;
	/** Per-block locks (`locks()`): the data key naming a block's owner, e.g. `lockedBy`. Unset: none. */
	EDYTOR_LOCKS?: string;
	/**
	 * The namespace of the rooms blocks move to (`rooms()`): the room
	 * forwards late edits of moved blocks there itself. Unset: they wait
	 * for the host's `forwardLateEdits`.
	 */
	EDYTOR_ROOMS?: MoveNamespace;
	/** `off`: the room keeps no comment threads (its comments requests answer `404`). */
	EDYTOR_COMMENTS?: string;
	/** The bytes the room's comments may hold ({@link CommentOptions.maxBytes}). */
	EDYTOR_MAX_COMMENT_BYTES?: string | number;
	/** Comment requests per second ({@link CommentOptions.maxRequestsPerSecond}). */
	EDYTOR_MAX_COMMENT_REQUESTS_PER_SECOND?: string | number;
};

/** What a socket is bound to: its verified user, its replica (Yjs client id), its access. */
export type SocketIdentity = {
	user: string;
	/** `null` until bound — by `authorize`, or by the socket's first presence entry. */
	replica: number | null;
	readOnly: boolean;
	/**
	 * When its credential expires (ms since the epoch, the room's clock):
	 * the room closes it `4401` then (`room.access`). `null` or absent: never.
	 */
	expiresAt?: number | null;
};

/**
 * A socket's attachment (survives hibernation): its identity, its presence
 * clock, and whether it subscribed to the comment changes.
 */
export type Attachment = SocketIdentity & { clock: number | null; comments?: boolean };

export type Refusal = {
	reason:
		| 'generation'
		| 'schema'
		| 'malformed'
		| 'container'
		| 'identity'
		| 'replica'
		| 'read-only'
		// A frame's deletes of items the room lacks, dropped: they would pass
		// MAX_WAITING_DELETES ({ user, ranges }). The rest of the frame applies.
		| 'waiting'
		| 'storage'
		// A fault of the room itself (the engine, a send): the socket is closed 1011.
		| 'internal'
		// A room quota refused the frame ({ user, quota, … }): the socket is closed 4413.
		| 'quota'
		// Not a refusal: the room ended or changed a user's access ({ user, access, sockets }):
		// `expired` (closed 4401), `closed` (`closeUser`), or `setAccess`'s `read`, `write`, `none`
		// (closed 4403).
		| 'access'
		// A presence entry past `maxPresenceBytes` ignored ({ user, quota: 'size', bytes, limit }),
		// or the start of a socket's burst of presence messages past `maxPresencePerSecond`
		// ({ user, quota: 'rate', limit }; one entry per burst, `refusalCounts` counts each
		// message): an entry coalesced (the newest is relayed later), a query dropped. The socket stays.
		| 'presence'
		// A comment request past the room's comment rate ({ user, quota: 'rate', limit }: over
		// HTTP answered 429, a socket's comment message dropped, the socket stays), or a thread
		// or reply past its byte quota ({ user, quota: 'bytes', limit }: refused 413).
		| 'comments'
		// Per-writer block marks (`del.<n>`, `wd.<n>`) the sender may not write
		// or delete, stripped ({ user, writers, ranges }); the rest of the frame applies.
		| 'mark'
		// Attribution entries the sender may not write or delete ({ user, keys }): another
		// replica's binding (`c/<n>`) or another user's profile (`u/<id>`), collected
		// from the frame (a write) or dropped (a delete); the rest of the frame applies.
		| 'forged'
		// Not a refusal: a frame `validate` denied, compensated by the room ({ user, touched }).
		| 'denied'
		// Not a refusal: an id a registry-less restore left unowned, claimed ({ replica, user }).
		| 'orphan'
		// Not a refusal: structs under an id the room held nothing of, delivered by
		// another replica ({ replica, user }) and stored unowned.
		| 'relayed'
		// A version the history could not write ({ key, bytes, limit } past the
		// size limit, { key, error } when the store failed, { room } past the key
		// limit): skipped; or a retention sweep that failed ({ retention, error }).
		| 'history';
	detail: unknown;
};

/** A duration series: how many, their total and longest (ms; see {@link RoomMetrics}). */
export type Timing = { count: number; totalMs: number; maxMs: number; lastMs: number };

/**
 * The room's counters, since this instance started (memory: a wake
 * starts them again), read with `metrics()` (also over RPC). Times are
 * what the runtime's clock reports: Workers advance it only across I/O, so
 * in production synchronous work (a compaction, a fold) often reads `0`;
 * sizes and counts are exact.
 */
export type RoomMetrics = {
	/** The document's size as the document quota measures it: its records, uncompressed. */
	documentBytes: number;
	/** What its rows take in storage (a snapshot compressed). */
	storedBytes: number;
	/** Logical records stored (the generation record included), and their rows. */
	records: number;
	rows: number;
	/** Update records since the last compaction (compaction runs at `compactAfter`). */
	updateRecords: number;
	/** Bytes of updates held waiting for a dependency (in memory, never stored). */
	waitingBytes: number;
	/** The document's open sockets. */
	sockets: number;
	/** Chunk sequences in flight on every socket, and the bytes buffered for them (`maxBufferedBytes`). */
	buffered: { sequences: number; bytes: number };
	/** Compactions run, with their time. */
	compaction: Timing & { lastBytes: number };
	/** Client sync frames folded (applied, indexed, stored and relayed), with their time. */
	fold: Timing;
	/** Frames sent to other sockets (relays, presence, acknowledgements to others), and their bytes. */
	fanOut: { messages: number; bytes: number };
	/** Writes refused by a quota (`quota` refusals) and frames `validate` denied. */
	quotaHits: number;
	validationDenials: number;
	/** Every refusal, by reason (as `refusalCounts`). */
	refusals: Partial<Record<Refusal['reason'], number>>;
	/** Versions written to the history, skipped (`history` refusals), and the last key written. */
	history: { written: number; skipped: number; lastKey: string | null };
	/** Purges run and what they wrote, summed; the last horizon purged (ms since the epoch). */
	purge: PurgeReport & { runs: number; horizon: number | null };
	/** When this instance started (ms since the epoch). */
	since: number;
};

/** One line of the room's log: a compaction, a quota hit, a denial, a fault. */
export type RoomLogEntry =
	| { edytor: 'compaction'; ms: number; bytes: number; records: number; rows: number }
	| { edytor: 'history'; key: string; bytes: number; editors: number }
	| { edytor: 'restore'; key: string; user: string | null; undo: boolean }
	| { edytor: 'comment'; type: CommentChange['type']; thread: string; user: string }
	| ({ edytor: 'purge'; horizon: number; bytes: number } & PurgeReport)
	| { edytor: 'quota'; user: string; quota: string }
	| { edytor: 'denied'; user: string; touched: number }
	// A client's advertised roles differ from the room's on these kinds (development builds).
	| { edytor: 'semantics'; user: string; kinds: string[] }
	| { edytor: 'fault'; reason: 'storage' | 'internal'; detail: string }
	| { edytor: 'convert'; from: number; to: number; blocks: number; bytes: number }
	| { edytor: 'move'; moveId: string; role: 'out' | 'in'; peer: string; blocks: number }
	| {
			edytor: 'late';
			moveId: string;
			seq: number;
			edits: number;
			structural: number;
			forwarded: boolean;
	  };

/** `pending`: deletes of items the room does not hold yet (they wait for them). */
type RowKind = 'generation' | 'update' | 'snapshot' | 'pending';

/**
 * An upgrade accepted and closed at once, so the client reads `code`: a
 * browser sees an HTTP error at the upgrade only as `1006`, which a
 * provider cannot tell from a network failure. Refuse a dial your Worker
 * turns away itself with it: the provider stops at `1008` or `4xxx`
 * (except `4401`, redialed), and redials after anything else (`CLOSE`,
 * `isRefusal` in `crdt/providers/room.ts`).
 */
export const closedSocket = (code: number, reason: string): Response => {
	const [client, server] = Object.values(new WebSocketPair());
	server.accept();
	server.close(code, reason);
	return new Response(null, { status: 101, webSocket: client });
};

/** A stored record, reassembled: its kind, record number, bytes, and whether they are v2 (a v2 container's snapshot). */
export type StoredRecord = {
	kind: RowKind;
	record: number;
	bytes: Uint8Array<ArrayBuffer>;
	v2: boolean;
};

/** Run an entry point with timers forbidden — a pending timer keeps a Durable Object from hibernating. */
export const noTimers = <T>(fn: () => T): T => {
	const g = globalThis as Record<string, unknown>;
	const saved = [g.setTimeout, g.setInterval];
	const forbidden = () => {
		throw new Error('room scheduled a timer (a Durable Object could not hibernate)');
	};
	g.setTimeout = forbidden;
	g.setInterval = forbidden;
	try {
		return fn();
	} finally {
		[g.setTimeout, g.setInterval] = saved;
	}
};

// ── Validation ────────────────────────────────────────────────

/** A block as `validate` reads it, before or after a frame. */
export type ValidatedBlock = {
	id: string;
	type: string;
	data: Record<string, unknown>;
	content: NonNullable<JSONBlock['content']>;
	/** Its display parent (`null`: the document's root). */
	parent: string | null;
};

/** One client frame the room applied, as `validate` reads it. */
export type FrameValidation = {
	/** The sender's verified user. */
	user: string;
	/** The sender's replica (client id), when bound. */
	replica: number | null;
	/**
	 * The blocks the frame changed, from the facade's change report: shown
	 * or hidden (with their subtrees), given another parent or moved among
	 * their siblings (not shifted by a sibling's move), retyped, given
	 * other data, or other content.
	 */
	touched: string[];
	/** The frame changed the document's own data. */
	dataChanged: boolean;
	/** A block as it was before the frame (`null`: it did not show). */
	before: (id: string) => ValidatedBlock | null;
	/** A block as it is now (`null`: it does not show). */
	after: (id: string) => ValidatedBlock | null;
	/** The live document. Read it; never write from `validate` (defer a `transact` instead). */
	facade: DocumentOperations;
};

/** The room's comment threads (`comments` of {@link AttachRoomOptions}). */
export type CommentOptions = {
	/**
	 * Notifications: called after each change is stored and sent to the
	 * sockets (a thread added, a reply, a resolve or reopen, a delete),
	 * awaited before the request is answered. A throw is logged; the change
	 * stands.
	 */
	onComment?: (change: CommentChange) => void | Promise<void>;
	/** The longest comment body (default and ceiling 10,000 characters). */
	maxLength?: number;
	/**
	 * The bytes the room's comments may hold (default
	 * {@link DEFAULT_MAX_COMMENT_BYTES}, 4 MiB): each body and quote in UTF-8
	 * plus 128 a comment. A thread or reply past it is refused `413`; a
	 * delete frees its bytes.
	 */
	maxBytes?: number;
	/**
	 * Comment requests per second (default
	 * {@link DEFAULT_MAX_COMMENT_REQUESTS_PER_SECOND}, a ten-second burst):
	 * over HTTP per verified user (past it, `429`), and a socket's comment
	 * messages per socket (past it, dropped). RPC calls are the host's own and
	 * are not counted.
	 */
	maxRequestsPerSecond?: number;
};

/** The bytes a room's comments hold at most, by default (4 MiB). */
export const DEFAULT_MAX_COMMENT_BYTES = 4 * 1024 * 1024;
/** Comment requests per second and user (or socket), by default. */
export const DEFAULT_MAX_COMMENT_REQUESTS_PER_SECOND = 2;

/** What {@link attachRoom} (and `DocumentRoom`) takes. */
export type AttachRoomOptions = {
	/**
	 * Retrieve: the document for a room that stores nothing yet. Return
	 * JSON, `{ update, replicas }` from `onSave` (a bare `update` restores
	 * the content, but not who owns which client id), or nothing for an
	 * empty room. Nothing is stored until it settles, so it is asked again
	 * at each start (and after a throw, at the next dial) until something
	 * is stored. A payload the room refuses (another generation or schema,
	 * undecodable bytes, another shape) refuses every socket (1008).
	 */
	onLoad?: () => Promise<LoadedDocument | null | undefined> | LoadedDocument | null | undefined;
	/**
	 * Save: mirror the document to your own store, `saveAfter` ms after the
	 * first unsaved change, on the object's alarm (a throw is retried by the
	 * platform). Without it no alarm is ever set.
	 */
	onSave?: (document: SavedDocument) => Promise<void> | void;
	/** ms between the first unsaved change and `onSave` (default {@link DEFAULT_SAVE_AFTER}). */
	saveAfter?: number;
	/** Update records before the rows are merged into one snapshot (default {@link DEFAULT_COMPACT_AFTER}). */
	compactAfter?: number;
	/** Largest stored row; can only be lowered (default {@link DEFAULT_MAX_ROW_BYTES}). */
	maxRowBytes?: number;
	/** Largest frame sent whole; can only be lowered (default 32 MiB). */
	maxFrameBytes?: number;
	/** Prefix of the document's SQL tables, beside your own (default `'edytor_'`). */
	tablePrefix?: string;
	/** Largest document, in stored bytes (default {@link DEFAULT_MAX_DOCUMENT_BYTES}). */
	maxDocumentBytes?: number;
	/** Largest frame a socket may send, reassembled (default {@link DEFAULT_MAX_INBOUND_FRAME_BYTES}). */
	maxInboundFrameBytes?: number;
	/**
	 * The chunk sequences in flight on every socket together (default twice
	 * `maxInboundFrameBytes`, never less than it): a sequence that would
	 * pass it closes its socket `1011` (`room busy`), and its provider
	 * redials.
	 */
	maxBufferedBytes?: number;
	/** Sync messages per second a socket may send (default {@link DEFAULT_MAX_UPDATES_PER_SECOND}). */
	maxUpdatesPerSecond?: number;
	/** Largest presence state a socket may publish, as JSON (default {@link DEFAULT_MAX_PRESENCE_BYTES}). */
	maxPresenceBytes?: number;
	/** Presence messages per second a socket may send (default {@link DEFAULT_MAX_PRESENCE_PER_SECOND}). */
	maxPresencePerSecond?: number;
	/** Presence frames per second the room sends over all its sockets (default {@link DEFAULT_MAX_PRESENCE_FANOUT}). */
	maxPresenceFanout?: number;
	/**
	 * Accept, then compensate: after the room applied and stored a
	 * client frame that changed blocks, it is asked whether to keep it.
	 * `false` (or a throw) denies it: the room writes the frame's inverse as
	 * its own transaction — the history undo of exactly that frame
	 * (`room.validate.inverse`) — stores it and sends it to every socket,
	 * the sender's included, so every replica converges. The frame stays
	 * stored and acknowledged and the socket open. Synchronous; runs only
	 * when set (the room then keeps an index of every block's state).
	 */
	validate?: (frame: FrameValidation) => boolean | void;
	/**
	 * Per-block locks (`room.locks`): a block whose data names a user
	 * under `key` (default `lockedBy`) is that user's alone — a frame from
	 * anyone else touching it is denied and compensated, as `validate`'s
	 * denials are ({@link lockedBlocks}). Asked before `validate`.
	 */
	locks?: LockOptions;
	/**
	 * The rooms blocks move to (`room.move`): with it, the room forwards
	 * the late edits of blocks it moved out to their destination itself, on
	 * its alarm; without it, they wait for the host's `forwardLateEdits`.
	 */
	rooms?: () => MoveNamespace | undefined;
	/**
	 * The room's log: one entry per compaction, quota hit, denial or
	 * fault. Default: `console.log` of the entry as JSON (Workers Logs and
	 * `wrangler tail` collect it); `false` logs nothing.
	 */
	log?: ((entry: RoomLogEntry) => void) | false;
	/**
	 * The block roles `transact` edits obey — the document semantics your
	 * clients' plugins declare (`defaultType` also names the block an empty
	 * room is seeded with). Default
	 * {@link defaultSemantics} (the bundled rich-text, code and image kinds).
	 */
	semantics?: DocumentSemanticsConfig;
	/**
	 * Version history in KV (`room.history.*`): the room writes its
	 * state twice a day — the morning's at local noon, the evening's at
	 * midnight, in `timeZone` — when it changed, for `retentionDays`; read
	 * and restore them with `listHistory`, `readHistory`, `restoreHistory`
	 * and `undoRestore` (or `routeDocumentHistory`). Without it, no history.
	 */
	history?: HistoryOptions;
	/**
	 * Days after which deleted content is purged from the room and every
	 * replica (`room.purge.*`): default the history's `retentionDays`,
	 * else 30; `false` never purges.
	 */
	purgeAfterDays?: number | false;
	/** The room's clock, ms since the epoch (default `Date.now`): its slots, epochs and alarm read it. */
	now?: () => number;
	/**
	 * Comment threads (`room.comments`): kept in the room's `threads` and
	 * `comments` tables, read and written through `routeDocumentComments`
	 * (or `listComments` and `comment` over RPC), each change sent to the
	 * sockets that subscribed. On by default; `false` keeps none.
	 */
	comments?: CommentOptions | false;
};

/** `EDYTOR_PURGE_AFTER_DAYS`: `off` (or `false`) never purges; a number of days; anything else the default. */
const purgeAfterDays = (value: unknown): number | false | undefined => {
	if (value === 'off' || value === 'false' || value === false) return false;
	const n = Number(value);
	return Number.isInteger(n) && n > 0 ? n : undefined;
};

/** The tag of the document's sockets: other sockets of the object are left to you. */
export const SOCKET_TAG = 'edytor';

/**
 * One edytor document living in a Durable Object's storage: the room
 * logic, independent of the class that hosts it. Create it with
 * {@link attachRoom} (any Durable Object) or extend `DocumentRoom`.
 * The socket handlers ignore sockets without {@link SOCKET_TAG} and
 * return `false` for them.
 */
export class AttachedDocument {
	readonly ctx: DurableObjectState;
	readonly maxRowBytes: number;
	readonly maxFrameBytes: number;
	readonly compactAfter: number;
	readonly saveAfter: number;
	readonly maxDocumentBytes: number;
	readonly maxInboundFrameBytes: number;
	readonly maxBufferedBytes: number;
	readonly maxUpdatesPerSecond: number;
	readonly maxPresenceBytes: number;
	readonly maxPresencePerSecond: number;
	readonly maxPresenceFanout: number;
	/** Why the stored container was refused (another generation, a torn record, `onLoad`…). */
	failure: Error | null = null;
	/** Latest presence entry per replica, for join snapshots (memory: refills after a wake). */
	presence = new Map<number, AwarenessEntry>();
	/** The newest {@link MAX_REFUSALS} refusals since this instance started (diagnostics; memory only). */
	refusals: Refusal[] = [];
	/** Every refusal since this instance started, by reason. */
	refusalCounts: Partial<Record<Refusal['reason'], number>> = {};
	/** How this instance came to be: a fresh container, or a restore of N stored records. */
	origin:
		| { kind: 'fresh' }
		| { kind: 'restored'; records: number }
		| { kind: 'converted'; from: number; records: number } = { kind: 'fresh' };
	/** The room's parts and what they share (`room/context.ts`). */
	private readonly room: RoomContext;

	constructor(ctx: DurableObjectState, options: AttachRoomOptions = {}) {
		this.ctx = ctx;
		this.maxRowBytes = knob(options.maxRowBytes, DEFAULT_MAX_ROW_BYTES);
		this.maxFrameBytes = knob(options.maxFrameBytes, E.MAX_FRAME_BYTES);
		this.compactAfter = knob(options.compactAfter, DEFAULT_COMPACT_AFTER, 1e9);
		this.saveAfter = knob(options.saveAfter, DEFAULT_SAVE_AFTER, 1e9);
		this.maxDocumentBytes = knob(
			options.maxDocumentBytes,
			DEFAULT_MAX_DOCUMENT_BYTES,
			QUOTA_CEILING
		);
		this.maxInboundFrameBytes = knob(
			options.maxInboundFrameBytes,
			DEFAULT_MAX_INBOUND_FRAME_BYTES,
			QUOTA_CEILING
		);
		this.maxBufferedBytes = Math.max(
			this.maxInboundFrameBytes,
			knob(options.maxBufferedBytes, 2 * this.maxInboundFrameBytes, QUOTA_CEILING)
		);
		this.maxUpdatesPerSecond = knob(
			options.maxUpdatesPerSecond,
			DEFAULT_MAX_UPDATES_PER_SECOND,
			QUOTA_CEILING
		);
		this.maxPresenceBytes = knob(
			options.maxPresenceBytes,
			DEFAULT_MAX_PRESENCE_BYTES,
			QUOTA_CEILING
		);
		this.maxPresencePerSecond = knob(
			options.maxPresencePerSecond,
			DEFAULT_MAX_PRESENCE_PER_SECOND,
			QUOTA_CEILING
		);
		this.maxPresenceFanout = knob(
			options.maxPresenceFanout,
			DEFAULT_MAX_PRESENCE_FANOUT,
			QUOTA_CEILING
		);
		const room = new RoomContext(ctx, options, this, this);
		this.room = room;
		room.storage = new RoomStorage(room);
		room.scheduler = new Scheduler(room, {
			history: () => room.history.closeSlot(),
			save: () => room.storage.save(),
			purge: () => {
				room.purge.tick();
			},
			retention: () => room.history.expireVersions(),
			forward: () => room.moves.forwardMoves(),
			expiry: () => noTimers(() => room.access.expireSockets())
		});
		room.admission = new Admission(room);
		room.replicas = new ReplicaRegistry(room);
		room.validation = new RoomValidation(room);
		room.history = new RoomHistory(room);
		room.purge = new RoomPurge(room);
		room.moves = new RoomMoves(room);
		room.presence = new RoomPresence(room);
		room.access = new RoomAccess(room);
		room.comments = new RoomComments(room);
		// The provider pings a silent socket: answer without waking the object.
		if (ctx.setWebSocketAutoResponse && !ctx.getWebSocketAutoResponse?.()) {
			ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
		}
		void ctx.blockConcurrencyWhile(() => room.storage.start());
	}

	// ── Server-side access ───────────────────────────────────────────────

	/**
	 * The live document; `null` when the stored container was refused.
	 * Like {@link facade}, reading it first drops a direct write whose
	 * append failed (`heal`, only while the room is idle), so the next
	 * write through it is stored.
	 */
	get doc(): YDoc | null {
		noTimers(() => this.room.storage.heal());
		return this.room.live;
	}

	/**
	 * The facade over the live document. Read while the room is idle, it
	 * first drops a direct write whose append failed (`heal`), so the next
	 * write through it is stored.
	 */
	get facade(): DocumentOperations {
		return this.room.facade;
	}

	/**
	 * Manipulate: run `fn` on the facade in one transaction. The edit is
	 * stored, then broadcast to every socket. It is not a rollback, like
	 * every client-side `transact`: when `fn` throws, what it wrote before
	 * the throw is kept (stored and broadcast) and its error is rethrown —
	 * validate before writing, or apply one `facade.prepare.*` plan. When
	 * the append fails, the storage error is thrown instead and nothing is
	 * kept (the live doc is rebuilt from the stored rows). A call inside
	 * `fn` joins the enclosing one. An empty room is first seeded with one
	 * empty block, as a client with no `value` would. Called anywhere else
	 * inside a transaction or its events — a `facade.onChange` subscriber
	 * (of a client's frame or of the room's own `transact`), a
	 * `doc.on('afterAllTransactions')` listener during a frame — it throws
	 * without writing: the engine would queue the write until that one
	 * ends, so it could not be stored before returning.
	 */
	transact<T>(fn: (facade: DocumentOperations) => T): T {
		return this.room.transact(fn);
	}

	/** The document as JSON. */
	read(): JSONDoc {
		return this.room.read();
	}

	/**
	 * The room's one alarm (`room.alarm.tasks`): every task due at its time
	 * runs — the history slot (`room.history.slots`), `onSave`, the purge
	 * (`room.purge.timing`) — each re-arming itself or clearing its due
	 * row; then the alarm is set to the earliest due time left. While the
	 * rows cannot be read (a retryable failure), it starts the room again;
	 * if that fails too, the save stays due, later at each failure (up to 5
	 * minutes), so the mirror never silently lags what the room stored. A
	 * throw from `onSave` keeps it due and is rethrown (the platform retries).
	 */
	alarm(): Promise<void> {
		return this.room.scheduler.alarm();
	}

	/**
	 * Generation cutover: drop the stored document (both tables) of a room
	 * whose storage belongs to another edytor generation, and start again
	 * from `onLoad` — reseed it from JSON. Refused for any other room.
	 */
	reset(): Promise<void> {
		return this.room.storage.reset();
	}

	// ── Storage ──────────────────────────────────────────────────────────

	/**
	 * Reassembled logical records in write order (of one kind, with
	 * `only`); a torn record throws. A v2 container's snapshot is v2
	 * (`v2`), inflated when it is stored compressed.
	 */
	records(only?: RowKind): StoredRecord[] {
		return this.room.storage.records(only);
	}

	/**
	 * Resolves once the snapshot compression in flight, if any, is stored: a compaction stores its snapshot raw, then compresses it in
	 * place. Wait for it before reading the rows' sizes.
	 */
	compressed(): Promise<void> {
		return this.room.storage.compressed();
	}

	/**
	 * Compaction: the rows become the generation record + one chunked
	 * snapshot of the live document's state (the healed state, deleted
	 * content collected but the text a replica may copy again —
	 * never a merge of the records, which keeps every keystroke's struct
	 * and every deleted character), atomically, + one
	 * `pending` record of the stored deletes still waiting. A waiting delete
	 * of a client id no user registered and no socket holds is reclaimed,
	 * in memory too: nothing can deliver its item (a made-up id) — the
	 * registrations of ids with waiting deletes are kept. The registry
	 * keeps the ids holding content and those bound to an open socket; the
	 * others (page loads that never wrote) are dropped, and re-register at
	 * their next dial or write. Runs by itself after `compactAfter` update
	 * records; callable over RPC (e.g. from the host's own alarm).
	 */
	compact(): { rows: number } {
		return this.room.storage.compact();
	}

	/**
	 * When the room last stored a change (ms since the epoch), or `null`
	 * for a room that stored none since 0.1.0-next.23. Cheap: one
	 * row, no document. `routeDocumentSocket` answers it over HTTP
	 * (`GET <room>?lastUpdated`), also over RPC.
	 */
	lastUpdated(): number | null {
		return this.room.storage.lastUpdated();
	}

	// ── History ────────────────────────────────────────────────────

	/**
	 * Resolves once the versions the room is writing are stored (a slot a
	 * write closed is written in the background).
	 */
	historyWritten(): Promise<void> {
		return this.room.history.written();
	}

	/**
	 * The room's versions, newest first: one per half-day slot that
	 * changed, for the retention (`room.history.slots`). Throws when the
	 * room keeps no history.
	 */
	listHistory(): Promise<HistoryEntry[]> {
		return this.room.history.list();
	}

	/** Version `key` as JSON (a preview), or `null` when this room holds no such version. */
	readHistory(key: string): Promise<JSONDoc | null> {
		return this.room.history.read(key);
	}

	/**
	 * Restore version `key` as a forward edit (`room.history.restore`): one
	 * room transaction makes the visible document equal the version, keeping
	 * every id the registry holds and writing only what differs; stored,
	 * relayed to every socket, one step `undoRestore` undoes. `user` (the
	 * restorer) is recorded as the slot's editor and in the log. `refused`:
	 * this room holds no such version (expired, another room's key).
	 */
	restoreHistory(key: string, options: { user?: string } = {}): Promise<RestoreResult> {
		return this.room.history.restore(key, options);
	}

	/**
	 * Undo the last restore (`room.history.undo`): the history undo of
	 * exactly its transaction, edits made since kept. One level: `noop` when
	 * no restore stands (none, undone already, or past the purge horizon).
	 */
	undoRestore(options: { user?: string } = {}): Promise<{ status: 'applied' | 'noop' }> {
		return this.room.history.undoRestore(options);
	}

	// ── Comments (`room.comments`) ───────────────────────────────────────

	/** Every comment thread, oldest first, with the last change's sequence number (also over RPC). */
	listComments(): CommentSnapshot {
		return this.room.comments.list();
	}

	/**
	 * One comments request by `actor` (also over RPC): add a thread, reply,
	 * resolve, reopen or delete, under the rules every store applies. An
	 * applied change is stored, sent to every socket that subscribed, and
	 * passed to `onComment`; a removed thread's anchor marks leave the
	 * document as one room transaction. A `moderator` may delete anyone's
	 * comment.
	 */
	comment(request: CommentRequest, actor: CommentActor): Promise<CommentOutcome> {
		return this.room.comments.apply(request, actor);
	}

	// ── Moves (`room.move`) ─────────────────────────────────────────

	/**
	 * Export blocks `ids` for a move (`room.move`, step 1): their visible
	 * subtrees as JSON, the outermost only, in document order. Writes
	 * nothing to the document; records the export (`moveId`) for
	 * `commitMove`. Throws when none of them shows.
	 */
	exportBlocks(ids: string[]): ExportedBlocks {
		return this.room.moves.exportBlocks(ids);
	}

	/**
	 * Import a move's blocks (`room.move`, step 2) under `dest.parent` at
	 * `dest.index`, as one room transaction: each keeps its id unless this
	 * document holds it already (then `<id>~<n>`). Idempotent: a second
	 * call with the same `moveId` writes nothing and returns the same ids,
	 * the acknowledgement `commitMove` needs.
	 */
	importBlocks(request: ImportRequest): ImportReceipt {
		return this.room.moves.importBlocks(request);
	}

	/**
	 * Commit a move (`room.move`, step 3), with the destination's
	 * acknowledgement: delete the exported blocks with their subtrees, as
	 * one room transaction, and watch them for late edits (`room.move.late`)
	 * for the grace period. Idempotent; `refused` for an unknown or aborted
	 * move.
	 */
	commitMove(moveId: string, receipt: { to: string; ids: Record<string, string> }): CommitResult {
		return this.room.moves.commitMove(moveId, receipt);
	}

	/** Drop an export that was not committed (`room.move`): the blocks stay. */
	abortMove(moveId: string): { moveId: string; status: 'applied' | 'noop' } {
		return this.room.moves.abortMove(moveId);
	}

	/** The late edits waiting to reach their destination (`room.move.late`), oldest first. */
	lateEdits(): LateEditBatch[] {
		return this.room.moves.lateEdits();
	}

	/** The destination applied a move's late edits through `seq`: they are dropped here. */
	ackLateEdits(moveId: string, seq: number): void {
		this.room.moves.ackLateEdits(moveId, seq);
	}

	/**
	 * Apply a batch of late edits of a move this room imported
	 * (`room.move.late`): each block's content and data merged three ways
	 * into what it holds now (what was written here since stays), as one
	 * room transaction. Idempotent by sequence number; a block that no
	 * longer shows is skipped. Returns the last sequence applied.
	 */
	applyLateEdits(batch: LateEditBatch): { applied: number; skipped: string[] } {
		return this.room.moves.applyLateEdits(batch);
	}

	// ── Purge ───────────────────────────────────────────────────────

	/**
	 * The purge task, also over RPC (`room.purge.timing`): record an epoch
	 * (the state vector, now) when the document changed since the last one,
	 * purge what was deleted before the horizon — the newest epoch at least
	 * `purgeAfterDays` old — when it is newer than the last purged, and
	 * re-arm for the next epoch to pass it. Returns what the purge wrote, or
	 * `null` when nothing was past the horizon.
	 */
	purge(): (PurgeReport & { horizon: number }) | null {
		return this.room.purge.tick();
	}

	/** The room's counters, also over RPC — see {@link RoomMetrics}. */
	metrics(): RoomMetrics {
		const room = this.room;
		return noTimers(() => {
			const stored = room.live === null ? null : room.storage.usage();
			const { counters } = room;
			return {
				documentBytes: room.storage.documentBytes,
				storedBytes: stored?.bytes ?? 0,
				records: stored?.records ?? 0,
				rows: stored?.rows ?? 0,
				updateRecords: room.storage.updates,
				waitingBytes: room.live?.store.pendingStructs?.update.length ?? 0,
				sockets: this.ctx.getWebSockets(SOCKET_TAG).length,
				buffered: room.admission.buffered(),
				compaction: { ...counters.compaction },
				fold: { ...counters.fold },
				fanOut: { ...counters.fanOut },
				quotaHits: this.refusalCounts.quota ?? 0,
				validationDenials: this.refusalCounts.denied ?? 0,
				refusals: { ...this.refusalCounts },
				history: { ...counters.history },
				purge: { ...counters.purge },
				since: counters.since
			};
		});
	}

	/**
	 * Drop every waiting delete, stored or in memory (callable over RPC):
	 * the way out when a writer filled {@link MAX_WAITING_DELETES} with
	 * deletes of registered ids' items, which compaction keeps. A dropped
	 * delete's item shows if it ever arrives — but for an entry a waiting
	 * rewrite replaces, which that rewrite deletes should it integrate.
	 * Returns how many ranges were dropped.
	 */
	dropWaitingDeletes(): { ranges: number } {
		return this.room.storage.dropWaitingDeletes();
	}

	// ── Hibernation WebSocket API ────────────────────────────────────────

	fetch(request: Request): Promise<Response> {
		return this.room.access.fetch(request);
	}

	// ── Access (`room.access`) ───────────────────────────────────────────

	/**
	 * Revoke: close every socket of `userId` (also over RPC), `4403`
	 * (`access revoked`, final for the provider) unless you pass another
	 * `code` (`4401` redials with fresh `params`; `1011` redials too).
	 * Call it when the user loses access to the document, or signs out:
	 * `authorize` decides at every dial, the room only at the dial.
	 * Returns how many sockets it closed. A `code` a socket cannot be
	 * closed with (only `1000`, `1011`, `1012` and `3000`–`4999` can) or a
	 * `reason` over 123 UTF-8 bytes throws a `RangeError` before anything
	 * is closed or announced.
	 */
	closeUser(userId: string, code: number = CLOSE.denied, reason?: string): { sockets: number } {
		return this.room.access.closeUser(userId, code, reason);
	}

	/**
	 * Change `userId`'s access on its open sockets (also over RPC):
	 * `'read'` downgrades each write socket in place (the read-only notice,
	 * then every write denied, the socket stays); `'write'` closes each
	 * read-only socket `1012` (`access changed`), which its provider
	 * redials, so `authorize` grants the new access; `'none'` closes every
	 * socket `4403` (`access revoked`), as {@link closeUser}. Your `authorize` must decide the
	 * same from then on. Returns how many sockets it changed.
	 */
	setAccess(userId: string, access: 'write' | 'read' | 'none'): { sockets: number } {
		return this.room.access.setAccess(userId, access);
	}

	/** Is `ws` one of this document's sockets? */
	owns(ws: WebSocket): boolean {
		return this.ctx.getTags(ws).includes(SOCKET_TAG);
	}

	webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): boolean {
		if (!this.owns(ws)) return false;
		this.room.admission.message(ws, message);
		return true;
	}

	webSocketClose(ws: WebSocket, code: number, reason: string): boolean {
		if (!this.owns(ws)) return false;
		this.room.admission.forget(ws);
		noTimers(() => this.room.presence.depart(ws));
		// Complete the closing handshake (a no-op where the runtime already
		// auto-replies). 1005/1006 are not sendable codes.
		try {
			ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
		} catch {
			// already closed
		}
		return true;
	}

	webSocketError(ws: WebSocket): boolean {
		if (!this.owns(ws)) return false;
		this.room.admission.forget(ws);
		noTimers(() => this.room.presence.depart(ws));
		return true;
	}
}

type Handler = 'fetch' | 'webSocketMessage' | 'webSocketClose' | 'webSocketError' | 'alarm';

/**
 * Attach an edytor room to any Durable Object (`attachRoom(this, opts)`,
 * in the constructor or a field). Its tables (`edytor_rows`,
 * `edytor_replicas`) live beside yours and its sockets carry
 * {@link SOCKET_TAG}. Each handler your class does not define —
 * `fetch`, `webSocketMessage`, `webSocketClose`, `webSocketError` and
 * `alarm` (a socket's credential may expire) — is installed on the
 * object; a class that
 * defines one delegates to the returned document's method (which returns
 * `false` for a socket that is not the document's).
 */
export const attachRoom = (
	host: DurableObject<any>,
	options: AttachRoomOptions = {}
): AttachedDocument => {
	const ctx = (host as unknown as { ctx?: DurableObjectState } | null)?.ctx;
	if (!ctx?.storage) {
		throw new TypeError(
			'attachRoom(this): `this` must be a Durable Object (a class extending DurableObject, after super())'
		);
	}
	const document = new AttachedDocument(ctx, options);
	const target = host as unknown as Record<Handler, unknown>;
	// The alarm runs `onSave`, the history slots, the purge and the sockets'
	// expiry (`room.alarm.tasks`).
	const handlers: Handler[] = [
		'fetch',
		'webSocketMessage',
		'webSocketClose',
		'webSocketError',
		'alarm'
	];
	for (const name of handlers) {
		if (typeof target[name] === 'function') continue;
		target[name] = (...args: never[]) => (document[name] as (...a: never[]) => unknown)(...args);
	}
	return document;
};

/**
 * The ready-made room: a Durable Object hosting one document, configured
 * by `vars` ({@link DocumentRoomEnv}). Subclass it to override `onLoad` and
 * `onSave`, and add your own RPC methods over `transact`/`read`. Its tables
 * are `rows` and `replicas` (no prefix).
 */
export class DocumentRoom<
	// Unconstrained: an all-optional constraint would reject an Env naming none of the knobs.
	Env = DocumentRoomEnv
> extends DurableObject<Env> {
	readonly room: AttachedDocument;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		const knobs = env as DocumentRoomEnv;
		const saves = this.onSave !== DocumentRoom.prototype.onSave;
		const validates = this.validate !== DocumentRoom.prototype.validate;
		const semantics = () => this.semantics();
		const history = () => this.history();
		const locks = () => this.locks();
		const comments = (): CommentOptions | false =>
			String(knobs.EDYTOR_COMMENTS ?? '') === 'off'
				? false
				: {
						onComment: (change) => this.onComment(change),
						maxBytes: Number(knobs.EDYTOR_MAX_COMMENT_BYTES),
						maxRequestsPerSecond: Number(knobs.EDYTOR_MAX_COMMENT_REQUESTS_PER_SECOND)
					};
		this.room = new AttachedDocument(ctx, {
			maxRowBytes: Number(knobs.EDYTOR_MAX_ROW_BYTES),
			maxFrameBytes: Number(knobs.EDYTOR_MAX_FRAME_BYTES),
			compactAfter: Number(knobs.EDYTOR_COMPACT_AFTER),
			saveAfter: Number(knobs.EDYTOR_SAVE_AFTER),
			maxDocumentBytes: Number(knobs.EDYTOR_MAX_DOCUMENT_BYTES),
			maxInboundFrameBytes: Number(knobs.EDYTOR_MAX_INBOUND_FRAME_BYTES),
			maxBufferedBytes: Number(knobs.EDYTOR_MAX_BUFFERED_BYTES),
			maxUpdatesPerSecond: Number(knobs.EDYTOR_MAX_UPDATES_PER_SECOND),
			maxPresenceBytes: Number(knobs.EDYTOR_MAX_PRESENCE_BYTES),
			maxPresencePerSecond: Number(knobs.EDYTOR_MAX_PRESENCE_PER_SECOND),
			maxPresenceFanout: Number(knobs.EDYTOR_MAX_PRESENCE_FANOUT),
			tablePrefix: '',
			purgeAfterDays: purgeAfterDays(knobs.EDYTOR_PURGE_AFTER_DAYS),
			now: () => this.now(),
			// Getters: a subclass's fields do not exist yet in this constructor.
			get semantics() {
				return semantics();
			},
			get history() {
				return history();
			},
			get locks() {
				return locks();
			},
			get comments() {
				return comments();
			},
			rooms: () => this.rooms(),
			onLoad: () => this.onLoad(),
			onSave: saves ? (document) => this.onSave(document) : undefined,
			validate: validates ? (frame) => this.validate(frame) : undefined,
			log: (entry) => this.log(entry)
		});
	}

	/** Retrieve — see {@link AttachRoomOptions.onLoad}. */
	protected async onLoad(): Promise<LoadedDocument | null | undefined> {
		return undefined;
	}

	/** Save — see {@link AttachRoomOptions.onSave}. Not overridden: no alarm is ever set. */
	protected async onSave(_document: SavedDocument): Promise<void> {}

	/**
	 * Validate a client frame — see {@link AttachRoomOptions.validate}:
	 * `false` denies it, and the room writes its inverse. Not overridden: no
	 * frame is validated, and no block index is kept.
	 */
	protected validate(_frame: FrameValidation): boolean | void {}

	/**
	 * Notifications — see {@link CommentOptions.onComment}: each comment
	 * change, once stored. Not overridden: nothing is called.
	 */
	protected onComment(_change: CommentChange): void | Promise<void> {}

	/**
	 * One log entry: `console.log` of it as JSON, unless the
	 * `EDYTOR_LOG` var is `off`. Override it to send entries elsewhere.
	 */
	protected log(entry: RoomLogEntry): void {
		if (String((this.env as DocumentRoomEnv).EDYTOR_LOG ?? '') === 'off') return;
		console.log(JSON.stringify(entry));
	}

	/**
	 * Block roles — see {@link AttachRoomOptions.semantics}. Read once,
	 * at first use (after construction: it may return a subclass field).
	 */
	protected semantics(): DocumentSemanticsConfig {
		return defaultSemantics;
	}

	/**
	 * Version history — see {@link AttachRoomOptions.history}. Default:
	 * `EDYTOR_HISTORY` — a KV namespace binding ({@link kvHistory}), an R2
	 * bucket binding ({@link r2History}) or the string `room` (the room's
	 * own storage, {@link roomHistory}) — with `EDYTOR_HISTORY_RETENTION_DAYS`
	 * and `EDYTOR_HISTORY_TIME_ZONE`; none without it. Read once, at first use.
	 */
	protected history(): HistoryOptions | undefined {
		const env = this.env as DocumentRoomEnv;
		const binding = env.EDYTOR_HISTORY;
		if (!binding) return undefined;
		return {
			store:
				binding === 'room'
					? roomHistory()
					: isR2Bucket(binding)
						? r2History(binding)
						: typeof binding === 'string'
							? () => {
									throw new Error(`EDYTOR_HISTORY: unknown store ${JSON.stringify(binding)}`);
								}
							: kvHistory(binding),
			retentionDays: Number(env.EDYTOR_HISTORY_RETENTION_DAYS) || undefined,
			timeZone: env.EDYTOR_HISTORY_TIME_ZONE || undefined
		};
	}

	/**
	 * Per-block locks — see {@link AttachRoomOptions.locks}. Default: the
	 * `EDYTOR_LOCKS` var names the data key (`{ key }`); none without it.
	 * Read once, at the first frame.
	 */
	protected locks(): LockOptions | undefined {
		const key = (this.env as DocumentRoomEnv).EDYTOR_LOCKS;
		return typeof key === 'string' && key !== '' ? { key } : undefined;
	}

	/**
	 * The rooms blocks move to — see {@link AttachRoomOptions.rooms}.
	 * Default: the `EDYTOR_ROOMS` binding; none without it.
	 */
	protected rooms(): MoveNamespace | undefined {
		return (this.env as DocumentRoomEnv).EDYTOR_ROOMS;
	}

	/** The room's clock — see {@link AttachRoomOptions.now}. */
	protected now(): number {
		return Date.now();
	}

	fetch(request: Request): Promise<Response> {
		return this.room.fetch(request);
	}
	webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
		this.room.webSocketMessage(ws, message);
	}
	webSocketClose(ws: WebSocket, code: number, reason: string) {
		this.room.webSocketClose(ws, code, reason);
	}
	webSocketError(ws: WebSocket) {
		this.room.webSocketError(ws);
	}
	/** Runs the room's tasks: `onSave`, the history slots, the purge. Call `super.alarm()` if you override it. */
	alarm(): Promise<void> {
		return this.room.alarm();
	}

	/** The versions, newest first, also over RPC — see {@link AttachedDocument.listHistory}. */
	listHistory(): Promise<HistoryEntry[]> {
		return this.room.listHistory();
	}
	/** A version as JSON, also over RPC — see {@link AttachedDocument.readHistory}. */
	readHistory(key: string): Promise<JSONDoc | null> {
		return this.room.readHistory(key);
	}
	/** Restore a version, also over RPC — see {@link AttachedDocument.restoreHistory}. */
	restoreHistory(key: string, options?: { user?: string }): Promise<RestoreResult> {
		return this.room.restoreHistory(key, options);
	}
	/** Undo the last restore, also over RPC — see {@link AttachedDocument.undoRestore}. */
	undoRestore(options?: { user?: string }): Promise<{ status: 'applied' | 'noop' }> {
		return this.room.undoRestore(options);
	}
	/** The version writes in flight, also over RPC — see {@link AttachedDocument.historyWritten}. */
	historyWritten(): Promise<void> {
		return this.room.historyWritten();
	}
	/** Export blocks for a move, also over RPC — see {@link AttachedDocument.exportBlocks}. */
	exportBlocks(ids: string[]): ExportedBlocks {
		return this.room.exportBlocks(ids);
	}
	/** Import a move's blocks, also over RPC — see {@link AttachedDocument.importBlocks}. */
	importBlocks(request: ImportRequest): ImportReceipt {
		return this.room.importBlocks(request);
	}
	/** Commit a move, also over RPC — see {@link AttachedDocument.commitMove}. */
	commitMove(moveId: string, receipt: { to: string; ids: Record<string, string> }): CommitResult {
		return this.room.commitMove(moveId, receipt);
	}
	/** Abort an export, also over RPC — see {@link AttachedDocument.abortMove}. */
	abortMove(moveId: string): { moveId: string; status: 'applied' | 'noop' } {
		return this.room.abortMove(moveId);
	}
	/** The late edits waiting, also over RPC — see {@link AttachedDocument.lateEdits}. */
	lateEdits(): LateEditBatch[] {
		return this.room.lateEdits();
	}
	/** Drop forwarded late edits, also over RPC — see {@link AttachedDocument.ackLateEdits}. */
	ackLateEdits(moveId: string, seq: number): void {
		this.room.ackLateEdits(moveId, seq);
	}
	/** Apply late edits, also over RPC — see {@link AttachedDocument.applyLateEdits}. */
	applyLateEdits(batch: LateEditBatch): { applied: number; skipped: string[] } {
		return this.room.applyLateEdits(batch);
	}
	/** Run the purge task now, also over RPC — see {@link AttachedDocument.purge}. */
	purge(): (PurgeReport & { horizon: number }) | null {
		return this.room.purge();
	}

	/** Every comment thread, also over RPC — see {@link AttachedDocument.listComments}. */
	listComments(): CommentSnapshot {
		return this.room.listComments();
	}
	/** One comments request, also over RPC — see {@link AttachedDocument.comment}. */
	comment(request: CommentRequest, actor: CommentActor): Promise<CommentOutcome> {
		return this.room.comment(request, actor);
	}

	/** Close every socket of a user, also over RPC — see {@link AttachedDocument.closeUser}. */
	closeUser(userId: string, code?: number, reason?: string): { sockets: number } {
		return this.room.closeUser(userId, code, reason);
	}
	/** Change a user's access on its sockets, also over RPC — see {@link AttachedDocument.setAccess}. */
	setAccess(userId: string, access: 'write' | 'read' | 'none'): { sockets: number } {
		return this.room.setAccess(userId, access);
	}

	/** Compaction, also over RPC. */
	compact(): { rows: number } {
		return this.room.compact();
	}
	/** The room's counters, also over RPC — see {@link RoomMetrics}. */
	metrics(): RoomMetrics {
		return this.room.metrics();
	}
	/** When the room last stored a change, also over RPC — see {@link AttachedDocument.lastUpdated}. */
	lastUpdated(): number | null {
		return this.room.lastUpdated();
	}
	/** The snapshot compression in flight, also over RPC — see {@link AttachedDocument.compressed}. */
	compressed(): Promise<void> {
		return this.room.compressed();
	}
	/** Drop the stored waiting deletes, also over RPC — see {@link AttachedDocument.dropWaitingDeletes}. */
	dropWaitingDeletes(): { ranges: number } {
		return this.room.dropWaitingDeletes();
	}
	/** Generation cutover, also over RPC — see {@link AttachedDocument.reset}. */
	reset(): Promise<void> {
		return this.room.reset();
	}
	/** Server-side edit — see {@link AttachedDocument.transact}. */
	transact<T>(fn: (facade: DocumentOperations) => T): T {
		return this.room.transact(fn);
	}
	/** The document as JSON. */
	read(): JSONDoc {
		return this.room.read();
	}
	get facade(): DocumentOperations {
		return this.room.facade;
	}
	get doc(): YDoc | null {
		return this.room.doc;
	}
	get failure(): Error | null {
		return this.room.failure;
	}
	get refusals(): Refusal[] {
		return this.room.refusals;
	}
	get refusalCounts(): AttachedDocument['refusalCounts'] {
		return this.room.refusalCounts;
	}
	get presence(): Map<number, AwarenessEntry> {
		return this.room.presence;
	}
	get origin(): AttachedDocument['origin'] {
		return this.room.origin;
	}
	records(): ReturnType<AttachedDocument['records']> {
		return this.room.records();
	}
}
