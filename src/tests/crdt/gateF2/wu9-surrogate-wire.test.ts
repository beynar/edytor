/**
 * Gate-F2 probe — unpaired-surrogate wire normalization (F2-M1, FIXED).
 *
 * Mechanism (verified): an item whose `ContentString` contains a lone
 * UTF-16 surrogate keeps it in the producing replica's store verbatim,
 * but `encodeStateAsUpdate` writes strings through UTF-8 encoding, which
 * maps every unpaired surrogate to U+FFFD (EF BF BD). The receiving
 * replica therefore stores a DIFFERENT string for the same item id —
 * a permanent content divergence that no later delivery repairs.
 *
 * Fix (facade boundary, vendored engine untouched): every public
 * text-ingress path normalizes caller-supplied strings to well-formed
 * UTF-16 before they enter replicated state —
 * `sanitizeWireString`/`sanitizeWireJson` in `src/lib/utils/json.ts`:
 *
 * - `insertText`/`setBlock` content (`T.insertIntoText` payload + marks)
 * - `insertBlock`/`insertSubtree`/`E.init` specs (`M.insertBlock` →
 *   `sanitizeSpec`, including inline atoms via `buildInline`)
 * - `insertInline`/`setInlineData`, `setBlockType`/`setBlockData`,
 *   `formatRange`/`setMark`, `splitBlock` newId
 * - migration materialization (`sanitizeWireJson(json)` in migrate.ts)
 *
 * The raw-engine probe below is retained as boundary documentation: the
 * vendored engine still stores verbatim what it is handed, which is
 * exactly why normalization lives at the facade — raw `applyDelta`
 * writes on user-facing types are outside the supported contract.
 */
// @ts-nocheck -- vendored upstream source is plain JS; checked structurally, not via types.
import { describe, expect, it } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { bindEdytorDoc } from '../../../lib/crdt/index.js';
import { bindModel } from '../../oracles/model-ops.js';
import { createPeerPair, type Peer } from '../harness/peer-set.js';
import { modelSpecSeed } from '../scenarios/seeds.js';
import { assertConverged } from '../harness/assert/convergence.js';
import { createDocOps } from '../harness/ops/doc-ops.js';
import * as delta from 'lib0-v14/delta';

const E = bindEdytorDoc(Y);
const M = bindModel(Y);
const ops = createDocOps();

const facades = new WeakMap<InstanceType<typeof Y.Doc>, ReturnType<typeof E.create>>();
const ed = (peer: Peer) => {
	let f = facades.get(peer.doc);
	if (!f) {
		f = E.create(peer.doc);
		facades.set(peer.doc, f);
	}
	return f;
};

/** A lone HIGH surrogate — ill-formed UTF-16. */
const HI = String.fromCharCode(0xd83d);
/** A lone LOW surrogate — ill-formed UTF-16. */
const LO = String.fromCharCode(0xde80);

/** Every live ContentString in sequence order — the store's ground truth. */
const allItemStrs = (text) => {
	const out = [];
	for (let it = text._start; it !== null; it = it.right) {
		if (!it.deleted && it.content?.str !== undefined) out.push(it.content.str);
	}
	return out;
};

/** Live ContentString entries of a block's backing text node. */
const blockItemStrs = (doc, id) => {
	const node = M.blockNodeOf(doc, id);
	const content = node?.getAttr('content');
	return content ? allItemStrs(content) : [];
};

const seedBlock = (id = 'p', text = 'ab🚀cd') =>
	modelSpecSeed([{ id, type: 'paragraph', content: [{ kind: 'text', text }] }]);

describe('gateF2 — unpaired-surrogate wire normalization (F2-M1)', () => {
	it('engine level (documented boundary): raw applyDelta stores verbatim, wire maps to �', () => {
		// The vendored engine is deliberately unpatched: it stores what it is
		// handed and its encoder still rewrites unpaired surrogates on the
		// wire. This raw path is below the facade contract — it exists here
		// as proof of WHERE the normalization boundary sits and why it must
		// exist. Facade-level writes never reach the store unnormalized.
		const a = new Y.Doc();
		a.clientID = 1;
		const ta = a.get('t');
		a.transact(() => ta.applyDelta(delta.create().insert(`x${HI}y`)));
		const update = Y.encodeStateAsUpdate(a);
		const b = new Y.Doc();
		b.clientID = 2;
		Y.applyUpdate(b, update);
		const tb = b.get('t');
		expect(allItemStrs(ta)).toEqual([`x${HI}y`]); // verbatim locally
		expect(allItemStrs(tb)).toEqual(['x�y']); // U+FFFD over the wire
	});

	it('facade insertText: a lone-surrogate payload is stored normalized and converges', () => {
		const set = createPeerPair(seedBlock('p', 'ab'));
		const { A, B } = set;
		ops.insertText(A, 'p', 1, `x${HI}y${LO}`);
		// Local store holds exactly what the wire carries — no silent loss:
		// both unpaired surrogates became U+FFFD BEFORE reaching the store.
		expect(blockItemStrs(A.doc, 'p')).toContain('x�y�');
		set.deliver('A', 'B');
		assertConverged(set, ops, 'post-insertText');
	});

	it('facade E.init: spec text normalizes at ingress', () => {
		const a = new Y.Doc();
		a.clientID = 1;
		E.init(a, {
			content: [
				{
					id: 'b1',
					type: 'paragraph',
					content: [{ kind: 'text', text: `seed ${HI} text` }]
				}
			]
		});
		// Local store holds the normalized form, not the raw payload.
		expect(blockItemStrs(a, 'b1')).toEqual(['seed � text']);
		const update = Y.encodeStateAsUpdate(a);
		const b = new Y.Doc();
		b.clientID = 2;
		Y.applyUpdate(b, update);
		expect(JSON.stringify(E.create(b).project())).toBe(JSON.stringify(E.create(a).project()));
	});

	it('facade insertBlock: spec text/marks/data/inline ids normalize at ingress', () => {
		const set = createPeerPair(seedBlock('p', 'ab'));
		const { A, B } = set;
		ops.insertBlock(
			A,
			{ parent: null, index: 1 },
			{
				id: 'q',
				type: 'paragraph',
				data: { note: `da${LO}ta` },
				content: [
					{ kind: 'text', text: `lo${HI}ne`, marks: { [`we${HI}ird`]: `va${LO}l` } },
					{ kind: 'inline', id: `in${HI}l`, type: 'mention', data: { who: `u${LO}` } }
				]
			}
		);
		expect(blockItemStrs(A.doc, 'q')).toContain('lo�ne');
		set.deliver('A', 'B');
		assertConverged(set, ops, 'post-insertBlock');
	});

	it('facade setBlock content: replacement text normalizes at ingress', () => {
		const set = createPeerPair(seedBlock('p', 'keep'));
		const { A, B } = set;
		A.transact(() =>
			ed(A).setBlock('p', {
				content: [{ kind: 'text', text: `re${LO}placed` }]
			})
		);
		expect(blockItemStrs(A.doc, 'p')).toContain('re�placed');
		set.deliver('A', 'B');
		assertConverged(set, ops, 'post-setBlock');
	});

	it('facade setBlockType/setBlockData/setMark normalize at ingress', () => {
		const set = createPeerPair(seedBlock('p', 'ab'));
		const { A, B } = set;
		A.transact(() => {
			ed(A).setBlockType('p', `he${HI}ding`);
			ed(A).setBlockData('p', { note: `da${LO}ta` });
			ops.setMark(A, 'p', 0, 2, `bo${HI}d`, true);
		});
		set.deliver('A', 'B');
		assertConverged(set, ops, 'post-meta-writes');
	});

	it('facade insertText inside a surrogate pair converges on delivery', () => {
		const set = createPeerPair(seedBlock());
		const { A, B } = set;
		// Insert at offset 3 — inside the 🚀 (a b \uD83D | \uDE80 c d). The
		// item splits at the insertion and ContentString.splice replaces the
		// exposed edge surrogates with U+FFFD, so both replicas store the
		// same well-formed halves.
		ops.insertText(A, 'p', 3, 'Z');
		set.deliver('A', 'B');
		const projA = JSON.stringify(ed(A).project());
		const projB = JSON.stringify(ed(B).project());
		expect(projB, 'projections must agree after delivery').toBe(projA);
	});

	it('facade level (control): a mid-pair splitBlock does NOT diverge', () => {
		const set = createPeerPair(seedBlock());
		const { A, B } = set;
		ops.splitBlock(A, 'p', 3, 'q');
		set.deliver('A', 'B');
		// Anchored ranges read the same backing item — identical projections.
		expect(JSON.stringify(ed(B).project())).toBe(JSON.stringify(ed(A).project()));
	});

	it('valid surrogate pairs pass through the boundary untouched', () => {
		const set = createPeerPair(seedBlock('p', 'ab'));
		const { A, B } = set;
		ops.insertText(A, 'p', 2, '🚀🌟');
		// Well-formed input is stored verbatim — normalization is lossless.
		expect(blockItemStrs(A.doc, 'p').join('')).toBe('ab🚀🌟');
		set.deliver('A', 'B');
		assertConverged(set, ops, 'post-pair-insert');
	});

	it('documented mitigation: pre-sanitized content converges (control)', () => {
		const a = new Y.Doc();
		a.clientID = 1;
		const ta = a.get('t');
		// U+FFFD instead of a lone surrogate — wire-stable.
		a.transact(() => ta.applyDelta(delta.create().insert('x�y')));
		const update = Y.encodeStateAsUpdate(a);
		const b = new Y.Doc();
		b.clientID = 2;
		Y.applyUpdate(b, update);
		expect(allItemStrs(b.get('t'))).toEqual(allItemStrs(ta));
	});
});
