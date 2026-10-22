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
 * document (`messageRebase`): its unsaved edits are rebased onto a copy of
 * the current document, and what that wrote goes through the admission as
 * an update of its user (`room.reseed.rebase`: the quotas, access,
 * validation, attribution), then it is closed `4410` too; one that may not
 * write is closed at once. Any other epoch the room cannot rebase (older
 * than the cuts kept, `graceDays`, or later than the room's) is closed
 * `4410` at once, and a dial that names none, in a room that re-seeded,
 * `1008` (a client that predates the re-seed). A current socket that sends
 * an older epoch's content (a tab that took it from another) is closed
 * `4410` too.
 */
import { Y } from '../../crdt/engine.js';
import * as E from '../../crdt/protocol.js';
import { CLOSE } from '../../crdt/providers/room.js';
import {
	baseOf,
	cutBetween,
	decodeCut,
	decodeMerged,
	encodeCut,
	encodeMerged,
	hasEdits,
	rebaseOnto,
	seedFrom,
	type Cut,
	type Replica
} from '../../crdt/reseed.js';
import { asEngineDoc } from '../../crdt/structs.js';
import { suggestionsOf } from '../../crdt/doc/suggest.js';
import { EPOCH_ROOT } from '../../crdt/schema.js';
import type { YDoc } from '../../crdt/index.js';
import type { Attachment, SocketIdentity } from '../DocumentRoom.js';
import { allowance, type Bucket } from './admission.js';
import type { Decoded } from './context.js';
import {
	DEFAULT_RESEED_FORCE,
	DEFAULT_RESEED_GAIN,
	DEFAULT_RESEED_GRACE_DAYS,
	DEFAULT_RESEED_IDLE,
	noTimers
} from './shared.js';
import { DAY, crdt, now, type RoomContext } from './context.js';
import { decode, epochFrame } from './frames.js';

/** A share in (0, 1], else `fallback`. */
const share = (value: unknown, fallback: number) => {
	const n = Number(value);
	return n > 0 && n <= 1 ? n : fallback;
};

/** A rebase is a full rebuild of the document: one per user every ten seconds. */
const REBASES_PER_SECOND = 0.1;

/** A failed re-seed runs again this much later. */
const RESEED_RETRY = 60_000;

/** An epoch a dial names (`?epoch=`; `new`: a document that holds nothing yet), or `null`. */
export const parseEpoch = (raw: string | null): number | 'new' | null => {
	if (raw === 'new') return raw;
	const n = raw !== null && /^\d{1,9}$/.test(raw) ? Number(raw) : NaN;
	return Number.isSafeInteger(n) ? n : null;
};

export class RoomReseed {
	/** Each user's rebase allowance (memory: a wake refills it). */
	readonly #rebases = new Map<string, Bucket>();
	/** When the last re-seed failed: none again before {@link RESEED_RETRY} (memory). */
	#failedAt = -Infinity;
	/** The client ids of the epochs the cuts kept (`null`: not read since they changed). */
	#oldClients: Set<number> | null = null;

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

	/** The room's epoch: what its document says (`epoch.n`, which only the room writes), 0 before a re-seed. */
	get epoch(): number {
		const n =
			this.room.live === null ? 0 : asEngineDoc(this.room.live).get(EPOCH_ROOT).getAttr('n');
		return typeof n === 'number' ? n : 0;
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

	/** Store `bytes` as epoch `epoch`'s `kind` (`cut`, `merged:<user>`), in rows ≤ `maxRowBytes`. */
	#write(epoch: number, kind: string, bytes: Uint8Array, at: number) {
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

	#read(epoch: number, kind: string): { bytes: Uint8Array; at: number } | null {
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
		// Under the floor a re-seed gave back too little: none until the document grows past it;
		// after one that failed, none before its retry.
		if (bytes < config.at || bytes < this.#floor() || at < this.#failedAt + RESEED_RETRY) return;
		if (bytes >= config.force) scheduler.schedule('reseed', at, 'earlier');
		else scheduler.schedule('reseed', at + config.idleMs, 'replace');
	}

	/**
	 * The `reseed` task: the cuts past their grace go (`room.reseed.grace`),
	 * then it re-seeds when still due (past the threshold and the floor); a
	 * re-seed that failed runs again a minute later. It is due again when
	 * the oldest cut left expires.
	 */
	task() {
		const room = this.room;
		noTimers(() => {
			const config = this.config;
			room.scheduler.unschedule('reseed');
			this.prune(room.clock());
			const bytes = room.storage.documentBytes;
			if (config !== null && room.live !== null && bytes >= config.at && bytes >= this.#floor()) {
				try {
					this.run(bytes >= config.force ? 'full' : 'idle');
				} catch (error) {
					room.note({ reason: 'internal', detail: `reseed: ${String(error)}` });
					this.#failedAt = room.clock();
					room.scheduler.schedule('reseed', room.clock() + RESEED_RETRY, 'earlier');
				}
			}
			this.#prunesAt();
		});
	}

	/** Due when the oldest cut kept passes its grace. */
	#prunesAt() {
		const { sql, tables, scheduler } = this.room;
		this.#ensure();
		const oldest = sql
			.exec<{ at: number | null }>(`SELECT MIN(at) AS at FROM ${tables.cuts} WHERE kind = 'cut'`)
			.toArray()[0]?.at;
		const grace = (this.config?.graceDays ?? DEFAULT_RESEED_GRACE_DAYS) * DAY;
		if (oldest != null) scheduler.schedule('reseed', oldest + grace, 'earlier');
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
				const epoch = this.epoch + 1;
				const base = baseOf(old.facade);
				const document = seedFrom(old, base, (json): Replica => {
					fresh.seed(json.children, json.data);
					// The document says its epoch: a client dials with it (`room.reseed.protocol`).
					asEngineDoc(scratch).get(EPOCH_ROOT).setAttr('n', epoch);
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
				const cut = cutBetween(old, base, document);
				const at = room.clock();
				const { sql, tables } = room;
				room.storage.replaceWith(update, () => {
					sql.exec(`DELETE FROM ${tables.replicas}`);
					sql.exec(`DELETE FROM ${tables.epochs}`);
					sql.exec(`DELETE FROM ${tables.restore}`);
					sql.exec(`DELETE FROM ${tables.meta} WHERE key = 'reseed.floor'`);
					this.#write(epoch, 'cut', encodeCut(cut), at);
				});
				this.#oldClients = null;
				// The `onSave` mirror holds the new epoch, as the rows do.
				room.storage.scheduleSave();
				this.#prunesAt();
				room.state.presence.clear();
				room.storage.rebuild();
				// A stale socket's hand-over still merges: the cuts it reads down are kept.
				for (const ws of room.sockets()) {
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
	 * or closed: none, in a room that re-seeded, `1008` (a client that
	 * predates the re-seed); any other epoch the room cannot rebase (past
	 * the cuts kept, or later than its own: the room lost it), `4410`, so
	 * the client drops its copy and loads the room's.
	 */
	door(asked: number | 'new' | null): 'current' | 'stale' | { code: number; reason: string } {
		const current = this.epoch;
		if (asked === 'new') return 'current';
		if (asked === null)
			return current === 0 ? 'current' : { code: CLOSE.refused, reason: 'refused: epoch' };
		if (asked === current) return 'current';
		if (asked < current && this.#cutsSince(asked) !== null) return 'stale';
		return { code: CLOSE.reseeded, reason: String(current) };
	}

	/**
	 * Whether `decoded`, from a socket of the current epoch, holds an older
	 * epoch's content (`room.reseed.protocol`): a struct of a client the
	 * cuts kept name, which the document holds nothing of (a tab took it
	 * from another tab of the old epoch). Its socket is closed `4410`.
	 */
	holdsOld(decoded: Decoded, doc: YDoc): boolean {
		if (this.#oldClients?.size === 0 || this.epoch === 0) return false;
		if (this.#oldClients === null) {
			const { sql, tables } = this.room;
			this.#ensure();
			const epochs = sql
				.exec<{ epoch: number }>(`SELECT DISTINCT epoch FROM ${tables.cuts} WHERE kind = 'cut'`)
				.toArray();
			this.#oldClients = new Set();
			for (const { epoch } of epochs) {
				const found = this.#read(epoch, 'cut');
				if (found === null) continue;
				for (const client of Y.decodeStateVector(decodeCut(found.bytes).sv).keys())
					this.#oldClients.add(client);
			}
		}
		const old = this.#oldClients;
		const held = doc.store.clients;
		return decoded.structs.some(
			(struct) =>
				!(struct instanceof Y.Skip) && old.has(struct.id.client) && !held.has(struct.id.client)
		);
	}

	/** The largest frame a socket of an older epoch may send: its whole old document. */
	get staleFrameBytes(): number {
		const { maxInboundFrameBytes, maxDocumentBytes, maxBufferedBytes } = this.room.limits;
		return Math.min(maxBufferedBytes, Math.max(maxInboundFrameBytes, 2 * maxDocumentBytes));
	}

	/**
	 * A stale socket joined: one that may write is told the room's epoch
	 * (its provider then hands over its old document); any other has no
	 * edit to merge and is closed `4410`. Past its user's rebase rate it is
	 * closed `1011` before it uploads anything: its provider dials again
	 * later.
	 */
	join(ws: WebSocket, identity: SocketIdentity) {
		const room = this.room;
		if (identity.readOnly || identity.access === 'suggest') {
			return room.close(ws, CLOSE.reseeded, String(this.epoch));
		}
		if (!this.#mayRebase(identity.user)) return room.close(ws, CLOSE.fault, 'rebase: rate');
		room.send(ws, epochFrame(this.epoch));
	}

	/** Whether `user`'s rebase allowance holds a token now (it takes none). */
	#mayRebase(user: string): boolean {
		const held = this.#rebases.get(user);
		if (held === undefined) return true;
		const burst = REBASES_PER_SECOND * 10;
		const elapsed = Math.max(0, this.room.clock() - held.at) / 1000;
		return Math.min(burst, held.tokens + elapsed * REBASES_PER_SECOND) >= 1;
	}

	/**
	 * A stale socket's message: its old document (`messageRebase`) is
	 * rebased onto a copy of the current one, and what that wrote is
	 * admitted as an update of its user, from a client id of its own (the
	 * admission's quotas, access, validation and attribution, as any
	 * update); then it is closed `4410`. The merged state is kept per user
	 * and cut (`merged:<user>`), so another tab's upload merges nothing
	 * twice and another user's cannot claim it. A hand-over that cannot be
	 * read or rebased is dropped, its socket closed `4410` all the same (its
	 * client loads the room's document); past the rebase rate (one per user
	 * every ten seconds), `1011`, and the provider hands over again later.
	 * Anything else a stale socket sends is dropped.
	 */
	onStale(ws: WebSocket, attachment: Attachment, type: number, decoder: E.Decoder) {
		const room = this.room;
		if (type !== E.messageRebase) return;
		const from = attachment.epoch!;
		const started = now();
		const done = (status: 'noop' | 'applied' | 'refused' | 'failed', bytes: number) => {
			room.log({
				edytor: 'rebase',
				user: attachment.user,
				from,
				epoch: this.epoch,
				status,
				bytes,
				ms: now() - started
			});
			if (ws.readyState === WebSocket.OPEN) room.close(ws, CLOSE.reseeded, String(this.epoch));
		};
		let upload: Uint8Array;
		let update: Uint8Array | null;
		let writer: number;
		let merged: ReturnType<typeof rebaseOnto>['merged'];
		const kind = `merged:${attachment.user}`;
		// Read-only now (a downgrade since it joined): nothing to rebuild.
		if (attachment.readOnly) return done('refused', 0);
		let cuts: Cut[] | null;
		let found: { bytes: Uint8Array; at: number } | null;
		try {
			cuts = this.#cutsSince(from);
			found = this.#read(from + 1, kind);
		} catch (error) {
			room.note({ reason: 'internal', detail: `rebase: ${String(error)}` });
			return done('failed', 0);
		}
		if (cuts === null) return done('failed', 0);
		try {
			upload = decode(() => E.readVarUint8Array(decoder));
			const before = found === null ? undefined : decodeMerged(found.bytes);
			if (!hasEdits(upload, before ?? { sv: cuts[0]!.sv, ds: cuts[0]!.ds, maps: [] }))
				return done('noop', upload.length);
			if (!allowance(this.#rebases, attachment.user, REBASES_PER_SECOND, room.clock())) {
				room.note({ reason: 'quota', detail: { user: attachment.user, quota: 'rebase' } });
				return room.close(ws, CLOSE.fault, 'rebase: rate');
			}
			({ update, writer, merged } = this.#rebase(attachment.user, cuts, upload, before));
		} catch (error) {
			room.note({ reason: 'internal', detail: `rebase: ${String(error)}` });
			return done('failed', 0);
		}
		if (update === null) return done('noop', upload.length);
		const doc = room.requireDoc();
		// The rebase's writes, from a client id of their own: the admission's, as any update's.
		const admitted = room.admission.admitRebase(ws, attachment, doc, update, writer);
		if (!admitted) return done('refused', upload.length);
		try {
			room.ctx.storage.transactionSync(() =>
				this.#write(from + 1, kind, encodeMerged(merged), this.#read(from + 1, 'cut')!.at)
			);
		} catch (error) {
			// The edits are in: the client still drops its copy, never hands them over again.
			room.note({ reason: 'storage', detail: `rebase: ${String(error)}` });
		}
		done('applied', upload.length);
	}

	/**
	 * Rebase `upload` onto a copy of the live document as `user`
	 * (`crdt/reseed.ts`): the update the copy's writes make (`null`:
	 * nothing to write), the client id they are under (the copy's own,
	 * random) and what this rebase merged.
	 */
	#rebase(
		user: string,
		cuts: Cut[],
		upload: Uint8Array,
		merged: ReturnType<typeof rebaseOnto>['merged'] | undefined
	): {
		update: Uint8Array | null;
		writer: number;
		merged: ReturnType<typeof rebaseOnto>['merged'];
	} {
		const room = this.room;
		const live = room.requireDoc();
		const scratch: { doc: YDoc; facade: { dispose(): void } }[] = [];
		const open = (update: Uint8Array, actor?: { id: string }): Replica => {
			const doc = crdt.createDoc();
			Y.applyUpdate(doc, update);
			const facade = room.facadeOf(doc, actor);
			scratch.push({ doc, facade });
			return { doc: asEngineDoc(doc), facade: facade as never };
		};
		try {
			const target = open(Y.encodeStateAsUpdate(live), { id: user });
			const copy = scratch[0]!;
			let result!: ReturnType<typeof rebaseOnto>;
			(copy.facade as unknown as { transact(f: () => void): void }).transact(() => {
				result = rebaseOnto(target, cuts, upload, (update) => open(update), merged);
			});
			const update =
				result.report.status === 'noop'
					? null
					: Y.encodeStateAsUpdate(copy.doc, Y.encodeStateVector(live));
			return { update, writer: copy.doc.clientID, merged: result.merged };
		} finally {
			for (const { doc, facade } of scratch) {
				facade.dispose();
				doc.destroy();
			}
		}
	}

	/** Drop the cuts older than the grace, with what their rebases merged (`room.reseed.grace`). */
	prune(at: number) {
		const config = this.config;
		const { sql, tables } = this.room;
		this.#ensure();
		const cutoff = at - (config?.graceDays ?? DEFAULT_RESEED_GRACE_DAYS) * DAY;
		const gone = sql
			.exec<{
				epoch: number;
			}>(`SELECT DISTINCT epoch FROM ${tables.cuts} WHERE kind = 'cut' AND at < ?`, cutoff)
			.toArray();
		for (const { epoch } of gone) sql.exec(`DELETE FROM ${tables.cuts} WHERE epoch = ?`, epoch);
		if (gone.length > 0) this.#oldClients = null;
	}
}
