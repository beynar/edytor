/**
 * WU7 — shared per-document model state (`src/lib/crdt/text/runs.ts` +
 * `bindModel`'s `modelState` provider + the `EdytorDoc` facade).
 *
 * Contract under test (docs/crdt-v14-follow-up-prompt.md, WU7):
 *
 * - ONE OWNER: `bindRuns`' doc-scoped state is the single owner of the
 *   derived indexes — block records, ownership, per-text interval rows,
 *   resolved placements and the children index are maintained once and
 *   shared by commands (`bindModel.view`), anchors, maintained runs,
 *   `DocChange` and rendering. `modelCtx()`/`M.view()` hand out the SAME
 *   object; multiple leases and multiple facades never get private copies.
 * - FACET INVALIDATION: a content edit preserves `placements`/`kids`
 *   object identity (no rebuild); `at`/structure/registry churn rebuilds
 *   them. `commitInfo()` reports `fast` eligibility and the touched sets.
 * - OWNERSHIP SHIM: `ctx.own` satisfies `Ownership` over the maintained
 *   indexes — `ownerOf`/`hidden`/`intervals`/`resolvedRange`/`maxG` agree
 *   with a fresh `computeOwnership` baseline, including merge claims.
 * - READ-YOUR-WRITES: reads inside an open transaction see that
 *   transaction's own writes (`doc._transaction.changed` folded in).
 * - DOCCHANGE FAST PATH: content-only commits emit content-only diffs;
 *   placement commits emit moved/order diffs; meta commits emit meta
 *   diffs — and every stream still reconstructs the fresh projection.
 * - LEASES/DISPOSAL: releasing one lease keeps the shared state alive for
 *   the rest; the last release (or doc destroy) tears it down and
 *   `M.view()` falls back to fresh collection.
 */
// @ts-nocheck -- vendored upstream source is plain JS; checked structurally, not via types.
import { describe, expect, it } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { bindEdytorDoc, bindModel, bindRuns } from '../../../lib/crdt/index.js';
import { bindText } from '../../../lib/crdt/text/model.js';
import { createPeerPair, remoteOrigin } from '../harness/peer-set.js';
import { modelSpecSeed } from '../scenarios/seeds.js';

const R = bindRuns(Y);
/** Model wired the way `bindEdytorDoc` wires it — shared state preferred. */
const M = bindModel(Y, (doc) => R.modelState(doc));
/** Unwired model — the fresh-view fallback baseline. */
const MF = bindModel(Y);
const T = bindText(Y);
const E = bindEdytorDoc(Y);

const SEED = modelSpecSeed([
	{ id: 'a', type: 'paragraph', content: [{ kind: 'text', text: 'alpha' }] },
	{ id: 'b', type: 'paragraph', content: [{ kind: 'text', text: 'beta' }] },
	{
		id: 'c',
		type: 'list',
		content: [{ kind: 'text', text: 'gamma' }],
		children: [{ id: 'c1', type: 'paragraph', content: [{ kind: 'text', text: 'child' }] }]
	}
]);

// Bare doc — `ed.init` writes the schema meta + seed content itself.
const newDoc = () => new Y.Doc();

describe('shared model ctx — identity', () => {
	it('M.view returns the SAME maintained ctx object on every call', () => {
		const set = createPeerPair(SEED);
		const doc = set.A.doc;
		const view = R.attach(doc);
		const ctx = view.modelCtx();
		expect(M.view(doc)).toBe(ctx);
		expect(M.view(doc)).toBe(ctx);
		// Facets are the maintained instances, not per-call copies.
		expect(M.view(doc).blocks).toBe(ctx.blocks);
		expect(M.view(doc).placements).toBe(ctx.placements);
		expect(M.view(doc).kids).toBe(ctx.kids);
		expect(M.view(doc).own).toBe(ctx.own);
		view.dispose();
	});

	it('two leases share one ctx; content reads agree with the fresh model', () => {
		const set = createPeerPair(SEED);
		const doc = set.A.doc;
		const v1 = R.attach(doc);
		const v2 = R.attach(doc);
		expect(v1.modelCtx()).toBe(v2.modelCtx());
		const fresh = MF.view(doc);
		expect([...v1.modelCtx().blocks.keys()].sort()).toEqual([...fresh.blocks.keys()].sort());
		expect(M.project(doc)).toEqual(MF.project(doc));
		v1.dispose();
		v2.dispose();
	});
});

describe('shared model ctx — facet invalidation', () => {
	it('a content edit keeps placements AND kids identity; only the block recomputes', () => {
		const set = createPeerPair(SEED);
		const doc = set.A.doc;
		const view = R.attach(doc);
		const ctx = view.modelCtx();
		const placements = ctx.placements;
		const kids = ctx.kids;
		const bRuns = view.runs('b');
		const cRuns = view.runs('c');
		const c1Runs = view.runs('c1');
		view.runs('a');
		view.debug.reset();
		set.A.transact(() => M.insertText(doc, 'a', 0, '!'));
		expect(ctx.placements).toBe(placements); // untouched — same map
		expect(ctx.kids).toBe(kids);
		expect(view.runs('b')).toBe(bRuns); // untouched — same array
		expect(view.runs('c')).toBe(cRuns);
		expect(view.runs('c1')).toBe(c1Runs);
		view.runs('a');
		expect([...view.debug.recomputed].sort()).toEqual(['a']);
		const info = view.commitInfo();
		expect(info.fast).toBe(true);
		expect([...info.content]).toEqual(['a']);
		expect(info.meta.size).toBe(0);
		view.dispose();
	});

	it('an `at` write rebuilds placements+kids but recomputes no runs', () => {
		const set = createPeerPair(SEED);
		const doc = set.A.doc;
		const view = R.attach(doc);
		const ctx = view.modelCtx();
		const placements = ctx.placements;
		const kids = ctx.kids;
		const aRuns = view.runs('a');
		view.debug.reset();
		set.A.transact(() => M.moveBlock(doc, 'a', { parent: 'c', index: 1 }));
		expect(ctx.placements).not.toBe(placements);
		expect(ctx.kids).not.toBe(kids);
		// The move changed display order only — a's runs are identical refs.
		expect(view.runs('a')).toBe(aRuns);
		expect(view.debug.recomputed.has('a')).toBe(false);
		expect(view.commitInfo().fast).toBe(false);
		// And the new placements reflect the move (root is now [b, c]).
		expect(M.project(doc).children[1].children.map((k) => k.id)).toEqual(['c1', 'a']);
		view.dispose();
	});

	it('meta-only writes report a fast commit with an empty content set', () => {
		const set = createPeerPair(SEED);
		const doc = set.A.doc;
		const view = R.attach(doc);
		set.A.transact(() => M.setMark(doc, 'a', 0, 3, 'x', true)); // warm caches
		const placements = view.modelCtx().placements;
		set.A.transact(() => {
			const node = doc.get('blocks').getAttr('a');
			node.setAttr('data', { level: 2 });
		});
		const info = view.commitInfo();
		expect(info.fast).toBe(true);
		expect(info.content.size).toBe(0);
		expect([...info.meta]).toEqual(['a']);
		expect(view.modelCtx().placements).toBe(placements);
		expect(view.modelCtx().blocks.get('a').data).toEqual({ level: 2 });
		view.dispose();
	});

	it('a merge claim rebuilds ownership, placements and kids', () => {
		const set = createPeerPair(SEED);
		const doc = set.A.doc;
		const view = R.attach(doc);
		const ctx = view.modelCtx();
		const placements = ctx.placements;
		const kids = ctx.kids;
		set.A.transact(() => M.mergeBlocks(doc, 'b', 'a'));
		expect(ctx.placements).not.toBe(placements);
		expect(ctx.kids).not.toBe(kids);
		expect(view.commitInfo().fast).toBe(false);
		expect(ctx.own.hidden('b')).toBe(true);
		expect(M.project(doc).children.map((k) => k.id)).toEqual(['a', 'c']);
		view.dispose();
	});
});

describe('shared model ctx — ownership shim', () => {
	it('ctx.own agrees with a fresh computeOwnership baseline (incl. merges)', () => {
		const set = createPeerPair(SEED);
		const doc = set.A.doc;
		const view = R.attach(doc);
		set.A.transact(() => M.mergeBlocks(doc, 'b', 'a'));
		set.A.transact(() => M.insertText(doc, 'a', 0, '>>'));
		const ctx = view.modelCtx();
		const freshBlocks = MF.collectBlocks(doc);
		const fresh = T.computeOwnership(doc, freshBlocks);
		for (const id of freshBlocks.keys()) {
			expect(ctx.own.ownerOf(id), `ownerOf(${id})`).toBe(fresh.ownerOf(id));
			expect(ctx.own.hidden(id), `hidden(${id})`).toBe(fresh.hidden(id));
		}
		for (const t of ['a', 'b', 'c', 'c1']) {
			expect(ctx.own.intervals.get(t) ?? [], `intervals(${t})`).toEqual(
				fresh.intervals.get(t) ?? []
			);
			expect(ctx.own.maxG.get(t) ?? 0, `maxG(${t})`).toBe(fresh.maxG.get(t) ?? 0);
		}
		view.dispose();
	});

	it('per-text interval rows stay shared — an edit to text a never rebuilds text c', () => {
		const set = createPeerPair(SEED);
		const doc = set.A.doc;
		const view = R.attach(doc);
		const ctx = view.modelCtx();
		const aIvs = ctx.own.intervals.get('a');
		const cIvs = ctx.own.intervals.get('c');
		set.A.transact(() => M.insertText(doc, 'a', 0, '!'));
		expect(ctx.own.intervals.get('c')).toBe(cIvs); // untouched row — same array
		expect(ctx.own.intervals.get('a')).not.toBe(aIvs); // rebuilt row
		view.dispose();
	});
});

describe('shared model ctx — read-your-writes', () => {
	it('mid-transaction reads see the transaction’s own content writes', () => {
		const set = createPeerPair(SEED);
		const doc = set.A.doc;
		const view = R.attach(doc);
		set.A.transact(() => {
			M.insertText(doc, 'a', 0, 'ZZ');
			// Same transaction — the maintained run already reflects the write.
			const runs = view.runs('a');
			expect(runs[0].text.startsWith('ZZ')).toBe(true);
			// And the model view's text projection agrees.
			expect(T.contentItemsOf('a', view.modelCtx().blocks, view.modelCtx().own)[0].text).toBe(
				'ZZalpha'
			);
		});
		view.dispose();
	});

	it('mid-transaction reads see the transaction’s own placement writes', () => {
		const set = createPeerPair(SEED);
		const doc = set.A.doc;
		const view = R.attach(doc);
		set.A.transact(() => {
			M.moveBlock(doc, 'a', { parent: 'c', index: 0 });
			const ctx = view.modelCtx(); // syncs tr.changed
			expect(ctx.placements.get('a').displayParent ?? ctx.placements.get('a')).toBeTruthy();
			// The children index already reflects the uncommitted move.
			expect((ctx.kids.get('c') ?? []).map((k) => k.id)).toContain('a');
			expect((ctx.kids.get(null) ?? []).map((k) => k.id)).not.toContain('a');
		});
		view.dispose();
	});
});

describe('shared model ctx — remote commits & disposal', () => {
	it('remote applyUpdate folds through the same invalidation path', () => {
		const set = createPeerPair(SEED);
		const docB = set.B.doc;
		const view = R.attach(docB);
		const ctx = view.modelCtx();
		const placements = ctx.placements;
		set.A.transact(() => M.insertText(set.A.doc, 'a', 0, 'R'));
		const upd = Y.encodeStateAsUpdate(set.A.doc, Y.encodeStateVector(docB));
		docB.transact(() => Y.applyUpdate(docB, upd, remoteOrigin('A')), remoteOrigin('A'));
		expect(ctx.placements).toBe(placements); // content-only — identity kept
		expect(view.commitInfo().fast).toBe(true);
		expect(view.runs('a')[0].text.startsWith('R')).toBe(true);
		view.dispose();
	});

	it('disposing one lease keeps the shared state alive for the other', () => {
		const set = createPeerPair(SEED);
		const doc = set.A.doc;
		const v1 = R.attach(doc);
		const v2 = R.attach(doc);
		const ctx = v1.modelCtx();
		v1.dispose();
		expect(R.modelState(doc)).toBe(ctx); // still owned by v2's lease
		set.A.transact(() => M.insertText(doc, 'a', 0, '!'));
		expect(v2.runs('a')[0].text.startsWith('!')).toBe(true);
		v2.dispose();
		expect(R.modelState(doc)).toBeUndefined(); // last release tears down
		// M.view now falls back to fresh collection — still correct.
		expect(M.view(doc)).not.toBe(ctx);
		expect(M.project(doc)).toEqual(MF.project(doc));
	});
});

describe('facade — DocChange fast path & shared state', () => {
	const seedEd = () => {
		const doc = newDoc();
		const ed = E.create(doc);
		ed.init({
			content: [
				{ id: 'a', type: 'paragraph', content: [{ kind: 'text', text: 'alpha' }] },
				{ id: 'b', type: 'paragraph', content: [{ kind: 'text', text: 'beta' }] },
				{
					id: 'c',
					type: 'list',
					content: [{ kind: 'text', text: 'gamma' }],
					children: [{ id: 'c1', type: 'paragraph', content: [{ kind: 'text', text: 'child' }] }]
				}
			]
		});
		return ed;
	};

	it('content-only commits emit a content-only DocChange', () => {
		const ed = seedEd();
		const changes = [];
		ed.onChange((c) => changes.push(c));
		ed.insertText('a', 0, '!');
		ed.setMark('a', 0, 2, 'bold', true);
		ed.setBlockData('b', { k: 1 });
		expect(changes.length).toBe(3);
		// insertText + setMark: content diffs only.
		for (const c of changes.slice(0, 2)) {
			expect([...c.content.keys()]).toEqual(['a']);
			expect(c.meta.size).toBe(0);
			expect(c.added.size + c.removed.size + c.moved.size + c.order.size).toBe(0);
		}
		// setBlockData: meta diff only.
		expect([...changes[2].meta.keys()]).toEqual(['b']);
		expect(changes[2].meta.get('b').data).toEqual({ k: 1 });
		expect(changes[2].content.size).toBe(0);
		ed.dispose();
	});

	it('placement commits emit moved/order diffs; deletes emit removed', () => {
		const ed = seedEd();
		const changes = [];
		ed.onChange((c) => changes.push(c));
		ed.moveBlock('a', { parent: 'c', index: 0 });
		ed.deleteBlock('b');
		expect(changes.length).toBe(2);
		expect(changes[0].moved.has('a')).toBe(true);
		expect(changes[0].order.size).toBeGreaterThan(0);
		expect(changes[0].content.size).toBe(0);
		expect(changes[1].removed.has('b')).toBe(true);
		ed.dispose();
	});

	it('two facades on one doc share state and each get a correct diff stream', () => {
		const doc = newDoc();
		const ed1 = seedEdInto(doc);
		const ed2 = E.create(doc);
		const c1 = [];
		const c2 = [];
		ed1.onChange((c) => c1.push(c));
		ed2.onChange((c) => c2.push(c));
		ed1.insertText('a', 0, '#');
		expect(c1.length).toBe(1);
		expect(c2.length).toBe(1);
		expect([...c2[0].content.keys()]).toEqual(['a']);
		// Both facades project identically — one maintained model underneath.
		expect(ed1.project()).toEqual(ed2.project());
		ed1.dispose();
		// ed2 keeps working — its lease still owns the shared state.
		ed2.insertText('b', 0, '?');
		expect(c2.length).toBe(2);
		expect(ed2.project().children[1].content[0].text.startsWith('?')).toBe(true);
		ed2.dispose();
	});

	function seedEdInto(doc) {
		const ed = E.create(doc);
		ed.init({
			content: [
				{ id: 'a', type: 'paragraph', content: [{ kind: 'text', text: 'alpha' }] },
				{ id: 'b', type: 'paragraph', content: [{ kind: 'text', text: 'beta' }] }
			]
		});
		return ed;
	}
});
