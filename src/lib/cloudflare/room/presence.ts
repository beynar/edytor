/**
 * Presence through the instance-free codec (`room.presence.*`): each
 * socket publishes only its own replica's entry, relayed with its actor
 * set to the verified user, held past the presence rate and released at
 * a later message (no timer), and its departure announced when the socket
 * goes.
 */
import { semanticsMismatch } from '../../crdt/semantics.js';
import type { AwarenessEntry } from '../../crdt/protocol.js';
import type { YDoc } from '../../crdt/index.js';
import type { Attachment } from '../DocumentRoom.js';
import { allowance, type Allowances } from './admission.js';
import { encodeJSON, type RoomContext } from './context.js';
import { presenceFrame } from './frames.js';
import { stateVector } from './updates.js';

/**
 * A presence entry as the room relays it: a state that names an actor
 * (`actor`, as every view publishes) names the socket's verified user
 * (`room.attribution.trust`), whatever the client wrote there. A state with no `actor` claims
 * no identity and is relayed as it is.
 */
const verifiedPresence = (entry: AwarenessEntry, user: string): AwarenessEntry => {
	const { state } = entry;
	if (state === null || typeof state !== 'object' || Array.isArray(state)) return entry;
	if (!('actor' in state)) return entry;
	const actor = state.actor;
	const claimed =
		actor !== null && typeof actor === 'object' && !Array.isArray(actor)
			? (actor as Record<string, unknown>)
			: {};
	if (claimed.id === user) return entry;
	return { ...entry, state: { ...state, actor: { ...claimed, id: user } } };
};

export class RoomPresence {
	/** Each socket's presence allowance, a bucket of its own. */
	private readonly allowances: Allowances = new WeakMap();
	/** Sockets in a burst past their presence rate, logged once (`overRate`). */
	private readonly bursts = new WeakSet<WebSocket>();
	/**
	 * Each socket's newest presence entry past its rate, relayed once the
	 * rate allows (the end of any message), or replaced by a newer one.
	 */
	private readonly held = new Map<WebSocket, AwarenessEntry>();

	constructor(private readonly room: RoomContext) {}

	/** The latest entry per replica, for join snapshots (`AttachedDocument.presence`). */
	private get entries(): Map<number, AwarenessEntry> {
		return this.room.state.presence;
	}

	/** Every entry the room holds, as one frame (a join, a query). */
	snapshot(): Uint8Array {
		return presenceFrame([...this.entries.values()]);
	}

	/**
	 * The presence rate quota (`room.presence.quota`): `maxPresencePerSecond`
	 * on a bucket of the socket's own. `false`: over it.
	 */
	allow(ws: WebSocket): boolean {
		if (!allowance(this.allowances, ws, this.room.limits.maxPresencePerSecond)) return false;
		this.bursts.delete(ws);
		return true;
	}

	/**
	 * Presence for the socket's own replica only (bound by `authorize`,
	 * else by its first entry): the newest clock wins, the attachment
	 * records the clock, the accepted entry is relayed — to its sender too
	 * (a no-op for it), so a lone socket hears from the room at every
	 * renewal and is never torn down as silent. Entries for other replicas
	 * (a client re-sending what it heard) are dropped.
	 */
	onPresence(ws: WebSocket, attachment: Attachment, doc: YDoc, entries: AwarenessEntry[]) {
		const room = this.room;
		let replica = attachment.replica;
		if (replica === null && entries.length > 0) {
			replica = entries[0].clientID;
			if (!room.replicas.bind(attachment.user, replica, stateVector(doc), !attachment.readOnly)) {
				return room.refuse(ws, { reason: 'replica', detail: replica });
			}
		}
		const found = entries.find((candidate) => candidate.clientID === replica);
		if (found === undefined || replica === null) return;
		// The relayed state names the verified user as its actor (`room.attribution.trust`).
		const entry = verifiedPresence(found, attachment.user);
		const known = this.entries.get(replica);
		if (known && known.clock > entry.clock) return;
		// The size quota: an entry past it is ignored (its previous one stays).
		if (entry.state !== null) {
			const bytes = encodeJSON(entry.state).length;
			if (bytes > room.limits.maxPresenceBytes) {
				return room.note({
					reason: 'presence',
					detail: {
						user: attachment.user,
						quota: 'size',
						bytes,
						limit: room.limits.maxPresenceBytes
					}
				});
			}
		}
		this.compareSemantics(attachment.user, known, entry);
		if (entry.state === null) this.entries.delete(replica);
		else this.entries.set(replica, entry);
		ws.serializeAttachment({
			...attachment,
			replica,
			clock: entry.state === null ? null : entry.clock
		} satisfies Attachment);
		// The rate quota: past it, the newest entry waits for the next token.
		if (!this.allow(ws)) {
			this.held.set(ws, entry);
			return this.overRate(ws, attachment);
		}
		this.held.delete(ws);
		this.relay(ws, entry);
	}

	/** Relay a socket's accepted entry: to its sender too (liveness), but a removal. */
	private relay(ws: WebSocket, entry: AwarenessEntry) {
		this.room.broadcast(presenceFrame([entry]), entry.state === null ? ws : null);
	}

	/**
	 * The dev-time roles check: a client's presence advertises the
	 * digest of its document's roles (`semantics`, development builds); one
	 * naming kinds, marks or a default type the room reads otherwise is
	 * logged (`semantics`), once per digest the client advertises. Never a
	 * refusal: a client without a plugin, or with roles the room lacks, is
	 * the host's to fix, in `semantics`.
	 */
	private compareSemantics(user: string, known: AwarenessEntry | undefined, entry: AwarenessEntry) {
		const advertised = entry.state?.semantics;
		if (advertised === undefined) return;
		if (JSON.stringify(known?.state?.semantics) === JSON.stringify(advertised)) return;
		const kinds = semanticsMismatch(this.room.digest, advertised);
		if (kinds.length > 0) this.room.log({ edytor: 'semantics', user, kinds });
	}

	/**
	 * A presence message past the socket's rate (`room.presence.quota`):
	 * never closed. A burst is one log entry, its first message's (the
	 * socket's next allowed one ends it); `refusalCounts.presence` counts
	 * every message past the rate.
	 */
	overRate(ws: WebSocket, attachment: Attachment) {
		const room = this.room;
		if (this.bursts.has(ws)) {
			const counts = room.state.refusalCounts;
			counts.presence = (counts.presence ?? 0) + 1;
			return;
		}
		this.bursts.add(ws);
		room.note({
			reason: 'presence',
			detail: { user: attachment.user, quota: 'rate', limit: room.limits.maxPresencePerSecond }
		});
	}

	/**
	 * Relay the entries held past their socket's rate whose rate allows them
	 * now — the newest of each socket, at the end of any socket's message
	 * (no timer: a Durable Object with one could not hibernate). A socket
	 * that floods is relayed at its rate, its last entry at the latest with
	 * the room's next message (every client renews its presence). The
	 * entries released together go out as one frame.
	 */
	release() {
		if (this.held.size === 0) return;
		const due: AwarenessEntry[] = [];
		for (const [ws, entry] of this.held) {
			if (ws.readyState !== WebSocket.OPEN) {
				this.held.delete(ws);
			} else if (this.allow(ws)) {
				this.held.delete(ws);
				if (entry.state === null) this.relay(ws, entry);
				else due.push(entry);
			}
		}
		if (due.length > 0) this.room.broadcast(presenceFrame(due), null);
	}

	/** The departure the client may not have announced — from the attachment, so it works after a wake. */
	depart(ws: WebSocket) {
		this.held.delete(ws);
		const attachment = ws.deserializeAttachment() as Attachment | null;
		if (attachment?.replica == null || attachment.clock === null) return;
		// Announce once: a later close/error event on this socket is a no-op.
		ws.serializeAttachment({ ...attachment, clock: null } satisfies Attachment);
		this.entries.delete(attachment.replica);
		this.room.broadcast(
			presenceFrame([{ clientID: attachment.replica, clock: attachment.clock + 1, state: null }]),
			ws
		);
	}
}
