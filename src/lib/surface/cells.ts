/**
 * Render cells (plan §2.4 "Render cells", "Segments", "Placeholder attribute";
 * §4.4 `surface/cells.ts`; rules R1, R11).
 *
 * One cell per visible block id, `{type, data, childIds, runs}`. The tree is
 * built once from the document's projection; after that it changes only when
 * a commit's change report (D9: `added`, `removed`, `order`, `meta`,
 * `content`) is applied. A cell is a frozen value. A patch replaces exactly
 * the cells the report names and keeps every other object, so a consumer can
 * key its reactivity on identity. A cell exists iff the last report left its
 * id visible.
 *
 * Segments are a pure function of a cell's runs: the text between inline
 * atoms, keyed by the id of the atom before it, or `start`. A segment has no
 * identity beyond that key, so typing inside it, or an atom inserted in
 * another segment, never renames it (positional ordinals did, L18).
 *
 * Cells are reactive (R2): each cell and the root list are pointers a patch
 * replaces, so a component re-renders only when the cell it reads was named
 * by a report. Components render from cells only; operations read the
 * document (R3), and the wrapper mirror is patched from the same reports
 * until R4.
 */
import { SvelteMap, createSubscriber } from 'svelte/reactivity';
import type { BlockId, ContentRun, DocChange, ProjectedBlock } from '../crdt/index.js';
import type { JSONText } from '../utils/json.js';

type Data = Readonly<Record<string, unknown>> | undefined;

export type Cell = {
	readonly id: BlockId;
	readonly type: string;
	readonly data: Data;
	readonly childIds: readonly BlockId[];
	readonly runs: readonly ContentRun[];
};

/** What a cell tree is patched from: the change report's collections (§2.4). */
export type CellReport = Pick<DocChange, 'added' | 'removed' | 'order' | 'meta' | 'content'>;

/** The document surface cells read: its projection once, then its change reports. */
export type CellSource = {
	project: () => { children: ProjectedBlock[] };
	onChange: (cb: (change: DocChange) => void) => () => void;
};

/** The ids a patch replaced; `null` names the root's child list. */
export type Patched = ReadonlySet<BlockId | null>;
/** The cells a patch replaced, as they were before it (what the DOM still shows). */
export type Replaced = ReadonlyMap<BlockId, Cell>;

export type Cells = {
	/** The root's visible child ids. */
	readonly rootIds: readonly BlockId[];
	readonly size: number;
	get: (id: BlockId) => Cell | undefined;
	/** Patch from one change report. */
	apply: (report: CellReport) => Patched;
	/** Re-create a block's text elements from its cell (the observer's repair of foreign damage). */
	remount: (id: BlockId) => void;
	/** Bumped by {@link remount}: part of the block's text element keys. */
	epoch: (id: BlockId) => number;
	dispose: () => void;
};

const cellOf = (node: ProjectedBlock): Cell =>
	Object.freeze({
		id: node.id,
		type: node.type,
		data: node.data,
		childIds: Object.freeze(node.children.map((child) => child.id)),
		runs: node.content
	});

const sameIds = (a: readonly BlockId[], b: readonly BlockId[]) =>
	a.length === b.length && a.every((id, i) => id === b[i]);

/**
 * The cells of `source`'s visible tree, patched from each of its change
 * reports (`onPatch` is told which cells each report replaced).
 */
export const createCells = (
	source: CellSource,
	onPatch?: (patched: Patched, before: Replaced) => void
): Cells => {
	const cells = new SvelteMap<BlockId, Cell>();
	const epochs = new SvelteMap<BlockId, number>();
	let notifyRoot = () => {};
	const trackRoot = createSubscriber((update) => {
		notifyRoot = update;
		return () => (notifyRoot = () => {});
	});
	const build = (node: ProjectedBlock) => {
		cells.set(node.id, cellOf(node));
		node.children.forEach(build);
	};
	const top = source.project().children;
	let rootIds: readonly BlockId[] = Object.freeze(top.map((node) => node.id));
	top.forEach(build);

	let before = new Map<BlockId, Cell>();
	const patch = (id: BlockId, fields: Partial<Cell>) => {
		const cell = cells.get(id);
		if (cell && !before.has(id)) before.set(id, cell);
		if (cell) cells.set(id, Object.freeze({ ...cell, ...fields }));
		return cell !== undefined;
	};

	const apply = (report: CellReport): Patched => {
		before = new Map();
		const patched = new Set<BlockId | null>();
		// A child listed by a changed parent is still visible, even when its old
		// parent's subtree went away in the same commit.
		const listed = new Set<BlockId>();
		for (const ids of report.order.values()) for (const id of ids) listed.add(id);
		const drop = (id: BlockId) => {
			const cell = cells.get(id);
			if (!cell) return;
			cells.delete(id);
			for (const child of cell.childIds) if (!listed.has(child)) drop(child);
		};
		report.removed.forEach(drop);
		// An added subtree carries its new descendants. One that was visible
		// before keeps its cell: the report names it again where it changed (K7).
		const rebuild = (node: ProjectedBlock) => {
			if (patched.has(node.id)) return;
			if (!cells.has(node.id)) {
				cells.set(node.id, cellOf(node));
				patched.add(node.id);
			}
			node.children.forEach(rebuild);
		};
		report.added.forEach(rebuild);
		for (const [parent, ids] of report.order) {
			if (parent === null) {
				if (sameIds(rootIds, ids)) continue;
				rootIds = ids;
				patched.add(null);
				notifyRoot();
			} else if (!sameIds(cells.get(parent)?.childIds ?? ids, ids)) {
				patch(parent, { childIds: ids });
				patched.add(parent);
			}
		}
		for (const [id, meta] of report.meta)
			if (patch(id, { type: meta.type, data: meta.data })) patched.add(id);
		for (const [id, runs] of report.content) if (patch(id, { runs })) patched.add(id);
		return patched;
	};

	const off = source.onChange((change) => {
		const patched = apply(change);
		onPatch?.(patched, before);
	});

	return {
		get rootIds() {
			trackRoot();
			return rootIds;
		},
		get size() {
			return cells.size;
		},
		get: (id) => cells.get(id),
		apply,
		remount: (id) => {
			epochs.set(id, (epochs.get(id) ?? 0) + 1);
			onPatch?.(new Set([id]), new Map());
		},
		epoch: (id) => epochs.get(id) ?? 0,
		dispose: off
	};
};

// ── segments and render deltas ──────────────────────────────────────────

export const START = 'start';

type TextRun = Extract<ContentRun, { kind: 'text' }>;

/** The text between two inline atoms (or a content edge), keyed causally. */
export type Segment = {
	readonly kind: 'text';
	/** The id of the atom before this segment, or {@link START}. */
	readonly key: string;
	readonly text: string;
	readonly runs: readonly TextRun[];
};

export type AtomPart = {
	readonly kind: 'inline';
	readonly key: string;
	readonly id: string;
	readonly type: string;
	readonly data: Data;
};

export type Part = Segment | AtomPart;

const partsMemo = new WeakMap<readonly ContentRun[], readonly Part[]>();

/**
 * A cell's content as segments and atoms, alternating, starting and ending
 * with a segment (an empty content is one empty `start` segment).
 */
export const partsOf = (runs: readonly ContentRun[]): readonly Part[] => {
	const memo = partsMemo.get(runs);
	if (memo) return memo;
	const parts: Part[] = [];
	let key = START;
	let segment: TextRun[] = [];
	const close = () =>
		parts.push(
			Object.freeze({
				kind: 'text' as const,
				key,
				text: segment.map((run) => run.text).join(''),
				runs: Object.freeze(segment)
			})
		);
	for (const run of runs) {
		if (run.kind === 'text') {
			segment.push(run);
			continue;
		}
		close();
		parts.push(
			Object.freeze({ kind: 'inline', key: run.id, id: run.id, type: run.type, data: run.data })
		);
		key = run.id;
		segment = [];
	}
	close();
	partsMemo.set(runs, Object.freeze(parts));
	return parts;
};

export type RenderDelta = {
	readonly text: string;
	/** Mark entries in nesting order (the first run's order when runs merge). */
	readonly marks: readonly (readonly [string, unknown])[];
};

/** Mark payloads compare by canonical value: key-sorted, `undefined` values dropped. */
const marksKey = (marks: Record<string, unknown> | undefined) =>
	marks
		? JSON.stringify(
				Object.entries(marks)
					.filter(([, value]) => value !== undefined)
					.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			)
		: '[]';

/** One delta per maximal stretch of equal marks; empty runs render nothing. */
export const renderDeltas = (
	items: readonly { text: string; marks?: Record<string, unknown> }[]
): RenderDelta[] => {
	const deltas: { text: string; marks: [string, unknown][]; key: string }[] = [];
	for (const item of items) {
		if (!item.text) continue;
		const key = marksKey(item.marks);
		const last = deltas[deltas.length - 1];
		if (last?.key === key) last.text += item.text;
		else deltas.push({ text: item.text, marks: Object.entries(item.marks ?? {}), key });
	}
	return deltas.map(({ text, marks }) => ({ text, marks }));
};

/** A kind's text decoration (`transformText`), fed declared values, not wrappers. */
export type TextTransform = (payload: {
	text: { stringContent: string; value: JSONText[] };
	block: { id: BlockId; type: string; data: Data };
	content: JSONText[];
}) => JSONText[];

/** The render deltas of one segment of `cell`, decorated by its kind's transform. */
export const segmentDeltas = (
	cell: Cell,
	segment: Segment,
	transform?: TextTransform
): RenderDelta[] => {
	const deltas = renderDeltas(segment.runs);
	if (!transform) return deltas;
	const value = deltas.map(({ text, marks }) =>
		marks.length ? { text, marks: Object.fromEntries(marks) as JSONText['marks'] } : { text }
	);
	return renderDeltas(
		transform({
			text: { stringContent: segment.text, value },
			block: { id: cell.id, type: cell.type, data: cell.data },
			content: value
		})
	);
};

/**
 * `data-placeholder` (§2.4): the cell shows one empty text and no live
 * composition is in it.
 */
export const placeholderOf = (cell: Cell, composing: boolean): boolean => {
	const [only, ...rest] = partsOf(cell.runs);
	return rest.length === 0 && only.kind === 'text' && only.text === '' && !composing;
};
