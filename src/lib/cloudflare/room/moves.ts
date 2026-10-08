/**
 * Moves between rooms (`room.move`): export, import, commit and abort a
 * move of blocks, and the late edits of moved-out blocks — watched for
 * the grace period, collected into batches and forwarded to their
 * destination (`room.move.late`). The three-way merge is `../move.ts`.
 */
import { Y } from '../../crdt/engine.js';
import { DEL_PREFIX, REGISTRY_KEY } from '../../crdt/schema.js';
import { asEngineDoc, attrItems } from '../../crdt/structs.js';
import type { EngineNode } from '../../crdt/engine-api.js';
import type { EdytorDoc, JSONBlock, YDoc } from '../../crdt/index.js';
import { toBlockSpec } from '../../utils/json.js';
import { noTimers } from '../DocumentRoom.js';
import {
	DEFAULT_MOVE_GRACE_DAYS,
	contentOf,
	flattenMoved,
	hunk,
	mergeData,
	subtreesOf,
	threeWay,
	unitsOf,
	type CommitResult,
	type ExportedBlocks,
	type ImportReceipt,
	type ImportRequest,
	type LateEdit,
	type LateEditBatch,
	type MovedState
} from '../move.js';
import { DAY, crdt, type RoomContext } from './context.js';

/** A forward of late edits that failed runs again this much later (`room.move.late`). */
const FORWARD_RETRY = 60_000;

export class RoomMoves {
	/** The blocks moved out and watched for late edits, by id → their move (`null`: not read yet). */
	private watched: Map<string, string> | null = null;

	constructor(private readonly room: RoomContext) {}

	/** Forget the watched blocks (a reset dropped the moves table). */
	forget() {
		this.watched = null;
	}

	private ensureMoves() {
		const { sql, tables } = this.room;
		sql.exec(
			`CREATE TABLE IF NOT EXISTS ${tables.moves} (
				id TEXT PRIMARY KEY,
				role TEXT NOT NULL,
				state TEXT NOT NULL,
				peer TEXT,
				roots TEXT NOT NULL DEFAULT '[]',
				map TEXT NOT NULL DEFAULT '{}',
				sent TEXT NOT NULL DEFAULT '[]',
				watched TEXT NOT NULL DEFAULT '[]',
				marker INTEGER NOT NULL DEFAULT 0,
				c0 INTEGER NOT NULL DEFAULT 0,
				c1 INTEGER NOT NULL DEFAULT 0,
				at INTEGER NOT NULL,
				dirty INTEGER NOT NULL DEFAULT 0,
				seq INTEGER NOT NULL DEFAULT 0
			)`
		);
		sql.exec(
			`CREATE TABLE IF NOT EXISTS ${tables.late} (move TEXT NOT NULL, seq INTEGER NOT NULL, edits TEXT NOT NULL, PRIMARY KEY (move, seq))`
		);
	}

	/** One move's row. */
	private moveRow(id: string, role: 'out' | 'in') {
		this.ensureMoves();
		return this.room.sql
			.exec<{
				id: string;
				state: string;
				peer: string | null;
				roots: string;
				map: string;
				sent: string;
				watched: string;
				marker: number;
				c0: number;
				c1: number;
				at: number;
				dirty: number;
				seq: number;
			}>(`SELECT * FROM ${this.room.tables.moves} WHERE id = ? AND role = ?`, id, role)
			.toArray()[0];
	}

	/** Days a moved-out block is watched for late edits: the purge horizon, else {@link DEFAULT_MOVE_GRACE_DAYS}. */
	private get graceMs(): number {
		return (this.room.purge.days ?? DEFAULT_MOVE_GRACE_DAYS) * DAY;
	}

	/** Export blocks `ids` for a move (`AttachedDocument.exportBlocks`). */
	exportBlocks(ids: string[]): ExportedBlocks {
		const room = this.room;
		return noTimers(() => {
			room.storage.heal();
			room.requireDoc();
			const blocks = subtreesOf(room.facade.toJSON().children, new Set(ids));
			if (blocks.length === 0) throw new Error('exportBlocks: none of these blocks shows');
			const moveId = crypto.randomUUID();
			this.ensureMoves();
			room.sql.exec(
				`INSERT INTO ${room.tables.moves} (id, role, state, roots, sent, at) VALUES (?, 'out', 'exported', ?, ?, ?)`,
				moveId,
				JSON.stringify(blocks.map((b) => b.id)),
				JSON.stringify(blocks),
				room.clock()
			);
			return { moveId, blocks };
		});
	}

	/** Import a move's blocks (`AttachedDocument.importBlocks`). */
	importBlocks(request: ImportRequest): ImportReceipt {
		const room = this.room;
		return noTimers(() => {
			const known = this.moveRow(request.moveId, 'in');
			if (known !== undefined)
				return { moveId: request.moveId, status: 'applied', ids: JSON.parse(known.map) };
			const facade = room.facade;
			const ids: Record<string, string> = {};
			const taken = new Set<string>();
			const rename = (block: JSONBlock): JSONBlock => {
				let id = block.id;
				if (id !== undefined) {
					let to = id;
					for (let n = 2; facade.hasBlock(to) || taken.has(to); n++) to = `${id}~${n}`;
					taken.add(to);
					ids[id] = to;
					id = to;
				}
				return { ...block, id, children: block.children?.map(rename) };
			};
			const specs = request.blocks.map(rename).map((block) => toBlockSpec(block));
			const parent = request.dest.parent;
			if (parent !== null && !facade.isVisibleBlock(parent))
				return { moveId: request.moveId, status: 'refused', ids: {}, reason: 'no such parent' };
			let status = 'refused';
			this.room.transact((f) => {
				const index = Math.max(0, Math.min(request.dest.index, f.childrenIds(parent).length));
				status = f.apply(f.prepare.insertBlocks({ parent, index }, specs)).status;
			});
			if (status !== 'applied')
				return { moveId: request.moveId, status: 'refused', ids: {}, reason: 'insert refused' };
			room.sql.exec(
				`INSERT INTO ${room.tables.moves} (id, role, state, peer, map, at, seq) VALUES (?, 'in', 'imported', ?, ?, ?, 0)`,
				request.moveId,
				request.from,
				JSON.stringify(ids),
				room.clock()
			);
			room.log({
				edytor: 'move',
				moveId: request.moveId,
				role: 'in',
				peer: request.from,
				blocks: Object.keys(ids).length
			});
			return { moveId: request.moveId, status: 'applied', ids };
		});
	}

	/** Commit a move (`AttachedDocument.commitMove`). */
	commitMove(moveId: string, receipt: { to: string; ids: Record<string, string> }): CommitResult {
		const room = this.room;
		return noTimers(() => {
			const row = this.moveRow(moveId, 'out');
			if (row === undefined) return { moveId, status: 'refused', reason: 'unknown move' };
			if (row.state === 'moved' || row.state === 'done') return { moveId, status: 'applied' };
			if (row.state !== 'exported') return { moveId, status: 'refused', reason: row.state };
			const roots = JSON.parse(row.roots) as string[];
			const doc = room.requireDoc();
			const marker = doc.clientID;
			const c0 = doc.store.getClock(marker);
			this.room.transact((f) => {
				for (const id of roots)
					if (f.isVisibleBlock(id)) f.apply(f.prepare.deleteBlock(id, { keepChildren: false }));
			});
			const c1 = doc.store.getClock(marker);
			const watched = this.markedBetween(room.requireDoc(), marker, c0, c1);
			room.sql.exec(
				`UPDATE ${room.tables.moves} SET state = 'moved', peer = ?, map = ?, marker = ?, c0 = ?, c1 = ?, watched = ?, at = ?, dirty = 1 WHERE id = ? AND role = 'out'`,
				receipt.to,
				JSON.stringify(receipt.ids),
				marker,
				c0,
				c1,
				JSON.stringify(watched),
				room.clock(),
				moveId
			);
			this.watched = null;
			room.scheduler.schedule('forward', room.clock(), 'earlier');
			room.log({ edytor: 'move', moveId, role: 'out', peer: receipt.to, blocks: roots.length });
			return { moveId, status: 'applied' };
		});
	}

	/** Drop an export that was not committed (`AttachedDocument.abortMove`). */
	abortMove(moveId: string): { moveId: string; status: 'applied' | 'noop' } {
		this.ensureMoves();
		const row = this.moveRow(moveId, 'out');
		if (row?.state !== 'exported') return { moveId, status: 'noop' };
		this.room.sql.exec(
			`UPDATE ${this.room.tables.moves} SET state = 'aborted', sent = '[]' WHERE id = ? AND role = 'out'`,
			moveId
		);
		return { moveId, status: 'applied' };
	}

	/** The late edits waiting to reach their destination, oldest first. */
	lateEdits(): LateEditBatch[] {
		const { sql, tables } = this.room;
		this.ensureMoves();
		return sql
			.exec<{
				move: string;
				seq: number;
				edits: string;
				peer: string | null;
			}>(
				`SELECT l.move AS move, l.seq AS seq, l.edits AS edits, m.peer AS peer FROM ${tables.late} l JOIN ${tables.moves} m ON m.id = l.move AND m.role = 'out' ORDER BY l.move, l.seq`
			)
			.toArray()
			.map((row) => ({
				moveId: row.move,
				from: this.room.roomId,
				...(row.peer === null ? {} : { to: row.peer }),
				seq: row.seq,
				edits: JSON.parse(row.edits) as LateEdit[]
			}));
	}

	/** The destination applied a move's late edits through `seq`: they are dropped here. */
	ackLateEdits(moveId: string, seq: number): void {
		this.ensureMoves();
		this.room.sql.exec(
			`DELETE FROM ${this.room.tables.late} WHERE move = ? AND seq <= ?`,
			moveId,
			seq
		);
	}

	/** Apply a batch of late edits (`AttachedDocument.applyLateEdits`). */
	applyLateEdits(batch: LateEditBatch): { applied: number; skipped: string[] } {
		return noTimers(() => {
			const row = this.moveRow(batch.moveId, 'in');
			if (row === undefined) return { applied: 0, skipped: batch.edits.map((e) => e.block) };
			if (row.seq >= batch.seq) return { applied: row.seq, skipped: [] };
			const skipped: string[] = [];
			this.room.transact((f) => {
				for (const edit of batch.edits) {
					if (!f.isVisibleBlock(edit.block)) {
						skipped.push(edit.block);
						continue;
					}
					this.mergeLateEdit(f, edit);
				}
			});
			this.room.sql.exec(
				`UPDATE ${this.room.tables.moves} SET seq = ? WHERE id = ? AND role = 'in'`,
				batch.seq,
				batch.moveId
			);
			return { applied: batch.seq, skipped };
		});
	}

	/** One block's late edit, merged into what it holds (inside a room transaction). */
	private mergeLateEdit(f: EdytorDoc, edit: LateEdit) {
		const id = edit.block;
		const dst = unitsOf(
			f.contentItems(id).map((item) =>
				item.kind === 'text'
					? { text: item.text, ...(item.marks === undefined ? {} : { marks: item.marks }) }
					: {
							id: item.id,
							type: item.type,
							...(item.data === undefined ? {} : { data: item.data })
						}
			) as JSONBlock['content']
		);
		const merged = threeWay(unitsOf(edit.base.content), unitsOf(edit.src.content), dst);
		const { p, e, mid } = hunk(dst, merged);
		const width = (u: (typeof dst)[number]) => (u.text === undefined ? 1 : u.text.length);
		let at = dst.slice(0, p).reduce((n, u) => n + width(u), 0);
		const gone = dst.slice(p, e).reduce((n, u) => n + width(u), 0);
		if (gone > 0) f.apply(f.prepare.deleteText(id, at, gone));
		for (const item of contentOf(mid)) {
			if ('text' in item && typeof item.text === 'string') {
				f.apply(f.prepare.insertText(id, at, item.text, item.marks as Record<string, unknown>));
				at += item.text.length;
			} else {
				const atom = item as { id?: string; type: string; data?: Record<string, unknown> };
				f.apply(
					f.prepare.insertInline(id, at, {
						id: atom.id ?? crypto.randomUUID(),
						type: atom.type,
						...(atom.data === undefined ? {} : { data: atom.data })
					})
				);
				at += 1;
			}
		}
		const now = subtreesOf(f.toJSON().children, new Set([id]))[0];
		const data = (now?.data ?? {}) as Record<string, unknown>;
		const next = mergeData(edit.base.data, edit.src.data, data);
		if (JSON.stringify(next) !== JSON.stringify(data)) f.apply(f.prepare.setBlockData(id, next));
	}

	/** The registry entries carrying a `del.<marker>` mark written between clocks `c0` and `c1`. */
	private markedBetween(doc: YDoc, marker: number, c0: number, c1: number): string[] {
		const out: string[] = [];
		const key = `${DEL_PREFIX}${marker}`;
		asEngineDoc(doc)
			.get(REGISTRY_KEY)
			.forEachAttr((node: unknown, id: string) => {
				const item = (
					node as { _map?: Map<string, { id: { client: number; clock: number } }> }
				)._map?.get(key);
				if (
					item !== undefined &&
					item.id.client === marker &&
					item.id.clock >= c0 &&
					item.id.clock < c1
				)
					out.push(id);
			});
		return out;
	}

	/** The moved-out blocks watched for late edits (`room.move.late`), by id → their move. */
	private watchedBlocks(): Map<string, string> {
		if (this.watched !== null) return this.watched;
		this.ensureMoves();
		const out = new Map<string, string>();
		for (const row of this.room.sql
			.exec<{
				id: string;
				watched: string;
			}>(`SELECT id, watched FROM ${this.room.tables.moves} WHERE role = 'out' AND state = 'moved'`)
			.toArray())
			for (const id of JSON.parse(row.watched) as string[]) out.set(id, row.id);
		return (this.watched = out);
	}

	/** A transaction that changed a watched block marks its move dirty (inside the `update` emit: no doc write). */
	noteLateEdits(tr: { changed?: Map<unknown, Set<string | null>> }) {
		const room = this.room;
		if (this.watched !== null && this.watched.size === 0) return;
		if (tr?.changed === undefined || room.live === null) return;
		let watched: Map<string, string> | null = null;
		const registry = room.live.get(REGISTRY_KEY) as unknown;
		const dirty = new Set<string>();
		for (const [type, subs] of tr.changed) {
			let key: string | null = null;
			if (type === registry) {
				for (const sub of subs) {
					watched ??= this.watchedBlocks();
					const move = sub === null ? undefined : watched.get(sub);
					if (move !== undefined) dirty.add(move);
				}
				continue;
			}
			for (
				let t = type as { _item: { parent: unknown; parentSub: string | null } | null } | null;
				t;
			) {
				const it = t._item;
				if (it === null) break;
				if (it.parent === registry) {
					key = it.parentSub;
					break;
				}
				t = it.parent as typeof t;
			}
			if (key === null) continue;
			watched ??= this.watchedBlocks();
			if (watched.size === 0) return;
			const move = watched.get(key);
			if (move !== undefined) dirty.add(move);
		}
		if (dirty.size === 0) return;
		for (const move of dirty)
			room.sql.exec(
				`UPDATE ${room.tables.moves} SET dirty = 1 WHERE id = ? AND role = 'out'`,
				move
			);
		room.scheduler.schedule('forward', room.clock(), 'earlier');
	}

	/**
	 * The `forward` task (`room.move.late`): turn each dirty move's changes
	 * into a batch of late edits — read on a copy of the document with the
	 * move's own deletes left out — then forward the waiting batches to
	 * their destinations (with `rooms`), and stop watching moves past the
	 * grace period. A forward that fails runs again a minute later.
	 */
	async forwardMoves(): Promise<void> {
		const room = this.room;
		const { scheduler, sql, tables } = room;
		scheduler.unschedule('forward');
		this.ensureMoves();
		const now = room.clock();
		// Past the grace period: no longer watched.
		sql.exec(
			`UPDATE ${tables.moves} SET state = 'done', sent = '[]', watched = '[]' WHERE role = 'out' AND state = 'moved' AND at <= ?`,
			now - this.graceMs
		);
		this.watched = null;
		const dirty = sql
			.exec<{
				id: string;
				roots: string;
				sent: string;
				map: string;
				watched: string;
				marker: number;
				c0: number;
				c1: number;
				seq: number;
			}>(
				`SELECT id, roots, sent, map, watched, marker, c0, c1, seq FROM ${tables.moves} WHERE role = 'out' AND state = 'moved' AND dirty = 1`
			)
			.toArray();
		if (dirty.length > 0 && room.live !== null) {
			const children = noTimers(() => this.withoutMoveDeletes(dirty));
			for (const row of dirty) this.collectLateEdits(row, children);
		}
		const rooms = room.options.rooms?.();
		let retry = false;
		if (rooms !== undefined) {
			for (const batch of this.lateEdits()) {
				if (batch.to === undefined) continue;
				try {
					const { applied } = await rooms.getByName(batch.to).applyLateEdits(batch);
					this.ackLateEdits(batch.moveId, applied);
				} catch (error) {
					retry = true;
					room.note({ reason: 'internal', detail: `move ${batch.moveId}: ${String(error)}` });
				}
			}
		}
		if (retry) return scheduler.schedule('forward', room.clock() + FORWARD_RETRY, 'earlier');
		const next = sql
			.exec<{
				at: number | null;
			}>(`SELECT MIN(at) AS at FROM ${tables.moves} WHERE role = 'out' AND state = 'moved'`)
			.one().at;
		if (next !== null) scheduler.schedule('forward', next + this.graceMs, 'earlier');
	}

	/** The document's blocks as they show without the deletes of `moves`' commits: a copy, read once. */
	private withoutMoveDeletes(
		moves: readonly { watched: string; marker: number; c0: number; c1: number }[]
	): JSONBlock[] {
		const copy = crdt.createDoc();
		Y.applyUpdateV2(copy, Y.encodeStateAsUpdateV2(this.room.requireDoc()));
		const facade = this.room.facadeOf(copy);
		try {
			const registry = asEngineDoc(copy).get(REGISTRY_KEY);
			copy.transact(() => {
				for (const move of moves) {
					const key = `${DEL_PREFIX}${move.marker}`;
					for (const id of JSON.parse(move.watched) as string[]) {
						const node = registry.getAttr(id) as EngineNode | undefined;
						type Entry = { deleted: boolean; id: { client: number; clock: number } };
						const item = node && attrItems<Entry>(node).get(key);
						if (
							item !== undefined &&
							!item.deleted &&
							item.id.client === move.marker &&
							item.id.clock >= move.c0 &&
							item.id.clock < move.c1
						)
							node!.deleteAttr(key);
					}
				}
			});
			return facade.toJSON().children;
		} finally {
			facade.dispose();
			copy.destroy();
		}
	}

	/** One dirty move's changes since its last batch, as a new batch of late edits (or a report). */
	private collectLateEdits(
		row: { id: string; roots: string; sent: string; map: string; seq: number },
		children: JSONBlock[]
	) {
		const room = this.room;
		const roots = new Set(JSON.parse(row.roots) as string[]);
		const now = subtreesOf(children, roots);
		const sent = flattenMoved(JSON.parse(row.sent) as JSONBlock[]);
		const cur = flattenMoved(now);
		const map = JSON.parse(row.map) as Record<string, string>;
		const same = (a: MovedState, b: MovedState) =>
			JSON.stringify([a.content, a.data]) === JSON.stringify([b.content, b.data]);
		const edits: LateEdit[] = [];
		let structural = 0;
		for (const [id, base] of sent) {
			const src = cur.get(id);
			if (src === undefined) structural++;
			else if (!same(base, src)) edits.push({ block: map[id] ?? id, base, src });
		}
		for (const id of cur.keys()) if (!sent.has(id)) structural++;
		// A structural late edit (a split, a new or deleted block) stays at the
		// source, visible there: the move's content edits stop being forwarded.
		const forwarded = structural === 0 && edits.length > 0;
		const seq = forwarded ? row.seq + 1 : row.seq;
		room.ctx.storage.transactionSync(() => {
			if (forwarded)
				room.sql.exec(
					`INSERT INTO ${room.tables.late} (move, seq, edits) VALUES (?, ?, ?)`,
					row.id,
					seq,
					JSON.stringify(edits)
				);
			room.sql.exec(
				`UPDATE ${room.tables.moves} SET sent = ?, seq = ?, dirty = 0, state = ? WHERE id = ? AND role = 'out'`,
				JSON.stringify(now),
				seq,
				structural > 0 ? 'diverged' : 'moved',
				row.id
			);
		});
		if (structural > 0) this.watched = null;
		if (edits.length > 0 || structural > 0)
			room.log({ edytor: 'late', moveId: row.id, seq, edits: edits.length, structural, forwarded });
	}
}
