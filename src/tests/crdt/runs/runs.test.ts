/**
 * U05 — maintained run view (`src/lib/crdt/text/runs.ts`) unit tests.
 *
 * Contract under test (docs/crdt-v14-richtext-adr.md):
 *
 * - EQUIVALENCE: `view.runs(b)` always equals the fresh from-scratch
 *   projection (`computeAllRuns` — a third code path through
 *   `bindText.flatten`/`contentItemsOf`) after LOCAL edits, REMOTE update
 *   application, UNDO, and across split/merge/move — the maintained view
 *   must never serve stale snapshots.
 * - GRANULARITY: an edit to block A invalidates only the blocks whose
 *   flatten consulted the touched text/lists — editing A in a multi-block
 *   doc recomputes A (and any owner-of-shared-text), never unrelated B.
 * - IDENTITY: unaffected blocks keep array AND run-object identity
 *   (`toBe`); within an edited block, runs outside the edited window keep
 *   object identity (prefix/suffix structural sharing); equal mark objects
 *   are interned (`===`).
 * - ISOLATION: snapshots are frozen (array, run, marks, data) — engine
 *   internals never escape; `contentJSON()` returns owned copies.
 * - REACTIVITY: `version()` bumps per observed change; a block whose
 *   content did not change keeps its run array (`toBe`). Pure reads need
 *   no subscription.
 */
// @ts-nocheck -- vendored upstream source is plain JS; checked structurally, not via types.
import { describe, expect, it } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { bindRunsOracle } from '../../oracles/runs.js';
import { bindRuns } from '../../../lib/crdt/text/runs.js';
import { bindModel } from '../../oracles/model-ops.js';
import { createPeerPair, createPeerSet } from '../harness/peer-set.js';
import { createModelOps } from '../harness/ops/model-ops.js';
import { mulberry32, int, pick } from '../harness/rng.js';
import { modelSpecSeed, MODEL_BASE_SEED } from '../scenarios/seeds.js';

const M = bindModel(Y);
const R = bindRuns(Y);
const O = bindRunsOracle(Y);
const ops = createModelOps();

const RICH_SEED = modelSpecSeed([
	{
		id: 'a',
		type: 'paragraph',
		content: [
			{ kind: 'text', text: 'alpha ', marks: { bold: true } },
			{ kind: 'text', text: 'plain ' },
			{ kind: 'text', text: 'omega', marks: { bold: true, italic: true } }
		]
	},
	{
		id: 'b',
		type: 'paragraph',
		content: [
			{ kind: 'text', text: 'beta ' },
			{ kind: 'inline', id: 'm1', type: 'mention', data: { user: 'sam' } },
			{ kind: 'text', text: ' tail' }
		]
	},
	{
		id: 'c',
		type: 'list',
		content: [{ kind: 'text', text: 'gamma' }],
		children: [{ id: 'c1', type: 'paragraph', content: [{ kind: 'text', text: 'child one' }] }]
	}
]);

/** Deep-equality of maintained runs vs the fresh from-scratch baseline. */
const expectRunsFresh = (view, doc, id) => {
	const fresh = O.computeAllRuns(doc).get(id) ?? Object.freeze([]);
	expect(view.runs(id), `runs(${id}) vs fresh`).toEqual([...fresh]);
};

/** Every visible block's runs equal the fresh baseline. */
const expectAllFresh = (view, doc) => {
	const fresh = O.computeAllRuns(doc);
	for (const [id, runs] of fresh) {
		expect(view.runs(id), `runs(${id})`).toEqual([...runs]);
	}
};

const projectContent = (doc, id) => {
	const stack = [...M.project(doc).children];
	while (stack.length) {
		const b = stack.pop();
		if (b.id === id) return b.content;
		stack.push(...b.children);
	}
	return undefined;
};

describe('run view — basic equivalence', () => {
	it('runs() equals the fresh projection and M.project content on a seeded doc', () => {
		const set = createPeerPair(RICH_SEED);
		const doc = set.A.doc;
		const view = R.attach(doc);
		expectRunsFresh(view, doc, 'a');
		expectRunsFresh(view, doc, 'b');
		expectRunsFresh(view, doc, 'c');
		expectRunsFresh(view, doc, 'c1');
		// Cross-check against the production projection path too.
		expect(view.runs('a')).toEqual(projectContent(doc, 'a'));
		// Inline atoms project as {kind:'inline',id,type,data}.
		const b = view.runs('b');
		expect(b[1]).toEqual({ kind: 'inline', id: 'm1', type: 'mention', data: { user: 'sam' } });
		// Unknown ids project to the empty snapshot.
		expect(view.runs('nope')).toEqual([]);
	});

	it('marks objects are interned — equal mark sets share identity', () => {
		const seed = modelSpecSeed([
			{
				id: 'a',
				type: 'paragraph',
				content: [
					{ kind: 'text', text: 'x', marks: { bold: true } },
					{ kind: 'text', text: 'y', marks: { italic: true } },
					{ kind: 'text', text: 'z', marks: { bold: true } }
				]
			}
		]);
		const set = createPeerPair(seed);
		const view = R.attach(set.A.doc);
		const runs = view.runs('a');
		expect(runs[0].marks).toBe(runs[2].marks); // same interned object
		expect(runs[0].marks).not.toBe(runs[1].marks);
	});
});

describe('run view — invalidation granularity & identity', () => {
	it('editing block A recomputes only A — B keeps array AND run identity', () => {
		const set = createPeerPair(RICH_SEED);
		const doc = set.A.doc;
		const view = R.attach(doc);
		const aRuns = view.runs('a');
		const bRuns = view.runs('b');
		const cRuns = view.runs('c');
		view.debug.reset();
		set.A.transact(() => M.insertText(doc, 'a', 0, '!'));
		view.debug.reset(); // count only what re-reads trigger below
		expect(view.runs('b')).toBe(bRuns); // untouched — same array
		expect(view.runs('c')).toBe(cRuns);
		expect(view.debug.recomputed.has('a')).toBe(false); // lazy: not yet re-read
		const fresh = O.computeAllRuns(doc).get('a');
		expect(view.runs('a')).toEqual([...fresh]);
		expect(view.debug.recomputes).toBe(1); // only A recomputed
	});

	it('a format edit in the middle keeps prefix/suffix run identity', () => {
		const set = createPeerPair(RICH_SEED);
		const doc = set.A.doc;
		const view = R.attach(doc);
		const before = view.runs('a'); // [bold 'alpha ', plain 'plain ', b+i 'omega']
		// Underline 'plain ' — a new mark set, so runs stay three.
		set.A.transact(() => M.setMark(doc, 'a', 6, 6, 'underline', true));
		const after = view.runs('a');
		expect(after.length).toBe(3);
		expect(after[0]).toBe(before[0]); // prefix run reused
		expect(after[1]).not.toBe(before[1]); // edited window rebuilt
		expect(after[1].text).toBe('plain ');
		expect(after[1].marks).toEqual({ underline: true });
		expect(after[2]).toBe(before[2]); // suffix run reused verbatim
	});

	it('a format edit that equalizes marks merges the runs canonically', () => {
		const set = createPeerPair(RICH_SEED);
		const doc = set.A.doc;
		const view = R.attach(doc);
		const before = view.runs('a');
		// Bold 'plain ' → runs 0+1 now share {bold:true} and merge.
		set.A.transact(() => M.setMark(doc, 'a', 6, 6, 'bold', true));
		const after = view.runs('a');
		expect(after.length).toBe(2);
		expect(after[0].text).toBe('alpha plain ');
		expect(after[0].marks).toBe(before[0].marks); // interned {bold:true}
		expect(after[1]).toBe(before[2]); // 'omega' suffix reused
	});

	it('a MOVE does not invalidate runs at all (at-facet ignored)', () => {
		const set = createPeerPair(RICH_SEED);
		const doc = set.A.doc;
		const view = R.attach(doc);
		const aRuns = view.runs('a');
		const c1Runs = view.runs('c1');
		view.debug.reset();
		set.A.transact(() => M.moveBlock(doc, 'a', { parent: null, index: 2 }));
		expect(view.debug.recomputes).toBe(0);
		expect(view.runs('a')).toBe(aRuns);
		set.A.transact(() => M.nestBlock(doc, 'b', 'c'));
		expect(view.debug.recomputes).toBe(0);
		expect(view.runs('c1')).toBe(c1Runs);
	});

	it('merged-away blocks project to []; the owner shows the claimed runs', () => {
		const set = createPeerPair(RICH_SEED);
		const doc = set.A.doc;
		const view = R.attach(doc);
		view.runs('b');
		set.A.transact(() => M.mergeBlocks(doc, 'b', 'a'));
		expect(view.runs('b')).toEqual([]);
		const a = view.runs('a');
		const flat = a.map((r) => (r.kind === 'text' ? r.text : '�')).join('');
		expect(flat).toContain('beta');
		expectRunsFresh(view, doc, 'a');
	});

	it('split re-routes runs: sibling shows tail, head shows head — both equal fresh', () => {
		const set = createPeerPair(RICH_SEED);
		const doc = set.A.doc;
		const view = R.attach(doc);
		view.runs('b');
		set.A.transact(() => M.splitBlock(doc, 'b', 5, 'b-tail'));
		expectRunsFresh(view, doc, 'b');
		expectRunsFresh(view, doc, 'b-tail');
		expect(view.runs('b-tail').map((r) => (r.kind === 'inline' ? r.id : r.text))).toEqual([
			'm1',
			' tail'
		]);
	});
});

describe('run view — fresh equivalence through edits (local, remote, undo)', () => {
	it('stays equal to fresh after every kind of local edit', () => {
		const set = createPeerPair(RICH_SEED);
		const doc = set.A.doc;
		const view = R.attach(doc);
		expectAllFresh(view, doc);
		set.A.transact(() => M.insertText(doc, 'a', 3, 'XX'));
		expectAllFresh(view, doc);
		set.A.transact(() => M.setMark(doc, 'a', 0, 4, 'underline', true));
		expectAllFresh(view, doc);
		set.A.transact(() => M.deleteText(doc, 'b', 0, 2));
		expectAllFresh(view, doc);
		set.A.transact(() =>
			M.insertInline(doc, 'b', 1, { id: 'm2', type: 'mention', data: { user: 'bo' } })
		);
		expectAllFresh(view, doc);
		set.A.transact(() => M.splitBlock(doc, 'a', 4, 'a2'));
		expectAllFresh(view, doc);
		set.A.transact(() => M.mergeBlocks(doc, 'a2', 'a'));
		expectAllFresh(view, doc);
		set.A.transact(() => M.deleteBlock(doc, 'b'));
		expectAllFresh(view, doc);
	});

	it('stays equal to fresh after REMOTE update application', () => {
		const set = createPeerPair(RICH_SEED);
		const viewB = R.attach(set.B.doc);
		expectAllFresh(viewB, set.B.doc);
		set.A.transact(() => M.insertText(set.A.doc, 'a', 0, '>>'));
		set.deliver('A', 'B');
		expectAllFresh(viewB, set.B.doc);
		set.A.transact(() => M.splitBlock(set.A.doc, 'b', 3, 'b2'));
		set.deliver('A', 'B');
		expectAllFresh(viewB, set.B.doc);
	});

	it('a remote delete invalidates the claim loser whose stale interval no longer overlaps the post-delete gap span', () => {
		// Regression for the collab-DST divergence: 'b' claims the tail of a
		// shared backing text and caches its runs. A single remote commit then
		// tombstones the head AND middle atoms — every deleted item resolves to
		// a post-delete gap near position 0, so the narrowed extent cannot
		// intersect b's stale ownership interval [4, 11) — without the delete→
		// opaque fallback, b's cached runs would survive unchanged.
		const set = createPeerPair(
			modelSpecSeed([
				{
					id: 'a',
					type: 'paragraph',
					content: [{ kind: 'text', text: 'tail' }]
				}
			])
		);
		// Type 'headXYZ' atom-by-atom across BOTH peers — contiguous same-client
		// inserts would merge into one item whose deleted span [0,7) still
		// intersects the stale interval. Alternating clients keeps each atom a
		// separate item, so every tombstone resolves to a distinct ~[0,1)
		// post-delete gap (exactly the char-typed DST shape).
		for (const [i, ch] of [...'headXYZ'].entries()) {
			const side = i % 2 === 0 ? 'A' : 'B';
			set[side].transact(() => M.insertText(set[side].doc, 'a', i, ch));
			set.deliver('A', 'B');
			set.deliver('B', 'A');
		}
		set.A.transact(() => M.splitBlock(set.A.doc, 'a', 4, 'b')); // b claims 'XYZtail'
		set.deliver('A', 'B');
		const viewB = R.attach(set.B.doc);
		expect(
			viewB
				.runs('b')
				.map((r) => r.text)
				.join('')
		).toBe('XYZtail');
		// Tombstone ALL of 'headXYZtail' directly on the backing text — exactly
		// what a remote update carries (item deletes, no slices-record rewrite;
		// going through `M.deleteText` would re-anchor b's claim records and
		// mask the bug via the structure facet). Post-delete b's claim resolves
		// to an empty range — no fresh interval — so only the stale-interval
		// check could catch it, and every deleted span sits at [0,1).
		set.A.transact(() => {
			const content = set.A.doc.get('blocks').getAttr('a').getAttr('content');
			content.delete(0, content.length);
		});
		set.deliver('A', 'B');
		expect(
			viewB
				.runs('b')
				.map((r) => r.text)
				.join('')
		).toBe('');
		expectRunsFresh(viewB, set.B.doc, 'b');
	});

	it('stays equal to fresh after undo/redo', () => {
		const set = createPeerPair(RICH_SEED);
		const doc = set.A.doc;
		const view = R.attach(doc);
		const um = set.A.enableUndo({ scope: doc });
		set.A.transact(() => M.insertText(doc, 'a', 0, 'QQ'));
		set.A.transact(() => M.splitBlock(doc, 'a', 2, 'a2'));
		expectAllFresh(view, doc);
		um.undo(); // undo the split
		expectAllFresh(view, doc);
		um.undo(); // undo the insert
		expectAllFresh(view, doc);
		um.redo();
		expectAllFresh(view, doc);
	});
});

describe('run view — stale-cache fuzz (equivalence after every op)', () => {
	it('random op sequence: maintained runs equal fresh after EVERY step', () => {
		const rng = mulberry32(0x5eed);
		const set = createPeerPair(MODEL_BASE_SEED);
		const doc = set.A.doc;
		const view = R.attach(doc);
		let splits = 0;
		for (let step = 0; step < 120; step++) {
			const ids = M.listBlockIds(doc);
			if (ids.length === 0) break;
			const id = pick(rng, ids);
			const kind = int(rng, 0, 9);
			const len = M.blockText(doc, id)?.length ?? 0;
			switch (kind) {
				case 0:
					set.A.transact(() => M.insertText(doc, id, int(rng, 0, len), 'x'));
					break;
				case 1:
					if (len > 0) set.A.transact(() => M.deleteText(doc, id, int(rng, 0, len - 1), 1));
					break;
				case 2:
					if (len > 0)
						set.A.transact(() => M.setMark(doc, id, int(rng, 0, len - 1), 1, 'bold', true));
					break;
				case 3:
					if (len > 0) set.A.transact(() => M.unsetMark(doc, id, int(rng, 0, len - 1), 1, 'bold'));
					break;
				case 4:
					set.A.transact(() =>
						M.insertInline(doc, id, int(rng, 0, len), { id: `i${step}`, type: 'mention' })
					);
					break;
				case 5:
					if (len > 0)
						set.A.transact(() => M.splitBlock(doc, id, int(rng, 0, len), `s${splits++}`));
					break;
				case 6: {
					const other = pick(rng, ids);
					if (other !== id) set.A.transact(() => M.mergeBlocks(doc, id, other));
					break;
				}
				case 7:
					set.A.transact(() =>
						M.moveBlock(doc, id, { parent: null, index: int(rng, 0, ids.length) })
					);
					break;
				case 8:
					set.A.transact(() => M.deleteBlock(doc, id));
					break;
				case 9:
					set.A.transact(() =>
						M.insertBlock(
							doc,
							{ parent: null, index: ids.length },
							{
								id: `n${step}`,
								type: 'paragraph',
								content: [{ kind: 'text', text: `new ${step}` }]
							}
						)
					);
					break;
			}
			// The invariant: maintained view == fresh projection, every step.
			expectAllFresh(view, doc);
		}
	});
});

describe('run view — snapshot isolation & export', () => {
	it('snapshots are frozen at every level; consumer mutation cannot corrupt the view', () => {
		const set = createPeerPair(RICH_SEED);
		const doc = set.A.doc;
		const view = R.attach(doc);
		const runs = view.runs('b');
		expect(Object.isFrozen(runs)).toBe(true);
		expect(Object.isFrozen(runs[0])).toBe(true);
		const inlineRun = runs.find((r) => r.kind === 'inline');
		expect(Object.isFrozen(inlineRun.data)).toBe(true);
		const markedRuns = view.runs('a');
		expect(Object.isFrozen(markedRuns[0].marks)).toBe(true);
	});

	it('contentJSON exports the public {text, marks?}/{id,type,data?} shape', () => {
		const set = createPeerPair(RICH_SEED);
		const doc = set.A.doc;
		const view = R.attach(doc);
		expect(view.contentJSON('a')).toEqual([
			{ text: 'alpha ', marks: { bold: true } },
			{ text: 'plain ' },
			{ text: 'omega', marks: { bold: true, italic: true } }
		]);
		expect(view.contentJSON('b')).toEqual([
			{ text: 'beta ' },
			{ id: 'm1', type: 'mention', data: { user: 'sam' } },
			{ text: ' tail' }
		]);
		// Exported marks/data are owned copies — mutating them is harmless.
		const out = view.contentJSON('b');
		out[1].data.user = 'x';
		expect(view.runs('b')[1].data.user).toBe('sam');
	});

	it('pure read path: runs()/contentJSON work without any subscription', () => {
		const set = createPeerPair(RICH_SEED);
		const doc = set.A.doc;
		const view = R.attach(doc);
		// No subscribe at all — reads must still be correct and fresh.
		set.A.transact(() => M.insertText(doc, 'a', 0, '#'));
		// The unmarked '#' lands before bold 'alpha ' — its own run.
		expect(view.contentJSON('a')[0]).toEqual({ text: '#' });
		expect(
			view
				.contentJSON('a')
				.map((r) => r.text)
				.join('')
		).toBe('#alpha plain omega');
		expectRunsFresh(view, doc, 'a');
	});
});

describe('run view — reactivity', () => {
	it('version() bumps per observed transaction', () => {
		const set = createPeerPair(RICH_SEED);
		const doc = set.A.doc;
		const view = R.attach(doc);
		const v0 = view.version();
		set.A.transact(() => M.insertText(doc, 'a', 0, '1'));
		const v1 = view.version();
		expect(v1).toBe(v0 + 1);
		set.A.transact(() => M.insertText(doc, 'a', 0, '2'));
		set.A.transact(() => M.moveBlock(doc, 'a', { parent: null, index: 3 }));
		expect(view.version()).toBe(v1 + 2); // moves count as observed changes
	});

	it('only a real content change replaces a block run array', () => {
		const set = createPeerPair(RICH_SEED);
		const doc = set.A.doc;
		const view = R.attach(doc);
		const a0 = view.runs('a');
		const b0 = view.runs('b');
		set.A.transact(() => M.insertText(doc, 'b', 0, '!')); // edit B, not A
		expect(view.runs('a')).toBe(a0); // A untouched
		expect(view.runs('b')).not.toBe(b0);
		set.A.transact(() => M.insertText(doc, 'a', 0, '!'));
		expect(view.runs('a')).not.toBe(a0);
		expect(view.runs('a')[0].text).toBe('!'); // unmarked insert is its own run
	});
});
