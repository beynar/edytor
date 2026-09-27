/**
 * Gate-F2 probes — WU7 shared model state adversarial cases NOT covered by
 * `src/tests/crdt/runs/shared-state.test.ts`:
 *
 * 1. SHARED BACKING: after `mergeBlocks(b, a)` block `a` displays b's
 *    backing text through the claim. An edit into the claimed region
 *    (through `a`'s display coordinates — ops on hidden `b` are refused,
 *    placement/model.ts:904-921) must invalidate `a`'s runs — the
 *    flatten-dep fanout `textConsumers['b'] ∋ a` (runs.ts:1118).
 * 2. MERGE CHAIN c→b→a staged by merge order (merging INTO a hidden block
 *    is refused): `a` displays all three texts; edits through `a`'s
 *    coordinates landing in the MIDDLE (text b) and BOTTOM (text c) must
 *    reach `a`'s maintained runs.
 * 3. REMOTE WRITES TO A LOCALLY-HIDDEN BLOCK: the strongest fanout case —
 *    B edits text b / appends a claim to b's slices while b is hidden on
 *    A; on delivery A's maintained view must reflect it through the claim.
 * 4. commitFast×5 THEN STRUCTURAL: five consecutive content-only commits
 *    patch the DocChange skeleton; a following structural commit's full
 *    diff must not be corrupted by accumulated skeleton drift — and a fast
 *    commit AFTER the structural one must still patch correctly.
 * 5. LIFECYCLE + MID-TRANSACTION read-your-writes.
 */
// @ts-nocheck -- vendored upstream source is plain JS; checked structurally, not via types.
import { describe, expect, it } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { bindRunsOracle } from '../../oracles/runs.js';
import { bindEdytorDoc, bindRuns } from '../../../lib/crdt/index.js';
import { bindModel } from '../../oracles/model-ops.js';
import { createPeerPair } from '../harness/peer-set.js';
import { modelSpecSeed } from '../scenarios/seeds.js';

const E = bindEdytorDoc(Y);
const R = bindRuns(Y);
const O = bindRunsOracle(Y);
const M = bindModel(Y);

const SEED = modelSpecSeed([
	{ id: 'a', type: 'paragraph', content: [{ kind: 'text', text: 'alpha' }] },
	{ id: 'b', type: 'paragraph', content: [{ kind: 'text', text: 'beta' }] },
	{ id: 'c', type: 'paragraph', content: [{ kind: 'text', text: 'gamma' }] },
	{ id: 'd', type: 'list', content: [{ kind: 'text', text: 'parent' }] }
]);

const flat = (runs) => runs.map((r) => (r.kind === 'text' ? r.text : '�')).join('');

describe('gateF2/WU7 — shared backing + merge-chain invalidation', () => {
	it('edit through a into b-claimed atoms invalidates a (textConsumers fanout)', () => {
		const set = createPeerPair(SEED);
		const doc = set.A.doc;
		set.A.transact(() => M.mergeBlocks(doc, 'b', 'a'));
		const view = R.attach(doc);
		expect(flat(view.runs('a'))).toBe('alphabeta');
		// Ops on hidden b are refused — the write enters through a's display
		// coords; offset 5 is the seam where the b-claim begins (text b pos 0).
		expect(M.insertText(doc, 'b', 0, '>>')).toBe(false); // hidden: refused
		set.A.transact(() => M.insertText(doc, 'a', 5, '>>'));
		// a consulted text b during flatten — the write into text b must have
		// invalidated a's cache through textConsumers['b'].
		expect(flat(view.runs('a'))).toBe('alpha>>beta');
		expect(view.runs('a')).toEqual([...O.computeAllRuns(doc).get('a')]);
		// The commit must report a as content-touched (the fanout), not just b.
		expect(view.commitInfo().content.has('a')).toBe(true);
		view.dispose();
	});

	it('merge chain c→b→a: edits landing in middle and bottom texts reach the top', () => {
		const set = createPeerPair(SEED);
		const doc = set.A.doc;
		// c claims into b while b is still visible; then b claims into a —
		// a's flatten walks a→{m:b}→b's list→{m:c}→c's records transitively.
		set.A.transact(() => M.mergeBlocks(doc, 'c', 'b'));
		set.A.transact(() => M.mergeBlocks(doc, 'b', 'a'));
		const view = R.attach(doc);
		expect(flat(view.runs('a'))).toBe('alphabetagamma');
		// Edit into the MIDDLE of the chain (text b): offset 7 is inside
		// 'beta' (a's display 'alpha|beta|gamma', b-seg at 5..9).
		set.A.transact(() => M.insertText(doc, 'a', 7, '!'));
		expect(flat(view.runs('a'))).toBe('alphabe!tagamma');
		// Edit at the BOTTOM (text c): offset 12 inside 'gamma' (9..14).
		set.A.transact(() => M.insertText(doc, 'a', 12, '<<'));
		expect(flat(view.runs('a'))).toBe('alphabe!taga<<mma');
		expect(view.runs('a')).toEqual([...O.computeAllRuns(doc).get('a')]);
		view.dispose();
	});

	it('REMOTE edit to a locally-hidden backing text fans out through the claim', () => {
		const set = createPeerPair(SEED);
		const docA = set.A.doc;
		// A merges b→a locally — b hidden on A. NOT delivered to B yet.
		set.A.transact(() => M.mergeBlocks(docA, 'b', 'a'));
		const view = R.attach(docA);
		view.runs('a'); // prime caches + dep tables
		// B still sees b visible: edits text b directly, then delivers.
		set.B.transact(() => M.insertText(set.B.doc, 'b', 0, 'REMOTE-'));
		set.deliver('B', 'A');
		// The remote write to hidden-b's text must invalidate a on A.
		expect(flat(view.runs('a'))).toBe('alphaREMOTE-beta');
		expect(view.runs('a')).toEqual([...O.computeAllRuns(docA).get('a')]);
		expect(view.commitInfo().content.has('a')).toBe(true);
		view.dispose();
	});

	it('REMOTE claim appended to a locally-hidden list extends the chain', () => {
		const set = createPeerPair(SEED);
		const docA = set.A.doc;
		set.A.transact(() => M.mergeBlocks(docA, 'b', 'a'));
		const view = R.attach(docA);
		expect(flat(view.runs('a'))).toBe('alphabeta');
		// B (b still visible there) merges d into b — writes {m:d} onto b's
		// slices list — while b is hidden on A. On delivery, a's flatten
		// walks a→{m:b}→[b-recs,{m:d}]→d's records: a must gain d's atoms.
		set.B.transact(() => M.mergeBlocks(set.B.doc, 'd', 'b'));
		set.deliver('B', 'A');
		expect(flat(view.runs('a'))).toBe('alphabetaparent');
		expect(view.runs('a')).toEqual([...O.computeAllRuns(docA).get('a')]);
		// The slices-list write is structural: not a fast commit.
		expect(view.commitInfo().fast).toBe(false);
		view.dispose();
	});
});

describe('gateF2/WU7 — commitFast streak then structural', () => {
	it('five fast commits + structural + fast commit keep DocChange complete', () => {
		const set = createPeerPair(SEED);
		const doc = set.A.doc;
		const ed = E.create(doc);
		const changes = [];
		ed.onChange((c) => changes.push(c));
		// 5 consecutive fast (content-only) commits — each patches the skeleton.
		for (let i = 0; i < 5; i++) ed.insertText('a', i, `x${i}`);
		expect(changes.length).toBe(5);
		for (const c of changes) {
			expect([...c.content.keys()]).toEqual(['a']);
			expect(c.meta.size).toBe(0);
			expect(c.added.size + c.removed.size + c.moved.size + c.order.size).toBe(0);
		}
		// 'x0'@0,'x1'@1,'x2'@2,'x3'@3,'x4'@4 → each 2-char insert at offset i.
		expect(ed.blockText('a')).toBe('xxxxx43210alpha');
		// Structural commit — fullDiff against the patched skeleton. If the
		// skeleton drifted, `moved`/`order`/`removed` will be wrong or missing.
		ed.moveBlock('a', { parent: 'd', index: 0 });
		const mv = changes[5];
		expect(mv.moved.has('a')).toBe(true);
		expect(mv.order.get('d')).toEqual(['a']);
		expect(mv.order.get(null)).toEqual(['b', 'c', 'd']);
		expect(mv.content.size).toBe(0);
		// A fast commit AFTER the structural one on the MOVED block — the
		// skeleton must still be tracking `a` at its new placement.
		ed.insertText('a', 0, '>>');
		const post = changes[6];
		expect([...post.content.keys()]).toEqual(['a']);
		expect(ed.blockText('a')).toBe('>>xxxxx43210alpha');
		// Meta on another block — skeleton meta fields must not be stale.
		ed.setBlockData('b', { v: 1 });
		expect([...changes[7].meta.keys()]).toEqual(['b']);
		// Structural removal — covered-by-parent semantics: deleting d
		// removes a too (a's parent is d) but only the ROOT `d` is reported.
		ed.deleteBlock('d');
		const rm = changes[8];
		expect([...rm.removed].sort()).toEqual(['d']); // 'a' covered by its parent d
		expect(rm.order.get(null)).toEqual(['b', 'c']);
		// Final fast commit still works on the survivors.
		ed.insertText('c', 0, '?');
		expect([...changes[9].content.keys()]).toEqual(['c']);
		ed.dispose();
	});

	it('mixed fast/structural interleave: every DocChange reflects the fresh projection', () => {
		const set = createPeerPair(SEED);
		const doc = set.A.doc;
		const ed = E.create(doc);
		const changes = [];
		ed.onChange((c) => changes.push(c));
		ed.insertText('a', 0, '1');
		ed.splitBlock('a', 3, 'a2');
		ed.insertText('a2', 0, '2');
		ed.deleteBlock('b');
		ed.insertText('c', 0, '3');
		expect(changes.length).toBe(5);
		expect([...changes[0].content.keys()]).toEqual(['a']);
		expect(changes[1].added.has('a2')).toBe(true);
		expect([...changes[2].content.keys()]).toEqual(['a2']);
		expect(changes[3].removed.has('b')).toBe(true);
		expect([...changes[4].content.keys()]).toEqual(['c']);
		expect(ed.project().children.map((k) => k.id)).toEqual(['a', 'a2', 'c', 'd']);
		ed.dispose();
	});
});

describe('gateF2/WU7 — lifecycle: detach/reattach/destroy/subscriptions', () => {
	it('released subscriptions never fire; reattach serves a fresh correct view', () => {
		const set = createPeerPair(SEED);
		const doc = set.A.doc;
		const v1 = R.attach(doc);
		let fired = 0;
		const unsub = v1.subscribe(() => fired++);
		set.A.transact(() => M.insertText(doc, 'a', 0, 'x'));
		expect(fired).toBe(1);
		v1.dispose();
		set.A.transact(() => M.insertText(doc, 'a', 0, 'y'));
		// The last lease is gone — the observer detached; no more events.
		expect(fired).toBe(1);
		expect(R.modelState(doc)).toBeUndefined();
		unsub(); // release after teardown must be a no-op, never throws
		// Reattach — fresh state, correct reads (no stale view after remount).
		const v2 = R.attach(doc);
		expect(flat(v2.runs('a'))).toBe('yxalpha');
		expect(v2.runs('a')).toEqual([...O.computeAllRuns(doc).get('a')]);
		set.A.transact(() => M.insertText(doc, 'a', 0, 'z'));
		expect(fired).toBe(1); // still dead — v1's sub is gone
		expect(flat(v2.runs('a'))).toBe('zyxalpha');
		v2.dispose();
	});

	it('doc.destroy tears the shared view down; a later attach rebuilds', () => {
		const set = createPeerPair(SEED);
		const doc = set.A.doc;
		const v1 = R.attach(doc);
		v1.runs('a');
		doc.destroy();
		expect(R.modelState(doc)).toBeUndefined();
		const v2 = R.attach(doc);
		expect(flat(v2.runs('a'))).toBe('alpha');
		v2.dispose();
	});

	it('block-level subscriptions release exactly once and only for the right block', () => {
		const set = createPeerPair(SEED);
		const doc = set.A.doc;
		const v = R.attach(doc);
		const seen = [];
		const unsubA = v.subscribeBlock('a', (runs) => seen.push(flat(runs)));
		v.subscribeBlock('b', (runs) => seen.push('b:' + flat(runs)));
		set.A.transact(() => M.insertText(doc, 'a', 0, 'x'));
		expect(seen).toEqual(['xalpha']);
		unsubA();
		unsubA(); // idempotent
		set.A.transact(() => M.insertText(doc, 'a', 0, 'y'));
		set.A.transact(() => M.insertText(doc, 'b', 0, 'z'));
		// a's sub is gone (once only), b's still live.
		expect(seen).toEqual(['xalpha', 'b:zbeta']);
		v.dispose();
	});
});

describe('gateF2/WU7 — mid-transaction read-your-writes (fast-eligible writes)', () => {
	it('content+meta writes inside one transaction are readable before commit', () => {
		const set = createPeerPair(SEED);
		const doc = set.A.doc;
		const view = R.attach(doc);
		doc.transact(() => {
			M.insertText(doc, 'a', 0, 'IN-TX');
			expect(flat(view.runs('a'))).toBe('IN-TXalpha');
			const node = doc.get('blocks').getAttr('a');
			node.setAttr('data', { t: 9 });
			expect(view.modelCtx().blocks.get('a').data).toEqual({ t: 9 });
			// The same transaction's slices churn must also be visible.
			M.splitBlock(doc, 'b', 2, 'b2');
			expect(flat(view.runs('b'))).toBe('be');
			expect(flat(view.runs('b2'))).toBe('ta');
		});
		view.dispose();
	});
});
