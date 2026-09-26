/**
 * Block lineage ring — opt-in bounded history on `b/<id>` records.
 *
 * Contract under test (`lineage.depth` + `attribution.history`):
 * - a write that displaces the block's current `lastChangedBy` owner
 *   captures the pre-write subtree as `{actor, by, seq, block}` —
 *   "what this edit overwrote";
 * - same-actor edits append nothing (the ring stores transitions, not
 *   keystrokes), and refused/no-op writes append nothing;
 * - destructive events capture unconditionally: deletes and undo/redo
 *   displace state regardless of who owns `l`;
 * - the ring trims to `depth`, converges under concurrent appends, is
 *   incarnation-scoped (a reincarnated id starts fresh), and its public
 *   entries are deep copies;
 * - with no configured actor (or `depth: 0`) the facade performs zero
 *   lineage writes — byte-identical to the pre-feature schema.
 */
import { describe, expect, it } from 'vitest';
import { applyUpdate, docValue, firstBlock, wireDocs } from './helpers.js';
import { Y } from '../../../lib/crdt/engine.js';
import { blockRecordsOf, lineageOf } from '../../../lib/crdt/attribution/block.js';
import type { EngineDoc } from '../../../lib/crdt/engine-api.js';
import {
	attachDocument,
	createDocument,
	loadDocument,
	type DocumentActor,
	type EdytorDocument
} from '../../../lib/crdt/index.js';

const alice: DocumentActor = { id: 'alice', name: 'Alice' };
const bob: DocumentActor = { id: 'bob', name: 'Bob' };
const carol: DocumentActor = { id: 'carol', name: 'Carol' };

const textOf = (d: EdytorDocument, blockId: string) => d.facade.blockText(blockId);
const append = (d: EdytorDocument, blockId: string, text: string) => {
	d.transact(() => d.facade.insertText(blockId, textOf(d, blockId).length, text));
};
const historyOf = (d: EdytorDocument, blockId: string) => d.attribution.history(blockId);

const withLineage = (options: { actor: DocumentActor; depth?: number; text?: string }) =>
	createDocument({
		value: docValue(options.text ?? 'hello'),
		actor: options.actor,
		lineage: { depth: options.depth ?? 5 },
		history: { captureTimeout: 0 }
	});

describe('lineage — transition capture', () => {
	it('a displacing write appends the displaced pre-state', () => {
		const A = withLineage({ actor: alice });
		const blockId = firstBlock(A).id;

		append(A, blockId, '-alice'); // alice's own edits — no entries
		expect(historyOf(A, blockId)).toEqual([]);

		// Bob's replica joins and edits — displaces alice's `l`.
		const B = createDocument({ actor: bob, lineage: { depth: 5 }, history: { captureTimeout: 0 } });
		applyUpdate(B.doc, A.encode());
		B.sync();
		append(B, blockId, '-bob');

		const entries = historyOf(B, blockId);
		expect(entries).toHaveLength(1);
		expect(entries![0]).toMatchObject({ actor: 'alice', by: 'bob' });
		// The captured block is alice's pre-bob state.
		expect(entries![0].block.id).toBe(blockId);
		expect(entries![0].block.content).toEqual([{ text: 'hello-alice' }]);
		B.destroy();
		A.destroy();
	});

	it('same-actor edits across many ops append nothing', () => {
		const A = withLineage({ actor: alice });
		const blockId = firstBlock(A).id;
		append(A, blockId, '1');
		append(A, blockId, '2');
		A.transact(() => A.facade.setBlockData(blockId, { k: 1 }));
		A.transact(() => A.facade.setBlockType(blockId, 'heading'));
		expect(historyOf(A, blockId)).toEqual([]);
		A.destroy();
	});

	it('alternating handoffs accumulate one entry per transition', () => {
		const A = withLineage({ actor: alice });
		const B = createDocument({ actor: bob, lineage: { depth: 5 }, history: { captureTimeout: 0 } });
		applyUpdate(B.doc, A.encode());
		B.sync();
		const blockId = firstBlock(A).id;
		const unwire = wireDocs(A, B);

		append(B, blockId, '-b1'); // bob displaces alice → entry
		append(B, blockId, '-b2'); // bob again — no entry
		append(A, blockId, '-a1'); // alice displaces bob → entry
		const entries = historyOf(A, blockId);
		expect(entries).toHaveLength(2);
		expect(entries!.map((e) => `${e.actor}->${e.by}`)).toEqual(['alice->bob', 'bob->alice']);
		expect(entries![1].block.content).toEqual([{ text: 'hello-b1-b2' }]);
		unwire();
		A.destroy();
		B.destroy();
	});
});

describe('lineage — ring trim & convergence', () => {
	it('trims to depth, keeping the newest entries', () => {
		const A = withLineage({ actor: alice, depth: 2 });
		const B = createDocument({ actor: bob, lineage: { depth: 2 }, history: { captureTimeout: 0 } });
		applyUpdate(B.doc, A.encode());
		B.sync();
		const blockId = firstBlock(A).id;
		const unwire = wireDocs(A, B);

		append(B, blockId, '-b'); // entry 1: alice->bob
		append(A, blockId, '-a'); // entry 2: bob->alice
		append(B, blockId, '-b2'); // entry 3: alice->bob → evicts entry 1
		const entries = historyOf(A, blockId);
		expect(entries).toHaveLength(2);
		expect(entries!.map((e) => `${e.actor}->${e.by}`)).toEqual(['bob->alice', 'alice->bob']);
		unwire();
		A.destroy();
		B.destroy();
	});

	it('concurrent appends on two replicas converge to the same ring', () => {
		const A = withLineage({ actor: alice });
		const B = createDocument({ actor: bob, lineage: { depth: 5 }, history: { captureTimeout: 0 } });
		applyUpdate(B.doc, A.encode());
		B.sync();
		const blockId = firstBlock(A).id;
		// NOT wired — both edit concurrently, then sync.
		append(A, blockId, '-fromA'); // alice's own edit — no entry on A
		// bob displaces alice on B (B hasn't seen A's '-fromA' yet — l there
		// is still alice's seed stamp... alice's append rewrote l locally but
		// B's view still resolves alice → transition fires on B).
		append(B, blockId, '-fromB');
		applyUpdate(B.doc, A.encode());
		applyUpdate(A.doc, B.encode());
		B.sync();
		const ea = historyOf(A, blockId)!.map((e) => `${e.actor}->${e.by}`);
		const eb = historyOf(B, blockId)!.map((e) => `${e.actor}->${e.by}`);
		expect(ea).toEqual(eb);
		expect(ea.length).toBeGreaterThanOrEqual(1);
		A.destroy();
		B.destroy();
	});

	it('mixed depths: ONE retention policy — the watermark, on receipt AND append', () => {
		// The ring's bound is the MAX of surviving entries' `d`, enforced
		// identically on append, receive, and read. A shallow replica must
		// preserve a deeper writer's entries BOTH when it receives them and
		// when it appends — the bound only falls once the deepest entries
		// have themselves aged out.
		const A = withLineage({ actor: alice, depth: 5 });
		const B = createDocument({ actor: bob, lineage: { depth: 1 }, history: { captureTimeout: 0 } });
		applyUpdate(B.doc, A.encode());
		B.sync();
		const blockId = firstBlock(A).id;
		const unwire = wireDocs(A, B);

		// Alternate displacements: bob's entries carry d=1, alice's d=5.
		append(B, blockId, '-b1'); // e1 {by:bob, d:1}
		append(A, blockId, '-a1'); // e2 {by:alice, d:5}
		append(B, blockId, '-b2'); // e3 {by:bob, d:1}
		append(A, blockId, '-a2'); // e4 {by:alice, d:5}

		// THE sequence: the depth-1 replica appends — its own entry is
		// d=1 but the bound stays 5 while alice's d=5 entries survive.
		append(B, blockId, '-b3'); // e5 {by:bob, d:1} → ring=5, wm=5
		const seq = (d: EdytorDocument) => historyOf(d, blockId)!.map((e) => `${e.actor}->${e.by}`);
		expect(seq(A)).toEqual(seq(B));
		expect(seq(B)).toHaveLength(5);
		expect(seq(B)).toEqual(['alice->bob', 'bob->alice', 'alice->bob', 'bob->alice', 'alice->bob']);

		// Once every d=5 entry has aged out, the bound drops to the
		// surviving writers' depth — the ring self-shrinks, and both
		// replicas still agree. Alice stops writing; bob and a third
		// depth-1 peer alternate displacements (each append carries d=1).
		const C = createDocument({
			actor: carol,
			lineage: { depth: 1 },
			history: { captureTimeout: 0 }
		});
		applyUpdate(C.doc, A.encode());
		C.sync();
		// Pairwise wiring (wireDocs is two-doc + origin-filtered): C joins
		// A's existing A↔B link via its own pair — B↔C and C↔A.
		const unwireBC = wireDocs(B, C);
		const unwireCA = wireDocs(C, A);

		// 6 fresh d=1 transitions evict every older entry: ring keeps the
		// newest 5 while a d=5 survives, then collapses to 1 once all of
		// them are gone — convergent on every replica.
		for (let i = 0; i < 6; i++) {
			append(i % 2 === 0 ? C : B, blockId, `-x${i}`);
		}
		expect(seq(A)).toEqual(seq(B));
		expect(seq(B)).toEqual(seq(C));
		expect(seq(B)).toHaveLength(1);
		unwireBC();
		unwireCA();
		unwire();
		A.destroy();
		B.destroy();
		C.destroy();
	});
});

describe('lineage — restore & undo', () => {
	it('restoring an entry is an ordinary edit that itself lands an entry', () => {
		const A = withLineage({ actor: alice });
		const blockId = firstBlock(A).id;
		append(A, blockId, '-alice');

		const B = createDocument({ actor: bob, lineage: { depth: 5 }, history: { captureTimeout: 0 } });
		applyUpdate(B.doc, A.encode());
		B.sync();
		append(B, blockId, '-bob'); // captures alice's 'hello-alice'

		// Alice restores bob's displaced entry on HER replica — the stored
		// snapshot is canonical `JSONBlock` (un-tagged `content` items), so
		// the restore maps to `setBlock`'s kind-tagged ContentItem shape.
		applyUpdate(A.doc, B.encode());
		const entry = historyOf(A, blockId)![0]!;
		expect(textOf(A, blockId)).toBe('hello-alice-bob');
		A.transact(() =>
			A.facade.setBlock(blockId, {
				content: (entry.block.content ?? []).map((c) =>
					'text' in c
						? { kind: 'text' as const, text: c.text, marks: c.marks }
						: {
								kind: 'inline' as const,
								id: c.id!,
								type: c.type,
								data: c.data
							}
				)
			})
		);
		expect(textOf(A, blockId)).toBe('hello-alice');
		// The restore itself displaced bob's state → a new entry names it.
		const entries = historyOf(A, blockId)!;
		const last = entries[entries.length - 1]!;
		expect(last.by).toBe('alice');
		expect(last.block.content).toEqual([{ text: 'hello-alice-bob' }]);
		A.destroy();
		B.destroy();
	});

	it('undo of a displacing edit captures the state the undo destroys', () => {
		const A = withLineage({ actor: alice });
		const blockId = firstBlock(A).id;

		const B = createDocument({ actor: bob, lineage: { depth: 5 }, history: { captureTimeout: 0 } });
		applyUpdate(B.doc, A.encode());
		B.sync();
		const unwire = wireDocs(A, B);

		append(B, blockId, '-bob'); // entry 1 on the ring
		expect(textOf(A, blockId)).toBe('hello-bob');

		// Bob undoes his own edit — the replay destroys 'hello-bob',
		// which the ring must keep as "what undo displaced".
		B.history.undo();
		expect(textOf(B, blockId)).toBe('hello');
		const entries = historyOf(B, blockId)!;
		const last = entries[entries.length - 1]!;
		expect(last.by).toBe('bob');
		expect(last.block.content).toEqual([{ text: 'hello-bob' }]);

		// REDO the edit — the replay re-displaces 'hello' → a redo-side
		// entry captures it too.
		B.history.redo();
		expect(textOf(B, blockId)).toBe('hello-bob');
		const after = historyOf(B, blockId)!;
		expect(after[after.length - 1]!.by).toBe('bob');
		expect(after[after.length - 1]!.block.content).toEqual([{ text: 'hello' }]);
		unwire();
		A.destroy();
		B.destroy();
	});
});

describe('lineage — incarnation isolation & opt-out', () => {
	it('a deleted block keeps its ring; undo-resurrection keeps the same lineage', () => {
		const A = withLineage({ actor: alice });
		const blockId = firstBlock(A).id;
		const B = createDocument({ actor: bob, lineage: { depth: 5 }, history: { captureTimeout: 0 } });
		applyUpdate(B.doc, A.encode());
		B.sync();
		const unwire = wireDocs(A, B);

		append(B, blockId, '-bob'); // ring: [alice->bob]
		// Bob deletes the block — force-capture lands on the orphaned record.
		B.transact(() => B.facade.deleteBlock(blockId));
		const dead = historyOf(A, blockId)!;
		expect(dead).toHaveLength(2);
		expect(dead[1]!.by).toBe('bob');
		expect(dead[1]!.block.content).toEqual([{ text: 'hello-bob' }]);
		// Facade insert of an existing id is refused even when deleted —
		// reincarnation only ever happens via undo/redo (the `redone` line).
		expect(
			A.facade.insertBlock({ parent: null, index: 0 }, { id: blockId, type: 'paragraph' })
		).toBe(false);

		// Undo the delete: the block returns on the SAME incarnation line —
		// its record is adopted (`i` refreshed), so the ring persists.
		B.history.undo();
		expect(textOf(B, blockId)).toBe('hello-bob');
		const restored = historyOf(B, blockId)!;
		expect(restored.length).toBeGreaterThanOrEqual(2);
		expect(restored[0]).toMatchObject({ actor: 'alice', by: 'bob' });
		// And a later handoff appends onto the SAME ring.
		append(A, blockId, '-alice2');
		const grown = historyOf(B, blockId)!;
		expect(grown[grown.length - 1]!.by).toBe('alice');
		unwire();
		A.destroy();
		B.destroy();
	});

	it('blockRecordsOf enumerates deleted blocks — ring, stamps, incarnation', () => {
		// The DST dump barrier depends on this: a deleted block's record
		// must remain enumerable so a lost/diverging recovery snapshot on
		// a tombstoned block cannot escape cross-replica comparison.
		const A = withLineage({ actor: alice, depth: 5 });
		const blockId = firstBlock(A).id;
		const B = createDocument({ actor: bob, lineage: { depth: 5 }, history: { captureTimeout: 0 } });
		applyUpdate(B.doc, A.encode());
		B.sync();
		const unwire = wireDocs(A, B);

		append(B, blockId, '-bob');
		B.transact(() => B.facade.deleteBlock(blockId));

		for (const doc of [A, B]) {
			const records = blockRecordsOf(doc.doc as unknown as EngineDoc);
			const record = records.find((r) => r.id === blockId);
			// The tombstoned block's record is still present with its ring…
			expect(record, 'deleted block record must remain enumerable').toBeDefined();
			expect(record!.lineage!.length).toBeGreaterThanOrEqual(2);
			expect(record!.lineage!.at(-1)!.by).toBe('bob');
			// …carrying attribution and its incarnation stamp.
			expect(record!.attribution?.contributors).toContain('bob');
			expect(record!.incarnation).toMatch(/^\d+:\d+$/);
		}
		// …and identical across replicas — the property the dump barrier diffs.
		expect(blockRecordsOf(A.doc as unknown as EngineDoc)).toEqual(
			blockRecordsOf(B.doc as unknown as EngineDoc)
		);
		unwire();
		A.destroy();
		B.destroy();
	});

	it('depth 0 and missing actor perform zero lineage writes', () => {
		// depth 0 — never captures.
		const off = createDocument({
			value: docValue('x'),
			actor: alice,
			lineage: { depth: 0 }
		});
		const blockId = firstBlock(off).id;
		append(off, blockId, '1');
		expect(historyOf(off, blockId)).toEqual([]);

		// Byte-identity: a doc with lineage configured and an unattributed
		// foreign write produce no ring entries.
		const bare = createDocument({ value: docValue('x'), actor: alice });
		const bareId = firstBlock(bare).id;
		append(bare, bareId, '1');
		expect(historyOf(bare, bareId)).toEqual([]);
		off.destroy();
		bare.destroy();
	});

	it('public entries are deep copies — mutating them cannot corrupt state', () => {
		const A = withLineage({ actor: alice });
		const blockId = firstBlock(A).id;
		const B = createDocument({ actor: bob, lineage: { depth: 5 }, history: { captureTimeout: 0 } });
		applyUpdate(B.doc, A.encode());
		B.sync();
		append(B, blockId, '-bob');
		const e = historyOf(B, blockId)![0]!;
		(e.block as { content?: unknown[] }).content = [];
		(e.block.data as Record<string, unknown>).evil = true;
		const reread = historyOf(B, blockId)![0]!;
		expect(reread.block.content).toEqual([{ text: 'hello' }]);
		expect(reread.block.data).toEqual({});
		A.destroy();
		B.destroy();
	});

	it('the ring survives encode → loadDocument round-trips', () => {
		const A = withLineage({ actor: alice });
		const blockId = firstBlock(A).id;
		const B = createDocument({ actor: bob, lineage: { depth: 5 }, history: { captureTimeout: 0 } });
		applyUpdate(B.doc, A.encode());
		B.sync();
		append(B, blockId, '-bob');

		const restored = loadDocument(B.encode(), { actor: bob, lineage: { depth: 5 } });
		const entries = historyOf(restored, blockId);
		expect(entries).toHaveLength(1);
		expect(entries![0]).toMatchObject({ actor: 'alice', by: 'bob' });
		expect(entries![0].block.content).toEqual([{ text: 'hello' }]);
		restored.destroy();
		A.destroy();
		B.destroy();
	});
});

describe('lineage — coverage gaps', () => {
	it('merge captures BOTH sides: survivor pre-state + absorbed block final state', () => {
		const A = createDocument({
			value: {
				children: [
					{ type: 'paragraph', content: [{ text: 'one' }] },
					{ type: 'paragraph', content: [{ text: 'two' }] }
				]
			},
			actor: alice,
			lineage: { depth: 5 },
			history: { captureTimeout: 0 }
		});
		const [b1, b2] = A.facade.project().children;
		const B = createDocument({ actor: bob, lineage: { depth: 5 }, history: { captureTimeout: 0 } });
		applyUpdate(B.doc, A.encode());
		B.sync();
		const unwire = wireDocs(A, B);

		// Bob merges b2 INTO b1 — two captures: b1's displaced state on its
		// ring, b2's final state on its (now-orphaned) record.
		B.transact(() => B.facade.mergeBlocks(b2.id, b1.id));
		const intoRing = historyOf(A, b1.id)!;
		expect(intoRing).toHaveLength(1);
		expect(intoRing[0]).toMatchObject({ actor: 'alice', by: 'bob' });
		expect(intoRing[0].block.content).toEqual([{ text: 'one' }]);
		const fromRing = historyOf(A, b2.id)!;
		expect(fromRing[fromRing.length - 1]!.by).toBe('bob');
		expect(fromRing[fromRing.length - 1]!.block.content).toEqual([{ text: 'two' }]);
		unwire();
		A.destroy();
		B.destroy();
	});

	it('split captures the source block pre-split state', () => {
		const A = withLineage({ actor: alice });
		const blockId = firstBlock(A).id;
		append(A, blockId, ' world');
		const B = createDocument({ actor: bob, lineage: { depth: 5 }, history: { captureTimeout: 0 } });
		applyUpdate(B.doc, A.encode());
		B.sync();
		const unwire = wireDocs(A, B);

		B.transact(() => B.facade.splitBlock(blockId, 5, 'tail-1'));
		const ring = historyOf(A, blockId)!;
		expect(ring).toHaveLength(1);
		expect(ring[0]).toMatchObject({ actor: 'alice', by: 'bob' });
		// The captured subtree is the WHOLE pre-split source.
		expect(ring[0].block.content).toEqual([{ text: 'hello world' }]);
		// The tail is a fresh identity — no ring carried over.
		expect(historyOf(A, 'tail-1')).toEqual([]);
		unwire();
		A.destroy();
		B.destroy();
	});

	it('snapshot fidelity: marks, inline atoms, children and data survive in j', () => {
		const A = createDocument({
			value: {
				children: [
					{
						type: 'section',
						data: { collapsible: true, level: 2 },
						content: [
							{ text: 'plain ', marks: { bold: true } },
							{ type: 'mention', id: 'm1', data: { who: 'ada' } },
							{ text: ' tail' }
						],
						children: [
							{ type: 'paragraph', content: [{ text: 'kid one' }] },
							{ type: 'paragraph', content: [{ text: 'kid two' }] }
						]
					}
				]
			},
			actor: alice,
			lineage: { depth: 3 },
			history: { captureTimeout: 0 }
		});
		const blockId = firstBlock(A).id;
		const B = createDocument({ actor: bob, lineage: { depth: 3 }, history: { captureTimeout: 0 } });
		applyUpdate(B.doc, A.encode());
		B.sync();
		const unwire = wireDocs(A, B);
		append(B, blockId, '!');

		const j = historyOf(A, blockId)![0]!.block;
		expect(j.type).toBe('section');
		expect(j.data).toEqual({ collapsible: true, level: 2 });
		expect(j.content).toEqual([
			{ text: 'plain ', marks: { bold: true } },
			{ type: 'mention', id: 'm1', data: { who: 'ada' } },
			{ text: ' tail' }
		]);
		expect(j.children).toHaveLength(2);
		expect(j.children![0]!.content).toEqual([{ text: 'kid one' }]);
		unwire();
		A.destroy();
		B.destroy();
	});

	it('history() distinguishes unrecorded blocks (undefined) from empty rings ([])', () => {
		const A = withLineage({ actor: alice });
		expect(historyOf(A, 'never-existed')).toBeUndefined();
		expect(historyOf(A, firstBlock(A).id)).toEqual([]); // recorded (seeded) but no entries yet
		A.destroy();
	});

	it('attachDocument refuses a divergent lineage.depth on the same raw doc', () => {
		const A = withLineage({ actor: alice, depth: 4 });
		// Re-attaching the same raw doc with a different depth is a
		// SemanticConflictError — the live facade's capture depth is fixed.
		expect(() => attachDocument(A.doc, { actor: alice, lineage: { depth: 9 } })).toThrowError(
			/lineage\.depth/
		);
		// Same depth reattaches cleanly.
		const re = attachDocument(A.doc, { actor: alice, lineage: { depth: 4 } });
		expect(re).toBe(A);
		A.destroy();
	});

	it('a second REPLICA of the same actor is not a handoff', () => {
		const A = withLineage({ actor: alice });
		const blockId = firstBlock(A).id;
		// Same actor id, different replica (fresh clientID).
		const A2 = createDocument({
			actor: alice,
			lineage: { depth: 5 },
			history: { captureTimeout: 0 }
		});
		applyUpdate(A2.doc, A.encode());
		A2.sync();
		const unwire = wireDocs(A, A2);

		append(A2, blockId, '-sameActor');
		expect(historyOf(A, blockId)).toEqual([]);
		expect(historyOf(A2, blockId)).toEqual([]);
		unwire();
		A.destroy();
		A2.destroy();
	});

	it('keepChildren delete captures the pre-move subtree on the dead record', () => {
		const A = createDocument({
			value: {
				children: [
					{
						type: 'section',
						content: [{ text: 'parent' }],
						children: [{ type: 'paragraph', content: [{ text: 'kid' }] }]
					}
				]
			},
			actor: alice,
			lineage: { depth: 5 },
			history: { captureTimeout: 0 }
		});
		const parentId = firstBlock(A).id;
		const B = createDocument({ actor: bob, lineage: { depth: 5 }, history: { captureTimeout: 0 } });
		applyUpdate(B.doc, A.encode());
		B.sync();

		B.transact(() => B.facade.deleteBlock(parentId, { keepChildren: true }));
		// The capture ran BEFORE the child moves — the snapshot retains them.
		const dead = historyOf(B, parentId)!;
		const last = dead[dead.length - 1]!;
		expect(last.by).toBe('bob');
		expect(last.block.children).toHaveLength(1);
		expect(last.block.children![0]!.content).toEqual([{ text: 'kid' }]);
		A.destroy();
		B.destroy();
	});

	it('an unattributed (engine-level) block captures with `actor` absent', () => {
		// `createDocument` always assigns an actor (anonymous when
		// unconfigured), so the genuinely unattributed case is content
		// written below the facade — foreign/migrated/tooling inserts.
		const A = withLineage({ actor: alice });
		A.transact(() => {
			A.facade.model.insertBlock(
				A.doc as never,
				{ parent: null, index: 0 },
				{ id: 'foreign-1', type: 'paragraph', content: [{ kind: 'text', text: 'sys' }] }
			);
		});
		expect(A.attribution.block('foreign-1')).toBeUndefined(); // never stamped
		const B = createDocument({ actor: bob, lineage: { depth: 5 }, history: { captureTimeout: 0 } });
		applyUpdate(B.doc, A.encode());
		B.sync();

		append(B, 'foreign-1', '-b');
		const entries = historyOf(B, 'foreign-1')!;
		expect(entries).toHaveLength(1);
		expect(entries[0]!.actor).toBeUndefined();
		expect(entries[0]!.by).toBe('bob');
		expect(entries[0]!.block.content).toEqual([{ text: 'sys' }]);
		A.destroy();
		B.destroy();
	});

	it('depth 1 keeps exactly the latest displaced state', () => {
		const A = withLineage({ actor: alice, depth: 1 });
		const blockId = firstBlock(A).id;
		const B = createDocument({ actor: bob, lineage: { depth: 1 }, history: { captureTimeout: 0 } });
		applyUpdate(B.doc, A.encode());
		B.sync();
		const unwire = wireDocs(A, B);

		append(B, blockId, '-b');
		append(A, blockId, '-a');
		const entries = historyOf(A, blockId)!;
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ actor: 'bob', by: 'alice' });
		expect(entries[0].block.content).toEqual([{ text: 'hello-b' }]);
		unwire();
		A.destroy();
		B.destroy();
	});
});

describe('lineage — cap & validation regressions', () => {
	it('setBlock({children: []}) captures each removed child subtree', () => {
		// Children-replace deletes kids through the raw model path — each
		// must still land a forced capture on its own (soon-orphaned)
		// record, or a destructive edit leaves no recovery copy.
		const A = createDocument({
			value: {
				children: [
					{
						type: 'section',
						content: [{ text: 'parent' }],
						children: [
							{
								type: 'paragraph',
								content: [{ text: 'kid one' }],
								children: [{ type: 'paragraph', content: [{ text: 'grandkid' }] }]
							},
							{ type: 'paragraph', content: [{ text: 'kid two' }] }
						]
					}
				]
			},
			actor: alice,
			lineage: { depth: 5 },
			history: { captureTimeout: 0 }
		});
		const parent = firstBlock(A);
		const [k1, k2] = parent.children!;
		const B = createDocument({ actor: bob, lineage: { depth: 5 }, history: { captureTimeout: 0 } });
		applyUpdate(B.doc, A.encode());
		B.sync();

		B.transact(() => B.facade.setBlock(parent.id, { children: [] }));

		expect(firstBlock(B).children ?? []).toHaveLength(0);
		// Each removed kid's ring keeps its whole displaced subtree.
		const h1 = historyOf(B, k1.id)!;
		expect(h1).toHaveLength(1);
		expect(h1[0]).toMatchObject({ actor: 'alice', by: 'bob' });
		expect(h1[0]!.block.content).toEqual([{ text: 'kid one' }]);
		expect(h1[0]!.block.children![0]!.content).toEqual([{ text: 'grandkid' }]);
		const h2 = historyOf(B, k2.id)!;
		expect(h2).toHaveLength(1);
		expect(h2[0]!.block.content).toEqual([{ text: 'kid two' }]);
		// The parent's own state (type/data/content) is untouched — no entry.
		expect(historyOf(B, parent.id)).toEqual([]);
		A.destroy();
		B.destroy();
	});

	it('concurrent appends converge the STORED ring to the cap — visible and persisted', () => {
		// depth 1 on all three replicas; bob and carol each displace alice
		// while partitioned. The merged ring transiently holds 2 entries —
		// the watermark trim converges it back, and `history()` never
		// shows more than the cap either way.
		const A = withLineage({ actor: alice, depth: 1 });
		const blockId = firstBlock(A).id;
		const B = createDocument({ actor: bob, lineage: { depth: 1 }, history: { captureTimeout: 0 } });
		applyUpdate(B.doc, A.encode());
		B.sync();
		const C = createDocument({
			actor: carol,
			lineage: { depth: 1 },
			history: { captureTimeout: 0 }
		});
		applyUpdate(C.doc, A.encode());
		C.sync();

		append(B, blockId, '-b'); // {alice->bob}
		append(C, blockId, '-c'); // {alice->carol}
		const bState = B.encode(); // pre-merge bytes — carry exactly one entry
		const cState = C.encode();
		applyUpdate(A.doc, bState);
		applyUpdate(A.doc, cState);
		applyUpdate(B.doc, cState);
		applyUpdate(C.doc, bState);

		for (const d of [A, B, C]) {
			expect(historyOf(d, blockId)).toHaveLength(1);
			// The STORED ring converges to the watermark too — not just the
			// read-side cap.
			expect(lineageOf(d.doc as unknown as EngineDoc, blockId)).toHaveLength(1);
		}
		// All three retain the SAME surviving entry (deterministic trim).
		expect(historyOf(A, blockId)).toEqual(historyOf(B, blockId));
		expect(historyOf(B, blockId)).toEqual(historyOf(C, blockId));

		// Persisted state written BEFORE any trim-aware replica existed:
		// stage the over-cap ring on a bare engine doc (no facade → no
		// listener), then load it — the install-time sweep converges it.
		const raw = new Y.Doc();
		applyUpdate(raw as never, bState);
		applyUpdate(raw as never, cState);
		expect(lineageOf(raw as unknown as EngineDoc, blockId)).toHaveLength(2);
		const loaded = loadDocument(Y.encodeStateAsUpdate(raw), {
			actor: { id: 'dave' },
			lineage: { depth: 1 }
		});
		expect(lineageOf(loaded.doc as unknown as EngineDoc, blockId)).toHaveLength(1);
		expect(historyOf(loaded, blockId)).toHaveLength(1);
		loaded.destroy();
		A.destroy();
		B.destroy();
		C.destroy();
	});

	it('a shallow replica preserves a deeper writer’s entries on receive AND append', () => {
		// Mixed-depth swarm: B writes at depth 1, A at depth 20. ONE
		// retention policy — the entries' own watermark — governs receipt,
		// append, and read: B stores, keeps, and reads what A's depth
		// produced.
		const A = withLineage({ actor: alice, depth: 20 });
		const blockId = firstBlock(A).id;
		const B = createDocument({ actor: bob, lineage: { depth: 1 }, history: { captureTimeout: 0 } });
		applyUpdate(B.doc, A.encode());
		B.sync();
		const unwire = wireDocs(A, B);

		append(B, blockId, '-b1'); // d=1 entry
		append(A, blockId, '-a1'); // d=20 entry → A ring=2, B receives → wm=20 → keeps 2 stored
		const stored = lineageOf(B.doc as unknown as EngineDoc, blockId)!;
		expect(stored).toHaveLength(2);
		// Reads see the shared ring — not a per-replica slice of it.
		expect(historyOf(B, blockId)).toHaveLength(2);
		expect(historyOf(A, blockId)).toHaveLength(2);

		// B's own append must NOT trim to its local depth: its d=1 entry
		// appends while the watermark stays 20.
		append(B, blockId, '-b2');
		expect(lineageOf(B.doc as unknown as EngineDoc, blockId)).toHaveLength(3);
		expect(historyOf(B, blockId)).toHaveLength(3);
		expect(historyOf(B, blockId)).toEqual(historyOf(A, blockId));
		unwire();
		A.destroy();
		B.destroy();
	});

	it('invalid lineage.depth refuses at every entry path', () => {
		const bad = [Number.NaN, Number.POSITIVE_INFINITY, -1, 2.5];
		const seed = createDocument({ value: docValue('s'), actor: alice });
		const seedBytes = seed.encode();
		for (const depth of bad) {
			expect(() => createDocument({ actor: alice, lineage: { depth } })).toThrowError(RangeError);
			expect(() => loadDocument(seedBytes, { actor: alice, lineage: { depth } })).toThrowError(
				RangeError
			);
			expect(() => attachDocument(new Y.Doc(), { actor: alice, lineage: { depth } })).toThrowError(
				RangeError
			);
		}
		// …and on reattach the invalid value fails BEFORE the compat check
		// can mislabel it a conflict.
		const live = createDocument({ actor: alice, lineage: { depth: 3 } });
		expect(() => attachDocument(live.doc, { actor: alice, lineage: { depth: 2.5 } })).toThrowError(
			RangeError
		);
		// Boundaries still admit: off, and ordinary positive depths.
		expect(() => createDocument({ actor: alice, lineage: { depth: 0 } })).not.toThrow();
		expect(() => createDocument({ actor: alice, lineage: { depth: 1 } })).not.toThrow();
		seed.destroy();
		live.destroy();
	});
});
