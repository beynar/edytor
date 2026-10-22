/**
 * The re-seed (`room.reseed.*`): once the stored document grew past a
 * share of its quota (`at`, half of it by default) and nobody wrote for
 * `idleMs`, the room rebuilds it from its content with fresh identities
 * (`crdt/reseed.ts`) as a new epoch, when that gives back at least `gain`
 * of it, keeps the cut (what an offline client's old document needs to
 * merge), and closes every socket `4410`. Past `force` of the quota it
 * waits neither for an idle period nor for the pending suggestions (it
 * drops them), and still runs only when it gives back `gain`.
 *
 * A socket that dials an older epoch (`room.reseed.protocol`) is told the
 * room's (`messageEpoch`) when it may write, and hands over its old
 * document (`messageRebase`): its unsaved edits are rebased onto the
 * current document as one transaction of its user (`room.reseed.rebase`),
 * then it is closed `4410` too; one that may not write is closed at once.
 * An epoch older than the cuts kept (`graceDays`) is closed `4411`, and a
 * dial that names none, in a room that re-seeded, `1008` (a client that
 * predates the re-seed).
 */
import { Y } from '../../crdt/engine.js';
import * as E from '../../crdt/protocol.js';
import { CLOSE } from '../../crdt/providers/room.js';
import {
	cutBetween,
	decodeCut,
	encodeCut,
	rebaseOnto,
	seedFrom,
	type Cut,
	type Merged,
	type Replica
} from '../../crdt/reseed.js';
import { asEngineDoc } from '../../crdt/structs.js';
import { suggestionsOf } from '../../crdt/doc/suggest.js';
import type { YDoc } from '../../crdt/index.js';
import type { Attachment, SocketIdentity } from '../DocumentRoom.js';
import {
	DEFAULT_RESEED_FORCE,
	DEFAULT_RESEED_GAIN,
	DEFAULT_RESEED_GRACE_DAYS,
	DEFAULT_RESEED_IDLE,
	SOCKET_TAG,
	noTimers
} from './shared.js';
import { DAY, crdt, now, type RoomContext } from './context.js';
import { decode, epochFrame } from './frames.js';
import * as encoding from 'lib0-v14/encoding';
import * as decoding from 'lib0-v14/decoding';

/** A share in (0, 1], else `fallback`. */
const share = (value: unknown, fallback: number) => {
	const n = Number(value);
	return n > 0 && n <= 1 ? n : fallback;
};

const encodeMerged = (merged: Merged) =>
	encoding.encode((e) => {
		encoding.writeVarUint8Array(e, merged.sv);
		encoding.writeVarUint8Array(e, merged.ds);
	});
const decodeMerged = (bytes: Uint8Array): Merged => {
	const d = decoding.createDecoder(bytes);
	return { sv: decoding.readVarUint8Array(d), ds: decoding.readVarUint8Array(d) };
};

/** An epoch a dial names (`?epoch=`), or `null`. */
export const parseEpoch = (raw: string | null): number | null => {
	const n = raw !== null && /^\d{1,9}$/.test(raw) ? Number(raw) : NaN;
	return Number.isSafeInteger(n) ? n : null;
};

export class RoomReseed {
	#epoch: number | null = null;

	constructor(private readonly room: RoomContext) {}

	/** The re-seed's settings (`null`: off). */
	get config() {
		const { options, limits } = this.room;
		const o = options.reseed;
		if (o === false) return null;
		const quota = limits.maxDocumentBytes;
		const at = Number(o?.at);
		const idle = Number(o?.idleMs);
		const grace = Number(o?.graceDays);
		return {
			at: Number.isFinite(at) && at > 0 ? at : quota / 2,
			idleMs: Number.isFinite(idle) && idle >= 0 ? idle : DEFAULT_RESEED_IDLE,
			gain: share(o?.gain, DEFAULT_RESEED_GAIN),
			force: share(o?.force, DEFAULT_RESEED_FORCE) * quota,
			graceDays: Number.isFinite(grace) && grace > 0 ? grace : DEFAULT_RESEED_GRACE_DAYS
		};
	}

	/** The room's epoch: 0 until it first re-seeds (meta `epoch`). */
	get epoch(): number {
		if (this.#epoch === null) {
			const { sql, tables } = this.room;
			this.#epoch =
				sql
					.exec<{ value: number }>(`SELECT value FROM ${tables.meta} WHERE key = 'epoch'`)
					.toArray()[0]?.value ?? 0;
		}
		return this.#epoch;
	}

	/** Forget what memory holds (a reset dropped the tables). */
	forget() {
		this.#epoch = null;
	}

	/** Set the epoch (inside the caller's storage transaction): a re-seed, or a seed from `onLoad`. */
	setEpoch(epoch: number) {
		const { sql, tables } = this.room;
		sql.exec(`INSERT OR REPLACE INTO ${tables.meta} (key, value) VALUES ('epoch', ?)`, epoch);
		this.#epoch = epoch;
	}

	#ensure() {
		this.room.sql.exec(
			`CREATE TABLE IF NOT EXISTS ${this.room.tables.cuts} (
				epoch INTEGER NOT NULL,
				kind TEXT NOT NULL,
				part INTEGER NOT NULL,
				parts INTEGER NOT NULL,
				at INTEGER NOT NULL,
				bytes BLOB NOT NULL,
				PRIMARY KEY (epoch, kind, part)
			)`
		);
	}

	/** Store `bytes` as epoch `epoch`'s `kind` (`cut`, `merged`), in rows ≤ `maxRowBytes`. */
	#write(epoch: number, kind: 'cut' | 'merged', bytes: Uint8Array, at: number) {
		const { sql, tables, limits } = this.room;
		this.#ensure();
		sql.exec(`DELETE FROM ${tables.cuts} WHERE epoch = ? AND kind = ?`, epoch, kind);
		const parts = Math.max(1, Math.ceil(bytes.length / limits.maxRowBytes));
		for (let part = 0; part < parts; part++) {
			const row = bytes.slice(part * limits.maxRowBytes, (part + 1) * limits.maxRowBytes);
			sql.exec(
				`INSERT INTO ${tables.cuts} (epoch, kind, part, parts, at, bytes) VALUES (?, ?, ?, ?, ?, ?)`,
				epoch,
				kind,
				part,
				parts,
				at,
				row
			);
		}
	}

	#read(epoch: number, kind: 'cut' | 'merged'): { bytes: Uint8Array; at: number } | null {
		const { sql, tables } = this.room;
		this.#ensure();
		const rows = sql
			.exec<{
				part: number;
				parts: number;
				at: number;
				bytes: ArrayBuffer;
			}>(
				`SELECT part, parts, at, bytes FROM ${tables.cuts} WHERE epoch = ? AND kind = ? ORDER BY part`,
				epoch,
				kind
			)
			.toArray();
		if (rows.length === 0 || rows.length !== rows[0]!.parts) return null;
		const bytes = new Uint8Array(rows.reduce((n, row) => n + row.bytes.byteLength, 0));
		let offset = 0;
		for (const row of rows) {
			bytes.set(new Uint8Array(row.bytes), offset);
			offset += row.bytes.byteLength;
		}
		return { bytes, at: rows[0]!.at };
	}

	/**
	 * The cuts from epoch `from` to the room's, oldest first (`null`: one is
	 * gone, or older than the grace: `room.reseed.grace`).
	 */
	#cutsSince(from: number): Cut[] | null {
		const grace = (this.config?.graceDays ?? DEFAULT_RESEED_GRACE_DAYS) * DAY;
		const cuts: Cut[] = [];
		for (let epoch = from + 1; epoch <= this.epoch; epoch++) {
			const found = this.#read(epoch, 'cut');
			if (found === null || found.at < this.room.clock() - grace) return null;
			cuts.push(decodeCut(found.bytes));
		}
		return cuts;
	}

	/** The bytes a re-seed that gave back too little left: not tried again under them (meta `reseed.floor`). */
	#floor(): number {
		const { sql, tables } = this.room;
		return (
			sql
				.exec<{ value: number }>(`SELECT value FROM ${tables.meta} WHERE key = 'reseed.floor'`)
				.toArray()[0]?.value ?? 0
		);
	}

	/**
	 * A change was stored at `at` (`room.reseed.timing`): past the
	 * threshold the re-seed is due once nobody writes for `idleMs` (each
	 * change pushes it back), past `force` at once.
	 */
	noteChange(at: number) {
		const config = this.config;
		if (config === null) return;
		const bytes = this.room.storage.documentBytes;
		const { scheduler } = this.room;
		if (bytes >= config.force) scheduler.schedule('reseed', at, 'earlier');
		else if (bytes >= config.at && bytes >= this.#floor())
			scheduler.schedule('reseed', at + config.idleMs, 'replace');
	}

	/** The `reseed` task: it runs when still due (past the threshold), else it clears itself. */
	task() {
		const room = this.room;
		noTimers(() => {
			const config = this.config;
			room.scheduler.unschedule('reseed');
			if (config === null || room.live === null) return;
			const bytes = room.storage.documentBytes;
			if (bytes < config.at) return;
			this.run(bytes >= config.force ? 'full' : 'idle');
		});
	}

	/**
	 * Re-seed now (`room.reseed.cut`): the new epoch replaces the rows, in
	 * one storage transaction with its cut; the replica registry, the
	 * purge's epochs and the last restore's step go (they name the old
	 * identities); the live document is rebuilt from the rows and every
	 * socket closed `4410`. `idle` (the task, once nobody wrote) waits while
	 * a suggestion is pending (an idle period later); `full` (the task, past
	 * `force` of the quota) drops them; both do nothing when the new epoch
	 * would give back less than `gain` (and wait for the document to grow by
	 * a quarter of `at` before trying again). `manual` (`reseed()`) runs
	 * whatever it gives back and drops them. Answers the new epoch, or `null`.
	 */
	run(mode: 'idle' | 'full' | 'manual'): number | null {
		const room = this.room;
		const config = this.config;
		if (config === null) return null;
		return noTimers(() => {
			if (room.busy) {
				room.scheduler.schedule('reseed', room.clock() + 60_000, 'earlier');
				return null;
			}
			room.storage.heal();
			const doc = room.requireDoc();
			const facade = room.facade;
			const old: Replica = { doc: asEngineDoc(doc), facade: facade as never };
			const pending = suggestionsOf(facade as never).changes().length;
			const before = room.storage.documentBytes;
			if (pending > 0 && mode === 'idle') {
				room.log({ edytor: 'reseed', skipped: 'suggestions', bytes: before, pending });
				room.scheduler.schedule('reseed', room.clock() + config.idleMs, 'replace');
				return null;
			}
			const started = now();
			const scratch = crdt.createDoc();
			const fresh = room.facadeOf(scratch);
			try {
				const document = seedFrom(old, (json): Replica => {
					fresh.seed(json.children, json.data);
					return { doc: asEngineDoc(scratch), facade: fresh as never };
				});
				const update = Y.encodeStateAsUpdate(scratch);
				if (mode !== 'manual' && update.length > before * (1 - config.gain)) {
					room.sql.exec(
						`INSERT OR REPLACE INTO ${room.tables.meta} (key, value) VALUES ('reseed.floor', ?)`,
						before + config.at / 4
					);
					room.log({ edytor: 'reseed', skipped: 'gain', bytes: before, estimate: update.length });
					return null;
				}
				const cut = cutBetween(old, document);
				const epoch = this.epoch + 1;
				const at = room.clock();
				const { sql, tables } = room;
				room.storage.replaceWith(update, () => {
					sql.exec(`DELETE FROM ${tables.replicas}`);
					sql.exec(`DELETE FROM ${tables.epochs}`);
					sql.exec(`DELETE FROM ${tables.restore}`);
					sql.exec(`DELETE FROM ${tables.meta} WHERE key = 'reseed.floor'`);
					this.setEpoch(epoch);
					this.#write(epoch, 'cut', encodeCut(cut), at);
				});
				room.state.presence.clear();
				room.storage.rebuild();
				for (const ws of room.ctx.getWebSockets(SOCKET_TAG)) {
					room.presence.depart(ws);
					room.close(ws, CLOSE.reseeded, String(epoch));
				}
				room.log({
					edytor: 'reseed',
					epoch,
					before,
					after: update.length,
					suggestions: pending,
					ms: now() - started
				});
				return epoch;
			} finally {
				fresh.dispose();
				scratch.destroy();
			}
		});
	}

	/**
	 * The door (`RoomAccess.accept`, `room.reseed.protocol`): a dial of
	 * epoch `asked` is current, stale (an older epoch whose cuts are kept),
	 * or closed: a later epoch, or none in a room that re-seeded, `1008`;
	 * an epoch past the cuts kept, `4411`.
	 */
	door(asked: number | null): 'current' | 'stale' | { code: number; reason: string } {
		const current = this.epoch;
		if (asked === null)
			return current === 0 ? 'current' : { code: CLOSE.refused, reason: 'refused: epoch' };
		if (asked === current) return 'current';
		if (asked > current) return { code: CLOSE.refused, reason: 'refused: epoch' };
		if (this.#cutsSince(asked) === null)
			return { code: CLOSE.epochExpired, reason: 'epoch expired' };
		return 'stale';
	}

	/**
	 * A stale socket joined: one that may write is told the room's epoch
	 * (its provider then hands over its old document); any other has no
	 * edit to merge and is closed `4410`.
	 */
	join(ws: WebSocket, identity: SocketIdentity) {
		const room = this.room;
		if (identity.readOnly || identity.access === 'suggest') {
			return room.close(ws, CLOSE.reseeded, String(this.epoch));
		}
		room.send(ws, epochFrame(this.epoch));
	}

	/**
	 * A stale socket's message: its old document (`messageRebase`) is
	 * rebased onto the current one as one transaction of its user (the
	 * socket its origin: the slot records the user, nothing is sent back to
	 * it), then it is closed `4410`; anything else it sends is dropped.
	 */
	onStale(ws: WebSocket, attachment: Attachment, type: number, decoder: E.Decoder) {
		const room = this.room;
		if (type !== E.messageRebase) return;
		const upload = decode(() => E.readVarUint8Array(decoder));
		const from = attachment.epoch!;
		const cuts = this.#cutsSince(from);
		if (cuts === null) return room.close(ws, CLOSE.epochExpired, 'epoch expired');
		const started = now();
		const doc = room.requireDoc();
		const found = this.#read(from + 1, 'merged');
		const merged = found === null ? undefined : decodeMerged(found.bytes);
		const shadows: { doc: YDoc; facade: { dispose(): void } }[] = [];
		const scratch = (update: Uint8Array): Replica => {
			const shadow = crdt.createDoc();
			Y.applyUpdate(shadow, update);
			const facade = room.facadeOf(shadow);
			shadows.push({ doc: shadow, facade });
			return { doc: asEngineDoc(shadow), facade: facade as never };
		};
		const facade = room.facadeOf(doc, { id: attachment.user });
		let result!: ReturnType<typeof rebaseOnto>;
		room.history.closeSlotIfPast();
		room.transacting = true;
		try {
			facade.transact(() => {
				result = rebaseOnto(
					{ doc: asEngineDoc(doc), facade: facade as never },
					cuts,
					upload,
					scratch,
					merged
				);
			}, ws);
		} finally {
			room.transacting = false;
			facade.dispose();
			for (const shadow of shadows) {
				shadow.facade.dispose();
				shadow.doc.destroy();
			}
		}
		if (room.unstored !== null) {
			const error = room.unstored;
			room.storage.heal();
			throw error;
		}
		room.ctx.storage.transactionSync(() =>
			this.#write(from + 1, 'merged', encodeMerged(result.merged), this.#read(from + 1, 'cut')!.at)
		);
		room.storage.compactIfDue();
		room.log({
			edytor: 'rebase',
			user: attachment.user,
			from,
			epoch: this.epoch,
			status: result.report.status,
			bytes: upload.length,
			ms: now() - started
		});
		room.close(ws, CLOSE.reseeded, String(this.epoch));
	}

	/** Drop the cuts older than the grace (the purge's daily tick, `room.reseed.grace`). */
	prune(at: number) {
		const config = this.config;
		const { sql, tables } = this.room;
		this.#ensure();
		const cutoff = at - (config?.graceDays ?? DEFAULT_RESEED_GRACE_DAYS) * DAY;
		sql.exec(`DELETE FROM ${tables.cuts} WHERE at < ?`, cutoff);
	}
}
