/**
 * The selection value and its projection.
 *
 * A selection is a value: none, a text range of two anchors (the anchor where
 * it started, the focus that moves) with optional pending marks, one inline
 * atom, or a set of block ids. Anchors are the document's codec (`DocAnchor`,
 * `{b, a}`: one item plus a side); nothing else is stored. Everything a
 * command reads — endpoints as *(block, display offset)*, direction,
 * collapsed, covered blocks and segments, edge flags, island/void root, and
 * lazily the marks at the caret and the selected string — is `project(value,
 * doc)`, a pure function memoized per (value, index version).
 *
 * The view's `commit(value, cause)` (public: `select(value)`) is the only writer; its
 * `selection.state` is a compatibility getter over the projection, and the
 * presence payload is `serialize(value)`.
 */
import type { BlockId, ContentItem } from '$lib/crdt/index.js';
import type { DocAnchor, EdytorDoc } from '$lib/crdt/edytor-doc.js';
import { jsonEquals } from '$lib/utils/json.js';

export type Marks = Record<string, unknown>;

export type SelectionValue =
	| { readonly kind: 'none' }
	| {
			readonly kind: 'text';
			readonly anchor: DocAnchor;
			readonly focus: DocAnchor;
			/** Marks the next insertion at a caret takes (values kept); cleared when the caret moves. */
			readonly pending?: Marks;
	  }
	| {
			readonly kind: 'atom';
			readonly blockId: BlockId;
			readonly atomId: string;
			/** The side the selection is anchored on: a Shift key extends from it. */
			readonly from: AtomSide;
	  }
	| { readonly kind: 'blocks'; readonly ids: readonly BlockId[] };

export const noSelection: SelectionValue = Object.freeze({ kind: 'none' });

export const textSelection = (
	anchor: DocAnchor,
	focus: DocAnchor = anchor,
	pending?: Marks
): SelectionValue =>
	Object.freeze({ kind: 'text', anchor, focus, ...(pending ? { pending } : {}) });

/** Where an atom selection is anchored: a click or a host selects from `before`. */
export type AtomSide = 'before' | 'after';

export const atomSelection = (
	blockId: BlockId,
	atomId: string,
	from: AtomSide = 'before'
): SelectionValue => Object.freeze({ kind: 'atom', blockId, atomId, from });

export const blockSelection = (ids: readonly BlockId[]): SelectionValue =>
	Object.freeze({ kind: 'blocks', ids: Object.freeze([...ids]) });

/** A position within one document version: block id + display offset (an atom counts 1). */
export type SelectionPoint = { block: BlockId; offset: number };

type TextRun = Extract<ContentItem, { kind: 'text' }>;

/** One content part of a block: a text segment (between atoms, possibly empty) or an inline atom. */
export type SelectionSegment =
	| { block: BlockId; kind: 'text'; segOrd: number; start: number; end: number; runs: TextRun[] }
	| { block: BlockId; kind: 'inline'; id: string; start: number; end: number };
type TextSegment = Extract<SelectionSegment, { kind: 'text' }>;

export type SelectionProjection = {
	kind: SelectionValue['kind'];
	/** Endpoints in document order; `null` when no endpoint resolves at this version. */
	start: SelectionPoint | null;
	end: SelectionPoint | null;
	isCollapsed: boolean;
	isReversed: boolean;
	/** Blocks from the start block to the end block in document order. */
	blocks: BlockId[];
	/** Content parts from the start point's text segment to the end point's. */
	segments: SelectionSegment[];
	isAtStartOfText: boolean;
	isAtEndOfText: boolean;
	isAtStartOfBlock: boolean;
	isAtEndOfBlock: boolean;
	isTextSpanning: boolean;
	isBlockSpanning: boolean;
	islandRoot: BlockId | null;
	voidRoot: BlockId | null;
	/** Lazy: the marks at the caret (the character before it; offset 0 → the first run) or at the range's start edge. */
	readonly marks: Marks;
	/** Lazy: the selected text (text segments only). */
	readonly content: string;
};

/** The document reads a projection needs (the facade satisfies it). */
export type ProjectionDoc = Pick<
	EdytorDoc,
	| 'version'
	| 'resolveAnchor'
	| 'compare'
	| 'order'
	| 'contentItems'
	| 'ancestorsOf'
	| 'isIsland'
	| 'isVoid'
	| 'isVisibleBlock'
>;

/** A block's content parts; always text first and last, one text segment between two atoms. */
export const segmentsOf = (doc: ProjectionDoc, block: BlockId): SelectionSegment[] => {
	const out: SelectionSegment[] = [];
	let text: TextSegment = { block, kind: 'text', segOrd: 0, start: 0, end: 0, runs: [] };
	for (const item of doc.contentItems(block)) {
		if (item.kind === 'text') {
			text.runs.push(item);
			text.end += item.text.length;
			continue;
		}
		out.push(text, { block, kind: 'inline', id: item.id, start: text.end, end: text.end + 1 });
		text = {
			block,
			kind: 'text',
			segOrd: text.segOrd + 1,
			start: text.end + 1,
			end: text.end + 1,
			runs: []
		};
	}
	out.push(text);
	return out;
};

/** The text segment displaying `offset`: the first one ending at or after it (a seam belongs to the left text). */
const textSegmentAt = (segments: SelectionSegment[], offset: number): TextSegment => {
	const texts = segments.filter((s): s is TextSegment => s.kind === 'text');
	return texts.find((s) => offset <= s.end) ?? texts[texts.length - 1];
};

const EMPTY: Omit<SelectionProjection, 'kind' | 'marks' | 'content'> = {
	start: null,
	end: null,
	isCollapsed: true,
	isReversed: false,
	blocks: [],
	segments: [],
	isAtStartOfText: false,
	isAtEndOfText: false,
	isAtStartOfBlock: false,
	isAtEndOfBlock: false,
	isTextSpanning: false,
	isBlockSpanning: false,
	islandRoot: null,
	voidRoot: null
};

const lazy = (
	fields: Omit<SelectionProjection, 'marks' | 'content'>,
	marks: () => Marks,
	content: () => string
) => {
	let m: Marks | undefined;
	let c: string | undefined;
	return Object.defineProperties(fields, {
		marks: { enumerable: true, get: () => (m ??= marks()) },
		content: { enumerable: true, get: () => (c ??= content()) }
	}) as SelectionProjection;
};

/** Marks over `[from, to)` of a text segment, or of the run holding `from` when empty (union, later runs win). */
const marksOver = (segment: TextSegment, from: number, to: number): Marks => {
	const marks: Marks = {};
	let offset = segment.start;
	let entered = false;
	for (const run of segment.runs) {
		const end = offset + run.text.length;
		if (!entered && from >= offset && from < end) entered = true;
		else if (entered && offset >= to) break;
		if (entered) Object.assign(marks, run.marks ?? {});
		offset = end;
	}
	return marks;
};

const between = (doc: ProjectionDoc, start: BlockId, end: BlockId): BlockId[] => {
	// One block (a caret): no walk of the document order.
	if (start === end) return [start];
	const ids = doc.order();
	const from = ids.indexOf(start);
	if (from < 0) return [start];
	const to = ids.indexOf(end, from);
	return ids.slice(from, to < 0 ? undefined : to + 1);
};

/** Project a range between two resolved points (in any order) at the current version. */
const projectRange = (
	doc: ProjectionDoc,
	kind: SelectionValue['kind'],
	anchor: SelectionPoint,
	focus: SelectionPoint,
	atomic: boolean
): SelectionProjection => {
	const order =
		anchor.block === focus.block
			? anchor.offset - focus.offset
			: doc.compare(anchor.block, focus.block);
	const isReversed = order > 0;
	const [start, end] = isReversed ? [focus, anchor] : [anchor, focus];
	const isCollapsed = !atomic && order === 0;
	const blocks = between(doc, start.block, end.block);
	const partsOf = new Map(blocks.map((id) => [id, segmentsOf(doc, id)]));
	const startSegments = partsOf.get(start.block) ?? segmentsOf(doc, start.block);
	const endSegments = partsOf.get(end.block) ?? segmentsOf(doc, end.block);
	const first = textSegmentAt(startSegments, start.offset);
	const last = textSegmentAt(endSegments, end.offset);
	const all = blocks.flatMap((id) => partsOf.get(id)!);
	const from = all.indexOf(first);
	const to = all.indexOf(last);
	const segments =
		from !== -1 && to >= from ? all.slice(from, to + 1) : first === last ? [first] : [first, last];
	const ancestry = [start.block, ...doc.ancestorsOf(start.block)];
	const lastText = endSegments[endSegments.length - 1];
	return lazy(
		{
			kind,
			start,
			end,
			isCollapsed,
			isReversed,
			blocks,
			segments,
			isAtStartOfText: start.offset === first.start,
			isAtEndOfText: end.offset === last.end,
			isAtStartOfBlock: first.segOrd === 0 && start.offset === 0,
			isAtEndOfBlock: last === lastText && end.offset === last.end,
			isTextSpanning: first !== last,
			isBlockSpanning: start.block !== end.block,
			islandRoot: ancestry.find((id) => doc.isIsland(id)) ?? null,
			voidRoot: ancestry.find((id) => doc.isVoid(id)) ?? null
		},
		() => {
			if (atomic) return {};
			const to = first === last ? end.offset : first.end;
			return marksOver(
				first,
				start.offset === to ? Math.max(start.offset - 1, first.start) : start.offset,
				to
			);
		},
		() =>
			isCollapsed
				? ''
				: segments
						.filter((s): s is TextSegment => s.kind === 'text')
						.map((s) => {
							const text = s.runs.map((r) => r.text).join('');
							return text.slice(
								(s === first ? start.offset : s.start) - s.start,
								(s === last ? end.offset : s.end) - s.start
							);
						})
						.join('')
	);
};

const compute = (doc: ProjectionDoc, value: SelectionValue): SelectionProjection => {
	const none = () =>
		lazy(
			{ kind: value.kind, ...EMPTY },
			() => ({}),
			() => ''
		);
	if (value.kind === 'text') {
		const a = doc.resolveAnchor(value.anchor);
		const f = value.focus === value.anchor ? a : doc.resolveAnchor(value.focus);
		// One unresolvable endpoint collapses the range to the survivor (anchor contract rule 5);
		// neither resolving is the vanished-endpoint seam, not projected here.
		const anchor = a ?? f;
		const focus = f ?? a;
		if (!anchor || !focus) return none();
		const at = (p: { blockId: BlockId; offset: number }): SelectionPoint => ({
			block: p.blockId,
			offset: p.offset
		});
		return projectRange(doc, 'text', at(anchor), at(focus), false);
	}
	if (value.kind === 'blocks') {
		const ids = value.ids.filter((id) => doc.isVisibleBlock(id)).sort((x, y) => doc.compare(x, y));
		if (ids.length === 0) return none();
		const endParts = segmentsOf(doc, ids[ids.length - 1]);
		const end = endParts[endParts.length - 1].end;
		return projectRange(
			doc,
			'blocks',
			{ block: ids[0], offset: 0 },
			{ block: ids[ids.length - 1], offset: end },
			true
		);
	}
	if (value.kind === 'atom' && doc.isVisibleBlock(value.blockId)) {
		const atom = segmentsOf(doc, value.blockId).find(
			(s) => s.kind === 'inline' && s.id === value.atomId
		);
		if (!atom) return none();
		return lazy(
			{
				...EMPTY,
				kind: 'atom',
				start: { block: value.blockId, offset: atom.start },
				end: { block: value.blockId, offset: atom.end },
				isCollapsed: false,
				blocks: [value.blockId],
				segments: [atom]
			},
			() => ({}),
			() => ''
		);
	}
	return none();
};

const memo = new WeakMap<
	SelectionValue,
	{ doc: ProjectionDoc; version: number; projection: SelectionProjection }
>();

/** The projection of `value` at the document's current version, memoized per (value, version). */
export const project = (value: SelectionValue, doc: ProjectionDoc): SelectionProjection => {
	const version = doc.version;
	const hit = memo.get(value);
	if (hit && hit.doc === doc && hit.version === version) return hit.projection;
	const projection = compute(doc, value);
	memo.set(value, { doc, version, projection });
	return projection;
};

/** Why a selection was written (the view keeps the last cause with the value). */
export type SelectCause = 'dom' | 'model' | 'repair' | 'history';

const sameAnchor = (a: DocAnchor, b: DocAnchor) =>
	a === b ||
	(a.b === b.b &&
		a.a.a === b.a.a &&
		(a.a.i === b.a.i || (a.a.i?.c === b.a.i?.c && a.a.i?.k === b.a.i?.k)));

const sameMarks = (a: Marks | undefined, b: Marks | undefined) => jsonEquals(a ?? null, b ?? null);

/** Value equality: kind, anchors (item + side), ids, pending marks. */
export const sameValue = (a: SelectionValue, b: SelectionValue): boolean => {
	if (a === b) return true;
	if (a.kind === 'text' && b.kind === 'text')
		return (
			sameAnchor(a.anchor, b.anchor) &&
			sameAnchor(a.focus, b.focus) &&
			sameMarks(a.pending, b.pending)
		);
	if (a.kind === 'blocks' && b.kind === 'blocks')
		return a.ids.length === b.ids.length && a.ids.every((id, i) => id === b.ids[i]);
	if (a.kind === 'atom' && b.kind === 'atom')
		return a.blockId === b.blockId && a.atomId === b.atomId && a.from === b.from;
	return a.kind === b.kind && a.kind === 'none';
};

/**
 * The presence payload: anchors only. A text range publishes its
 * endpoints in document order with collapsed/reversed; a block set its ids;
 * an atom its block and id; `none` publishes nothing.
 */
export type PresenceSelection =
	| { start: DocAnchor; end: DocAnchor; collapsed: boolean; reversed: boolean }
	| { blocks: BlockId[] }
	| { atom: string; block: BlockId };

/**
 * A text value's anchors as (start, end). A range an edit collapsed has no
 * order left; its anchors keep the roles they were minted with (a start
 * binds right, an end binds left), so the start stays the start.
 */
export const anchorsInOrder = (
	value: Extract<SelectionValue, { kind: 'text' }>,
	projection: SelectionProjection
): [DocAnchor, DocAnchor] =>
	projection.isReversed ||
	(projection.isCollapsed &&
		value.anchor !== value.focus &&
		value.anchor.a.a < 0 &&
		value.focus.a.a >= 0)
		? [value.focus, value.anchor]
		: [value.anchor, value.focus];

export const serialize = (
	value: SelectionValue,
	projection: SelectionProjection
): PresenceSelection | null => {
	if (value.kind === 'text') {
		const [start, end] = anchorsInOrder(value, projection);
		return { start, end, collapsed: projection.isCollapsed, reversed: projection.isReversed };
	}
	if (value.kind === 'blocks') return { blocks: [...value.ids] };
	if (value.kind === 'atom') return { atom: value.atomId, block: value.blockId };
	return null;
};
