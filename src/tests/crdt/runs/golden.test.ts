/**
 * U05 golden semantics — the AN01–AN07 rich-text contract, pinned against
 * the maintained run view.
 *
 * These tests are the EXECUTABLE spec for `docs/crdt-v14-richtext-adr.md`.
 * Where the engine's raw concurrent behavior needed a decision (AN06), the
 * rule adopted is documented here and in the ADR — it is NOT silently
 * inherited:
 *
 * - Marks are replicated as v14 format items: a `setMark(k,v)` writes a
 *   format-START item `{k:v}` and a format-END item `{k:null}` around the
 *   range. The active value of key `k` at any atom is the value of the
 *   last-start item preceding it in sequence order; an end item restores
 *   null. Concurrent items order by (client,clock) — deterministic and
 *   convergent on every replica.
 * - AN06 consequence (verified on both replicas, both delivery orders):
 *   the overlap resolves to the later-ordered writer; an exclusive prefix
 *   keeps the earlier writer's value; a loser's end marker restores null
 *   and therefore CLEARS the winner's value where it lands inside the
 *   winner's exclusive suffix. Independent keys never interact.
 * - AN07: annotations are marks on atoms. Endpoint inserts land OUTSIDE
 *   the annotation unless they carry the mark themselves; deleting an
 *   endpoint atom shrinks the annotation; split/merge carry marks with
 *   their atoms and merge re-unites adjacent equal runs.
 * - AN05: decorations are a pure overlay — `decorateRuns(runs, decos)`
 *   splits display runs at decoration boundaries and never writes to the
 *   doc (asserted by a zero emitted-update count).
 */
// @ts-nocheck -- vendored upstream source is plain JS; checked structurally, not via types.
import { describe, expect, it } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { bindRunsOracle } from '../../oracles/runs.js';
import { bindRuns, decorateRuns } from '../../../lib/crdt/index.js';
import { bindModel } from '../../oracles/model-ops.js';
import { createPeerPair } from '../harness/peer-set.js';
import { modelSpecSeed } from '../scenarios/seeds.js';

const M = bindModel(Y);
const R = bindRuns(Y);
const O = bindRunsOracle(Y);

const seed = (blocks) => modelSpecSeed(blocks);
const runs = (peer, id) => O.computeAllRuns(peer.doc).get(id) ?? [];
const view = (peer) => R.attach(peer.doc);

const updateCount = (doc) => {
	let n = 0;
	doc.on('update', () => n++);
	return () => n;
};

// ── AN01 — independent mark keys split/merge runs by key ────────────────

describe('AN01 — mark keys are independent run boundaries', () => {
	it('distinct keys on the same range merge into one run', () => {
		const set = createPeerPair(
			seed([{ id: 'a', type: 'p', content: [{ kind: 'text', text: 'hello' }] }])
		);
		set.A.transact(() => M.setMark(set.A.doc, 'a', 0, 5, 'bold', true));
		set.A.transact(() => M.setMark(set.A.doc, 'a', 0, 5, 'italic', true));
		expect(view(set.A).runs('a')).toEqual([
			{ kind: 'text', text: 'hello', marks: { bold: true, italic: true } }
		]);
	});

	it('overlapping different-key ranges partition at key boundaries', () => {
		const set = createPeerPair(
			seed([{ id: 'a', type: 'p', content: [{ kind: 'text', text: 'hello world' }] }])
		);
		set.A.transact(() => M.setMark(set.A.doc, 'a', 0, 8, 'bold', true)); // 'hello wo'
		set.A.transact(() => M.setMark(set.A.doc, 'a', 6, 5, 'italic', true)); // 'world'
		expect(view(set.A).runs('a')).toEqual([
			{ kind: 'text', text: 'hello ', marks: { bold: true } },
			{ kind: 'text', text: 'wo', marks: { bold: true, italic: true } },
			{ kind: 'text', text: 'rld', marks: { italic: true } }
		]);
	});

	it('removing one key re-merges equal runs; keys never bleed into each other', () => {
		const set = createPeerPair(
			seed([{ id: 'a', type: 'p', content: [{ kind: 'text', text: 'hello world' }] }])
		);
		set.A.transact(() => M.setMark(set.A.doc, 'a', 0, 8, 'bold', true));
		set.A.transact(() => M.setMark(set.A.doc, 'a', 6, 5, 'italic', true));
		set.A.transact(() => M.unsetMark(set.A.doc, 'a', 0, 11, 'bold'));
		expect(view(set.A).runs('a')).toEqual([
			{ kind: 'text', text: 'hello ' },
			{ kind: 'text', text: 'world', marks: { italic: true } }
		]);
	});

	it('object-valued marks (annotation payloads) split runs by value', () => {
		const set = createPeerPair(
			seed([{ id: 'a', type: 'p', content: [{ kind: 'text', text: 'hello world' }] }])
		);
		set.A.transact(() => M.setMark(set.A.doc, 'a', 0, 5, 'comment', { id: 'c1', text: 'x' }));
		set.A.transact(() => M.setMark(set.A.doc, 'a', 6, 5, 'comment', { id: 'c2', text: 'y' }));
		expect(view(set.A).runs('a')).toEqual([
			{ kind: 'text', text: 'hello', marks: { comment: { id: 'c1', text: 'x' } } },
			{ kind: 'text', text: ' ' },
			{ kind: 'text', text: 'world', marks: { comment: { id: 'c2', text: 'y' } } }
		]);
	});
});

// ── AN02 — formatting across split/merge; marked-boundary typing ────────

describe('AN02 — marks travel with atoms through split/merge', () => {
	it('format → split inside the range → merge: marks partition and reunite', () => {
		const set = createPeerPair(
			seed([{ id: 'a', type: 'p', content: [{ kind: 'text', text: 'hello world' }] }])
		);
		const v = view(set.A);
		set.A.transact(() => M.setMark(set.A.doc, 'a', 3, 5, 'bold', true));
		expect(v.runs('a')).toEqual([
			{ kind: 'text', text: 'hel' },
			{ kind: 'text', text: 'lo wo', marks: { bold: true } },
			{ kind: 'text', text: 'rld' }
		]);
		set.A.transact(() => M.splitBlock(set.A.doc, 'a', 5, 'a2'));
		expect(v.runs('a')).toEqual([
			{ kind: 'text', text: 'hel' },
			{ kind: 'text', text: 'lo', marks: { bold: true } }
		]);
		expect(v.runs('a2')).toEqual([
			{ kind: 'text', text: ' wo', marks: { bold: true } },
			{ kind: 'text', text: 'rld' }
		]);
		set.A.transact(() => M.mergeBlocks(set.A.doc, 'a2', 'a'));
		expect(v.runs('a')).toEqual([
			{ kind: 'text', text: 'hel' },
			{ kind: 'text', text: 'lo wo', marks: { bold: true } },
			{ kind: 'text', text: 'rld' }
		]);
		expect(v.runs('a2')).toEqual([]); // merged away — hidden
	});

	it('unmarked typing inside a marked run splits it (no implicit inheritance)', () => {
		const set = createPeerPair(
			seed([
				{ id: 'a', type: 'p', content: [{ kind: 'text', text: 'bolded', marks: { bold: true } }] }
			])
		);
		set.A.transact(() => M.insertText(set.A.doc, 'a', 3, 'X'));
		expect(view(set.A).runs('a')).toEqual([
			{ kind: 'text', text: 'bol', marks: { bold: true } },
			{ kind: 'text', text: 'X' },
			{ kind: 'text', text: 'ded', marks: { bold: true } }
		]);
	});

	it('a CONCURRENT remote insert inside a marked range adopts the mark', () => {
		// Format-item semantics: B writes 'X' while its replica has no mark
		// at that position (A's format op is concurrent) — the new atom lands
		// between A's format-start/end items and displays marked. When the
		// inserter's replica DOES carry the mark, the engine negates the
		// insert and it stays unmarked (previous test).
		const set = createPeerPair(
			seed([{ id: 'a', type: 'p', content: [{ kind: 'text', text: 'bolded' }] }])
		);
		set.A.transact(() => M.setMark(set.A.doc, 'a', 0, 6, 'bold', true));
		set.B.transact(() => M.insertText(set.B.doc, 'a', 3, 'X'));
		set.deliverAll();
		expect(view(set.A).runs('a')).toEqual([
			{ kind: 'text', text: 'bolXded', marks: { bold: true } }
		]);
		expect(view(set.B).runs('a')).toEqual(view(set.A).runs('a'));
	});

	it('typing at a marked boundary lands outside unless it carries the mark', () => {
		const set = createPeerPair(
			seed([
				{
					id: 'a',
					type: 'p',
					content: [
						{ kind: 'text', text: 'hello ' },
						{ kind: 'text', text: 'world', marks: { bold: true } }
					]
				}
			])
		);
		const v = view(set.A);
		// Unmarked insert at the mark's left edge stays unmarked.
		set.A.transact(() => M.insertText(set.A.doc, 'a', 6, '>'));
		expect(v.runs('a')).toEqual([
			{ kind: 'text', text: 'hello >' },
			{ kind: 'text', text: 'world', marks: { bold: true } }
		]);
		// Marked insert at the mark's right edge EXTENDS the run.
		set.A.transact(() => M.insertText(set.A.doc, 'a', 12, '!', { bold: true }));
		expect(v.runs('a')).toEqual([
			{ kind: 'text', text: 'hello >' },
			{ kind: 'text', text: 'world!', marks: { bold: true } }
		]);
		// Unmarked insert at the right edge stays outside.
		set.A.transact(() => M.insertText(set.A.doc, 'a', 13, '.'));
		expect(v.runs('a')).toEqual([
			{ kind: 'text', text: 'hello >' },
			{ kind: 'text', text: 'world!', marks: { bold: true } },
			{ kind: 'text', text: '.' }
		]);
	});
});

// ── AN03 — inline atoms: identity through edits + metadata updates ──────

describe('AN03 — inline atoms keep identity; metadata updates stay local', () => {
	const INLINE_SEED = seed([
		{
			id: 'a',
			type: 'p',
			content: [
				{ kind: 'text', text: 'x ' },
				{ kind: 'inline', id: 'm1', type: 'mention', data: { user: 'sam' } },
				{ kind: 'text', text: ' y' }
			]
		}
	]);

	it('atom identity survives text edits, split, merge, undo', () => {
		const set = createPeerPair(INLINE_SEED);
		const doc = set.A.doc;
		const v = view(set.A);
		set.A.transact(() => M.insertText(doc, 'a', 0, '> '));
		// '> ' merges with the unmarked 'x ' run — the atom stays index 1.
		expect(v.runs('a')[1]).toEqual({
			kind: 'inline',
			id: 'm1',
			type: 'mention',
			data: { user: 'sam' }
		});
		set.A.transact(() => M.splitBlock(doc, 'a', 4, 'a2'));
		// The atom moved to the sibling — same id, same data, no duplicate.
		expect(v.runs('a2')).toEqual([
			{ kind: 'inline', id: 'm1', type: 'mention', data: { user: 'sam' } },
			{ kind: 'text', text: ' y' }
		]);
		expect(v.runs('a').filter((r) => r.kind === 'inline')).toEqual([]);
		set.A.transact(() => M.mergeBlocks(doc, 'a2', 'a'));
		expect(
			v
				.runs('a')
				.map((r) => (r.kind === 'inline' ? r.id : r.text))
				.join('|')
		).toBe('> x |m1| y');
	});

	it('a metadata update rebuilds only the atom run — text runs keep identity', () => {
		const set = createPeerPair(INLINE_SEED);
		const doc = set.A.doc;
		const v = view(set.A);
		const before = v.runs('a');
		set.A.transact(() => M.setInlineData(doc, 'a', 'm1', { user: 'bo', nick: 'b' }));
		const after = v.runs('a');
		expect(after[0]).toBe(before[0]); // 'x ' reused
		expect(after[2]).toBe(before[2]); // ' y' reused
		expect(after[1]).not.toBe(before[1]); // the atom run is new
		expect(after[1]).toEqual({
			kind: 'inline',
			id: 'm1',
			type: 'mention',
			data: { user: 'bo', nick: 'b' }
		});
	});

	it('metadata updates replicate and are never duplicated/dropped', () => {
		const set = createPeerPair(INLINE_SEED);
		const vA = view(set.A);
		const vB = view(set.B);
		set.A.transact(() => M.setInlineData(set.A.doc, 'a', 'm1', { user: 'bo' }));
		set.B.transact(() => M.insertText(set.B.doc, 'a', 0, '#'));
		set.deliverAll();
		expect(vB.runs('a')).toEqual(vA.runs('a'));
		expect(vA.runs('a')).toEqual([
			{ kind: 'text', text: '#x ' }, // unmarked '#' merged into 'x '
			{ kind: 'inline', id: 'm1', type: 'mention', data: { user: 'bo' } },
			{ kind: 'text', text: ' y' }
		]);
	});

	it('removeInline deletes exactly the atom — neighbors merge', () => {
		const set = createPeerPair(INLINE_SEED);
		const v = view(set.A);
		set.A.transact(() => M.removeInline(set.A.doc, 'a', 'm1'));
		// 'x ' + ' y' — both unmarked, merge into one run.
		expect(v.runs('a')).toEqual([{ kind: 'text', text: 'x  y' }]);
		set.deliverAll();
		expect(view(set.B).runs('a')).toEqual(v.runs('a'));
	});

	it('concurrent removeInline vs metadata update: the delete wins', () => {
		// PINNED SEMANTIC — verified convergent in both delivery orders: a
		// sequence-delete tombstones the atom; a concurrent attr write to the
		// atom's node lands on the tombstone and does NOT resurrect it.
		for (const order of ['AB', 'BA']) {
			const set = createPeerPair(INLINE_SEED);
			const vA = view(set.A);
			const vB = view(set.B);
			set.A.transact(() => M.removeInline(set.A.doc, 'a', 'm1'));
			set.B.transact(() => M.setInlineData(set.B.doc, 'a', 'm1', { user: 'late' }));
			if (order === 'AB') {
				set.deliver('A', 'B');
				set.deliver('B', 'A');
			} else {
				set.deliver('B', 'A');
				set.deliver('A', 'B');
			}
			set.syncAll();
			expect(vA.runs('a'), order).toEqual(vB.runs('a'));
			expect(
				vA.runs('a').filter((r) => r.kind === 'inline'),
				order
			).toEqual([]);
		}
	});
});

// ── AN04 — live cache vs fresh vs maintained view vs readonly export ────

describe('AN04 — export is the public {text,marks?} shape; snapshots are immutable', () => {
	it('contentJSON exports public JSONText/JSONInlineBlock shapes', () => {
		const set = createPeerPair(
			seed([
				{
					id: 'a',
					type: 'p',
					content: [
						{ kind: 'text', text: 'a ', marks: { bold: true } },
						{ kind: 'inline', id: 'm1', type: 'mention', data: { user: 's' } },
						{ kind: 'text', text: 'z' }
					]
				}
			])
		);
		const v = view(set.A);
		const out = v.contentJSON('a');
		// Public shape only — no engine delta plumbing leaks.
		expect(out).toEqual([
			{ text: 'a ', marks: { bold: true } },
			{ id: 'm1', type: 'mention', data: { user: 's' } },
			{ text: 'z' }
		]);
		expect(Object.getPrototypeOf(out[0])).toBe(Object.prototype);
	});

	it('an exported snapshot does not change after later edits', () => {
		const set = createPeerPair(
			seed([
				{ id: 'a', type: 'p', content: [{ kind: 'text', text: 'one', marks: { bold: true } }] }
			])
		);
		const v = view(set.A);
		const snap = v.contentJSON('a');
		set.A.transact(() => M.unsetMark(set.A.doc, 'a', 0, 3, 'bold'));
		set.A.transact(() => M.insertText(set.A.doc, 'a', 3, ' two'));
		expect(snap).toEqual([{ text: 'one', marks: { bold: true } }]); // frozen in time
		expect(v.contentJSON('a')).toEqual([{ text: 'one two' }]);
	});

	it('runs/snapshot are frozen; deep mutation cannot corrupt the view', () => {
		const set = createPeerPair(
			seed([
				{ id: 'a', type: 'p', content: [{ kind: 'text', text: 'one', marks: { bold: true } }] }
			])
		);
		const v = view(set.A);
		const rs = v.runs('a');
		expect(() => {
			'use strict';
			(rs as { text: string }[])[0].text = 'tampered';
		}).toThrow();
		expect(v.runs('a')[0].text).toBe('one');
	});
});

// ── AN05 — local decorations never touch replicated state ───────────────

describe('AN05 — decorations are a pure local overlay', () => {
	const CODE_SEED = seed([
		{ id: 'a', type: 'code', content: [{ kind: 'text', text: 'const x = 1' }] }
	]);

	it('decorateRuns splits at boundaries, unions values, preserves marks', () => {
		const set = createPeerPair(CODE_SEED);
		const v = view(set.A);
		const rs = v.runs('a');
		const decorated = decorateRuns(rs, [
			{ from: 0, to: 5, key: 'syntax', value: 'keyword' }, // 'const'
			{ from: 6, to: 7, key: 'syntax', value: 'ident' }, // 'x'
			{ from: 6, to: 7, key: 'lens', value: 'used' }
		]);
		expect(decorated).toEqual([
			{ kind: 'text', text: 'const', decorations: { syntax: 'keyword' } },
			{ kind: 'text', text: ' ' },
			{ kind: 'text', text: 'x', decorations: { syntax: 'ident', lens: 'used' } },
			{ kind: 'text', text: ' = 1' }
		]);
	});

	it('decorations emit zero updates and do not alter replicated marks', () => {
		const set = createPeerPair(CODE_SEED);
		const v = view(set.A);
		const count = updateCount(set.A.doc);
		const marksBefore = v.contentJSON('a');
		decorateRuns(v.runs('a'), [{ from: 0, to: 5, key: 'syntax', value: 'kw' }]);
		expect(count()).toBe(0); // no doc writes
		expect(v.contentJSON('a')).toEqual(marksBefore); // persistent runs intact
	});

	it('remote persistent marks survive local decoration; decorations never replicate', () => {
		const set = createPeerPair(CODE_SEED);
		const vA = view(set.A);
		const vB = view(set.B);
		// A decorates locally; B marks persistently; sync only carries B's mark.
		const decorated = decorateRuns(vA.runs('a'), [
			{ from: 0, to: 11, key: 'syntax', value: 'line' }
		]);
		set.B.transact(() => M.setMark(set.B.doc, 'a', 6, 1, 'bold', true));
		set.deliverAll();
		// B's mark arrived; A's decoration exists only in A's local overlay.
		expect(vA.runs('a')).toEqual([
			{ kind: 'text', text: 'const ' },
			{ kind: 'text', text: 'x', marks: { bold: true } },
			{ kind: 'text', text: ' = 1' }
		]);
		expect(vB.runs('a')).toEqual(vA.runs('a'));
		// Re-decorating the NEW runs composes cleanly with the remote marks.
		expect(decorateRuns(vA.runs('a'), [{ from: 6, to: 7, key: 'syntax', value: 'ident' }])).toEqual(
			[
				{ kind: 'text', text: 'const ' },
				{ kind: 'text', text: 'x', marks: { bold: true }, decorations: { syntax: 'ident' } },
				{ kind: 'text', text: ' = 1' }
			]
		);
		// The decorated overlay itself never enters the doc — no 'syntax' key
		// in the public export.
		expect(JSON.stringify(vA.contentJSON('a'))).not.toContain('syntax');
	});

	it('a decoration with value undefined removes the key over its range', () => {
		const rs = Object.freeze([{ kind: 'text', text: 'ab', marks: { m: 1 } }]);
		const out = decorateRuns(rs, [
			{ from: 0, to: 2, key: 'd', value: 'x' },
			{ from: 1, to: 2, key: 'd', value: undefined }
		]);
		expect(out).toEqual([
			{ kind: 'text', text: 'a', marks: { m: 1 }, decorations: { d: 'x' } },
			{ kind: 'text', text: 'b', marks: { m: 1 } } // decoration removed here
		]);
	});
});

// ── AN06 — concurrent same-key marks: the deterministic spec ────────────

describe('AN06 — concurrent same-key conflicts resolve by format-item order', () => {
	const SEED = seed([{ id: 'a', type: 'p', content: [{ kind: 'text', text: 'hello world' }] }]);

	const bothOrders = (setup, verify) => {
		for (const order of ['AB', 'BA']) {
			const set = createPeerPair(SEED);
			setup(set);
			if (order === 'AB') {
				set.deliver('A', 'B');
				set.deliver('B', 'A');
			} else {
				set.deliver('B', 'A');
				set.deliver('A', 'B');
			}
			set.syncAll();
			const a = view(set.A).runs('a');
			const b = view(set.B).runs('a');
			expect(a, `${order}: replicas must converge`).toEqual(b);
			verify(a, order);
		}
	};

	it('independent keys on the same range always merge — never conflict', () => {
		bothOrders(
			(set) => {
				set.A.transact(() => M.setMark(set.A.doc, 'a', 0, 5, 'color', 'red'));
				set.B.transact(() => M.setMark(set.B.doc, 'a', 0, 5, 'bold', true));
			},
			(rs) => {
				expect(rs).toEqual([
					{ kind: 'text', text: 'hello', marks: { color: 'red', bold: true } },
					{ kind: 'text', text: ' world' }
				]);
			}
		);
	});

	it('same-key disjoint ranges both survive', () => {
		bothOrders(
			(set) => {
				set.A.transact(() => M.setMark(set.A.doc, 'a', 0, 3, 'color', 'red'));
				set.B.transact(() => M.setMark(set.B.doc, 'a', 6, 5, 'color', 'blue'));
			},
			(rs) => {
				expect(rs).toEqual([
					{ kind: 'text', text: 'hel', marks: { color: 'red' } },
					{ kind: 'text', text: 'lo ' },
					{ kind: 'text', text: 'world', marks: { color: 'blue' } }
				]);
			}
		);
	});

	it('same-key same range: one deterministic winner (item order, not value)', () => {
		bothOrders(
			(set) => {
				set.A.transact(() => M.setMark(set.A.doc, 'a', 0, 5, 'color', 'red'));
				set.B.transact(() => M.setMark(set.B.doc, 'a', 0, 5, 'color', 'blue'));
			},
			(rs) => {
				// B (client 2) wins the contested range in the harness — the rule
				// is ITEM ORDER, deterministic across replicas and orders; it is
				// not "last delivery wins" and not value-based.
				expect(rs).toEqual([
					{ kind: 'text', text: 'hello', marks: { color: 'blue' } },
					{ kind: 'text', text: ' world' }
				]);
			}
		);
	});

	it("same-key overlapping ranges: overlap → winner; end-marker clears the loser's tail", () => {
		bothOrders(
			(set) => {
				set.A.transact(() => M.setMark(set.A.doc, 'a', 0, 8, 'color', 'red')); // [0,8)
				set.B.transact(() => M.setMark(set.B.doc, 'a', 3, 8, 'color', 'blue')); // [3,11)
			},
			(rs) => {
				// Format-item scan: A-start red@0, B-start blue@3, A-end null@8,
				// B-end null@11. Atoms: [0,3) red; [3,8) blue (B's start is
				// later in item order); [8,11) null — A's end marker restores
				// null over B's exclusive suffix. Pinned, documented behavior.
				expect(rs).toEqual([
					{ kind: 'text', text: 'hel', marks: { color: 'red' } },
					{ kind: 'text', text: 'lo wo', marks: { color: 'blue' } },
					{ kind: 'text', text: 'rld' }
				]);
			}
		);
	});

	it('same-key contained ranges: the inner write wins; the outer tail is cleared', () => {
		bothOrders(
			(set) => {
				set.A.transact(() => M.setMark(set.A.doc, 'a', 0, 11, 'color', 'red'));
				set.B.transact(() => M.setMark(set.B.doc, 'a', 3, 4, 'color', 'blue')); // [3,7)
			},
			(rs) => {
				// A-start@0, B-start@3, B-end(null)@7 clears red, A-end(null)@11.
				expect(rs).toEqual([
					{ kind: 'text', text: 'hel', marks: { color: 'red' } },
					{ kind: 'text', text: 'lo w', marks: { color: 'blue' } },
					{ kind: 'text', text: 'orld' }
				]);
			}
		);
	});

	it('concurrent set vs unset of the same key: the null write wins the overlap', () => {
		const SEED2 = seed([
			{
				id: 'a',
				type: 'p',
				content: [{ kind: 'text', text: 'hello world', marks: { bold: true } }]
			}
		]);
		for (const order of ['AB', 'BA']) {
			const set = createPeerPair(SEED2);
			set.A.transact(() => M.unsetMark(set.A.doc, 'a', 0, 5, 'bold'));
			set.B.transact(() => M.setMark(set.B.doc, 'a', 0, 5, 'bold', true));
			if (order === 'AB') {
				set.deliver('A', 'B');
				set.deliver('B', 'A');
			} else {
				set.deliver('B', 'A');
				set.deliver('A', 'B');
			}
			set.syncAll();
			const rs = view(set.A).runs('a');
			expect(rs, order).toEqual(view(set.B).runs('a'));
			// Deterministic outcome (item order): the unmark wins [0,5).
			expect(rs).toEqual([
				{ kind: 'text', text: 'hello' },
				{ kind: 'text', text: ' world', marks: { bold: true } }
			]);
		}
	});
});

// ── AN07 — annotation endpoints: affinity + deleted endpoints ───────────

describe('AN07 — annotation endpoints follow atoms, not offsets', () => {
	const ANN_SEED = seed([
		{
			id: 'a',
			type: 'p',
			content: [
				{ kind: 'text', text: 'hello ' },
				{ kind: 'text', text: 'world', marks: { comment: 'c1' } }
			]
		}
	]);

	it('endpoint inserts stay outside unless they carry the mark', () => {
		const set = createPeerPair(ANN_SEED);
		const v = view(set.A);
		set.A.transact(() => M.insertText(set.A.doc, 'a', 6, '>')); // left edge, unmarked
		set.A.transact(() => M.insertText(set.A.doc, 'a', 13, '.')); // right edge, unmarked
		expect(v.runs('a')).toEqual([
			{ kind: 'text', text: 'hello >' },
			{ kind: 'text', text: 'world', marks: { comment: 'c1' } },
			{ kind: 'text', text: '.' }
		]);
		set.A.transact(() => M.insertText(set.A.doc, 'a', 12, '!', { comment: 'c1' })); // marked at right edge
		expect(v.runs('a')).toEqual([
			{ kind: 'text', text: 'hello >' },
			{ kind: 'text', text: 'world!', marks: { comment: 'c1' } },
			{ kind: 'text', text: '.' }
		]);
	});

	it('deleting an endpoint atom shrinks the annotation — the rest survives', () => {
		const set = createPeerPair(ANN_SEED);
		const v = view(set.A);
		set.A.transact(() => M.deleteText(set.A.doc, 'a', 5, 2)); // eats ' w'
		expect(v.runs('a')).toEqual([
			{ kind: 'text', text: 'hello' },
			{ kind: 'text', text: 'orld', marks: { comment: 'c1' } }
		]);
		// Delete the right endpoint too.
		set.A.transact(() => M.deleteText(set.A.doc, 'a', 8, 1));
		expect(v.runs('a')).toEqual([
			{ kind: 'text', text: 'hello' },
			{ kind: 'text', text: 'orl', marks: { comment: 'c1' } }
		]);
	});

	it('endpoints deleted across split+merge: marks travel with live atoms only', () => {
		const set = createPeerPair(ANN_SEED);
		const v = view(set.A);
		// Split AT the annotation's left edge, then delete the sibling's
		// first (left-endpoint) char, merge back — the annotation covers
		// only surviving atoms.
		set.A.transact(() => M.splitBlock(set.A.doc, 'a', 6, 'a2')); // 'hello ' | 'world'
		expect(v.runs('a2')).toEqual([{ kind: 'text', text: 'world', marks: { comment: 'c1' } }]);
		set.A.transact(() => M.deleteText(set.A.doc, 'a2', 0, 1)); // delete 'w' — left endpoint atom
		expect(v.runs('a2')).toEqual([{ kind: 'text', text: 'orld', marks: { comment: 'c1' } }]);
		set.A.transact(() => M.mergeBlocks(set.A.doc, 'a2', 'a'));
		expect(v.runs('a')).toEqual([
			{ kind: 'text', text: 'hello ' },
			{ kind: 'text', text: 'orld', marks: { comment: 'c1' } }
		]);
	});

	it('concurrent inserts at both endpoints converge in either delivery order', () => {
		for (const order of ['AB', 'BA']) {
			const set = createPeerPair(ANN_SEED);
			set.A.transact(() => M.insertText(set.A.doc, 'a', 6, 'L'));
			set.B.transact(() => M.insertText(set.B.doc, 'a', 11, 'R'));
			if (order === 'AB') {
				set.deliver('A', 'B');
				set.deliver('B', 'A');
			} else {
				set.deliver('B', 'A');
				set.deliver('A', 'B');
			}
			set.syncAll();
			const rs = view(set.A).runs('a');
			expect(rs, order).toEqual(view(set.B).runs('a'));
			// Both inserts land OUTSIDE the annotation: 'L' extends the left
			// plain run, 'R' starts a new plain run after 'world'.
			expect(rs, order).toEqual([
				{ kind: 'text', text: 'hello L' },
				{ kind: 'text', text: 'world', marks: { comment: 'c1' } },
				{ kind: 'text', text: 'R' }
			]);
		}
	});

	it('concurrent endpoint insert vs endpoint delete converges — annotation tracks atoms', () => {
		for (const order of ['AB', 'BA']) {
			const set = createPeerPair(ANN_SEED);
			set.A.transact(() => M.deleteText(set.A.doc, 'a', 6, 1)); // delete 'w' (left endpoint)
			set.B.transact(() => M.insertText(set.B.doc, 'a', 6, '>')); // insert at same edge
			if (order === 'AB') {
				set.deliver('A', 'B');
				set.deliver('B', 'A');
			} else {
				set.deliver('B', 'A');
				set.deliver('A', 'B');
			}
			set.syncAll();
			const rs = view(set.A).runs('a');
			expect(rs, order).toEqual(view(set.B).runs('a'));
			expect(rs, order).toEqual([
				{ kind: 'text', text: 'hello >' },
				{ kind: 'text', text: 'orld', marks: { comment: 'c1' } }
			]);
		}
	});
});
