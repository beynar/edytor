/**
 * arch-v2 V1 — the selection shadow comparator (plan §9.1 rule 3, §9.3 V1).
 *
 * Every view registers with the hook below; the view derives its selection
 * VALUE (`session/selection`) next to today's `selection.state` at every
 * writer. After each step — the end of every synchronous turn in which a
 * writer ran, every `flushDomUpdates()`, and the end of every test —
 * `project(value)` at the current document version is compared with today's
 * state on the fields both expose. A difference must be explained by a plan
 * §8 row (`CLASSES`, matched by an objective predicate) or it is a bug in the
 * shadow: unexplained differences fail the test (`assertShadowExplained`).
 *
 * Census: `SELECTION_SHADOW_REPORT=/abs/file.jsonl pnpm test:dom` appends one
 * line per test file (steps compared, differences by class, samples).
 * Temporary — removed at V2 with the state it compares against.
 */
import { appendFileSync } from 'node:fs';
import { expect } from 'vitest';

type Point = { block: string; offset: number } | null;
type Projection = {
	kind: string;
	start: Point;
	end: Point;
	isCollapsed: boolean;
	isReversed: boolean;
	blocks: string[];
	segments: (
		| { block: string; kind: 'text'; segOrd: number }
		| { block: string; kind: 'inline'; id: string }
	)[];
	isAtStartOfText: boolean;
	isAtEndOfText: boolean;
	isAtStartOfBlock: boolean;
	isAtEndOfBlock: boolean;
	isTextSpanning: boolean;
	isBlockSpanning: boolean;
	islandRoot: string | null;
	voidRoot: string | null;
	marks: Record<string, unknown>;
	content: string;
};
type SelectionModule = {
	project: (value: unknown, doc: unknown) => Projection;
	segmentsOf: (
		doc: unknown,
		block: string
	) => { kind: string; segOrd?: number; start: number; end: number }[];
};

// Resolved lazily so this file loads on the reference, where the module does not exist yet.
const lib = import.meta.glob<SelectionModule>('../../lib/session/selection.ts', { eager: true });
const project = Object.values(lib)[0]?.project;
const segmentsOf = Object.values(lib)[0]?.segmentsOf;

// Loosely typed: the comparator reads today's wrapper-based state and the V1 shadow fields.
type View = any;

/** Shared fields, as the comparator reads them from either side. */
type Shared = Record<string, unknown>;

const segmentKey = (s: { block: string; kind: string; segOrd?: number; id?: string }) =>
	s.kind === 'text' ? `${s.block}#t${s.segOrd}` : `${s.block}#i${s.id}`;

const stateSide = (view: View): Shared => {
	const s = view.state;
	const kind = view.selectedBlocks.size
		? 'blocks'
		: view.selectedInlineBlock.size
			? 'atom'
			: s.startText
				? 'text'
				: 'none';
	const point = (text: any, y: number): Point =>
		text ? { block: text.parent.id, offset: text.segStart + y } : null;
	return {
		kind,
		start: point(s.startText, s.yStart),
		end: point(s.endText, s.yEnd),
		isCollapsed: s.isCollapsed,
		isReversed: s.isReversed,
		blocks: s.blocks.map((b: any) => b.id),
		segments: s.contentParts.map((part: any) =>
			segmentKey(
				'_segOrd' in part
					? { block: part.parent.id, kind: 'text', segOrd: part._segOrd }
					: { block: part.parent.id, kind: 'inline', id: part.id }
			)
		),
		isAtStartOfText: Boolean(s.isAtStartOfText),
		isAtEndOfText: Boolean(s.isAtEndOfText),
		isAtStartOfBlock: Boolean(s.isAtStartOfBlock),
		isAtEndOfBlock: Boolean(s.isAtEndOfBlock),
		isTextSpanning: s.isTextSpanning,
		isBlockSpanning: s.isBlockSpanning,
		islandRoot: s.islandRoot?.id ?? null,
		voidRoot: s.voidRoot?.id ?? null,
		isIsland: s.isIsland,
		isVoid: s.isVoid,
		marks: s.currentMarks ?? {},
		content: s.content,
		length: s.length
	};
};

const shadowSide = (p: Projection): Shared => ({
	kind: p.kind,
	start: p.start,
	end: p.end,
	isCollapsed: p.isCollapsed,
	isReversed: p.isReversed,
	blocks: p.blocks,
	segments: p.segments.map(segmentKey),
	isAtStartOfText: p.isAtStartOfText,
	isAtEndOfText: p.isAtEndOfText,
	isAtStartOfBlock: p.isAtStartOfBlock,
	isAtEndOfBlock: p.isAtEndOfBlock,
	isTextSpanning: p.isTextSpanning,
	isBlockSpanning: p.isBlockSpanning,
	islandRoot: p.islandRoot,
	voidRoot: p.voidRoot,
	isIsland: p.islandRoot !== null,
	isVoid: p.voidRoot !== null,
	marks: p.marks,
	content: p.content,
	length: p.content.length
});

/** Fields compared per kind: an atom's or an empty selection's text fields are not maintained today. */
const FIELDS: Record<string, string[]> = {
	none: ['kind'],
	atom: ['kind'],
	text: [
		'kind',
		'start',
		'end',
		'isCollapsed',
		'isReversed',
		'blocks',
		'segments',
		'isAtStartOfText',
		'isAtEndOfText',
		'isAtStartOfBlock',
		'isAtEndOfBlock',
		'isTextSpanning',
		'isBlockSpanning',
		'islandRoot',
		'voidRoot',
		'isIsland',
		'isVoid',
		'marks',
		'content',
		'length'
	]
};
FIELDS.blocks = FIELDS.text;

export type ShadowDiff = { field: string; state: unknown; shadow: unknown };

/** What a classifier sees for one differing step. */
export type ShadowContext = {
	view: View;
	step: string;
	diffs: ShadowDiff[];
	fields: Set<string>;
	state: Shared;
	shadow: Shared;
	/** The document changed since the last writer ran (no writer re-derived the state). */
	docMoved: boolean;
	/** A state endpoint is a dead wrapper. */
	deadEndpoint: boolean;
	/** The editor host holds focus. */
	focused: boolean;
	/** Document commits since the last writer, by origin. */
	local: boolean;
	remote: boolean;
	/** The state was derived from a DOM selection (`startNode` is set only by the DOM derive). */
	domDerived: boolean;
	/** A state endpoint wrapper's length differs from its engine segment (the mirror lags the model). */
	mirrorLag: boolean;
};

/** A class of explained differences: the plan §8 row that owns it and its objective predicate. */
export type ShadowClass = {
	id: string;
	row: string;
	note: string;
	match: (c: ShadowContext) => boolean;
};

const only = (c: ShadowContext, ...fields: string[]) =>
	[...c.fields].every((f) => fields.includes(f));

/**
 * Today's own rules for the derived fields, re-applied now to the state's stored
 * endpoints (the wrapper reads `buildSelectionState` makes). When they agree with
 * the projection, a difference is staleness of a stored snapshot, not a rule
 * disagreement between the state and the shadow.
 */
const todayRule = (view: View): Shared => {
	const s = view.state;
	const { startText: a, endText: b, yStart, yEnd } = s;
	if (!a || !b) return {};
	const content = s.isCollapsed
		? ''
		: s.texts
				.map((t: View) => t.stringContent.slice(t === a ? yStart : 0, t === b ? yEnd : t.length))
				.join('');
	const markEnd = a === b ? yEnd : a.length;
	const markStart = yStart === markEnd ? Math.max(yStart - 1, 0) : yStart;
	const marks = view.selectedBlocks.size
		? {}
		: a
				.getMarksAtRange(markStart, markEnd)
				.reduce((acc: Shared, run: View) => Object.assign(acc, run.marks ?? {}), {});
	return {
		content,
		length: content.length,
		marks,
		isAtStartOfText: yStart === 0,
		isAtEndOfText: yEnd === b.length,
		isAtStartOfBlock: a === a.parent.firstText && yStart === 0,
		isAtEndOfBlock: b === b.parent.lastText && yEnd === b.length
	};
};

const squash = (text: unknown) => String(text).replace(/[\s\u200b\ufeff]/g, '');

const firstLast = (view: View) => {
	const ids: string[] = Array.from(view.selectedBlocks, (b: View) => b.id);
	ids.sort((x, y) => view.edytor.facade.compare(x, y));
	return [ids[0], ids[ids.length - 1]];
};

/** Explained difference classes, first match wins. Each names the §8 row whose gate removes it. */
export const CLASSES: ShadowClass[] = [
	{
		id: 'blocks-deleted-under-block-selection',
		row: 'F-S13 (local block-set delete/cut/replace: the command authors its result selection, V3); F-S7 when a peer deleted them (V2)',
		note: 'every block the selection covered is gone, so no endpoint resolves (the vanished-endpoint seam is V3); the state still names their dead wrappers until the deferred restore writes the next selection',
		match: (c) => c.shadow.start === null && c.deadEndpoint
	},
	{
		id: 'block-set-changed-without-state',
		row: 'F-S3 (a block-set write applies every side effect once, V2)',
		note: '`addBlockToSelection`/`removeBlockFromSelection` (Shift+Arrow block extension) change the set but not the state',
		match: (c) => {
			if (c.state.kind !== 'blocks') return false;
			const [first, last] = firstLast(c.view);
			const s = c.view.state;
			return s.startBlock?.id !== first || s.endBlock?.id !== last;
		}
	},
	{
		id: 'dom-string-content',
		row: 'F-S6 (content equals the model slice, V4); reader F9',
		note: 'a cross-text DOM-derived state stores `Selection.toString()` (block separators, filler) instead of the model slice',
		match: (c) =>
			c.domDerived &&
			only(c, 'content', 'length') &&
			c.state.content !== c.shadow.content &&
			squash(c.state.content) === squash(c.shadow.content)
	},
	{
		id: 'local-command-caret-pending',
		row: 'F-S1 (a write sets the selection synchronously; deferred writes go, V4)',
		note: 'inside the turn of a local edit the state still holds the pre-edit caret; the command writes its caret after the turn',
		match: (c) => c.step === 'turn' && c.docMoved && c.local && !c.remote
	},
	{
		id: 'stale-derived-field',
		row: 'F-S8 (the selection is a projection of the current version immediately, V2)',
		note: 'endpoints agree; a derived field is a snapshot taken before the document (or the mirror) reached this version — today’s own rule re-applied now gives the projection’s answer',
		match: (c) => {
			if (c.fields.has('start') || c.fields.has('end')) return false;
			const rule = todayRule(c.view);
			return c.diffs.every((d) => d.field in rule && equal(rule[d.field], d.shadow));
		}
	}
];

type Census = {
	steps: number;
	compared: number;
	skipped: Record<string, number>;
	classes: Record<string, { row: string; count: number; samples: string[] }>;
	unexplained: { test: string; step: string; diffs: ShadowDiff[]; context: Shared }[];
};
const fresh = (): Census => ({ steps: 0, compared: 0, skipped: {}, classes: {}, unexplained: [] });
let census = fresh();
let pendingUnexplained: Census['unexplained'] = [];

const views = new Set<View>();
/** Commits per view since registration: `[version, local]`. */
const commits = new WeakMap<View, [number, boolean][]>();
const track = (view: View) => {
	if (commits.has(view)) return commits.get(view)!;
	const list: [number, boolean][] = [];
	commits.set(view, list);
	const facade = view.edytor.facade;
	facade.onChange((change: { local: boolean }) => {
		list.push([facade.version, change.local]);
		if (list.length > 64) list.shift();
	});
	return list;
};

const lagging = (facade: unknown, text: any) => {
	if (!text || !text._live || !segmentsOf) return false;
	const segment = segmentsOf(facade, text.parent.id).find(
		(x) => x.kind === 'text' && x.segOrd === text._segOrd
	);
	return !segment || segment.end - segment.start !== text.length;
};

const testName = () => expect.getState().currentTestName ?? '(outside a test)';

const skip = (reason: string) => (census.skipped[reason] = (census.skipped[reason] ?? 0) + 1);

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Compare one view's shadow with its state; record the step in the census. */
export const compareShadow = (view: View, step: string) => {
	census.steps++;
	if (!project) return skip('no session/selection module (reference)');
	if (view.edytor.destroyed) return skip('view destroyed');
	if (view.shadowState === undefined) return skip('no shadow (view built before the hook)');
	// A test that assigns `selection.state` directly (reader T2) bypasses every writer.
	if (view.state !== view.shadowState)
		return skip('state assigned outside a writer (test-only, reader T2)');
	const facade = view.edytor.facade;
	const state = stateSide(view);
	const shadow = shadowSide(project(view.shadow, facade));
	census.compared++;
	const fields = FIELDS[state.kind as string] ?? FIELDS.text;
	const diffs = (state.kind === shadow.kind ? fields : ['kind'])
		.filter((f) => !equal(state[f], shadow[f]))
		.map((field) => ({ field, state: state[field], shadow: shadow[field] }));
	if (diffs.length === 0) return;
	const s = view.state;
	const since = track(view).filter(([version]) => version > view.shadowVersion);
	const node = view.edytor.node as HTMLElement | undefined;
	const active = node?.ownerDocument.activeElement;
	const context: ShadowContext = {
		view,
		step,
		diffs,
		fields: new Set(diffs.map((d) => d.field)),
		state,
		shadow,
		docMoved: facade.version !== view.shadowVersion,
		deadEndpoint: Boolean((s.startText && !s.startText._live) || (s.endText && !s.endText._live)),
		focused: Boolean(node && active && node.contains(active)),
		local: since.some(([, local]) => local),
		remote: since.some(([, local]) => !local),
		domDerived: s.startNode !== null,
		mirrorLag: lagging(facade, s.startText) || lagging(facade, s.endText)
	};
	const cls = CLASSES.find((c) => c.match(context));
	const sample = `${testName()} [${step}] ${JSON.stringify(diffs)}`.slice(0, 600);
	if (!cls) {
		const {
			view: _view,
			diffs: _diffs,
			fields: _fields,
			state: _s,
			shadow: _p,
			...flags
		} = context;
		const entry = { test: testName(), step, diffs, context: flags };
		census.unexplained.push(entry);
		pendingUnexplained.push(entry);
		return;
	}
	const entry = (census.classes[cls.id] ??= { row: cls.row, count: 0, samples: [] });
	entry.count++;
	if (entry.samples.length < 3) entry.samples.push(sample);
};

export const compareAllShadows = (step: string) => {
	for (const view of views) compareShadow(view, step);
};

/** Fail the current test on a difference no §8 row explains. */
export const assertShadowExplained = () => {
	const found = pendingUnexplained;
	pendingUnexplained = [];
	expect(found, 'selection shadow differences not explained by a §8 row').toEqual([]);
};

/** Append this file's census to `SELECTION_SHADOW_REPORT` (one JSON line). */
export const reportShadowCensus = (file: string) => {
	const target = process.env.SELECTION_SHADOW_REPORT;
	if (target) appendFileSync(target, JSON.stringify({ file, ...census }) + '\n');
	census = fresh();
};

const scheduled = new Set<View>();
(globalThis as { __EDYTOR_SELECTION_SHADOW__?: unknown }).__EDYTOR_SELECTION_SHADOW__ = {
	register: (view: View) => {
		views.add(view);
		queueMicrotask(() => views.has(view) && track(view));
	},
	unregister: (view: View) => views.delete(view),
	turn: (view: View) => {
		if (scheduled.has(view)) return;
		scheduled.add(view);
		queueMicrotask(() => {
			scheduled.delete(view);
			if (views.has(view)) compareShadow(view, 'turn');
		});
	}
};
