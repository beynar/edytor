/**
 * Cross-document moves (`room.move` in `docs/editor-delete-contract.md`):
 * blocks leave document A for document B so that no concurrent edit is
 * lost. Worker-safe; the room (`DocumentRoom.ts`) owns the storage and the
 * transactions, this module the protocol and the merge.
 *
 * 1. `exportBlocks(ids)` at the source writes nothing: it returns the
 *    blocks' subtrees as JSON and records the export (`moveId`).
 * 2. `importBlocks({ moveId, from, blocks, dest })` at the destination
 *    writes them (their ids, or fresh ones where the destination holds the
 *    id already) as one room transaction, and records the import; a retry
 *    of the same `moveId` writes nothing and returns the same ids — the
 *    acknowledgement.
 * 3. `commitMove(moveId, { to, ids })` at the source, only with that
 *    acknowledgement, deletes the blocks (their subtrees) as one room
 *    transaction and starts watching them: an edit that reaches the
 *    source for them later — an offline client's, or one made between the
 *    export and the commit — is a LATE EDIT.
 * 4. The source turns late edits into per-block content and data changes
 *    (`lateEdits()`), forwards them to the destination for a grace period
 *    (`applyLateEdits`, through the room's `rooms()` namespace or the
 *    host's `forwardLateEdits`), which merges each into its block three
 *    ways — what the destination wrote since stays — and acknowledges by
 *    sequence number. A structural late edit (a split, a new or deleted
 *    block under a moved one) is reported, not forwarded: it stays at the
 *    source, visible there. Past the grace period the source stops
 *    watching.
 *
 * `moveBlocksBetweenRooms(namespace, …)` runs steps 1–3 from the host Worker.
 */
import type { JSONBlock } from '../utils/json.js';
import { canonKey } from '../crdt/text/model.js';

/** Where imported blocks land in the destination: under `parent` at `index`. */
export type MoveDestination = { parent: string | null; index: number };

/** One block's state as a late edit carries it: its content and data. */
export type MovedState = {
	content: NonNullable<JSONBlock['content']>;
	data: Record<string, unknown>;
};

/** One block's late edit: the state last sent (`base`) and the source's now (`src`). */
export type LateEdit = { block: string; base: MovedState; src: MovedState };

/** A batch of late edits of one move, numbered from 1 (`to`: its destination, as the source lists it). */
export type LateEditBatch = {
	moveId: string;
	from: string;
	to?: string;
	seq: number;
	edits: LateEdit[];
};

/** What `exportBlocks` returns. */
export type ExportedBlocks = { moveId: string; blocks: JSONBlock[] };

/** What `importBlocks` takes. */
export type ImportRequest = {
	moveId: string;
	/** The source document's id. */
	from: string;
	blocks: JSONBlock[];
	dest: MoveDestination;
};

/** What `importBlocks` returns: the acknowledgement `commitMove` needs. */
export type ImportReceipt = {
	moveId: string;
	status: 'applied' | 'refused';
	/** Each moved block's id in the destination (a source id it already held is renamed). */
	ids: Record<string, string>;
	reason?: string;
};

/** What `commitMove` returns. */
export type CommitResult = { moveId: string; status: 'applied' | 'refused'; reason?: string };

/** The RPC surface of a room a move talks to (a `DocumentRoom` stub satisfies it). */
export type MoveRoom = {
	exportBlocks(ids: string[]): Promise<ExportedBlocks> | ExportedBlocks;
	importBlocks(request: ImportRequest): Promise<ImportReceipt> | ImportReceipt;
	commitMove(
		moveId: string,
		receipt: { to: string; ids: Record<string, string> }
	): Promise<CommitResult> | CommitResult;
	abortMove(moveId: string): Promise<unknown> | unknown;
	applyLateEdits(
		batch: LateEditBatch
	): Promise<{ applied: number; skipped: string[] }> | { applied: number; skipped: string[] };
	lateEdits(): Promise<LateEditBatch[]> | LateEditBatch[];
	ackLateEdits(moveId: string, seq: number): Promise<unknown> | unknown;
};

/** The rooms a move talks to: a Durable Object namespace of `DocumentRoom`s (or a subclass). */
export type MoveNamespace = { getByName(name: string): MoveRoom };

/** The default grace period: late edits are forwarded this long after the commit. */
export const DEFAULT_MOVE_GRACE_DAYS = 30;

// ── units and the three-way merge ─────────────────────────────────────

/** One display unit: a character (a code point) with its marks, or an inline atom. */
type Unit = { key: string; text?: string; marks?: Record<string, unknown>; atom?: JSONBlock };

/** `content` one unit each, keyed for comparison. */
export const unitsOf = (content: JSONBlock['content'] = []): Unit[] => {
	const out: Unit[] = [];
	for (const item of content) {
		if ('text' in item && typeof item.text === 'string') {
			const marks = (item.marks ?? undefined) as Record<string, unknown> | undefined;
			const tag = canonKey(marks ?? {});
			for (const ch of item.text) out.push({ key: `${ch}|${tag}`, text: ch, marks });
		} else {
			const atom = item as { id?: string; type: string; data?: unknown };
			out.push({
				key: `@${atom.id ?? ''}|${atom.type}|${canonKey(atom.data ?? {})}`,
				atom: atom as unknown as JSONBlock
			});
		}
	}
	return out;
};

/** Units back to JSON content (adjacent text of equal marks joined). */
export const contentOf = (units: readonly Unit[]): NonNullable<JSONBlock['content']> => {
	const out: NonNullable<JSONBlock['content']> = [];
	for (const u of units) {
		if (u.atom !== undefined) {
			out.push(u.atom as never);
			continue;
		}
		const last = out[out.length - 1] as
			| { text?: string; marks?: Record<string, unknown> }
			| undefined;
		if (last?.text !== undefined && canonKey(last.marks ?? {}) === canonKey(u.marks ?? {}))
			last.text += u.text!;
		else out.push({ text: u.text!, ...(u.marks === undefined ? {} : { marks: u.marks as never }) });
	}
	return out;
};

/** The one changed stretch from `x` to `y`: `x[p, e)` became `mid`. */
export const hunk = (x: readonly Unit[], y: readonly Unit[]) => {
	let p = 0;
	while (p < x.length && p < y.length && x[p].key === y[p].key) p++;
	let q = 0;
	while (
		q < x.length - p &&
		q < y.length - p &&
		x[x.length - 1 - q].key === y[y.length - 1 - q].key
	)
		q++;
	return { p, e: x.length - q, mid: y.slice(p, y.length - q) };
};

/**
 * Merge the source's change (`base` → `src`) into the destination's
 * (`base` → `dst`), each read as one stretch: disjoint stretches both
 * apply; overlapping ones keep the destination's and add the source's new
 * units after it (a deletion the destination also edited is dropped).
 */
export const threeWay = (
	base: readonly Unit[],
	src: readonly Unit[],
	dst: readonly Unit[]
): Unit[] => {
	const s = hunk(base, src);
	if (s.p === s.e && s.mid.length === 0) return [...dst];
	const d = hunk(base, dst);
	if (d.p === d.e && d.mid.length === 0) return [...src];
	if (s.e <= d.p) return [...dst.slice(0, s.p), ...s.mid, ...dst.slice(s.e)];
	if (s.p >= d.e) {
		const shift = d.mid.length - (d.e - d.p);
		return [...dst.slice(0, s.p + shift), ...s.mid, ...dst.slice(s.e + shift)];
	}
	const at = d.p + d.mid.length;
	return [...dst.slice(0, at), ...s.mid, ...dst.slice(at)];
};

/** Merge data per top-level key: a key the source changed and the destination did not takes the source's. */
export const mergeData = (
	base: Record<string, unknown>,
	src: Record<string, unknown>,
	dst: Record<string, unknown>
): Record<string, unknown> => {
	const out = { ...dst };
	const same = (a: unknown, b: unknown) => canonKey(a ?? null) === canonKey(b ?? null);
	for (const key of new Set([...Object.keys(base), ...Object.keys(src)])) {
		if (same(base[key], src[key]) || !same(base[key], dst[key])) continue;
		if (src[key] === undefined) delete out[key];
		else out[key] = src[key];
	}
	return out;
};

/** Every block of `blocks`' subtrees, by id, with its content and data. */
export const flattenMoved = (blocks: readonly JSONBlock[]): Map<string, MovedState> => {
	const out = new Map<string, MovedState>();
	const visit = (b: JSONBlock) => {
		if (b.id !== undefined)
			out.set(b.id, { content: b.content ?? [], data: (b.data ?? {}) as Record<string, unknown> });
		for (const c of b.children ?? []) visit(c);
	};
	blocks.forEach(visit);
	return out;
};

/** The subtrees of `ids` in `children`, outermost only, in document order. */
export const subtreesOf = (
	children: readonly JSONBlock[],
	ids: ReadonlySet<string>
): JSONBlock[] => {
	const out: JSONBlock[] = [];
	const visit = (b: JSONBlock) => {
		if (b.id !== undefined && ids.has(b.id)) out.push(b);
		else for (const c of b.children ?? []) visit(c);
	};
	children.forEach(visit);
	return out;
};

// ── the host Worker's side ────────────────────────────────────────────

/**
 * Move blocks `ids` of document `from` to document `to`, under
 * `dest.parent` at `dest.index` (`room.move`): export at the source,
 * import at the destination, then — with its acknowledgement — delete at
 * the source. A failure before the import leaves both documents as they
 * were (the export is aborted); a failure of the commit leaves the blocks
 * in both and throws: call it again with the same `moveId` (`commitMove` is
 * idempotent), or `abortMove`. Returns the destination ids.
 */
export const moveBlocksBetweenRooms = async (
	namespace: MoveNamespace,
	move: { from: string; to: string; ids: string[]; dest: MoveDestination }
): Promise<ImportReceipt> => {
	if (move.from === move.to)
		throw new Error('moveBlocksBetweenRooms: a move between two documents');
	const source = namespace.getByName(move.from);
	const target = namespace.getByName(move.to);
	const exported = await source.exportBlocks(move.ids);
	let receipt: ImportReceipt;
	try {
		receipt = await target.importBlocks({
			moveId: exported.moveId,
			from: move.from,
			blocks: exported.blocks,
			dest: move.dest
		});
	} catch (error) {
		await source.abortMove(exported.moveId);
		throw error;
	}
	if (receipt.status !== 'applied') {
		await source.abortMove(exported.moveId);
		return receipt;
	}
	const committed = await source.commitMove(exported.moveId, { to: move.to, ids: receipt.ids });
	if (committed.status !== 'applied')
		throw new Error(`moveBlocksBetweenRooms: commit refused (${committed.reason ?? 'unknown'})`);
	return receipt;
};

/**
 * Forward the late edits document `from` holds (`room.move.late`) to their
 * destinations and acknowledge them — for a room without `rooms()`, which
 * cannot reach the destination itself. Returns how many batches went.
 */
export const forwardLateEdits = async (namespace: MoveNamespace, from: string): Promise<number> => {
	const source = namespace.getByName(from);
	const batches = await source.lateEdits();
	let sent = 0;
	for (const batch of batches) {
		const to = batch.to;
		if (to === undefined) continue;
		const { applied } = await namespace.getByName(to).applyLateEdits(batch);
		await source.ackLateEdits(batch.moveId, applied);
		sent++;
	}
	return sent;
};
