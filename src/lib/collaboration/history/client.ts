/**
 * The version history client: what the history panel asks of a room's
 * history. Any object with these four methods is a client (an RPC binding,
 * a server route of your own, a stub in tests); `createHistoryClient` is
 * the default one, over the HTTP requests `routeDocumentHistory` answers.
 */
import { assertRoomId } from '../../crdt/providers/room.js';
import type { JSONDoc } from '../../utils/json.js';

/** One stored version, as the room lists it (`edytor/cloudflare`'s `HistoryEntry`). */
export type HistoryVersion = {
	/** The version's key, which `read` and `restore` take. */
	key: string;
	/** The local date of its slot, `YYYY-MM-DD`, in the room's time zone. */
	date: string;
	/** Its half of the day: `am` before local noon, `pm` until midnight. */
	slot: 'am' | 'pm';
	/** Stored (compressed) bytes. */
	bytes: number;
	/** Visible blocks. */
	blocks: number;
	/** The users whose edits the room stored during the slot. */
	editors: string[];
	/** Editors left out of `editors` to keep the metadata small. */
	more: number;
	/** When the version was written (ms since the epoch). */
	at: number;
	/** When it expires (ms since the epoch), `null` when its store does not say. */
	expiresAt: number | null;
};

/** What a restore did: `refused` when the room holds no such version. */
export type HistoryRestoreResult = {
	status: 'applied' | 'noop' | 'refused';
	key: string;
	revived?: number;
	moved?: number;
	rewritten?: number;
	created?: number;
	deleted?: number;
};

/** What undoing the last restore did: `noop` when there is none to undo. */
export type HistoryUndoResult = { status: 'applied' | 'noop' };

/** A room's version history, as the history panel reads and restores it. */
export type HistoryClient = {
	/** The versions, newest first. */
	list(): Promise<HistoryVersion[]>;
	/** A version as JSON, or `null` when the room holds no such version. */
	read(key: string): Promise<JSONDoc | null>;
	/** Restore a version as a forward edit every client receives. */
	restore(key: string): Promise<HistoryRestoreResult>;
	/** Undo the last restore (one level). */
	undo(): Promise<HistoryUndoResult>;
};

/** Options of {@link createHistoryClient}. */
export type HistoryClientOptions = {
	/**
	 * The base URL of the history route: requests go to
	 * `<server>/<room>`, the room percent-encoded as one path segment
	 * (`ws:`/`wss:` read as `http:`/`https:`).
	 */
	server: string;
	/** The document's id. */
	room: string;
	/** Query parameters sent with each request (a token): an object, or a function read at every request. */
	params?: Record<string, string> | (() => Record<string, string>);
	/** The fetch to use (default the global one). */
	fetch?: typeof fetch;
};

/** A history request the server refused: `status` is its HTTP status (`401`, `403`, `404`, `503`…). */
export class HistoryRequestError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.name = 'HistoryRequestError';
		this.status = status;
	}
}

/**
 * The default {@link HistoryClient}: the requests `routeDocumentHistory`
 * answers. `GET <url>` lists, `GET <url>?key=` reads (`404`: `null`),
 * `POST <url>?restore=` restores (`404`: `refused`), `POST <url>?undo`
 * undoes; any other refusal throws a {@link HistoryRequestError}. Throws
 * a `TypeError` at once for a room id no request can carry.
 */
export const createHistoryClient = (options: HistoryClientOptions): HistoryClient => {
	assertRoomId(options.room);
	const base = `${options.server.replace(/\/+$/, '').replace(/^ws/, 'http')}/${encodeURIComponent(options.room)}`;

	const request = async (
		method: 'GET' | 'POST',
		query: Record<string, string>,
		missing?: () => unknown
	): Promise<unknown> => {
		const url = new URL(base);
		const params = typeof options.params === 'function' ? options.params() : options.params;
		for (const [name, value] of Object.entries({ ...params, ...query }))
			url.searchParams.set(name, value);
		const response = await (options.fetch ?? fetch)(url.toString(), { method });
		if (response.status === 404 && missing) return missing();
		if (!response.ok) {
			const text = await response.text().catch(() => '');
			throw new HistoryRequestError(
				response.status,
				`history of ${options.room}: ${response.status} ${text}`.trim()
			);
		}
		return response.json();
	};

	return {
		list: () => request('GET', {}) as Promise<HistoryVersion[]>,
		read: (key) => request('GET', { key }, () => null) as Promise<JSONDoc | null>,
		restore: (key) =>
			request('POST', { restore: key }, () => ({
				status: 'refused',
				key
			})) as Promise<HistoryRestoreResult>,
		undo: () => request('POST', { undo: '' }) as Promise<HistoryUndoResult>
	};
};
