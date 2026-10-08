/**
 * The replica registry (`replicas` table): which user owns each client
 * id, the binding of a socket's replica at its dial or first presence
 * entry, which new writers of a frame its socket may deliver (the rest are
 * stripped, relayed ids stored unowned), and the room's rebinding of an
 * attribution entry to its verified user (`room.attribution.trust`).
 */
import { ATTRIBUTION_ROOT } from '../../crdt/schema.js';
import { asEngineDoc } from '../../crdt/structs.js';
import type { YDoc } from '../../crdt/index.js';
import type { Attachment, ReplicaOwner } from '../DocumentRoom.js';
import { ROOM_ORIGIN } from './shared.js';
import type { RoomContext } from './context.js';
import { BINDING_PREFIX } from './forged.js';
import { stateVector } from './updates.js';

/** A SQLite fault outside the append path (the replica registry). */
export class StorageFault extends Error {}

export class ReplicaRegistry {
	constructor(private readonly room: RoomContext) {}

	/** A registry read or write, its SQLite fault tagged (the socket closes 1011, never 1008). */
	private registry<T>(fn: () => T): T {
		try {
			return fn();
		} catch (error) {
			throw new StorageFault(String(error));
		}
	}

	/** Who owns `client`: a user, `''` (unowned: its dial claims it), or `undefined` (unregistered). */
	ownerOf(client: number): string | undefined {
		const { sql, tables } = this.room;
		return this.registry(
			() =>
				sql
					.exec<{
						user: string;
					}>(`SELECT user FROM ${tables.replicas} WHERE replica = ?`, client)
					.toArray()[0]?.user
		);
	}

	/** Register `owners` in one transaction; an unowned (`''`) row never replaces an owner. */
	private register(owners: ReplicaOwner[]) {
		if (owners.length === 0) return;
		const { ctx, sql, tables } = this.room;
		this.registry(() =>
			ctx.storage.transactionSync(() => {
				for (const { replica, user } of owners) {
					sql.exec(
						`INSERT ${user ? 'OR REPLACE' : 'OR IGNORE'} INTO ${tables.replicas} (replica, user) VALUES (?, ?)`,
						replica,
						user
					);
				}
			})
		);
	}

	/**
	 * May `user` bind `replica` to a socket (its dial, or its first presence
	 * entry)? Its own id; an unregistered id with no content in the room,
	 * registered now whatever the socket's access (so a viewer's id cannot be
	 * taken before it is granted edit); an unowned id (`''`), which a
	 * `writer` claims (logged `orphan`). Not another user's id, nor
	 * unregistered history.
	 */
	bind(user: string, replica: number, sv: Map<number, number>, writer: boolean): boolean {
		const owner = this.ownerOf(replica);
		if (owner === user) return true;
		if (owner === '') {
			if (!writer) return true;
			this.register([{ replica, user }]);
			this.room.note({ reason: 'orphan', detail: { replica, user } });
			this.bindOrphan(replica, user);
			return true;
		}
		if (owner !== undefined || (sv.get(replica) ?? 0) > 0) return false;
		this.register([{ replica, user }]);
		return true;
	}

	/**
	 * Which new writers of an update a socket may deliver; returns those
	 * stripped from its frame (the rest of the frame is applied: never
	 * refused whole). Written: its user's ids, and its own replica (the
	 * dialed or bound one), which claims an unowned id or a fresh one, as
	 * `bind` would. A socket with no replica claims fresh ids it writes.
	 * Any other id is relayed — another replica's structs, which a restore
	 * from a lagging snapshot may have lost: kept, and left unowned (`''`,
	 * claimable only by its own dial), when the room holds none of that id's
	 * clocks and no user owns it; stripped otherwise (logged `replica`).
	 * Ownership never moves to a relayer.
	 */
	attribute(
		{ user, replica }: Attachment,
		writers: Set<number>,
		sv: Map<number, number>,
		orphans: Set<number>
	): Set<number> {
		const room = this.room;
		const claimed: ReplicaOwner[] = [];
		const relayed: number[] = [];
		const stripped = new Set<number>();
		for (const client of writers) {
			const owner = this.ownerOf(client);
			if (owner === user) continue;
			const held = (sv.get(client) ?? 0) > 0;
			const fresh = owner === undefined && !held;
			if (client === replica ? fresh || owner === '' : replica === null && fresh) {
				claimed.push({ replica: client, user });
				if (owner === '') orphans.add(client);
			} else if ((fresh || owner === '') && !held) {
				relayed.push(client);
			} else {
				stripped.add(client);
			}
		}
		this.register([...claimed, ...relayed.map((client) => ({ replica: client, user: '' }))]);
		for (const client of orphans)
			room.note({ reason: 'orphan', detail: { replica: client, user } });
		for (const client of relayed)
			room.note({ reason: 'relayed', detail: { replica: client, user } });
		for (const client of stripped) room.note({ reason: 'replica', detail: client });
		return stripped;
	}

	/**
	 * A claimed orphan (an id relayed by another user, whose binding the
	 * relay could not carry): the room binds it to its claimer, when the
	 * room holds content of it. A failed write is healed here, the claim
	 * kept (the binding then stays as it was).
	 */
	private bindOrphan(replica: number, user: string) {
		const room = this.room;
		const doc = room.live;
		if (doc === null || (stateVector(doc).get(replica) ?? 0) === 0) return;
		room.handle(() => this.rebind(doc, new Set([BINDING_PREFIX + replica]), user));
		room.storage.heal();
	}

	/**
	 * Bind the sender's replicas whose `c/<n>` a frame set to another actor
	 * to its verified user (`room.attribution.trust`): one room write after the frame's, which
	 * replaces it on every replica, the sender's included.
	 */
	rebind(doc: YDoc, keys: ReadonlySet<string>, user: string) {
		const root = asEngineDoc(doc).get(ATTRIBUTION_ROOT);
		const stale = [...keys].filter((key) => root.getAttr(key) !== user);
		if (stale.length === 0) return;
		doc.transact(() => {
			for (const key of stale) root.setAttr(key, user);
		}, ROOM_ORIGIN);
	}
}
