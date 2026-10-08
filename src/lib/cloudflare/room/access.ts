/**
 * Access (`room.access`): the room's door — the verified identity
 * `routeDocumentSocket` forwards, the upgrade (the replica bound to its
 * user, the socket accepted with its identity in the attachment), the
 * probes, history and comments requests — and the end of a socket's access:
 * revocation, a changed access, an expired credential.
 */
import { CLOSE } from '../../crdt/providers/room.js';
import type { Attachment, SocketIdentity } from '../DocumentRoom.js';
import {
	COMMENTS_HEADER,
	HISTORY_HEADER,
	HISTORY_KEY_HEADER,
	IDENTITY_HEADERS,
	PROBE_HEADER,
	SOCKET_TAG,
	closedSocket,
	noTimers
} from './shared.js';
import { STORAGE_FAILURE, type RoomContext } from './context.js';
import { readOnlyFrame, step1Frame } from './frames.js';
import { StorageFault } from './replicas.js';
import { stateVector } from './updates.js';

/** The longest close reason the WebSocket API accepts, in UTF-8 bytes. */
const MAX_CLOSE_REASON_BYTES = 123;

/** Can a socket be closed with `code` (`ws.close` throws on the others)? */
const closableWith = (code: number): boolean =>
	Number.isInteger(code) &&
	(code === 1000 || code === 1011 || code === 1012 || (code >= 3000 && code <= 4999));

const utf8Length = (text: string): number => new TextEncoder().encode(text).length;

/** A Yjs client id (a non-negative safe integer), or `null`. */
export const parseReplica = (raw: unknown): number | null => {
	const n = typeof raw === 'string' && /^\d{1,16}$/.test(raw) ? Number(raw) : raw;
	return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null;
};

/** The user id `routeDocumentSocket` encoded into its header, or `null`. */
const readUser = (raw: string | null): string | null => {
	try {
		return raw === null ? null : decodeURIComponent(raw);
	} catch {
		return null;
	}
};

const readIdentity = (headers: Headers): SocketIdentity | null => {
	const user = readUser(headers.get(IDENTITY_HEADERS.user));
	const rawReplica = headers.get(IDENTITY_HEADERS.replica);
	const replica = rawReplica ? parseReplica(rawReplica) : null;
	const access = headers.get(IDENTITY_HEADERS.access);
	const rawExpires = headers.get(IDENTITY_HEADERS.expires);
	const expiresAt = rawExpires === null ? null : Number(rawExpires);
	if (!user || user.length > 256 || (rawReplica && replica === null)) return null;
	if (access !== 'read' && access !== 'write') return null;
	if (expiresAt !== null && !Number.isFinite(expiresAt)) return null;
	const identity: SocketIdentity = { user, replica, readOnly: access === 'read' };
	if (expiresAt !== null) identity.expiresAt = expiresAt;
	return identity;
};

export class RoomAccess {
	constructor(private readonly room: RoomContext) {}

	/** A request forwarded by the host Worker (`AttachedDocument.fetch`). */
	async fetch(request: Request): Promise<Response> {
		const room = this.room;
		// A history request, forwarded by `routeDocumentHistory` once authorized.
		const op = request.headers.get(HISTORY_HEADER);
		if (op !== null) {
			const identity = readIdentity(request.headers);
			if (identity === null) return new Response('verified identity required', { status: 401 });
			return room.history.request(op, identity, request.headers.get(HISTORY_KEY_HEADER));
		}
		// A comments request (`room.comments`), forwarded by `routeDocumentComments` once authorized.
		const comments = request.headers.get(COMMENTS_HEADER);
		if (comments !== null) {
			const identity = readIdentity(request.headers);
			if (identity === null) return new Response('verified identity required', { status: 401 });
			// A removed thread's anchor marks leave the document: it must be loaded.
			await room.storage.retryStart();
			const body = comments === 'post' ? await request.text() : '';
			return room.comments.request(comments, identity, body);
		}
		// The probes, forwarded by `routeDocumentSocket` once authorized:
		// `lastUpdated` and `snapshot` (the document as JSON).
		const probe = request.headers.get(PROBE_HEADER);
		if (probe === 'lastUpdated' || probe === 'snapshot') {
			if (readIdentity(request.headers) === null) {
				return new Response('verified identity required', { status: 401 });
			}
			await room.storage.retryStart();
			if (probe === 'lastUpdated')
				return Response.json({ lastUpdated: room.storage.lastUpdated() });
			if (room.live === null) return new Response('room unavailable', { status: 503 });
			return Response.json({ lastUpdated: room.storage.lastUpdated(), document: room.read() });
		}
		if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
			return new Response('expected a websocket upgrade', { status: 426 });
		}
		const identity = readIdentity(request.headers);
		if (identity === null) return new Response('verified identity required', { status: 401 });
		await room.storage.retryStart();
		return noTimers(() => this.accept(identity));
	}

	/** Accept a verified socket: its replica bound to its user, then the join (Step1, presence). */
	private accept(identity: SocketIdentity): Response {
		const room = this.room;
		room.storage.heal();
		const doc = room.live;
		if (doc !== null && identity.replica !== null) {
			let bound: boolean;
			try {
				bound = room.replicas.bind(
					identity.user,
					identity.replica,
					stateVector(doc),
					!identity.readOnly
				);
			} catch (error) {
				if (!(error instanceof StorageFault)) throw error;
				room.note({ reason: 'storage', detail: String(error) });
				return closedSocket(CLOSE.fault, STORAGE_FAILURE);
			}
			if (!bound) {
				room.note({ reason: 'replica', detail: identity.replica });
				return closedSocket(CLOSE.replicaTaken, 'replica bound to another user');
			}
		}
		const pair = new WebSocketPair();
		const [client, server] = [pair[0], pair[1]];
		room.ctx.acceptWebSocket(server, [SOCKET_TAG]);
		server.serializeAttachment({ ...identity, clock: null } satisfies Attachment);
		// The alarm closes the socket at its credential's expiry, should it send nothing.
		if (identity.expiresAt != null)
			room.scheduler.schedule('expiry', identity.expiresAt, 'earlier');
		if (doc === null) {
			room.refuseContainer(server);
		} else {
			// A read-only socket is never asked for its state: it has nothing
			// to give. It gets the read-only notice instead (not a refusal),
			// so its provider tracks nothing.
			room.send(server, identity.readOnly ? readOnlyFrame() : step1Frame(doc));
			if (room.state.presence.size > 0) room.send(server, room.presence.snapshot());
		}
		return new Response(null, { status: 101, webSocket: client });
	}

	/** The open sockets of `user`. */
	private socketsOf(user: string): Array<{ ws: WebSocket; attachment: Attachment }> {
		const sockets: Array<{ ws: WebSocket; attachment: Attachment }> = [];
		for (const ws of this.room.ctx.getWebSockets(SOCKET_TAG)) {
			if (ws.readyState !== WebSocket.OPEN) continue;
			const attachment = ws.deserializeAttachment() as Attachment | null;
			if (attachment?.user === user) sockets.push({ ws, attachment });
		}
		return sockets;
	}

	/** Close `sockets` with `code`, their departure announced, the change logged (`access`). */
	endAccess(
		sockets: WebSocket[],
		access: 'expired' | 'closed' | 'write' | 'none',
		code: number,
		reason: string
	) {
		const room = this.room;
		if (sockets.length === 0) return;
		const user = (sockets[0].deserializeAttachment() as Attachment | null)?.user ?? null;
		room.note({ reason: 'access', detail: { user, access, sockets: sockets.length } });
		for (const ws of sockets) {
			room.presence.depart(ws);
			room.close(ws, code, reason);
		}
	}

	/** Revoke: close every socket of `userId` (`AttachedDocument.closeUser`). */
	closeUser(userId: string, code: number = CLOSE.denied, reason?: string): { sockets: number } {
		const text = reason ?? (code === CLOSE.denied ? 'access revoked' : 'closed');
		if (!closableWith(code)) {
			throw new RangeError(
				`closeUser: close code ${code} is not one a socket can be closed with (1000, 1011, 1012, 3000-4999)`
			);
		}
		if (utf8Length(text) > MAX_CLOSE_REASON_BYTES) {
			throw new RangeError(`closeUser: close reason is over ${MAX_CLOSE_REASON_BYTES} UTF-8 bytes`);
		}
		return this.revoke(userId, 'closed', code, text);
	}

	/** Close every socket of `userId`, logged as `access`. */
	private revoke(
		userId: string,
		access: 'closed' | 'none',
		code: number,
		reason: string
	): { sockets: number } {
		return noTimers(() => {
			const sockets = this.socketsOf(userId).map(({ ws }) => ws);
			this.endAccess(sockets, access, code, reason);
			return { sockets: sockets.length };
		});
	}

	/** Change `userId`'s access on its open sockets (`AttachedDocument.setAccess`). */
	setAccess(userId: string, access: 'write' | 'read' | 'none'): { sockets: number } {
		const room = this.room;
		if (access !== 'write' && access !== 'read' && access !== 'none') {
			throw new RangeError(`setAccess: unknown access ${String(access)}`);
		}
		if (access === 'none') return this.revoke(userId, 'none', CLOSE.denied, 'access revoked');
		return noTimers(() => {
			const sockets = this.socketsOf(userId).filter(
				({ attachment }) => attachment.readOnly !== (access === 'read')
			);
			if (access === 'write') {
				this.endAccess(
					sockets.map(({ ws }) => ws),
					'write',
					CLOSE.accessChanged,
					'access changed'
				);
				return { sockets: sockets.length };
			}
			for (const { ws, attachment } of sockets) {
				ws.serializeAttachment({ ...attachment, readOnly: true } satisfies Attachment);
				room.send(ws, readOnlyFrame());
			}
			if (sockets.length > 0) {
				room.note({ reason: 'access', detail: { user: userId, access, sockets: sockets.length } });
			}
			return { sockets: sockets.length };
		});
	}

	/**
	 * The `expiry` task: close every socket whose credential expired
	 * (`4401`: its provider redials with fresh `params`), then arm the
	 * alarm at the next expiry of the sockets left.
	 */
	expireSockets() {
		const room = this.room;
		const now = room.clock();
		const expired: WebSocket[] = [];
		let next = Infinity;
		for (const ws of room.ctx.getWebSockets(SOCKET_TAG)) {
			if (ws.readyState !== WebSocket.OPEN) continue;
			const at = (ws.deserializeAttachment() as Attachment | null)?.expiresAt;
			if (at == null) continue;
			if (at <= now) expired.push(ws);
			else next = Math.min(next, at);
		}
		for (const ws of expired) this.endAccess([ws], 'expired', CLOSE.expired, 'expired');
		room.scheduler.unschedule('expiry');
		if (next !== Infinity) room.scheduler.schedule('expiry', next, 'replace');
	}
}
