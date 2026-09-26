/**
 * Delete-result oracle — `describeDelete`.
 *
 * The per-action effect oracle historically proved only that a delete
 * *changed something* (`requireSemanticChange`), leaving the result's
 * shape unverified: a cross-block range that merged wrong — lost nested
 * children, corrupted a mark seam, dropped an inline atom — passed as
 * long as the signature moved. This module derives the EXACT expected
 * post-state from the pre-action snapshot plus the delivered delete
 * semantics, mirroring the implementation contract in:
 *
 *   src/lib/events/beforeInputDeleteCommands.ts  (dispatch + boundaries)
 *   src/lib/edytor.utils.ts                    (deleteContentWithinSelection)
 *   src/lib/block/block.utils.ts               (removeBlock/removeInlineBlock)
 *   src/lib/crdt/edytor-doc.ts                 (mergeBackward/Forward/unNest)
 *   src/lib/text/text.utils.ts                 (grapheme-aware deleteText)
 *   src/lib/events/wordBoundary.ts             (word offsets — contract
 *                                               reimplemented below,
 *                                               deliberately NOT
 *                                               imported: U5 requires
 *                                               the oracle to pin the
 *                                               contract independently,
 *                                               so a production change
 *                                               surfaces as a mismatch
 *                                               instead of moving the
 *                                               oracle with the bug)
 *   src/lib/hotkeys.ts                         (node-selection deletes)
 *
 * The expectation compares against `after.value` canonicalized the same
 * way `tests/editor-dom/helpers.ts` canonicalizes serialized payloads
 * (adjacent same-mark runs merge; block identity, types, data, inline
 * ids and marks are all asserted).
 */
import type { DstBrowserSnapshot, DstEvent } from './browserState.js';
import type { DstAction } from './generator.js';

type Run = { text: string; marks: unknown };
type Part =
	| { kind: 'text'; id: string; runs: Run[] }
	| { kind: 'inline'; id: string; type: string; data: Record<string, unknown> };

type OBlock = {
	id: string;
	type: string;
	data: Record<string, unknown>;
	void: boolean;
	island: boolean;
	isRoot: boolean;
	parent: OBlock | null;
	children: OBlock[];
	parts: Part[];
};

export type ExpectedJsonBlock = {
	type: string;
	/** `null` marks a block created by the delete (fresh id — asserted as any string). */
	id: string | null;
	data: Record<string, unknown>;
	content?: unknown[];
	children?: ExpectedJsonBlock[];
};

export type DeleteExpectation =
	| { kind: 'unchanged'; reason: string }
	| { kind: 'selectOnly'; blockId: string; reason: string }
	| { kind: 'tree'; children: ExpectedJsonBlock[]; description: string }
	| { kind: 'indeterminate'; reason: string }
	/**
	 * The delivered browser range is itself implausible for the action —
	 * e.g. a `deleteWord*` span containing more than one contract
	 * word-run, or a range not anchored at the caret. Hard failure:
	 * production adopts the delivered range verbatim, so an implausible
	 * one corrupts the document rather than merely disagreeing.
	 */
	| { kind: 'invalid'; reason: string };

// ── grapheme boundaries (mirrors text.utils.ts — kept local so the test
// bundle does not pull the svelte wrapper layer) ──────────────────────

type GraphemeSegmenter = { segment(value: string): Iterable<{ index: number; segment: string }> };

const graphemeBoundaries = (value: string) => {
	const Segmenter = (Intl as typeof Intl & { Segmenter?: new () => GraphemeSegmenter }).Segmenter;
	if (Segmenter) {
		return Array.from(
			new Segmenter().segment(value),
			({ index, segment }) => ({ start: index, end: index + segment.length }) as const
		);
	}
	let index = 0;
	return Array.from(value).map((segment) => {
		const start = index;
		index += segment.length;
		return { start, end: index } as const;
	});
};

const previousGraphemeStart = (value: string, offset: number) => {
	const clamped = Math.min(Math.max(offset, 0), value.length);
	let previous = 0;
	for (const boundary of graphemeBoundaries(value)) {
		if (boundary.end >= clamped) return boundary.start < clamped ? boundary.start : previous;
		previous = boundary.start;
	}
	return previous;
};

const nextGraphemeEnd = (value: string, offset: number) => {
	const clamped = Math.min(Math.max(offset, 0), value.length);
	for (const boundary of graphemeBoundaries(value)) {
		if (boundary.end > clamped) return boundary.end;
	}
	return clamped;
};

// ── word boundaries (the contract, implemented independently) ────────
//
// The documented contract in src/lib/events/wordBoundary.ts: a word is
// a maximal run of `[\p{L}\p{N}_]` code points (Unicode letters,
// numbers, underscore); everything else — whitespace, punctuation,
// symbols, emoji — is a boundary. Offsets are UTF-16, so a surrogate
// pair is one character two units wide. This is written straight from
// that contract rather than mirrored from the production code: the
// oracle must detect a production semantics change, not inherit it.
const WORD_CHARACTER = /[\p{L}\p{N}_]/u;

/** The full code-point character ENDING at `offset` (a surrogate pair
 * when the two units before it form one, else the single UTF-16 unit). */
const codePointBefore = (value: string, offset: number): string | undefined => {
	if (offset <= 0) return undefined;
	const trailing = value.charCodeAt(offset - 1);
	if (trailing >= 0xdc00 && trailing <= 0xdfff && offset >= 2) {
		const leading = value.charCodeAt(offset - 2);
		if (leading >= 0xd800 && leading <= 0xdbff) {
			return value.slice(offset - 2, offset);
		}
	}
	return String.fromCharCode(trailing);
};

/** The full code-point character STARTING at `offset` (a surrogate pair
 * when the two units from it form one, else the single UTF-16 unit). */
const codePointAt = (value: string, offset: number): string | undefined => {
	if (offset >= value.length) return undefined;
	const leading = value.charCodeAt(offset);
	if (leading >= 0xd800 && leading <= 0xdbff && offset + 1 < value.length) {
		const trailing = value.charCodeAt(offset + 1);
		if (trailing >= 0xdc00 && trailing <= 0xdfff) {
			return value.slice(offset, offset + 2);
		}
	}
	return String.fromCharCode(leading);
};

/**
 * The start offset of the word run ending at or before `offset`:
 * non-word characters immediately before the caret are crossed first,
 * then the whole contiguous word run. When no word character exists
 * before `offset`, the boundary is the leading boundary-run's far edge
 * (start of value) — a boundary run alone is still consumable.
 */
export const contractWordStartOffset = (value: string, offset: number): number => {
	let at = Math.min(Math.max(offset, 0), value.length);
	for (
		let char = codePointBefore(value, at);
		char !== undefined && !WORD_CHARACTER.test(char);
		char = codePointBefore(value, at)
	) {
		at -= char.length;
	}
	if (at === 0) return at;
	for (
		let char = codePointBefore(value, at);
		char !== undefined && WORD_CHARACTER.test(char);
		char = codePointBefore(value, at)
	) {
		at -= char.length;
	}
	return at;
};

/**
 * The end offset of the word run starting at or after `offset`:
 * non-word characters immediately after the caret are crossed first,
 * then the whole contiguous word run. When no word character exists
 * after `offset`, the boundary is the trailing boundary-run's far edge
 * (end of value) — a boundary run alone is still consumable.
 */
export const contractWordEndOffset = (value: string, offset: number): number => {
	let at = Math.min(Math.max(offset, 0), value.length);
	for (
		let char = codePointAt(value, at);
		char !== undefined && !WORD_CHARACTER.test(char);
		char = codePointAt(value, at)
	) {
		at += char.length;
	}
	if (at === value.length) return at;
	for (
		let char = codePointAt(value, at);
		char !== undefined && WORD_CHARACTER.test(char);
		char = codePointAt(value, at)
	) {
		at += char.length;
	}
	return at;
};

// ── oracle tree ───────────────────────────────────────────────────────

const clonePart = (part: Part): Part =>
	part.kind === 'text'
		? { kind: 'text', id: part.id, runs: part.runs.map((run) => ({ ...run })) }
		: { ...part, data: structuredClone(part.data) };

const buildTree = (snapshot: DstBrowserSnapshot) => {
	const root: OBlock = {
		id: '__root__',
		type: 'root',
		data: {},
		void: false,
		island: false,
		isRoot: true,
		parent: null,
		children: [],
		parts: []
	};
	const byPath = new Map<string, OBlock>();
	const byId = new Map<string, OBlock>();
	// Hand-built fixtures may not carry `parts` — derive them from the
	// serialized `value` JSON (the canonical shape parts split into).
	// Text-part ids come from `renderedTextIds` in document order; void
	// blocks' texts are unrendered and get synthetic ids.
	const renderedIdQueue = [...snapshot.model.renderedTextIds];
	const jsonAt = (path: number[]): Record<string, unknown> | undefined => {
		let children = (snapshot.value as { children?: unknown[] }).children;
		let node: Record<string, unknown> | undefined;
		for (const index of path) {
			node = (children as Record<string, unknown>[] | undefined)?.[index];
			children = (node?.children ?? undefined) as unknown[] | undefined;
		}
		return node;
	};
	const deriveParts = (block: (typeof snapshot.model.blocks)[number]): Part[] => {
		const json = jsonAt(block.path);
		const content = (json?.content ?? []) as Array<Record<string, unknown>>;
		// Pass 1 — segment the content into parts (groupContent's shape:
		// consecutive text runs merge into one part, inlines stand alone,
		// boundaries get empty-text separators). Ids assigned in pass 2.
		const parts: Part[] = [];
		let textRuns: Run[] = [];
		const flushText = () => {
			if (textRuns.length === 0) return;
			parts.push({ kind: 'text', id: '', runs: textRuns });
			textRuns = [];
		};
		for (const entry of content) {
			if ('type' in entry) {
				flushText();
				parts.push({
					kind: 'inline',
					id: String(entry.id ?? `inline:${block.id}:${parts.length}`),
					type: String(entry.type),
					data: (entry.data ?? {}) as Record<string, unknown>
				});
			} else {
				textRuns.push({ text: String(entry.text ?? ''), marks: entry.marks ?? null });
			}
		}
		flushText();
		if (parts.length === 0 || parts.at(-1)?.kind !== 'text') {
			parts.push({ kind: 'text', id: '', runs: [{ text: '', marks: null }] });
		}
		if (parts[0]?.kind !== 'text') {
			parts.unshift({ kind: 'text', id: '', runs: [{ text: '', marks: null }] });
		}
		// Pass 2 — ids in document order.
		let textOrd = 0;
		for (const part of parts) {
			if (part.kind !== 'text') continue;
			part.id = block.void
				? `void-text:${block.id}:${textOrd}`
				: (renderedIdQueue.shift() ?? `text:${block.id}:${textOrd}`);
			textOrd += 1;
		}
		return parts;
	};
	for (const block of snapshot.model.blocks) {
		const parent =
			block.path.length <= 1 ? root : (byPath.get(block.path.slice(0, -1).join(',')) ?? root);
		const node: OBlock = {
			id: block.id,
			type: block.type,
			data: structuredClone(block.data ?? {}),
			void: block.void,
			island: block.island,
			isRoot: false,
			parent,
			children: [],
			parts: block.parts ? block.parts.map(clonePart) : deriveParts(block)
		};
		byPath.set(block.path.join(','), node);
		byId.set(block.id, node);
		parent.children.push(node);
	}
	return { root, byId };
};

const indexOf = (block: OBlock) => (block.parent ? block.parent.children.indexOf(block) : -1);

const partAtomLength = (part: Part) =>
	part.kind === 'text' ? part.runs.reduce((n, run) => n + run.text.length, 0) : 1;

const partAtomOffset = (block: OBlock, partIndex: number) =>
	block.parts.slice(0, partIndex).reduce((n, part) => n + partAtomLength(part), 0);

const blockAtomLength = (block: OBlock) =>
	block.parts.reduce((n, part) => n + partAtomLength(part), 0);

const textPartLength = (part: Part & { kind: 'text' }) =>
	part.runs.reduce((n, run) => n + run.text.length, 0);

const textPartContent = (part: Part & { kind: 'text' }) => part.runs.map((r) => r.text).join('');

/** `block.firstText` — first own text part, else the first child's. */
const firstTextPart = (block: OBlock): (Part & { kind: 'text' }) | undefined => {
	const own = block.parts.find((part): part is Part & { kind: 'text' } => part.kind === 'text');
	if (own) return own;
	const first = block.children[0];
	return first ? firstTextPart(first) : undefined;
};

/** `block.lastText` — last own text part, else the first child's (faithful quirk). */
const lastTextPart = (block: OBlock): (Part & { kind: 'text' }) | undefined => {
	const own = block.parts.findLast((part): part is Part & { kind: 'text' } => part.kind === 'text');
	if (own) return own;
	const first = block.children[0];
	return first ? lastTextPart(first) : undefined;
};

const hasContent = (block: OBlock) =>
	block.parts.some((part) => part.kind === 'text' && textPartLength(part) > 0);

const isEmptyBlock = (block: OBlock) => !hasContent(block) && block.children.length === 0;

const closestPreviousBlock = (block: OBlock): OBlock | null => {
	const index = indexOf(block);
	if (index === 0) {
		return block.parent && !block.parent.isRoot ? block.parent : null;
	}
	const previous = block.parent?.children[index - 1];
	if (!previous) return null;
	let current = previous;
	while (current.children.length > 0) current = current.children.at(-1)!;
	return current;
};

/** `block.closestNextBlock` — island/void blocks do not climb past their sibling list. */
const closestNextBlock = (block: OBlock): OBlock | null => {
	if (block.children.length > 0) return block.children[0];
	const next = block.parent?.children[indexOf(block) + 1];
	if (next || block.island || block.void) return next ?? null;
	let parent = block.parent;
	while (parent && !parent.isRoot) {
		const parentNext = parent.parent?.children[indexOf(parent) + 1];
		if (parentNext) return parentNext;
		parent = parent.parent;
	}
	return null;
};

/** Facade `islandOf` — nearest island STRICT ancestor (the block itself excluded). */
const islandOf = (block: OBlock): OBlock | null => {
	let current = block.parent;
	while (current && !current.isRoot) {
		if (current.island) return current;
		current = current.parent;
	}
	return null;
};

const insideIsland = (block: OBlock) => islandOf(block) !== null;

/** Selection-layer `islandRoot` — nearest island on the chain INCLUDING the block. */
const islandRootOf = (block: OBlock): OBlock | null => {
	let current: OBlock | null = block;
	while (current && !current.isRoot) {
		if (current.island) return current;
		current = current.parent;
	}
	return null;
};

const canAcceptMove = (parent: OBlock): boolean =>
	parent.isRoot || (!parent.void && !parent.island && !insideIsland(parent));

const isStrictAncestor = (ancestor: OBlock, block: OBlock) => {
	let current = block.parent;
	while (current) {
		if (current === ancestor) return true;
		current = current.parent;
	}
	return false;
};

// ── tree mutations (each mirrors the named model/view op) ─────────────

/**
 * Runs-view canonicalization: zero-length runs are never published, and
 * adjacent runs with equal marks merge (probe-verified — `contentJSON`
 * emits `[{text:'ac'}]` after deleting the middle run of `[a|b|c]`).
 */
const normalizeRuns = (runs: Run[]): Run[] => {
	const out: Run[] = [];
	for (const run of runs) {
		if (run.text.length === 0) continue;
		const last = out.at(-1);
		if (last && jsonEqual(last.marks, run.marks)) {
			last.text += run.text;
		} else {
			out.push({ text: run.text, marks: run.marks });
		}
	}
	return out;
};

const spliceRuns = (runs: Run[], start: number, length: number): Run[] => {
	if (length <= 0) return runs;
	const out: Run[] = [];
	let offset = 0;
	for (const run of runs) {
		const runStart = offset;
		const runEnd = offset + run.text.length;
		offset = runEnd;
		if (runEnd <= start || runStart >= start + length) {
			out.push(run);
			continue;
		}
		const head = run.text.slice(0, Math.max(0, start - runStart));
		const tail = run.text.slice(Math.min(run.text.length, start + length - runStart));
		out.push({ text: head + tail, marks: run.marks });
	}
	return normalizeRuns(out);
};

const sliceRunsFrom = (runs: Run[], offset: number): Run[] => {
	const out: Run[] = [];
	let position = 0;
	for (const run of runs) {
		const runEnd = position + run.text.length;
		if (runEnd > offset)
			out.push({ text: run.text.slice(Math.max(0, offset - position)), marks: run.marks });
		position = runEnd;
	}
	return normalizeRuns(out);
};

/** `model.deleteText(startAtom, len)` — atom-space splice over content parts. */
const deleteAtomRange = (block: OBlock, atomStart: number, atomEnd: number) => {
	if (atomEnd <= atomStart) return;
	let position = 0;
	block.parts = block.parts.filter((part) => {
		const length = partAtomLength(part);
		const partStart = position;
		const partEnd = position + length;
		position = partEnd;
		if (part.kind === 'inline') {
			return !(atomStart <= partStart && atomEnd >= partEnd);
		}
		const cutStart = Math.max(0, atomStart - partStart);
		const cutEnd = Math.min(length, atomEnd - partStart);
		part.runs = spliceRuns(part.runs, cutStart, cutEnd - cutStart);
		return true;
	});
};

/** `block.removeBlock({keepChildren: false})` — the subtree dies with it. */
const removeSubtree = (block: OBlock) => {
	const parent = block.parent;
	if (!parent || block.isRoot) return;
	const index = parent.children.indexOf(block);
	if (index >= 0) parent.children.splice(index, 1);
	block.parent = null;
};

/** Facade `unNestBlock` refusal rules + `M.unNestBlock` (move beside parent). */
const unNest = (block: OBlock): boolean => {
	if (insideIsland(block)) return false;
	const parent = block.parent;
	if (!parent || parent.isRoot) return false;
	const grandParent = parent.parent;
	if (!grandParent) return false;
	if (!canAcceptMove(grandParent)) return false;
	const parentIndex = indexOf(parent);
	parent.children.splice(indexOf(block), 1);
	grandParent.children.splice(parentIndex + 1, 0, block);
	block.parent = grandParent;
	return true;
};

/**
 * Facade `mergeUnnesting`: `from`'s children take over its vacated slot
 * (island sources also reset child types), then `from`'s content appends
 * into `into` and `from` leaves the live tree.
 */
const mergeUnnesting = (from: OBlock, into: OBlock, defaultType: string | null): boolean => {
	if (from === into || from.void || into.void) return false;
	const islandFrom = islandOf(from);
	if (islandFrom !== islandOf(into) && into !== islandFrom) return false;
	const parent = from.parent;
	if (!parent) return false;
	const index = indexOf(from);
	const kids = [...from.children];
	kids.forEach((kid, i) => {
		parent.children.splice(index + i, 0, kid);
		kid.parent = parent;
	});
	from.children = [];
	if (from.island && defaultType) {
		for (const kid of kids) kid.type = defaultType;
	}
	into.parts.push(...from.parts);
	removeSubtree(from);
	return true;
};

/** Facade `mergeBackward` — merge `block` into the previous doc-order block. */
const mergeBackward = (block: OBlock, defaultType: string | null): boolean => {
	if (block.void) return false;
	const index = indexOf(block);
	const previous =
		index === 0
			? block.parent && !block.parent.isRoot
				? block.parent
				: null
			: (() => {
					const sibling = block.parent?.children[index - 1];
					if (!sibling) return null;
					let current = sibling;
					while (current.children.length > 0) current = current.children.at(-1)!;
					return current;
				})();
	if (previous === null) {
		if (block.children.length === 0 && blockAtomLength(block) === 0) {
			return mergeForward(block, defaultType);
		}
		return false;
	}
	return mergeUnnesting(block, previous, defaultType);
};

/** Facade `mergeForward` — pull the next doc-order block into `block`. */
const mergeForward = (block: OBlock, defaultType: string | null): boolean => {
	if (block.void) return false;
	const next = (() => {
		if (block.children.length > 0) return block.children[0];
		let current = block;
		for (;;) {
			const parent = current.parent;
			if (!parent) return null;
			const sibling = parent.children[indexOf(current) + 1];
			if (sibling) return sibling;
			if (current.island || current.void) return null;
			if (parent.isRoot) return null;
			current = parent;
		}
	})();
	if (next === null) return false;
	return mergeUnnesting(next, block, defaultType);
};

/** `removeInlineBlock` — only fires when the addressed part is an inline atom. */
const removeInlinePart = (block: OBlock, partIndex: number) => {
	const part = block.parts[partIndex];
	if (part?.kind === 'inline') block.parts.splice(partIndex, 1);
};

/** Root re-population — `normalizeChildren` inserts a fresh default block. */
const normalizeRoot = (root: OBlock, defaultType: string | null, freshIds: Set<string>) => {
	if (root.children.length === 0) {
		const id = `__fresh_${freshIds.size}__`;
		freshIds.add(id);
		root.children.push({
			id,
			type: defaultType ?? 'paragraph',
			data: {},
			void: false,
			island: false,
			isRoot: false,
			parent: root,
			children: [],
			parts: [{ kind: 'text', id: `${id}-t`, runs: [{ text: '', marks: null }] }]
		});
	}
};

const moveUnder = (parent: OBlock, index: number, block: OBlock) => {
	if (block.parent) {
		const at = block.parent.children.indexOf(block);
		if (at >= 0) block.parent.children.splice(at, 1);
	}
	parent.children.splice(Math.min(index, parent.children.length), 0, block);
	block.parent = parent;
};

// ── expected JSON emission ────────────────────────────────────────────

const marksKey = (marks: unknown): string =>
	marks == null
		? ''
		: JSON.stringify(
				Object.entries(marks as Record<string, unknown>)
					.filter(([, value]) => value !== undefined)
					.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			);

const partToJson = (part: Part): unknown[] =>
	part.kind === 'inline'
		? [{ id: part.id, type: part.type, data: part.data }]
		: part.runs.map((run) => {
				const entry: Record<string, unknown> = { text: run.text };
				if (run.marks != null && Object.keys(run.marks as object).length > 0) {
					entry.marks = run.marks;
				}
				return entry;
			});

const canonicalContent = (parts: unknown[]): unknown[] => {
	const out: Record<string, unknown>[] = [];
	for (const item of parts) {
		const rest = item as Record<string, unknown>;
		// Serialized content never carries emptied runs — `runsToDeltas`
		// and the facade's contentJSON both drop `text:''` items.
		if ('text' in rest && rest.text === '') continue;
		const previous = out[out.length - 1];
		if (
			previous &&
			'text' in rest &&
			'text' in previous &&
			marksKey(previous.marks) === marksKey(rest.marks)
		) {
			previous.text = String(previous.text) + String(rest.text);
			continue;
		}
		out.push(rest);
	}
	return out;
};

const toExpectedJson = (block: OBlock, freshIds: Set<string>): ExpectedJsonBlock => {
	const content = canonicalContent(block.parts.flatMap(partToJson));
	const json: ExpectedJsonBlock = {
		type: block.type,
		id: freshIds.has(block.id) ? null : block.id,
		data: block.data
	};
	if (block.children.length > 0) {
		json.children = block.children.map((child) => toExpectedJson(child, freshIds));
	}
	if (content.length > 0) json.content = content;
	return json;
};

// ── inputType resolution ──────────────────────────────────────────────

/**
 * The delivered `beforeinput` decides which delete semantics ran — the
 * same chord means different things across engines (Meta+Backspace is a
 * soft-line delete on darwin WebKit/Chromium but may surface as a word
 * delete elsewhere). Read the last delivered delete inputType; fall back
 * to the platform mapping when the pipeline delivered none.
 */
export const deliveredDeleteInputType = (events: DstEvent[]): string | null => {
	const delivered = events.filter(
		(event) => event.type === 'beforeinput' && event.inputType?.startsWith('delete')
	);
	return delivered.at(-1)?.inputType ?? null;
};

const fallbackInputType = (action: DstAction): string | null => {
	switch (action.kind) {
		case 'backspace':
			return 'deleteContentBackward';
		case 'delete':
			return 'deleteContentForward';
		case 'wordDelete':
			// ⌥⌫ is `deleteWordBackward` on every platform, darwin
			// included — since schema v5 the ⌘⌫ line delete is the
			// separate `lineDelete` action.
			return action.direction === 'forward' ? 'deleteWordForward' : 'deleteWordBackward';
		case 'lineDelete':
			return process.platform === 'darwin'
				? action.direction === 'forward'
					? 'deleteSoftLineForward'
					: 'deleteSoftLineBackward'
				: null;
		default:
			return null;
	}
};

// ── the oracle ────────────────────────────────────────────────────────

export const describeDelete = (
	before: DstBrowserSnapshot,
	action: DstAction,
	events: DstEvent[]
): DeleteExpectation => {
	const expectation = describeDeleteInner(before, action, events);
	// A `tree` prediction identical to the before-state is a degenerate
	// range (e.g. soft-line delete at offset 0) — report it as a legal
	// no-op, not a demanded mutation.
	if (
		expectation.kind === 'tree' &&
		diffDeleteExpectation(
			expectation.children,
			(before.value as { children?: unknown[] } | undefined)?.children
		) === null
	) {
		return { kind: 'unchanged', reason: `${expectation.description} (empty range)` };
	}
	return expectation;
};

const describeDeleteInner = (
	before: DstBrowserSnapshot,
	action: DstAction,
	events: DstEvent[]
): DeleteExpectation => {
	const { root, byId } = buildTree(before);
	const freshIds = new Set<string>();
	const defaultType = before.model.defaultType;
	const rootDefaultType = before.model.rootDefaultType ?? defaultType;
	const tree = (description: string): DeleteExpectation => ({
		kind: 'tree',
		description,
		children: root.children.map((child) => toExpectedJson(child, freshIds))
	});
	const unchanged = (reason: string): DeleteExpectation => ({ kind: 'unchanged', reason });
	const selectOnly = (blockId: string, reason: string): DeleteExpectation => ({
		kind: 'selectOnly',
		blockId,
		reason
	});
	const indeterminate = (reason: string): DeleteExpectation => ({
		kind: 'indeterminate',
		reason
	});

	const selection = before.selection;

	// ── node selections: hotkey path, no beforeinput needed ─────────────
	if (selection?.kind === 'block' || selection?.kind === 'inline') {
		if (action.kind === 'wordDelete' || action.kind === 'lineDelete') {
			// No node-selection hotkey binds the word/line chords; the
			// beforeinput delete path returns early on `!startText`.
			return unchanged('word/line delete over a node selection has no model path');
		}
		if (selection.kind === 'inline') {
			// `deleteSelectedInlineBlock` — removes the selected inline atom.
			const targetId = selection.ids[0];
			const owner = before.model.blocks.find((block) =>
				block.parts.some((part) => part.kind === 'inline' && part.id === targetId)
			);
			const ownerNode = owner ? byId.get(owner.id) : undefined;
			const partIndex = ownerNode?.parts.findIndex(
				(part) => part.kind === 'inline' && part.id === targetId
			);
			if (ownerNode === undefined || partIndex === undefined || partIndex < 0) {
				return indeterminate('selected inline atom not found in the model');
			}
			removeInlinePart(ownerNode, partIndex);
			normalizeRoot(root, rootDefaultType, freshIds);
			return tree('inline atom removed from its block');
		}
		// `removeSelectedBlocksForReplacement` — every selected block and its
		// subtree, in reverse document order.
		for (const id of [...selection.ids].reverse()) {
			const node = byId.get(id);
			if (node) removeSubtree(node);
		}
		normalizeRoot(root, rootDefaultType, freshIds);
		return tree('selected blocks removed');
	}

	if (selection?.kind !== 'text') {
		return indeterminate('no model selection');
	}

	const partAtTextIndex = (textIndex: number) => {
		const textId = before.model.renderedTextIds[textIndex];
		if (!textId) return null;
		for (const block of byId.values()) {
			const partIndex = block.parts.findIndex((part) => part.kind === 'text' && part.id === textId);
			if (partIndex >= 0) return { block, partIndex };
		}
		return null;
	};

	// ── delivered targetRange → the selection the command actually saw ──
	// `syncSelectionFromBeforeInputTargetRange` (onBeforeInput.ts) rewrites
	// the model selection from the delivered `beforeinput` targetRange
	// BEFORE the command snapshot:
	// - `isDeleteTargetRangeInput` types — `deleteContent{Backward,Forward}`
	//   and the directional word/line deletes (`deleteWord*`,
	//   `deleteSoftLine*`, `deleteHardLine*`) — collapse the range to a
	//   caret — its start for forward, end for backward — when the model
	//   selection is collapsed, and skip the sync entirely when it isn't
	//   (or when the range fails the same-text safety check). The
	//   collapsed model command (`deleteCollapsed*`) then owns the
	//   delete extent — Firefox's block-level range end containers can
	//   never mint a degenerate caret.
	// - the remaining delete inputTypes (fragment deletes, generic
	//   `deleteContent`, `deleteEntireSoftLine`) still adopt the FULL
	//   delivered range into the model selection.
	const deliveredDelete = events
		.filter((event) => event.type === 'beforeinput' && event.inputType?.startsWith('delete'))
		.at(-1);
	const deliveredRange = deliveredDelete?.targetRange ?? null;
	let effective = selection;
	const invalid = (reason: string): DeleteExpectation => ({ kind: 'invalid', reason });
	/** Contract word-runs covered by a delivered delete span — walks the
	 * covered PART SPAN inside each block, so a run can never cross a
	 * block boundary OR an inline atom: `inWord` resets whenever the
	 * owning block changes and on every non-text part between covered
	 * texts (`hello`+atom+`world` is two runs, never one). */
	const wordRunsInRange = (range: NonNullable<typeof deliveredRange>): number => {
		const startLoc = partAtTextIndex(range.startTextIndex);
		const endLoc = partAtTextIndex(range.endTextIndex);
		if (!startLoc || !endLoc) return 0;
		let runs = 0;
		let inWord = false;
		let prevBlock: unknown = null;
		for (let ti = range.startTextIndex; ti <= range.endTextIndex; ti++) {
			const loc = partAtTextIndex(ti);
			if (!loc) {
				inWord = false;
				continue;
			}
			if (loc.block !== prevBlock) inWord = false;
			prevBlock = loc.block;
			const part = loc.block.parts[loc.partIndex];
			if (!part || part.kind !== 'text') {
				inWord = false;
				continue;
			}
			// Inline atoms and any other non-text parts BETWEEN the
			// previous covered text part and this one break the run even
			// inside a single block — the textIndex space skips them.
			const prevTextIndex = ti === range.startTextIndex ? null : ti - 1;
			const prevLoc = prevTextIndex === null ? null : partAtTextIndex(prevTextIndex);
			if (prevLoc && prevLoc.block === loc.block) {
				for (let pi = prevLoc.partIndex + 1; pi < loc.partIndex; pi++) {
					const between = loc.block.parts[pi];
					if (!between || between.kind !== 'text') inWord = false;
				}
			}
			const content = textPartContent(part);
			const s = ti === range.startTextIndex ? range.yStart : 0;
			const e = ti === range.endTextIndex ? range.yEnd : content.length;
			for (const ch of content.slice(s, e)) {
				const word = WORD_CHARACTER.test(ch);
				if (word && !inWord) runs++;
				inWord = word;
			}
		}
		return runs;
	};
	/** A word-delete span may not TRUNCATE a contract word-run: the
	 * covered char on the non-caret edge must not continue a word run
	 * past the span edge. `alpha brav` deleting 'o' splits 'bravo' —
	 * no platform word unit looks like that. */
	const truncatesWordRun = (
		range: NonNullable<typeof deliveredRange>,
		backward: boolean
	): boolean => {
		if (backward) {
			const loc = partAtTextIndex(range.startTextIndex);
			if (!loc) return false;
			const content = textPartContent(
				loc.block.parts[loc.partIndex] as Part & {
					kind: 'text';
				}
			);
			const first = codePointAt(content, range.yStart);
			let before = codePointBefore(content, range.yStart);
			if (before === undefined && range.yStart === 0) {
				// Only an ADJACENT same-block predecessor can continue a
				// word run — a run never crosses a block boundary or an
				// inline atom, so deleting all of 'café' after a
				// paragraph ending in a letter is NOT truncation.
				const prevLoc = partAtTextIndex(range.startTextIndex - 1);
				if (prevLoc && prevLoc.block === loc.block && prevLoc.partIndex === loc.partIndex - 1) {
					const prevContent = textPartContent(
						prevLoc.block.parts[prevLoc.partIndex] as Part & { kind: 'text' }
					);
					before = codePointBefore(prevContent, prevContent.length);
				}
			}
			return (
				first !== undefined &&
				WORD_CHARACTER.test(first) &&
				before !== undefined &&
				WORD_CHARACTER.test(before)
			);
		}
		const loc = partAtTextIndex(range.endTextIndex);
		if (!loc) return false;
		const content = textPartContent(
			loc.block.parts[loc.partIndex] as Part & {
				kind: 'text';
			}
		);
		const last = codePointBefore(content, range.yEnd);
		let after = codePointAt(content, range.yEnd);
		if (after === undefined && range.yEnd === content.length) {
			// Adjacent same-block only — see the backward branch above.
			const nextLoc = partAtTextIndex(range.endTextIndex + 1);
			if (nextLoc && nextLoc.block === loc.block && nextLoc.partIndex === loc.partIndex + 1) {
				const nextContent = textPartContent(
					nextLoc.block.parts[nextLoc.partIndex] as Part & { kind: 'text' }
				);
				after = codePointAt(nextContent, 0);
			}
		}
		return (
			last !== undefined &&
			WORD_CHARACTER.test(last) &&
			after !== undefined &&
			WORD_CHARACTER.test(after)
		);
	};
	/** The independent legal units for a collapsed-caret word delete on
	 * the caret's own part — computed from the contract model, never the
	 * delivered range. Anchored at the caret by construction; boundary-
	 * run-only is a specific platform allowance (engines may consume the
	 * adjacent whitespace run). A span equal to none of these is not a
	 * word delete on ASCII text. */
	const legalWordSpans = (backward: boolean): { yStart: number; yEnd: number }[] => {
		const loc = partAtTextIndex(selection.startTextIndex);
		const content = loc
			? textPartContent(loc.block.parts[loc.partIndex] as Part & { kind: 'text' })
			: null;
		if (content === null) return [];
		const o = selection.yStart;
		const spans: { yStart: number; yEnd: number }[] = [];
		if (backward) {
			let m = o;
			for (
				let ch = codePointBefore(content, m);
				ch !== undefined && !WORD_CHARACTER.test(ch);
				ch = codePointBefore(content, m)
			)
				m -= ch.length;
			let w = m;
			for (
				let ch = codePointBefore(content, w);
				ch !== undefined && WORD_CHARACTER.test(ch);
				ch = codePointBefore(content, w)
			)
				w -= ch.length;
			if (w < m) spans.push({ yStart: w, yEnd: o }); // contract unit
			if (m < o) spans.push({ yStart: m, yEnd: o }); // boundary-run only
		} else {
			let e = o;
			for (
				let ch = codePointAt(content, e);
				ch !== undefined && !WORD_CHARACTER.test(ch);
				ch = codePointAt(content, e)
			)
				e += ch.length;
			let w = e;
			for (
				let ch = codePointAt(content, w);
				ch !== undefined && WORD_CHARACTER.test(ch);
				ch = codePointAt(content, w)
			)
				w += ch.length;
			if (e < w) spans.push({ yStart: o, yEnd: w }); // contract unit
			if (e > o) spans.push({ yStart: o, yEnd: e }); // boundary-run only
		}
		return spans;
	};
	if (deliveredRange && deliveredDelete?.inputType) {
		const deliveredType = deliveredDelete.inputType;
		if (deliveredRange.startTextIndex < 0 || deliveredRange.endTextIndex < 0) {
			return indeterminate('delete target range endpoint outside editor text');
		}
		const directionalLine =
			deliveredType === 'deleteSoftLineBackward' ||
			deliveredType === 'deleteHardLineBackward' ||
			deliveredType === 'deleteSoftLineForward' ||
			deliveredType === 'deleteHardLineForward';
		const wordDelete =
			deliveredType === 'deleteWordBackward' || deliveredType === 'deleteWordForward';
		const collapseEdgeDelete =
			directionalLine ||
			wordDelete ||
			deliveredType === 'deleteContentBackward' ||
			deliveredType === 'deleteContentForward';
		const backwardDelete = deliveredType.endsWith('Backward');
		if (collapseEdgeDelete) {
			// Mirrors `isSafeDeleteTargetRange`: the sync only fires for a
			// collapsed model selection with a same-text, in-bounds range —
			// a collapsed range must still leave a deletable char on the
			// command side (backward needs yStart>0, forward yStart<len).
			// The adopted selection is the collapse EDGE — the collapsed
			// model command (`deleteCollapsed*`) owns the delete extent.
			const sameText = deliveredRange.startTextIndex === deliveredRange.endTextIndex;
			const targetPart = sameText ? partAtTextIndex(deliveredRange.startTextIndex) : null;
			const targetLen = targetPart
				? textPartLength(targetPart.block.parts[targetPart.partIndex] as Part & { kind: 'text' })
				: 0;
			const valid =
				sameText &&
				targetPart !== null &&
				deliveredRange.yStart >= 0 &&
				deliveredRange.yEnd >= deliveredRange.yStart &&
				deliveredRange.yEnd <= targetLen;
			const safe =
				valid &&
				(deliveredRange.yStart !== deliveredRange.yEnd ||
					(backwardDelete ? deliveredRange.yStart > 0 : deliveredRange.yStart < targetLen));
			if (selection.isCollapsed && safe) {
				const textIndex = backwardDelete
					? deliveredRange.endTextIndex
					: deliveredRange.startTextIndex;
				const y = backwardDelete ? deliveredRange.yEnd : deliveredRange.yStart;
				effective = {
					...selection,
					startTextIndex: textIndex,
					endTextIndex: textIndex,
					yStart: y,
					yEnd: y,
					isCollapsed: true
				};
			}
			// non-collapsed or unsafe range → sync skipped → model selection stands
			if (wordDelete) {
				// The delivered word span is no longer consumed as the
				// delete extent — the collapsed model command owns it — but
				// the delivery itself stays under contract bounds: on ASCII
				// text the span must BE one of the contract-derived legal
				// units (word-run+trailing boundary per the model, or the
				// boundary-run alone); on non-ASCII text platform
				// segmentation legitimately differs, so the bound is
				// plausibility — anchored at the caret, at most one
				// complete contract word-run, never a truncated run.
				const backward = backwardDelete;
				const anchored = backward
					? deliveredRange.endTextIndex === selection.endTextIndex &&
						deliveredRange.yEnd === selection.yStart
					: deliveredRange.startTextIndex === selection.startTextIndex &&
						deliveredRange.yStart === selection.yStart;
				if (!deliveredRange.collapsed) {
					// The bound only applies over a collapsed caret — a word
					// chord over a live selection legitimately delivers a span
					// covering the selection, not one anchored at a caret.
					if (selection.isCollapsed) {
						if (!anchored) {
							return invalid(
								`${deliveredType} delivered a range not anchored at the caret: ` +
									`[${deliveredRange.startTextIndex}@${deliveredRange.yStart}, ` +
									`${deliveredRange.endTextIndex}@${deliveredRange.yEnd}) vs caret ` +
									`${selection.startTextIndex}@${selection.yStart}`
							);
						}
						const caretLoc = partAtTextIndex(selection.startTextIndex);
						const caretContent = caretLoc
							? textPartContent(
									caretLoc.block.parts[caretLoc.partIndex] as Part & {
										kind: 'text';
									}
								)
							: '';
						const asciiContext = ![...caretContent].some(
							(ch) => !'\t\n\r'.includes(ch) && (ch < ' ' || ch > '~')
						);
						const samePart =
							deliveredRange.startTextIndex === selection.startTextIndex &&
							deliveredRange.endTextIndex === selection.startTextIndex;
						// The delivered offsets address PER-PART model
						// space — a span reaching past its part's length is
						// not a model unit. The ONE observed phantom is
						// WebKit delivering the ZWSP placeholder of an EMPTY
						// text part as a single-unit "word": empty caret
						// part + a ≤1-unit span. Anything else out of bounds
						// is a defect, ASCII or not.
						const startLoc = caretLoc;
						const endLoc = partAtTextIndex(deliveredRange.endTextIndex);
						const endPartLen = endLoc
							? textPartLength(
									endLoc.block.parts[endLoc.partIndex] as Part & {
										kind: 'text';
									}
								)
							: 0;
						const startPartLen = startLoc
							? textPartLength(
									startLoc.block.parts[startLoc.partIndex] as Part & {
										kind: 'text';
									}
								)
							: 0;
						const spanInModel =
							deliveredRange.yStart <= startPartLen && deliveredRange.yEnd <= endPartLen;
						const phantomSpan =
							samePart &&
							caretContent.length === 0 &&
							deliveredRange.yEnd - deliveredRange.yStart <= 1;
						if (!spanInModel && !phantomSpan) {
							return invalid(
								`${deliveredType} delivered an out-of-model span ` +
									`[${deliveredRange.startTextIndex}@${deliveredRange.yStart}, ` +
									`${deliveredRange.endTextIndex}@${deliveredRange.yEnd}) — ` +
									`part bounds are [.. <=${startPartLen}@${selection.startTextIndex}, ` +
									`.. <=${endPartLen}@${deliveredRange.endTextIndex}]`
							);
						}
						const inModelSpan =
							caretContent.length > 0 &&
							deliveredRange.yStart >= 0 &&
							deliveredRange.yEnd <= caretContent.length;
						if (samePart && asciiContext && inModelSpan) {
							// ASCII text gets INDEPENDENT expected results — the
							// delivered span must equal a contract-legal unit.
							const legal = legalWordSpans(backward);
							const hit = legal.some(
								(span) => span.yStart === deliveredRange.yStart && span.yEnd === deliveredRange.yEnd
							);
							if (!hit) {
								return invalid(
									`${deliveredType} delivered ` +
										`[${deliveredRange.startTextIndex}@${deliveredRange.yStart}, ` +
										`${deliveredRange.endTextIndex}@${deliveredRange.yEnd}) — ` +
										`no legal word unit at the caret matches ${JSON.stringify(legal)}`
								);
							}
						} else {
							// Non-ASCII or cross-part span: platform segmentation
							// is legitimately platform-owned — bound plausibility.
							const runs = wordRunsInRange(deliveredRange);
							if (runs > 1) {
								return invalid(
									`${deliveredType} delivered an oversized range ` +
										`[${deliveredRange.startTextIndex}@${deliveredRange.yStart}, ` +
										`${deliveredRange.endTextIndex}@${deliveredRange.yEnd}) covering ` +
										`${runs} contract word-runs — one word delete removes at most one`
								);
							}
							if (truncatesWordRun(deliveredRange, backward)) {
								return invalid(
									`${deliveredType} delivered a range that truncates a word ` +
										`run at its ${backward ? 'start' : 'end'} edge: ` +
										`[${deliveredRange.startTextIndex}@${deliveredRange.yStart}, ` +
										`${deliveredRange.endTextIndex}@${deliveredRange.yEnd})`
								);
							}
						}
					}
				}
			} else if (directionalLine && !deliveredRange.collapsed && selection.isCollapsed) {
				// A directional line unit always touches the caret — an
				// unanchored delivery is a defect even though the collapsed
				// model command now owns the extent.
				const anchored = backwardDelete
					? deliveredRange.endTextIndex === selection.endTextIndex &&
						deliveredRange.yEnd === selection.yStart
					: deliveredRange.startTextIndex === selection.startTextIndex &&
						deliveredRange.yStart === selection.yStart;
				if (!anchored) {
					return invalid(
						`${deliveredType} delivered a range not anchored at the caret: ` +
							`[${deliveredRange.startTextIndex}@${deliveredRange.yStart}, ` +
							`${deliveredRange.endTextIndex}@${deliveredRange.yEnd}) vs caret ` +
							`${selection.startTextIndex}@${selection.yStart}`
					);
				}
			}
		} else {
			if (deliveredRange.yStart < 0 || deliveredRange.yEnd < 0) {
				return indeterminate('delete target range does not resolve to model offsets');
			}
			// Fragment deletes, generic `deleteContent`, and
			// `deleteEntireSoftLine` still adopt the delivered range
			// verbatim — `deleteEntireSoftLine` covers its whole line and
			// stays unanchored.
			effective = {
				...selection,
				startTextIndex: deliveredRange.startTextIndex,
				endTextIndex: deliveredRange.endTextIndex,
				yStart: deliveredRange.yStart,
				yEnd: deliveredRange.yEnd,
				isCollapsed: deliveredRange.collapsed
			};
		}
	}

	// ── resolve the effective selection onto the oracle tree ────────────
	const start = partAtTextIndex(effective.startTextIndex);
	const end = partAtTextIndex(effective.endTextIndex);
	if (!start || !end) return indeterminate('selection does not resolve to rendered text parts');

	const startBlock = start.block;
	const endBlock = end.block;
	const startPart = startBlock.parts[start.partIndex] as Part & { kind: 'text' };
	const endPart = endBlock.parts[end.partIndex] as Part & { kind: 'text' };
	const { yStart, yEnd, isCollapsed } = effective;

	const isAtStartOfText = yStart === 0;
	const isAtEndOfText = yEnd === textPartLength(endPart);
	const isAtStartOfBlock = startPart.id === firstTextPart(startBlock)?.id && yStart === 0;
	const isAtEndOfBlock = endPart.id === lastTextPart(endBlock)?.id && isAtEndOfText;
	const isTextSpanning = startPart.id !== endPart.id;
	const isBlockSpanning = startBlock !== endBlock;
	const isFirstChildOfDocument = startBlock === root.children[0];
	const isNested = Boolean(startBlock.parent && !startBlock.parent.isRoot);
	const isLastChild = startBlock.parent?.children.at(-1) === startBlock;
	const islandRoot = islandRootOf(startBlock);

	/** `deleteContentWithinSelection({})` — the four structural paths. */
	const deleteWithinSelection = (): void => {
		if (startBlock === endBlock) {
			deleteAtomRange(
				startBlock,
				partAtomOffset(startBlock, start.partIndex) + yStart,
				partAtomOffset(endBlock, end.partIndex) + yEnd
			);
			return;
		}

		const selected: OBlock[] = [startBlock];
		let current: OBlock | null = startBlock;
		while (current && current !== endBlock) {
			current = closestNextBlock(current);
			if (current) selected.push(current);
		}
		const toDelete = selected.filter((block, index) => {
			if (index === 0) return isAtStartOfBlock;
			if (index === selected.length - 1) return isAtEndOfBlock;
			return true;
		});
		const deleted = new Set(toDelete);
		const deletesStart = deleted.has(startBlock);
		const keepsPartialEnd = !deleted.has(endBlock);
		const deletedEndAncestor = toDelete.find((block) => isStrictAncestor(block, endBlock));

		if (deletesStart && keepsPartialEnd && deletedEndAncestor && deletedEndAncestor.parent) {
			// End-block hoist: the partial end block (plus each ancestor's
			// trailing siblings) is re-parented over the deleted ancestor's slot.
			deleteAtomRange(endBlock, 0, partAtomOffset(endBlock, end.partIndex) + yEnd);
			const destinationParent = deletedEndAncestor.parent;
			const destinationIndex = indexOf(deletedEndAncestor);
			const survivors = [endBlock];
			let branch = endBlock;
			while (branch !== deletedEndAncestor) {
				const parent = branch.parent;
				if (!parent) break;
				survivors.push(...parent.children.slice(indexOf(branch) + 1));
				branch = parent;
			}
			survivors.forEach((survivor, i) =>
				moveUnder(destinationParent, destinationIndex + i, survivor)
			);
			removeSubtree(deletedEndAncestor);
			normalizeRoot(root, rootDefaultType, freshIds);
			return;
		}

		if (deletesStart && keepsPartialEnd && !deletedEndAncestor) {
			deleteAtomRange(endBlock, 0, partAtomOffset(endBlock, end.partIndex) + yEnd);
			for (const block of [...toDelete].reverse()) removeSubtree(block);
			normalizeRoot(root, rootDefaultType, freshIds);
			return;
		}

		// General path: trim the kept start tail, salvage the kept end tail
		// into the start block, delete every doomed block, hoist the end
		// block's children under the start block's parent.
		const startParent = startBlock.parent;
		const startIndex = indexOf(startBlock);
		if (startBlock !== toDelete[0]) {
			deleteAtomRange(
				startBlock,
				partAtomOffset(startBlock, start.partIndex) + yStart,
				blockAtomLength(startBlock)
			);
		}
		if (endBlock !== toDelete.at(-1)) {
			const tail = endBlock.parts.slice(end.partIndex).map((part, index) => {
				if (index === 0 && part.kind === 'text') {
					return { kind: 'text' as const, id: part.id, runs: sliceRunsFrom(part.runs, yEnd) };
				}
				return clonePart(part);
			});
			startBlock.parts.push(...tail);
		}
		for (const block of toDelete) removeSubtree(block);
		if (endBlock.children.length > 0 && !deleted.has(endBlock) && startParent) {
			[...endBlock.children].forEach((child, i) =>
				moveUnder(startParent, startIndex + 1 + i, child)
			);
		}
		removeSubtree(endBlock);
		normalizeRoot(root, rootDefaultType, freshIds);
	};

	const contentBackward = (): DeleteExpectation => {
		if (isCollapsed && isAtStartOfBlock && isFirstChildOfDocument && isEmptyBlock(startBlock)) {
			return unchanged('backspace at the start of the empty first block');
		}
		if (isBlockSpanning) {
			deleteWithinSelection();
			return tree('block-spanning backward delete');
		}
		if (isCollapsed && isAtStartOfBlock) {
			if (isNested && isLastChild && !islandRoot) {
				return unNest(startBlock)
					? tree('start-of-block backspace un-nests the last child')
					: unchanged('un-nest refused (island/void boundary)');
			}
			if (islandRoot && islandRoot.children.length === 1) {
				return selectOnly(islandRoot.id, 'sole island child backspace selects the island root');
			}
			if (islandRoot && islandRoot.children.length > 1 && indexOf(startBlock) === 0) {
				return unchanged('first child of a multi-child island cannot merge outward');
			}
			const previous = closestPreviousBlock(startBlock);
			if (previous?.void) {
				return selectOnly(previous.id, 'backspace before a void block selects it');
			}
			return mergeBackward(startBlock, defaultType)
				? tree('start-of-block backspace merges into the previous block')
				: unchanged('merge backward refused');
		}
		if (isCollapsed && isAtStartOfText) {
			removeInlinePart(startBlock, start.partIndex - 1);
			return tree('backspace at a text-part start removes the previous inline atom');
		}
		if (isTextSpanning) {
			deleteAtomRange(
				startBlock,
				partAtomOffset(startBlock, start.partIndex) + yStart,
				partAtomOffset(startBlock, end.partIndex) + yEnd
			);
			return tree('same-block spanning backward delete');
		}
		if (isCollapsed) {
			const startOffset = previousGraphemeStart(textPartContent(startPart), yStart);
			deleteAtomRange(
				startBlock,
				partAtomOffset(startBlock, start.partIndex) + startOffset,
				partAtomOffset(startBlock, start.partIndex) + yStart
			);
			return startOffset === yStart
				? unchanged('no grapheme before the caret')
				: tree('grapheme-aware backward delete');
		}
		deleteAtomRange(
			startBlock,
			partAtomOffset(startBlock, start.partIndex) + yStart,
			partAtomOffset(startBlock, start.partIndex) + yEnd
		);
		return tree('backward range delete');
	};

	const contentForward = (): DeleteExpectation => {
		if (isBlockSpanning) {
			deleteWithinSelection();
			return tree('block-spanning forward delete');
		}
		if (isCollapsed && isAtEndOfBlock) {
			if (startBlock.void) return unchanged('forward delete inside a void block is caret-only');
			const next = closestNextBlock(startBlock);
			if (next?.void) {
				return selectOnly(next.id, 'forward delete before a void block selects it');
			}
			return mergeForward(startBlock, defaultType)
				? tree('end-of-block forward delete pulls in the next block')
				: unchanged('merge forward refused');
		}
		if (isCollapsed && isAtEndOfText) {
			removeInlinePart(startBlock, start.partIndex + 1);
			return tree('forward delete at a text-part end removes the next inline atom');
		}
		if (isTextSpanning) {
			deleteAtomRange(
				startBlock,
				partAtomOffset(startBlock, start.partIndex) + yStart,
				partAtomOffset(startBlock, end.partIndex) + yEnd
			);
			return tree('same-block spanning forward delete');
		}
		if (isCollapsed) {
			const endOffset = nextGraphemeEnd(textPartContent(startPart), yStart);
			deleteAtomRange(
				startBlock,
				partAtomOffset(startBlock, start.partIndex) + yStart,
				partAtomOffset(startBlock, start.partIndex) + endOffset
			);
			return endOffset === yStart
				? unchanged('no grapheme after the caret')
				: tree('grapheme-aware forward delete');
		}
		deleteAtomRange(
			startBlock,
			partAtomOffset(startBlock, start.partIndex) + yStart,
			partAtomOffset(startBlock, start.partIndex) + yEnd
		);
		return tree('forward range delete');
	};

	const inputType = deliveredDeleteInputType(events) ?? fallbackInputType(action);
	if (!inputType) return indeterminate('no delete inputType delivered or derivable');

	switch (inputType) {
		case 'deleteContentBackward':
			return contentBackward();
		case 'deleteContentForward':
			return contentForward();
		case 'deleteWordBackward': {
			if (!isCollapsed) return contentBackward();
			// Reached only when no non-collapsed targetRange was adopted —
			// the caret stayed collapsed and production runs its own word
			// boundary (`getPreviousWordStartOffset`), mirrored by the
			// contract function.
			const target = contractWordStartOffset(textPartContent(startPart), yStart);
			deleteAtomRange(
				startBlock,
				partAtomOffset(startBlock, start.partIndex) + target,
				partAtomOffset(startBlock, start.partIndex) + yStart
			);
			return target === yStart
				? unchanged('no word boundary before the caret')
				: tree('word backward delete');
		}
		case 'deleteWordForward': {
			if (!isCollapsed) return contentForward();
			const target = contractWordEndOffset(textPartContent(startPart), yStart);
			deleteAtomRange(
				startBlock,
				partAtomOffset(startBlock, start.partIndex) + yStart,
				partAtomOffset(startBlock, start.partIndex) + target
			);
			return target === yStart
				? unchanged('no word boundary after the caret')
				: tree('word forward delete');
		}
		case 'deleteSoftLineBackward':
		case 'deleteHardLineBackward':
			if (!isCollapsed) return contentBackward();
			deleteAtomRange(startBlock, 0, partAtomOffset(startBlock, start.partIndex) + yStart);
			return tree('line backward delete');
		case 'deleteSoftLineForward':
		case 'deleteHardLineForward':
			if (!isCollapsed) return contentForward();
			deleteAtomRange(
				startBlock,
				partAtomOffset(startBlock, start.partIndex) + yStart,
				blockAtomLength(startBlock)
			);
			return tree('line forward delete');
		case 'deleteByCut':
		case 'deleteByDrag':
		case 'deleteByComposition':
			if (isCollapsed) return unchanged('fragment delete over a collapsed caret');
			return contentBackward();
		case 'deleteContent':
			return contentForward();
		case 'deleteEntireSoftLine':
			if (!isCollapsed) return contentForward();
			deleteAtomRange(startBlock, 0, blockAtomLength(startBlock));
			return tree('entire soft-line delete');
		default:
			return indeterminate(`unhandled delete inputType ${inputType}`);
	}
};

// ── comparison ────────────────────────────────────────────────────────

type JsonContentPart = Record<string, unknown>;

const canonicalJsonContent = (content: unknown): JsonContentPart[] => {
	if (!Array.isArray(content)) return [];
	const out: JsonContentPart[] = [];
	for (const raw of content) {
		const item = { ...(raw as JsonContentPart) };
		delete item.attribution;
		// See `canonicalContent` — emptied runs never serialize.
		if ('text' in item && item.text === '') continue;
		const previous = out[out.length - 1];
		if (
			previous &&
			'text' in item &&
			'text' in previous &&
			marksKey(previous.marks) === marksKey(item.marks)
		) {
			previous.text = String(previous.text) + String(item.text);
			continue;
		}
		out.push(item);
	}
	return out;
};

const jsonEqual = (a: unknown, b: unknown): boolean => stableKey(a) === stableKey(b);

const stableKey = (value: unknown): string => {
	if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`;
	if (value && typeof value === 'object') {
		return `{${Object.entries(value as Record<string, unknown>)
			.filter(([, v]) => v !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([k, v]) => `${JSON.stringify(k)}:${stableKey(v)}`)
			.join(',')}}`;
	}
	return JSON.stringify(value);
};

const diffBlock = (
	expected: ExpectedJsonBlock,
	actual: Record<string, unknown>,
	path: number[]
): string | null => {
	const label = `block[${path.join('.')}]`;
	if (expected.id !== null && actual.id !== expected.id) {
		return `${label}: id ${JSON.stringify(actual.id)} !== expected ${JSON.stringify(expected.id)}`;
	}
	if (expected.id === null && typeof actual.id !== 'string') {
		return `${label}: expected a fresh block id, got ${JSON.stringify(actual.id)}`;
	}
	if (actual.type !== expected.type) {
		return `${label}: type ${JSON.stringify(actual.type)} !== ${JSON.stringify(expected.type)}`;
	}
	if (!jsonEqual(actual.data ?? {}, expected.data)) {
		return `${label}: data ${stableKey(actual.data ?? {})} !== ${stableKey(expected.data)}`;
	}
	const expectedContent = canonicalJsonContent(expected.content ?? []);
	const actualContent = canonicalJsonContent(actual.content ?? []);
	if (stableKey(actualContent) !== stableKey(expectedContent)) {
		return `${label}: content ${stableKey(actualContent)} !== ${stableKey(expectedContent)}`;
	}
	const actualChildren = Array.isArray(actual.children)
		? (actual.children as JsonContentPart[])
		: [];
	const expectedChildren = expected.children ?? [];
	if (actualChildren.length !== expectedChildren.length) {
		return `${label}: ${actualChildren.length} children !== expected ${expectedChildren.length}`;
	}
	for (let i = 0; i < expectedChildren.length; i++) {
		const diff = diffBlock(expectedChildren[i], actualChildren[i], [...path, i]);
		if (diff) return diff;
	}
	return null;
};

/**
 * Compare the expected post-delete tree against `after.value.children`.
 * Returns the first divergence or null on a match.
 */
export const diffDeleteExpectation = (
	expected: ExpectedJsonBlock[],
	actualChildren: unknown
): string | null => {
	const actual = Array.isArray(actualChildren) ? (actualChildren as JsonContentPart[]) : [];
	if (actual.length !== expected.length) {
		return `root has ${actual.length} children, expected ${expected.length}`;
	}
	for (let i = 0; i < expected.length; i++) {
		const diff = diffBlock(expected[i], actual[i], [i]);
		if (diff) return diff;
	}
	return null;
};
