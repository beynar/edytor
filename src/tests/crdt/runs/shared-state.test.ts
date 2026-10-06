/**
 * WU7 / arch-v2 D9 — the per-document index (`src/lib/crdt/text/runs.ts`,
 * read by `bindModel` and the `EdytorDoc` facade).
 *
 * Contract under test (docs/crdt-v14-follow-up-prompt.md, WU7):
 *
 * - ONE OWNER: `bindRuns`' doc-scoped state is the single owner of the
 *   derived indexes — block records, ownership, per-text interval rows,
 *   resolved placements and the children index are maintained once and
 *   shared by commands (`bindModel.view`), anchors, maintained runs,
 *   `DocChange` and rendering. `index.view()`/`M.view()` hand out the SAME
 *   object; every binding and facade on a doc gets the doc's one index.
 * - FACET INVALIDATION: a content edit preserves `placements`/`kids`
 *   object identity (no rebuild); `at`/structure/registry churn rebuilds
 *   them. The change report names exactly what the commit changed.
 * - OWNERSHIP SHIM: `ctx.own` satisfies `Ownership` over the maintained
 *   indexes — `ownerOf`/`hidden`/`intervals`/`resolvedRange`/`maxG` agree
 *   with a fresh `computeOwnership` baseline, including merge claims.
 * - READ-YOUR-WRITES: reads inside an open transaction see that
 *   transaction's own writes (its pending writes are folded first).
 * - CHANGE REPORT: content-only commits emit content-only diffs;
 *   placement commits emit moved/order diffs; meta commits emit meta
 *   diffs — and every stream still reconstructs the fresh projection.
 * - LIFETIME: the index lives as long as the doc — disposing a facade
 *   leaves it serving every other reader; the doc's `destroy` tears it down.
 */
// @ts-nocheck -- vendored upstream source is plain JS; checked structurally, not via types.
import { describe, expect, it } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { bindEdytorDoc } from '../../../lib/crdt/edytor-doc.js';
import { bindRuns } from '../../../lib/crdt/text/runs.js';
import { bindModel } from '../../oracles/model-ops.js';
import { collectBlocks } from '../../oracles/fresh-view.js';
import { bindText } from '../../../lib/crdt/text/model.js';
import { createPeerPair, remoteOrigin } from '../harness/peer-set.js';
import { modelSpecSeed } from '../scenarios/seeds.js';

const R = bindRuns(Y);
const M = bindModel(Y);
/** The projection an index rebuilt from scratch reports (a reloaded copy of `doc`). */
const freshProject = (doc) => {
	const copy = new Y.Doc();
	Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
	return M.project(copy);
};
/** Collect the reports `index` publishes. */
const reports = (index) => {
	const out = [];
	index.onReport((r) => out.push(r));
	return out;
};
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
		const ctx = view.view();
		expect(M.view(doc)).toBe(ctx);
		expect(M.view(doc)).toBe(ctx);
		// Facets are the maintained instances, not per-call copies.
		expect(M.view(doc).blocks).toBe(ctx.blocks);
		expect(M.view(doc).placements).toBe(ctx.placements);
		expect(M.view(doc).kids).toBe(ctx.kids);
		expect(M.view(doc).own).toBe(ctx.own);
	});

	it('every attach returns the doc’s one index; reads agree with a fresh collect', () => {
		const set = createPeerPair(SEED);
		const doc = set.A.doc;
		const v1 = R.attach(doc);
		const v2 = bindRuns(Y).attach(doc);
		expect(v2).toBe(v1);
		expect([...v1.view().blocks.keys()].sort()).toEqual([...collectBlocks(doc).keys()].sort());
		expect(M.project(doc)).toEqual(freshProject(doc));
	});
});

describe('shared model ctx — facet invalidation', () => {
	it('a content edit keeps placements AND kids identity; only the block recomputes', () => {
		const set = createPeerPair(SEED);
		const doc = set.A.doc;
		const view = R.attach(doc);
		const ctx = view.view();
		const placements = ctx.placements;
		const kids = ctx.kids;
		const bRuns = view.runs('b');
		const cRuns = view.runs('c');
		const c1Runs = view.runs('c1');
		view.runs('a');
		view.debug.reset();
		const seen = reports(view);
		set.A.transact(() => M.insertText(doc, 'a', 0, '!'));
		expect(ctx.placements).toBe(placements); // untouched — same map
		expect(ctx.kids).toBe(kids);
		expect(view.runs('b')).toBe(bRuns); // untouched — same array
		expect(view.runs('c')).toBe(cRuns);
		expect(view.runs('c1')).toBe(c1Runs);
		view.runs('a');
		expect([...view.debug.recomputed].sort()).toEqual(['a']);
		expect(seen).toHaveLength(1);
		expect([...seen[0].content.keys()]).toEqual(['a']);
		expect(seen[0].meta.size + seen[0].order.size + seen[0].moved.size).toBe(0);
	});

	it('an `at` write re-places the moved block and patches its lists, recomputing no runs', () => {
		const set = createPeerPair(SEED);
		const doc = set.A.doc;
		const view = R.attach(doc);
		const ctx = view.view();
		const rootKids = ctx.kids.get(null);
		const cKids = ctx.kids.get('c');
		const aRuns = view.runs('a');
		view.debug.reset();
		const seen = reports(view);
		set.A.transact(() => M.moveBlock(doc, 'a', { parent: 'c', index: 1 }));
		// P3: the placements and child lists are maintained in place; each list
		// a move leaves or joins is replaced (a list a reader holds never changes).
		expect(ctx.placements.get('a').parent).toBe('c');
		expect(ctx.kids.get(null)).not.toBe(rootKids);
		expect(ctx.kids.get('c')).not.toBe(cKids);
		expect(cKids.map((k) => k.id)).toEqual(['c1']);
		// The move changed display order only — a's runs are identical refs.
		expect(view.runs('a')).toBe(aRuns);
		expect(view.debug.recomputed.has('a')).toBe(false);
		expect([...seen[0].moved].sort()).toEqual(['a', 'b', 'c']);
		expect(seen[0].content.size).toBe(0);
		// And the new placements reflect the move (root is now [b, c]).
		expect(M.project(doc).children[1].children.map((k) => k.id)).toEqual(['c1', 'a']);
	});

	it('meta-only writes report meta and no content', () => {
		const set = createPeerPair(SEED);
		const doc = set.A.doc;
		const view = R.attach(doc);
		set.A.transact(() => M.setMark(doc, 'a', 0, 3, 'x', true)); // warm caches
		const placements = view.view().placements;
		const seen = reports(view);
		set.A.transact(() => {
			const node = doc.get('blocks').getAttr('a');
			node.setAttr('data', { level: 2 });
		});
		expect(seen).toHaveLength(1);
		expect(seen[0].content.size).toBe(0);
		expect([...seen[0].meta.keys()]).toEqual(['a']);
		expect(view.view().placements).toBe(placements);
		expect(view.view().blocks.get('a').data).toEqual({ level: 2 });
	});

	it('a merge claim re-decides ownership and patches the lists', () => {
		const set = createPeerPair(SEED);
		const doc = set.A.doc;
		const view = R.attach(doc);
		const ctx = view.view();
		const rootKids = ctx.kids.get(null);
		const seen = reports(view);
		set.A.transact(() => M.mergeBlocks(doc, 'b', 'a'));
		expect(ctx.own.ownerOf('b')).toBe('a');
		expect(ctx.kids.get(null)).not.toBe(rootKids);
		expect([...seen[0].removed]).toEqual(['b']);
		expect(ctx.own.hidden('b')).toBe(true);
		expect(M.project(doc).children.map((k) => k.id)).toEqual(['a', 'c']);
	});
});

describe('shared model ctx — ownership shim', () => {
	it('ctx.own agrees with a fresh computeOwnership baseline (incl. merges)', () => {
		const set = createPeerPair(SEED);
		const doc = set.A.doc;
		const view = R.attach(doc);
		set.A.transact(() => M.mergeBlocks(doc, 'b', 'a'));
		set.A.transact(() => M.insertText(doc, 'a', 0, '>>'));
		const ctx = view.view();
		const freshBlocks = collectBlocks(doc);
		const fresh = T.computeOwnership(doc, freshBlocks);
		for (const id of freshBlocks.keys()) {
			expect(ctx.own.ownerOf(id), `ownerOf(${id})`).toBe(fresh.ownerOf(id));
			expect(ctx.own.hidden(id), `hidden(${id})`).toBe(fresh.hidden(id));
		}
		// The stream table (R2): every block's stream and display agree.
		for (const id of freshBlocks.keys()) {
			const keep = (x) => x && { block: x.block, home: x.home, start: x.start, end: x.end };
			expect(keep(ctx.own.streamOf(id)), `streamOf(${id})`).toEqual(keep(fresh.streamOf(id)));
			const segs = (x) => x?.map((g) => [g.t, g.block, g.i0, g.i1]) ?? null;
			expect(segs(ctx.own.display(id)), `display(${id})`).toEqual(segs(fresh.display(id)));
		}
	});

	it('streams of other texts stay shared — an edit to text a never re-places text c', () => {
		const set = createPeerPair(SEED);
		const doc = set.A.doc;
		const view = R.attach(doc);
		const ctx = view.view();
		const aStream = ctx.own.streamOf('a');
		const cStreams = ctx.own.streamsIn('c');
		set.A.transact(() => M.insertText(doc, 'a', 0, '!'));
		// Streams are read off the text's maintained row (P1): an untouched text's are equal.
		expect(ctx.own.streamsIn('c')).toEqual(cStreams);
		expect(ctx.own.streamOf('a')).not.toBe(aStream); // re-placed stream
		expect(ctx.own.streamOf('a').end).toBe(aStream.end + 1);
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
			expect(T.contentItemsOf('a', view.view().blocks, view.view().own)[0].text).toBe('ZZalpha');
		});
	});

	it('mid-transaction reads see the transaction’s own placement writes', () => {
		const set = createPeerPair(SEED);
		const doc = set.A.doc;
		const view = R.attach(doc);
		set.A.transact(() => {
			M.moveBlock(doc, 'a', { parent: 'c', index: 0 });
			const ctx = view.view(); // syncs tr.changed
			expect(ctx.placements.get('a').displayParent ?? ctx.placements.get('a')).toBeTruthy();
			// The children index already reflects the uncommitted move.
			expect((ctx.kids.get('c') ?? []).map((k) => k.id)).toContain('a');
			expect((ctx.kids.get(null) ?? []).map((k) => k.id)).not.toContain('a');
		});
	});
});

describe('shared model ctx — remote commits & disposal', () => {
	it('remote applyUpdate folds through the same invalidation path', () => {
		const set = createPeerPair(SEED);
		const docB = set.B.doc;
		const view = R.attach(docB);
		const ctx = view.view();
		const placements = ctx.placements;
		const seen = reports(view);
		set.A.transact(() => M.insertText(set.A.doc, 'a', 0, 'R'));
		const upd = Y.encodeStateAsUpdate(set.A.doc, Y.encodeStateVector(docB));
		docB.transact(() => Y.applyUpdate(docB, upd, remoteOrigin('A')), remoteOrigin('A'));
		expect(ctx.placements).toBe(placements); // content-only — identity kept
		expect([...seen[0].content.keys()]).toEqual(['a']);
		expect(view.runs('a')[0].text.startsWith('R')).toBe(true);
	});

	it('the index lives as long as the doc: disposing facades never tears it down', () => {
		const doc = newDoc();
		const ed1 = seedEd(doc);
		const ed2 = E.create(doc);
		const index = R.attach(doc);
		const ctx = index.view();
		ed1.dispose();
		ed2.insertText('a', 0, '!');
		expect(index.runs('a')[0].text.startsWith('!')).toBe(true);
		ed2.dispose();
		expect(R.attach(doc)).toBe(index);
		expect(M.view(doc)).toBe(ctx);
		expect(M.project(doc)).toEqual(freshProject(doc));
		// The doc's destroy releases it; a later attach builds a new one.
		doc.destroy();
		expect(R.attach(doc)).not.toBe(index);
	});
});

function seedEd(doc = newDoc()) {
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
}

describe('facade — change report & shared state', () => {
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
		// ed2 keeps working — the doc's index outlives any facade.
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
