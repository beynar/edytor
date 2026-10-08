/**
 * arch-v2 D11 → D12 — stream boundaries (plan §2.1, R2; §9.3 D11/D12 rows).
 * Written against the D11 spike; since D12 the spike is the implementation and
 * these rows run on the production model (`createModelOps`) and index.
 *
 * Rows (expected results from the plan's contracts, never from running code):
 * F-D13 (R2 property corpus, 4 replicas, concurrent-format generator, property
 * (e)), F-D14, F-D19, F-U3, F-U4a–e (also with an attribution renderer active
 * on every backing text — U-3), F-I7 (doc half), and the re-pins D-1/D-17 name
 * (TX06a = F-D14, TX09a, TX04a under three client assignments).
 *
 * Every multi-replica row runs both delivery orders, duplicate delivery, a
 * binary reload and at least three client-id assignments (plan §8).
 */
// @ts-nocheck -- drives the vendored engine JS directly (excluded lane).
import { describe, expect, it } from 'vitest';
import { createPeerSet } from '../harness/peer-set.js';
import { ContentMapRenderer, contentMapOfDoc } from '../harness/content-map-renderer.js';
import { createModelOps } from '../harness/ops/model-ops.js';
import * as S_ from '../harness/streams.js';
import { isBoundary } from '../../../lib/crdt/text/model.js';
import { modelSpecSeed } from '../scenarios/seeds.js';
import { assertAllStructurallyValid, assertConverged } from '../harness/assert/convergence.js';
import { bool, int, mulberry32, pick } from '../harness/rng.js';

/** Red on the D11 reference (no spike, no P7): `it.fails` in the tests-first commit (295b51b). */
const row = it;

const ops = createModelOps();
const S = () => ({ ...S_, view: S_.streamView });
const text = (p, id) => ops.blockText(p, id);
const runs = (p, id) => S_.runs(p.doc, id);

/** Client-id assignments per peer count (≥3 each; plan §8). */
const PERMS3 = [
	[5, 6, 7],
	[5, 7, 6],
	[6, 5, 7],
	[6, 7, 5],
	[7, 5, 6],
	[7, 6, 5]
];
const ASSIGN = {
	2: [
		[7, 3],
		[3, 7],
		[100, 50]
	],
	3: PERMS3,
	4: [
		[1, 2, 3, 4],
		[4, 3, 2, 1],
		[2, 4, 1, 3],
		[100, 70, 50, 30],
		[30, 100, 70, 50],
		[50, 30, 100, 70]
	]
};

const mkSet = (seed, ids) => {
	const set = createPeerSet(ids.length, seed);
	set.peers.forEach((p, i) => (p.doc.clientID = ids[i]));
	return set;
};
const settle = (set, ctx = '') => {
	set.deliverAll();
	set.syncAll();
	set.deliverAll();
	assertConverged(set, ops, ctx);
	assertAllStructurallyValid(set, ops, ctx);
};
/** Deliver every queue in `order` (peer names), each update twice (duplicates are idempotent). */
const deliverOrdered = (set, order) => {
	for (const from of order)
		for (const to of order) if (from !== to) set.deliver(from, to, { times: 2 });
};
const reloadAll = (set, verify) => {
	for (const p of set.peers) p.persist();
	for (const p of set.peers) p.reload('snapshot');
	assertConverged(set, ops, 'reload');
	assertAllStructurallyValid(set, ops, 'reload');
	verify(set);
};
/** Undo on `peer`, returning how many updates the undo emitted. */
const undoCounted = (peer) => {
	let n = 0;
	const h = () => n++;
	peer.doc.on('update', h);
	peer.undoManager.undo();
	peer.doc.off('update', h);
	return n;
};
/**
 * An attribution renderer that renders every deleted item (non-zero length) on every backing
 * text: every struct present at install time is attributed (the test port of the pruned
 * `AttributionsRenderer`, `harness/content-map-renderer.js`).
 */
const installRenderers = (set) => {
	for (const p of set.peers) {
		const r = new ContentMapRenderer(contentMapOfDoc(p.doc, 'x'));
		for (const [t] of S().view(p.doc).texts) t.useRenderer(r);
	}
};

const HELLO = modelSpecSeed([
	{ id: 'b', type: 'paragraph', content: [{ kind: 'text', text: 'hello world' }] }
]);

// ── F-D14 (TX06a re-pin), TX09a re-pin, TX04a ────────────────────────────

describe('F-D14 / D-1: a seam insert concurrent with a split lands by YATA order', () => {
	for (const [a, b] of ASSIGN[2]) {
		for (const order of [
			['A', 'B'],
			['B', 'A']
		]) {
			row(`A=${a} B=${b}, delivery ${order.join('→')}`, () => {
				const set = mkSet(HELLO, [a, b]);
				ops.splitBlock(set.A, 'b', 6, 's1');
				ops.insertText(set.B, 'b', 6, '|');
				deliverOrdered(set, order);
				settle(set);
				// Same origin and right origin: the lower client id goes left.
				const verify = (s) => {
					expect(text(s.A, 'b')).toBe(b < a ? 'hello |' : 'hello ');
					expect(text(s.A, 's1')).toBe(b < a ? 'world' : '|world');
				};
				verify(set);
				reloadAll(set, verify);
			});
		}
	}
});

describe('TX09a re-pin (D-1 class): typing into an empty block races its split at 0', () => {
	const EMPTY = modelSpecSeed([
		{ id: 'e1', type: 'paragraph' },
		{ id: 'e2', type: 'paragraph', content: [{ kind: 'text', text: 'x' }] }
	]);
	for (const [a, b] of ASSIGN[2]) {
		for (const order of [
			['A', 'B'],
			['B', 'A']
		]) {
			row(`A=${a} B=${b}, delivery ${order.join('→')}`, () => {
				const set = mkSet(EMPTY, [a, b]);
				ops.splitBlock(set.A, 'e1', 0, 'e1b');
				ops.insertText(set.B, 'e1', 0, 'z');
				deliverOrdered(set, order);
				settle(set);
				const verify = (s) => {
					expect(text(s.A, 'e1')).toBe(b < a ? 'z' : '');
					expect(text(s.A, 'e1b')).toBe(b < a ? '' : 'z');
					expect(ops.positionOf(s.A, 'e1b')).not.toBeNull();
				};
				verify(set);
				reloadAll(set, verify);
			});
		}
	}
});

describe('TX04a on streams: same-point concurrent splits, three client assignments', () => {
	for (const [a, b] of ASSIGN[2]) {
		row(`A=${a} B=${b}`, () => {
			for (const order of [
				['A', 'B'],
				['B', 'A']
			]) {
				const set = mkSet(HELLO, [a, b]);
				ops.splitBlock(set.A, 'b', 6, 'sA');
				ops.splitBlock(set.B, 'b', 6, 'sB');
				deliverOrdered(set, order);
				settle(set);
				// Both boundaries end the same gap; the lower client's goes left, so
				// its stream is empty and the higher client's block gets the tail
				// (the pinned "max stamp" answer: stamps are client-major).
				const verify = (s) => {
					expect(text(s.A, 'b')).toBe('hello ');
					expect(text(s.A, a > b ? 'sA' : 'sB')).toBe('world');
					expect(text(s.A, a > b ? 'sB' : 'sA')).toBe('');
				};
				verify(set);
				reloadAll(set, verify);
			}
		});
	}
});

// ── F-U4a–e (+ the attribution-renderer configuration) ──────────────────

/** Split `b` of `seed` at 6 into `t` on A, everywhere; history on for every peer. */
const withTail = (seed, ids) => {
	const set = mkSet(seed, ids);
	ops.splitBlock(set.A, 'b', 6, 't');
	settle(set);
	for (const p of set.peers) ops.trackHistory(p);
	return set;
};

for (const renderer of [false, true]) {
	const cfg = renderer ? ' [attribution renderer on every backing text]' : '';

	describe(`F-U4a: B splits the emptied tail at 0; A's undo returns world to t${cfg}`, () => {
		for (const [a, b] of ASSIGN[2]) {
			for (const undoFirst of [true, false]) {
				row(`A=${a} B=${b} undo ${undoFirst ? 'before' : 'after'} receiving the split`, () => {
					const set = withTail(HELLO, [a, b]);
					ops.deleteText(set.A, 't', 0, 5);
					set.deliver('A', 'B', { times: 2 });
					expect(text(set.B, 't')).toBe('');
					if (renderer) installRenderers(set);
					ops.splitBlock(set.B, 't', 0, 'u');
					if (!undoFirst) set.deliver('B', 'A', { times: 2 });
					expect(undoCounted(set.A)).toBe(1);
					settle(set);
					const verify = (s) => {
						expect(text(s.A, 'b')).toBe('hello ');
						expect(text(s.A, 't')).toBe('world');
						expect(text(s.A, 'u')).toBe('');
					};
					verify(set);
					reloadAll(set, verify);
				});
			}
		}
	});

	describe(`F-U4b: tail **world tail**, A deletes world, B splits at 0, A undoes${cfg}`, () => {
		const SEED = modelSpecSeed([
			{
				id: 'b',
				type: 'paragraph',
				content: [
					{ kind: 'text', text: 'hello ' },
					{ kind: 'text', text: 'world tail', marks: { bold: true } }
				]
			}
		]);
		for (const [a, b] of ASSIGN[2]) {
			for (const undoFirst of [true, false]) {
				row(`A=${a} B=${b} undo ${undoFirst ? 'before' : 'after'} receiving the split`, () => {
					const set = withTail(SEED, [a, b]);
					ops.deleteText(set.A, 't', 0, 5);
					set.deliver('A', 'B', { times: 2 });
					if (renderer) installRenderers(set);
					ops.splitBlock(set.B, 't', 0, 'u');
					if (!undoFirst) set.deliver('B', 'A');
					expect(undoCounted(set.A)).toBe(1);
					settle(set);
					const verify = (s) => {
						expect(runs(s.A, 't')).toEqual([
							{ kind: 'text', text: 'world', marks: { bold: true } }
						]);
						expect(runs(s.A, 'u')).toEqual([
							{ kind: 'text', text: ' tail', marks: { bold: true } }
						]);
					};
					verify(set);
					reloadAll(set, verify);
				});
			}
		}
	});

	describe(`F-U4c: marked deleted runs and shared format items${cfg}`, () => {
		const bold = (t) => ({ kind: 'text', text: t, marks: { bold: true } });
		const plainT = (t) => ({ kind: 'text', text: t });
		// [name, tail content (after 'hello '), delete [at, len), expected t runs, expected u runs]
		const variants = [
			[
				'marked run only, mid-stream',
				[plainT('ab'), bold('world'), plainT(' cd')],
				[2, 5],
				[plainT('ab'), bold('world')],
				[plainT(' cd')]
			],
			[
				'marked run only, stream start',
				[bold('world'), plainT(' cd')],
				[0, 5],
				[bold('world')],
				[plainT(' cd')]
			],
			[
				'opening format shared with following text',
				[plainT('ab'), bold('world tail')],
				[2, 5],
				[plainT('ab'), bold('world')],
				[bold(' tail')]
			],
			[
				'closing format shared with preceding text',
				[bold('ab world'), plainT(' cd')],
				[3, 5],
				[bold('ab world')],
				[plainT(' cd')]
			],
			[
				'unmarked run between marked neighbours',
				[bold('ab'), plainT('world'), bold('cd')],
				[2, 5],
				[bold('ab'), plainT('world')],
				[bold('cd')]
			]
		];
		for (const [name, tail, [at, len], tExp, uExp] of variants) {
			for (const [a, b] of ASSIGN[2]) {
				row(`${name} — A=${a} B=${b}`, () => {
					const seed = modelSpecSeed([
						{ id: 'b', type: 'paragraph', content: [plainT('hello '), ...tail] }
					]);
					for (const undoFirst of [true, false]) {
						const set = withTail(seed, [a, b]);
						ops.deleteText(set.A, 't', at, len);
						set.deliver('A', 'B', { times: 2 });
						if (renderer) installRenderers(set);
						ops.splitBlock(set.B, 't', at, 'u');
						if (!undoFirst) set.deliver('B', 'A');
						expect(undoCounted(set.A)).toBe(1);
						settle(set);
						const verify = (s) => {
							expect(runs(s.A, 't')).toEqual(tExp);
							expect(runs(s.A, 'u')).toEqual(uExp);
						};
						verify(set);
						reloadAll(set, verify);
					}
				});
			}
		}
	});

	describe(`F-U4d / D-17: A undoes before receiving B's split at 0 of the still-live world${cfg}`, () => {
		for (const [a, b] of ASSIGN[2]) {
			for (const order of [
				['A', 'B'],
				['B', 'A']
			]) {
				row(`A=${a} B=${b}, delivery ${order.join('→')}`, () => {
					const set = withTail(HELLO, [a, b]);
					ops.deleteText(set.A, 't', 0, 5);
					expect(undoCounted(set.A)).toBe(1);
					if (renderer) installRenderers(set);
					ops.splitBlock(set.B, 't', 0, 'u'); // world is live on B
					deliverOrdered(set, order);
					settle(set);
					// The undo copy and B's boundary share origin and right origin:
					// the lower client id goes left (YATA order, pinned both ways).
					const verify = (s) => {
						expect(text(s.A, 'b')).toBe('hello ');
						expect(text(s.A, 't') + text(s.A, 'u')).toBe('world');
						expect(text(s.A, 't')).toBe(a < b ? 'world' : '');
						expect(text(s.A, 'u')).toBe(a < b ? '' : 'world');
					};
					verify(set);
					reloadAll(set, verify);
				});
			}
		}
	});

	describe(`F-U4e: delete ‖ concurrent formats; C splits the emptied tail; A undoes${cfg}`, () => {
		const variants = [
			['B bolds world', ['B'], (set) => ops.setMark(set.B, 't', 0, 5, 'bold', true)],
			[
				'B bolds wo, D bolds rld',
				['B', 'D'],
				(set) => {
					ops.setMark(set.B, 't', 0, 2, 'bold', true);
					ops.setMark(set.peer('D'), 't', 2, 3, 'bold', true);
				}
			],
			[
				'B bolds world true, D bolds world "x"',
				['B', 'D'],
				(set) => {
					ops.setMark(set.B, 't', 0, 5, 'bold', true);
					ops.setMark(set.peer('D'), 't', 0, 5, 'bold', 'x');
				}
			]
		];
		for (const [name, formatters, format] of variants) {
			const n = formatters.includes('D') ? 4 : 3;
			for (const ids of ASSIGN[n === 4 ? 4 : 3]) {
				row(`${name} — ids ${ids.join('/')}`, () => {
					for (const cFirst of ['A', 'formats']) {
						for (const undoAfterAll of [false, true]) {
							const set = withTail(HELLO, ids);
							ops.deleteText(set.A, 't', 0, 5);
							format(set);
							const toC = (from) => set.deliver(from, 'C', { times: 2 });
							if (cFirst === 'A') {
								toC('A');
								formatters.forEach(toC);
							} else {
								formatters.forEach(toC);
								toC('A');
							}
							expect(text(set.C, 't')).toBe('');
							if (renderer) installRenderers(set);
							ops.splitBlock(set.C, 't', 0, 'u');
							if (undoAfterAll)
								for (const p of set.peers) if (p !== set.A) set.deliver(p.name, 'A');
							expect(undoCounted(set.A)).toBe(1);
							settle(set, `${cFirst} ${undoAfterAll}`);
							const verify = (s) => {
								for (const p of s.peers) {
									expect(text(p, 't'), `t on ${p.name}`).toBe('world');
									expect(text(p, 'u'), `u on ${p.name}`).toBe('');
									expect(text(p, 'b')).toBe('hello ');
								}
							};
							verify(set);
							reloadAll(set, verify);
						}
					}
				});
			}
		}
	});
}

row(
	'the attribution-renderer configuration is real: deleted items render with non-zero length',
	() => {
		const set = withTail(HELLO, [7, 3]);
		ops.deleteText(set.A, 't', 0, 5);
		installRenderers(set);
		const host = set.A.doc.get('blocks').getAttr('b').getAttr('content');
		expect(JSON.stringify(host.toDelta().toJSON())).toContain('world');
		expect(text(set.A, 't')).toBe('');
	}
);

// ── split = one boundary + the claims that follow the split point (D-21) ──

describe('split re-inserts the merge claims that follow the split point on the new block', () => {
	const SEED = modelSpecSeed([
		{ id: 'b', type: 'paragraph', content: [{ kind: 'text', text: 'ab' }] },
		{ id: 'c', type: 'paragraph', content: [{ kind: 'text', text: 'cd' }] },
		{ id: 'e', type: 'paragraph', content: [{ kind: 'text', text: 'ef' }] }
	]);
	const claimsOf = (p, id) =>
		S()
			.view(p.doc)
			.blocks.get(id)
			.claims.map((c) => c.m);
	for (const [a, b] of ASSIGN[2]) {
		row(`in the holder's own stream: the following claims move — A=${a} B=${b}`, () => {
			const set = mkSet(SEED, [a, b]);
			ops.mergeBlocks(set.A, 'c', 'b');
			ops.mergeBlocks(set.A, 'e', 'b');
			ops.splitBlock(set.A, 'b', 1, 'u');
			settle(set);
			const verify = (s) => {
				expect(text(s.A, 'b')).toBe('a');
				expect(text(s.A, 'u')).toBe('bcdef');
				expect(claimsOf(s.A, 'b')).toEqual([]);
				expect(claimsOf(s.A, 'u')).toEqual(['c', 'e']);
			};
			verify(set);
			reloadAll(set, verify);
		});
		row(
			`inside a claimed stream: the boundary lands in that text, later claims move — A=${a} B=${b}`,
			() => {
				const set = mkSet(SEED, [a, b]);
				ops.mergeBlocks(set.A, 'c', 'b');
				ops.mergeBlocks(set.A, 'e', 'b');
				ops.splitBlock(set.A, 'b', 3, 'u'); // between c and d
				settle(set);
				const verify = (s) => {
					expect(text(s.A, 'b')).toBe('abc');
					expect(text(s.A, 'u')).toBe('def');
					expect(claimsOf(s.A, 'b')).toEqual(['c']);
					expect(claimsOf(s.A, 'u')).toEqual(['e']);
					const v = S().view(s.A.doc);
					expect(v.streams.get('u').text).toBe(v.blocks.get('c').content);
				};
				verify(set);
				reloadAll(set, verify);
			}
		);
	}
});

// ── F-U3 ─────────────────────────────────────────────────────────────────

describe('F-U3: one wire update per undo; the receiver never shows hello world in the head', () => {
	for (const [a, b] of ASSIGN[2]) {
		row(
			`A=${a} B=${b} (lineage off; the lineage-on half is in stream-split-ownership.test.ts)`,
			() => {
				const set = withTail(HELLO, [a, b]);
				ops.deleteText(set.A, 't', 0, 5);
				set.deliver('A', 'B');
				expect(undoCounted(set.A)).toBe(1);
				// one wire frame, applied alone: the head never shows `hello world`
				expect(set.pending('A', 'B')).toBe(1);
				set.deliver('A', 'B');
				expect(text(set.B, 'b')).toBe('hello ');
				expect(text(set.B, 't')).toBe('world');
				settle(set);
			}
		);
	}
});

// ── F-D19 (streamless split-born block, F9) ─────────────────────────────

describe('F-D19: a split-born block whose boundary died is visible and empty; typing re-mints', () => {
	const SEED = modelSpecSeed([
		{ id: 'x', type: 'paragraph', content: [{ kind: 'text', text: 'x' }] }
	]);
	for (const [a, b] of ASSIGN[2]) {
		for (const order of [
			['A', 'B'],
			['B', 'A']
		]) {
			row(`A=${a} B=${b}, delivery ${order.join('→')}`, () => {
				const set = mkSet(SEED, [a, b]);
				ops.trackHistory(set.A);
				ops.insertBlock(
					set.A,
					{ parent: null, index: 1 },
					{
						id: 'P',
						type: 'paragraph',
						content: [{ kind: 'text', text: 'Hello world' }]
					}
				);
				settle(set);
				ops.splitBlock(set.B, 'P', 5, 'u'); // Enter inside P
				ops.insertText(set.B, 'u', 0, 'Q');
				settle(set);
				expect(text(set.A, 'u')).toBe('Q world');
				const oldN = S().view(set.A.doc).blocks.get('u').n;
				expect(undoCounted(set.A)).toBe(1); // undo the paste
				settle(set);
				for (const p of set.peers) {
					expect(ops.positionOf(p, 'P')).toBeNull();
					expect(ops.positionOf(p, 'u')).not.toBeNull();
					expect(text(p, 'u')).toBe('');
				}
				// typing into u creates its own text and re-mints n
				ops.insertText(set.B, 'u', 0, 'z');
				const v = S().view(set.B.doc);
				expect(v.blocks.get('u').content).toBeDefined();
				expect(v.blocks.get('u').n).not.toBe(oldN);
				// a late copy of the old boundary (A redoes the paste, concurrently) is inert
				set.A.undoManager.redo();
				deliverOrdered(set, order);
				settle(set);
				const verify = (s) => {
					expect(text(s.A, 'u')).toBe('z');
					const vv = S().view(s.A.doc);
					const stale = [...vv.texts.values()].flatMap((t) => t.bounds).filter((x) => x.s === 'u');
					expect(stale.length).toBe(1); // the redone copy is live …
					expect(stale[0].n).not.toBe(vv.blocks.get('u').n); // … and inert
					expect(vv.streams.get('u').text).toBe(vv.blocks.get('u').content);
				};
				verify(set);
				reloadAll(set, verify);
			});
		}
	}
});

// ── F-I7 (doc half) and anchors ─────────────────────────────────────────

describe('F-I7 (doc half): `alpha|Hello` split, then compose at the fresh block start', () => {
	const SEED = modelSpecSeed([
		{ id: 'p', type: 'paragraph', content: [{ kind: 'text', text: 'alphaHello' }] }
	]);
	for (const [a, b] of ASSIGN[2]) {
		row(`A=${a} B=${b}`, () => {
			const set = mkSet(SEED, [a, b]);
			ops.splitBlock(set.A, 'p', 5, 'u');
			settle(set);
			// A left-affine caret at u's start binds u's boundary item.
			const caret = S().anchorAt(set.A.doc, 'u', 0, 'left');
			const v = S().view(set.A.doc);
			const bound = v.texts.get(v.streams.get('u').text).bounds.find((x) => x.s === 'u');
			const [c, k] = bound.key.split(':').map(Number);
			expect(caret.a.i).toEqual({ c, k });
			expect(caret.a.a).toBe(-1);
			// compose n → に at the caret (preview, then the commit replaces it)
			ops.insertText(set.A, 'u', 0, 'n');
			ops.deleteText(set.A, 'u', 0, 1);
			ops.insertText(set.A, 'u', 0, 'に');
			// a peer types at alpha's end — the shared gap — concurrently
			ops.insertText(set.B, 'p', 5, '!');
			settle(set);
			for (const p of set.peers) {
				expect(text(p, 'u')).toBe('にHello');
				expect(text(p, 'p')).toBe('alpha!');
				expect(S().resolveAnchor(p.doc, caret)).toEqual({ blockId: 'u', offset: 0 });
			}
		});
	}
});

// ── F-D13: the R2 property corpus ───────────────────────────────────────

/** Live boundary items of a doc: `client:clock` → {bound, host text}. */
const liveBounds = (doc) => {
	const out = new Map();
	for (const [t, info] of S().view(doc).texts) {
		for (const x of info.bounds) out.set(x.key, { x, t });
	}
	return out;
};

const GENERAL = (id) => id !== 'q' && !id.startsWith('u');
const Q_TEXT = 'abcdefghij';
const CORPUS_SEED = modelSpecSeed([
	{ id: 'g0', type: 'paragraph', content: [{ kind: 'text', text: 'alpha beta' }] },
	{ id: 'g1', type: 'paragraph', content: [{ kind: 'text', text: 'gamma', marks: { b: true } }] },
	{ id: 'q', type: 'paragraph', content: [{ kind: 'text', text: Q_TEXT }] },
	{ id: 'g2', type: 'paragraph', content: [{ kind: 'text', text: 'delta epsilon' }] }
]);
const VALUES = [true, 'x', null];

const stats = { programs: 0, probes: 0, probeSplits: 0, stale: 0, conflictGaps: 0, undos: 0 };

/** (a): a boundary dies only with its host text or by the undo of the split that inserted it. */
const checkNoContentDeleteKillsBoundary = (before, after, popped, ctx) => {
	for (const [key, { t }] of before) {
		if (after.has(key)) continue;
		const hostDead = t._item === null || t._item.deleted;
		const [c, k] = key.split(':').map(Number);
		const undoneSplit = popped !== null && popped.inserts.has(c, k);
		expect(hostDead || undoneSplit, `${ctx}: boundary ${key} tombstoned by a content op`).toBe(
			true
		);
	}
};

/** (b) and the read skip: nonce-matching boundaries delimit (the first per id), others are inert. */
const checkBoundaries = (doc, ctx) => {
	const v = S().view(doc);
	const byId = new Map();
	for (const [t, info] of v.texts) {
		for (const x of info.bounds) byId.set(x.s, [...(byId.get(x.s) ?? []), { x, t }]);
		for (const s of info.streams) {
			for (const seg of S().display(v, s.block) ?? []) {
				if (seg.text !== t) continue;
				for (const x of info.bounds) {
					expect(x.at >= seg.i0 && x.at < seg.i1, `${ctx}: a read covers boundary ${x.s}`).toBe(
						false
					);
				}
			}
		}
	}
	for (const [id, list] of byId) {
		const matching = list.filter(({ x }) => v.blocks.get(id)?.n === x.n);
		if (list.length > matching.length) stats.stale++;
		const s = v.streams.get(id);
		const delimiting = list.filter(
			({ x, t }) => s !== undefined && s.text === t && s.start === x.at + 1
		);
		expect(delimiting.length, `${ctx}: ${id} delimited by ${delimiting.length}`).toBe(
			matching.length > 0 ? 1 : 0
		);
		if (delimiting.length === 1) expect(matching.map((m) => m.x)).toContain(delimiting[0].x);
	}
};

/** (c): no content unit renders twice; every unit of a visible block's stream renders. */
const checkRenderOnce = (doc, ctx) => {
	const v = S().view(doc);
	const rendered = new Set();
	/** Content units (never boundaries) of `[i0, i1)`. */
	const unitsOf = (t, i0, i1) => {
		const out = [];
		let at = 0;
		for (let it = t._start; it !== null && at < i1; it = it.right) {
			if (it.deleted || !it.countable) continue;
			for (let j = 0; j < it.length; j++) {
				if (at + j < i0 || at + j >= i1 || isBoundary(it.content.arr?.[j])) continue;
				out.push(`${it.id.client}:${it.id.clock + j}`);
			}
			at += it.length;
		}
		return out;
	};
	for (const id of v.order.ids) {
		for (const seg of S().display(v, id) ?? []) {
			for (const u of unitsOf(seg.text, seg.i0, seg.i1)) {
				expect(rendered.has(u), `${ctx}: unit ${u} renders twice`).toBe(false);
				rendered.add(u);
			}
		}
	}
	for (const id of v.order.ids) {
		const s = v.streams.get(id);
		if (s === undefined) continue;
		for (const u of unitsOf(s.text, s.start, s.end)) {
			expect(rendered.has(u), `${ctx}: unit ${u} of visible ${id} not rendered`).toBe(true);
		}
	}
};

/** Does any gap of any text hold two live same-key format items with different values? */
const hasConflictGap = (doc) => {
	for (const [t] of S().view(doc).texts) {
		let gap = new Map();
		for (let it = t._start; it !== null; it = it.right) {
			if (it.deleted) continue;
			if (it.countable) {
				gap = new Map();
				continue;
			}
			const { key, value } = it.content;
			if (gap.has(key) && gap.get(key) !== JSON.stringify(value)) return true;
			gap.set(key, JSON.stringify(value));
		}
	}
	return false;
};

const runProgram = (seed, ids) => {
	const r = mulberry32(seed * 7919 + ids[0]);
	const set = mkSet(CORPUS_SEED, ids);
	const names = set.peers.map((p) => p.name);
	for (const p of set.peers) ops.trackHistory(p);
	const popped = new Map();
	const hook = (p) => p.undoManager.on('stack-item-popped', (e) => popped.set(p.name, e.stackItem));
	set.peers.forEach(hook);
	let minted = 0;
	let lastId = null;
	const ctx = (s) => `seed ${seed} ids ${ids.join('/')} step ${s}`;
	/** Run one local op on `p` and check (a) around it. */
	const local = (p, s, f, isUndo = false) => {
		const before = liveBounds(p.doc);
		popped.set(p.name, null);
		f();
		checkNoContentDeleteKillsBoundary(
			before,
			liveBounds(p.doc),
			isUndo ? popped.get(p.name) : null,
			ctx(s)
		);
	};
	const general = (p) => ops.listBlockIds(p).filter(GENERAL);
	const generalStep = (p, s) => {
		const ids_ = general(p);
		if (ids_.length === 0) return;
		const id = pick(r, ids_);
		const len = text(p, id)?.length ?? 0;
		const k = r();
		if (k < 0.22)
			local(p, s, () =>
				ops.insertText(
					p,
					id,
					int(r, 0, len),
					pick(r, ['x', 'yz', 'Q']),
					bool(r, 0.3) ? { b: pick(r, [true, 'x']) } : undefined
				)
			);
		else if (k < 0.36 && len > 0) {
			const at = int(r, 0, len - 1);
			local(p, s, () => ops.deleteText(p, id, at, int(r, 1, Math.min(4, len - at))));
		} else if (k < 0.5 && len > 0) {
			const at = int(r, 0, len - 1);
			local(p, s, () =>
				ops.setMark(p, id, at, int(r, 1, len - at), pick(r, ['b', 'i']), pick(r, VALUES))
			);
		} else if (k < 0.66) {
			// same-id concurrent splits happen: ids are drawn so peers sometimes reuse one
			const nid = bool(r, 0.15) && lastId !== null ? lastId : `g${seed}_${minted++}`;
			lastId = nid;
			local(p, s, () => ops.splitBlock(p, id, int(r, 0, len), nid));
		} else if (k < 0.74 && ids_.length > 1) {
			const into = pick(
				r,
				ids_.filter((x) => x !== id)
			);
			local(p, s, () => ops.mergeBlocks(p, id, into));
		} else if (k < 0.78 && ids_.length > 2) local(p, s, () => ops.deleteBlock(p, id));
		else if (k < 0.92) {
			stats.undos++;
			local(p, s, () => p.undoManager.undo(), true);
		} else local(p, s, () => p.undoManager.redo());
	};
	const randomDelivery = () => {
		const from = pick(r, names);
		const to = pick(
			r,
			names.filter((n) => n !== from)
		);
		set.deliver(from, to, {
			times: bool(r, 0.3) ? 2 : 1,
			reverse: bool(r, 0.2),
			batch: bool(r, 0.2)
		});
	};

	let step = 0;
	for (; step < 30; step++) {
		generalStep(set.peers[int(r, 0, names.length - 1)], step);
		if (bool(r, 0.6)) randomDelivery();
	}
	// ── the (e) probe: X deletes from q; others format it concurrently and
	// split its gap after receiving the delete; X undoes once, at a random point.
	settle(set, ctx(step));
	const X = pick(r, set.peers);
	const others = set.peers.filter((p) => p !== X);
	const at = int(r, 1, 5);
	const len = int(r, 1, 4);
	local(X, step, () => ops.deleteText(X, 'q', at, len));
	const postDelete = Q_TEXT.slice(0, at) + Q_TEXT.slice(at + len);
	stats.probes++;
	const undoAt = int(r, 0, 11);
	let splits = 0;
	for (let w = 0; w < 12; w++, step++) {
		if (w === undoAt) {
			let n = 0;
			const h = () => n++;
			X.doc.on('update', h);
			local(X, step, () => X.undoManager.undo(), true);
			X.doc.off('update', h);
			expect(n, `${ctx(step)}: undo emitted ${n} updates`).toBe(1);
		}
		const p = pick(r, others);
		const qt = text(p, 'q');
		const roll = r();
		if (roll < 0.35 && qt.length > 0) {
			const f0 = int(r, 0, qt.length - 1);
			local(p, step, () =>
				ops.setMark(p, 'q', f0, int(r, 1, qt.length - f0), pick(r, ['b', 'i']), pick(r, VALUES))
			);
		} else if (roll < 0.55 && qt === postDelete && !ops.listBlockIds(p).includes(`u${p.name}`)) {
			splits++;
			local(p, step, () => ops.splitBlock(p, 'q', at, `u${p.name}`));
		} else generalStep(p, step);
		randomDelivery();
		if (bool(r, 0.5)) randomDelivery();
	}
	if (splits > 0) stats.probeSplits++;
	for (; step < 70; step++) {
		generalStep(pick(r, others), step);
		if (bool(r, 0.6)) randomDelivery();
	}
	// ── convergence and the properties on every replica
	settle(set, ctx(step)); // (d)
	if (set.peers.some((p) => hasConflictGap(p.doc))) stats.conflictGaps++;
	const verify = (s, tag) => {
		for (const p of s.peers) {
			checkBoundaries(p.doc, `${ctx(step)} ${tag} ${p.name}`); // (b)
			checkRenderOnce(p.doc, `${ctx(step)} ${tag} ${p.name}`); // (c)
			// (e) R16: the undone delete is back in q, the block that displayed it
			const us = ops.listBlockIds(p).filter((x) => x.startsWith('u'));
			const suffix = Q_TEXT.slice(at + len);
			if (us.length === 0) expect(text(p, 'q'), `${ctx(step)} (e)`).toBe(Q_TEXT);
			else {
				expect(text(p, 'q'), `${ctx(step)} (e) with splits`).toBe(Q_TEXT.slice(0, at + len));
				expect(us.map((u) => text(p, u)).sort()).toEqual(
					[suffix, ...us.slice(1).map(() => '')].sort()
				);
			}
			for (const id of s.peers[0] === p ? [] : ops.listBlockIds(p)) {
				expect(runs(p, id)).toEqual(runs(s.peers[0], id)); // (d) runs too
			}
		}
	};
	verify(set, 'live');
	reloadAll(set, (s) => verify(s, 'reload'));
	stats.programs++;
};

describe('F-D13: R2 property corpus — 4 replicas, random delivery, concurrent formats, (a)–(e)', () => {
	for (let seed = 1; seed <= 32; seed++) {
		for (const ids of ASSIGN[4]) {
			row(`program ${seed}, ids ${ids.join('/')}`, () => runProgram(seed, ids));
		}
	}
	row('the corpus reached the cases it exists for', () => {
		expect(stats.programs).toBe(32 * ASSIGN[4].length);
		expect(stats.probeSplits).toBeGreaterThan(40);
		expect(stats.conflictGaps).toBeGreaterThan(40);
		expect(stats.stale).toBeGreaterThan(0);
		expect(stats.undos).toBeGreaterThan(1000);
	});
});
