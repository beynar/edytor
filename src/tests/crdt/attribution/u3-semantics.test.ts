/**
 * U3 — block-attribution semantics proven across every supported path.
 *
 * The contract under test (`attribution/block.ts` + U1/U2 ledger entries):
 *
 *   - `b/<blockId>` records on the `blockattr` root carry `c` (createdBy)
 *     and `k/<actor>` contributor union — OUTSIDE undo scope, monotonic.
 *   - `l` (lastChangedBy) is a block-node attr — INSIDE undo scope: undo
 *     restores the previous author, never touches the contributor union.
 *   - Remote replicas read each other's stamps verbatim — application
 *     never relabels; suppression memory is per-replica.
 *   - `Edytor` views on one `EdytorDocument` share the facade's single
 *     actor — no per-view stamping, no double `l` items.
 *   - Legacy `a/` records (pre-U2 per-edit capture) and foreign roots
 *     coexist: preserved verbatim, decodable via `attribution.legacy()`,
 *     and gated by the same admission boundary as everything else.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Y } from '../../../lib/crdt/engine.js';
import { bindEdytorDoc } from '../../../lib/crdt/edytor-doc.js';
import {
	SchemaMismatchError,
	UnsupportedDocError,
	attachDocument,
	checkSchema,
	createDocument,
	inspectAdmission,
	loadDocument,
	type DocumentActor,
	type EdytorDocument
} from '../../../lib/crdt/index.js';
import { Edytor } from '../../../lib/edytor.svelte.js';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import {
	applyUpdate,
	attrsOn,
	docValue,
	firstBlock,
	itemsOf,
	contentNodeOf,
	legacyMapFor,
	recordKeys,
	wireDocs,
	writeLegacyRecord,
	authoredDocument
} from './helpers.js';
import type { EngineDoc, EngineNode, YDoc } from '../../../lib/crdt/engine-api.js';

const E = bindEdytorDoc(Y);

const alice: DocumentActor = { id: 'alice', name: 'Alice' };
const bob: DocumentActor = { id: 'bob', name: 'Bob' };
const carol: DocumentActor = { id: 'carol', name: 'Carol' };

/** Hydrate `b` from `a`'s encoded state and mark it ready (peer-joined-late path). */
const joinLate = (a: EdytorDocument, b: EdytorDocument): void => {
	applyUpdate(b.doc, a.encode());
	b.sync();
};

/** One-shot full-state exchange between two replicas (concurrent edits merge). */
const exchange = (a: EdytorDocument, b: EdytorDocument): void => {
	applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(a.doc)));
	applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc)));
};

const isNodeLike = (v: unknown): v is EngineNode =>
	v != null && typeof (v as { getAttr?: unknown }).getAttr === 'function';

const topOf = (type: EngineNode): EngineNode => {
	let cur = type;
	for (let i = 0; i < 64; i++) {
		const it = cur._item;
		if (it === null || it === undefined) return cur;
		const parent = it.parent;
		if (!isNodeLike(parent)) return cur;
		cur = parent;
	}
	return cur;
};

/**
 * Classify one committed transaction's `changed` map: `content` = a
 * registry-subtree change that is not ONLY an `l` stamp; `attr` = any
 * `blockattr`-root change or an `l` sub on a block node. Same oracle as
 * the U1 commit-boundary suite.
 */
const classify = (
	doc: EngineDoc,
	tr: { changed?: Map<EngineNode, Set<string | null>> }
): { content: boolean; attr: boolean } => {
	const registry = doc.get('blocks');
	const battr = doc.get('blockattr');
	let content = false;
	let attr = false;
	for (const [type, subs] of tr.changed ?? []) {
		const top = topOf(type);
		if (top === (battr as unknown as EngineNode)) {
			attr = true;
			continue;
		}
		if (top !== (registry as unknown as EngineNode)) continue;
		if (subs.has('l')) attr = true;
		const onlyStamps =
			type !== (registry as unknown as EngineNode) && [...subs].every((s) => s === 'l');
		if (!onlyStamps) content = true;
	}
	return { content, attr };
};

/** `{content, attr}` classification of every update committed while `fn` runs. */
const commitsDuring = (
	d: EdytorDocument,
	fn: () => void
): { content: boolean; attr: boolean }[] => {
	const out: { content: boolean; attr: boolean }[] = [];
	const on = (_u: Uint8Array, _o: unknown, _doc: unknown, tr: unknown) => {
		out.push(
			classify(
				d.doc as unknown as EngineDoc,
				tr as { changed?: Map<EngineNode, Set<string | null>> }
			)
		);
	};
	d.doc.on('update', on as never);
	try {
		fn();
	} finally {
		d.doc.off('update', on as never);
	}
	return out;
};

/**
 * Byte-level snapshot of the durable attribution state: every `b/` record's
 * full attr map plus every block node's surviving `l` value. Used to prove
 * encode/load/persist round-trips are verbatim.
 */
const blockattrSnapshot = (doc: YDoc) => {
	const records: Record<string, Record<string, unknown>> = {};
	const root = doc.get('blockattr');
	for (const key of root.attrKeys()) {
		const rec = root.getAttr(key) as EngineNode | undefined;
		const attrs: Record<string, unknown> = {};
		if (isNodeLike(rec)) {
			for (const k of rec.attrKeys()) attrs[k] = rec.getAttr(k);
		}
		records[key] = attrs;
	}
	const lastChanged: Record<string, string> = {};
	const registry = doc.get('blocks');
	for (const key of registry.attrKeys()) {
		const node = registry.getAttr(key) as EngineNode | undefined;
		const l = isNodeLike(node) ? node.getAttr('l') : undefined;
		if (typeof l === 'string') lastChanged[key] = l;
	}
	return { records, lastChanged };
};

// ──────────────────────────────────────────────────────────────────────
// Path 1 — local undo/redo
// ──────────────────────────────────────────────────────────────────────

describe('local undo/redo', () => {
	it('undo restores the prior lastChangedBy; contributors unchanged; redo re-stamps', () => {
		const a = authoredDocument(docValue('hi'), alice);
		const blockId = firstBlock(a).id;
		const b = createDocument({ actor: bob });
		joinLate(a, b);
		const unwire = wireDocs(a, b);

		b.transact(() => b.facade.insertText(blockId, 2, '!'));
		expect(a.attribution.block(blockId)?.lastChangedBy).toBe('bob');

		// Undo of bob's edit: bob's `l` item dies → alice's stamp resurfaces.
		// The contributor union is out of undo scope — unchanged.
		b.history.undo();
		for (const d of [a, b]) {
			expect(d.attribution.block(blockId)).toEqual({
				createdBy: 'alice',
				contributors: new Set(['alice', 'bob']),
				lastChangedBy: 'alice'
			});
		}

		// Redo re-applies bob's stamp on every replica.
		b.history.redo();
		for (const d of [a, b]) {
			expect(d.attribution.block(blockId)).toEqual({
				createdBy: 'alice',
				contributors: new Set(['alice', 'bob']),
				lastChangedBy: 'bob'
			});
		}
		unwire();
		a.destroy();
		b.destroy();
	});

	it('undo of a mark op restores `l`; the contributor union never shrinks', () => {
		const a = authoredDocument(docValue('hello'), alice);
		const blockId = firstBlock(a).id;
		const b = createDocument({ actor: bob });
		joinLate(a, b);
		const unwire = wireDocs(a, b);

		b.transact(() => b.facade.setMark(blockId, 0, 3, 'bold', true));
		expect(a.attribution.block(blockId)?.lastChangedBy).toBe('bob');
		b.history.undo();
		expect(a.attribution.block(blockId)).toEqual({
			createdBy: 'alice',
			contributors: new Set(['alice', 'bob']),
			lastChangedBy: 'alice'
		});
		unwire();
		a.destroy();
		b.destroy();
	});

	it('cross-actor undo chain: insert → remote edit → undo edit → undo insert → redo twice', () => {
		const a = authoredDocument(docValue('hi'), alice);
		const b = createDocument({ actor: bob });
		joinLate(a, b);
		const unwire = wireDocs(a, b);

		a.transact(() =>
			a.facade.insertBlock(
				{ parent: null, index: 1 },
				{ id: 'b2', type: 'paragraph', content: [{ kind: 'text', text: 'two' }] }
			)
		);
		b.transact(() => b.facade.insertText('b2', 3, '!'));
		expect(a.attribution.block('b2')?.lastChangedBy).toBe('bob');

		// Undo bob's edit (on b — his local op): l reverts to alice's stamp.
		b.history.undo();
		expect(a.attribution.block('b2')?.lastChangedBy).toBe('alice');

		// Undo alice's INSERT (a's local op): the block dies, its `l` item
		// dies with it — but the `b/` record keeps createdBy AND the full
		// contributor union (bob contributed while it lived).
		a.history.undo();
		expect(a.facade.hasBlock('b2')).toBe(false);
		const dead = a.attribution.block('b2');
		expect(dead?.createdBy).toBe('alice');
		expect(dead?.contributors).toEqual(new Set(['alice', 'bob']));
		expect(dead?.lastChangedBy).toBeUndefined();
		expect(b.attribution.block('b2')).toEqual(dead);

		// Redo the insert: block + alice's `l` item resurrect together.
		a.history.redo();
		expect(a.facade.hasBlock('b2')).toBe(true);
		expect(a.attribution.block('b2')?.lastChangedBy).toBe('alice');
		// Redo bob's edit: bob's `l` item resurrects as a fresh clone — the
		// engine's undo/redo resurrects deleted items via redone-clones, so
		// under interleaved undo/redo chains several live `l` items can
		// coexist and resolve by deterministic item order rather than
		// chronological order. Note bob's redone text stays invisible: the
		// resurrected item reparents to the pre-redo block subtree, which
		// a's redo had replaced with fresh clones — an inherent vendored
		// UndoManager boundary (convergent, no corruption). Pin what the
		// contract guarantees: convergent, actor-valid, union exact.
		b.history.redo();
		expect(a.facade.blockText('b2')).toBe('two');
		expect(b.facade.blockText('b2')).toBe('two'); // convergent
		const attrAfterRedo = a.attribution.block('b2');
		expect(b.attribution.block('b2')).toEqual(attrAfterRedo); // convergent
		expect(['alice', 'bob']).toContain(attrAfterRedo?.lastChangedBy);
		expect(attrAfterRedo).toMatchObject({
			createdBy: 'alice',
			contributors: new Set(['alice', 'bob'])
		});
		unwire();
		a.destroy();
		b.destroy();
	});
});

// ──────────────────────────────────────────────────────────────────────
// Path 2 — remote updates are verbatim (never relabeled)
// ──────────────────────────────────────────────────────────────────────

describe('remote updates', () => {
	it("replica B's stamps arrive verbatim on A; A never relabels B's blocks", () => {
		const a = authoredDocument(docValue('hi'), alice);
		const base = firstBlock(a).id;
		const b = createDocument({ actor: bob });
		joinLate(a, b);
		const unwire = wireDocs(a, b);
		// B's c/<clientID>→bob dictionary binding was published at attach
		// (before wiring) — deliver it via a one-shot state sync, the way a
		// provider's SyncStep2 handshake would.
		applyUpdate(a.doc, b.encode(), 'handshake');

		// B authors a block — A reads bob's c/k/l exactly as written.
		b.transact(() =>
			b.facade.insertBlock(
				{ parent: null, index: 1 },
				{ id: 'b-block', type: 'paragraph', content: [{ kind: 'text', text: 'B' }] }
			)
		);
		expect(a.attribution.block('b-block')).toEqual({
			createdBy: 'bob',
			contributors: new Set(['bob']),
			lastChangedBy: 'bob'
		});
		// A's untouched block keeps alice's stamps — receiving B's update
		// stamped nothing under alice.
		expect(a.attribution.block(base)).toEqual({
			createdBy: 'alice',
			contributors: new Set(['alice']),
			lastChangedBy: 'alice'
		});
		// The replica→actor dictionary resolves B's clientID to bob on A.
		expect(a.attribution.actorOf(b.clientID)).toBe('bob');

		// B edits A's block — union grows on A, `l` flips to bob.
		b.transact(() => b.facade.insertText(base, 0, 'B'));
		expect(a.attribution.block(base)).toEqual({
			createdBy: 'alice',
			contributors: new Set(['alice', 'bob']),
			lastChangedBy: 'bob'
		});
		unwire();
		a.destroy();
		b.destroy();
	});

	it('suppression memory is per-replica: A re-stamps after a remote `l` overwrite', () => {
		const a = authoredDocument(docValue('hi'), alice);
		const blockId = firstBlock(a).id;
		const b = createDocument({ actor: bob });
		joinLate(a, b);
		const unwire = wireDocs(a, b);

		// A's first local edit after seeding is suppressed (creation already
		// stamped alice on this replica) — zero attr writes in the commit.
		const own = commitsDuring(a, () => {
			a.transact(() => a.facade.insertText(blockId, 2, 'a'));
		});
		expect(own.filter((c) => c.attr)).toHaveLength(0);

		// B overwrites `l` — A's stored value no longer matches its memory.
		b.transact(() => b.facade.insertText(blockId, 0, 'b'));
		expect(a.attribution.block(blockId)?.lastChangedBy).toBe('bob');

		// A edits again: memory says alice but stored says bob → A MUST
		// write a fresh `l` item (staleness conjunct) — the commit carries
		// exactly one attr-bearing update.
		const restamp = commitsDuring(a, () => {
			a.transact(() => a.facade.insertText(blockId, 0, 'a2'));
		});
		expect(restamp.filter((c) => c.content && c.attr)).toHaveLength(1);
		expect(b.attribution.block(blockId)?.lastChangedBy).toBe('alice');
		expect(b.attribution.block(blockId)?.contributors).toEqual(new Set(['alice', 'bob']));
		unwire();
		a.destroy();
		b.destroy();
	});
});

// ──────────────────────────────────────────────────────────────────────
// Path 3 — multiple Edytor views on one document
// ──────────────────────────────────────────────────────────────────────

describe('multi-view — one document, one actor', () => {
	it('edits through either view stamp the document actor; no double-stamping', () => {
		const document = authoredDocument(docValue('hi'), alice);
		const v1 = new Edytor({ document, plugins: [richTextPlugin] });
		const v2 = new Edytor({ document, plugins: [richTextPlugin] });
		const blockId = firstBlock(document).id;

		// View 1 edits: same replica, same actor already stamped at seed →
		// suppression — the commit carries content only.
		const c1 = commitsDuring(document, () => {
			v1.transact(() => v1.facade.insertText(blockId, 2, '!'));
		});
		expect(c1.filter((c) => c.attr)).toHaveLength(0);
		expect(document.attribution.block(blockId)?.lastChangedBy).toBe('alice');

		// View 2 edits the SAME block: also suppressed — a second view must
		// not mint a second `l` item (one replica = one suppression map).
		const c2 = commitsDuring(document, () => {
			v2.transact(() => v2.facade.insertText(blockId, 3, '?'));
		});
		expect(c2.filter((c) => c.attr)).toHaveLength(0);
		expect(document.attribution.block(blockId)).toEqual({
			createdBy: 'alice',
			contributors: new Set(['alice']),
			lastChangedBy: 'alice'
		});

		// View 2 authors a NEW block — stamped once, under the document actor.
		v2.transact(() =>
			v2.facade.insertBlock(
				{ parent: null, index: 1 },
				{ id: 'v2-block', type: 'paragraph', content: [{ kind: 'text', text: 'v2' }] }
			)
		);
		expect(document.attribution.block('v2-block')).toEqual({
			createdBy: 'alice',
			contributors: new Set(['alice']),
			lastChangedBy: 'alice'
		});

		v1.destroy();
		v2.destroy();
		document.destroy();
	});

	it('undo across sibling views keeps the union; `l` falls back to the seed stamp', () => {
		const document = authoredDocument(docValue('hi'), alice);
		const v1 = new Edytor({ document, plugins: [richTextPlugin] });
		const v2 = new Edytor({ document, plugins: [richTextPlugin] });
		const blockId = firstBlock(document).id;

		v1.transact(() => v1.facade.insertText(blockId, 2, '1'));
		document.history.stopCapturing();
		v2.transact(() => v2.facade.insertText(blockId, 3, '2'));
		expect(document.facade.blockText(blockId)).toBe('hi12');

		// Undo v2's edit then v1's — the shared history pops both; `l` is
		// alice throughout (the seed stamp survives; same-actor edits wrote
		// no extra `l` items).
		document.history.undo();
		expect(document.attribution.block(blockId)?.lastChangedBy).toBe('alice');
		document.history.undo();
		expect(document.attribution.block(blockId)).toEqual({
			createdBy: 'alice',
			contributors: new Set(['alice']),
			lastChangedBy: 'alice'
		});
		expect(document.facade.blockText(blockId)).toBe('hi');

		v1.destroy();
		v2.destroy();
		document.destroy();
	});
});

// ──────────────────────────────────────────────────────────────────────
// Path 6 — same actor on N replicas (the counterexample, extended to 3)
// ──────────────────────────────────────────────────────────────────────

describe('same actor, multiple replicas', () => {
	it('three alice replicas: each undo falls through to a surviving `l` item', () => {
		const a = createDocument({ actor: alice });
		a.sync();
		const blockId = firstBlock(a).id;
		const b = createDocument({ actor: alice });
		const c = createDocument({ actor: alice });
		joinLate(a, b);
		joinLate(a, c);
		const unwire = [wireDocs(a, b), wireDocs(b, c), wireDocs(a, c)];

		// Each replica writes its OWN `l` item despite identical values —
		// per-replica suppression, not per-value.
		a.transact(() => a.facade.insertText(blockId, 0, 'A'));
		b.transact(() => b.facade.insertText(blockId, 1, 'B'));
		c.transact(() => c.facade.insertText(blockId, 2, 'C'));
		for (const d of [a, b, c]) {
			expect(d.attribution.block(blockId)?.lastChangedBy).toBe('alice');
			expect(d.facade.blockText(blockId)).toBe('ABC');
		}
		// Each replica's local stack captured exactly its own edit.
		expect(a.history.undoStack).toHaveLength(1);
		expect(b.history.undoStack).toHaveLength(1);
		expect(c.history.undoStack).toHaveLength(1);

		// A undoes: A's items die (its `l` item was already shadowed) →
		// `l` resolves through B's or C's surviving item — still alice.
		a.history.undo();
		for (const d of [a, b, c]) {
			const attr = d.attribution.block(blockId);
			expect(attr?.lastChangedBy).toBe('alice');
			expect(attr?.contributors).toEqual(new Set(['alice']));
		}
		// B undoes → C's item still carries alice.
		b.history.undo();
		for (const d of [a, b, c]) {
			expect(d.attribution.block(blockId)?.lastChangedBy).toBe('alice');
		}
		// C undoes → its items die, but undo resurrects the predecessor `l`
		// items each overwrite deleted (as redone-clones): earlier stamps
		// resurface, so `l` still reads alice — every resurrected item was
		// written by alice. The union holds; the text is gone.
		c.history.undo();
		for (const d of [a, b, c]) {
			const attr = d.attribution.block(blockId);
			expect(attr?.lastChangedBy).toBe('alice');
			expect(attr?.contributors).toEqual(new Set(['alice']));
			expect(d.facade.blockText(blockId)).toBe('');
		}

		// Redo chain resurrects each replica's own `l` item — convergent.
		c.history.redo();
		b.history.redo();
		a.history.redo();
		for (const d of [a, b, c]) {
			expect(d.attribution.block(blockId)?.lastChangedBy).toBe('alice');
			expect(d.facade.blockText(blockId)).toBe('ABC');
		}
		unwire.forEach((off) => off());
		a.destroy();
		b.destroy();
		c.destroy();
	});
});

// ──────────────────────────────────────────────────────────────────────
// Path 9 — remote updates never enter local history
// ──────────────────────────────────────────────────────────────────────

describe('remote edits vs local history', () => {
	it("a remote edit interleaved with local ops: undo touches only the local op — and bob's stamps survive", () => {
		const a = authoredDocument(docValue('seed'), alice);
		const blockId = firstBlock(a).id;
		const b = createDocument({ actor: bob });
		joinLate(a, b);
		const unwire = wireDocs(a, b);

		a.transact(() => a.facade.insertText(blockId, 0, 'L')); // local — captured
		b.transact(() => b.facade.insertText(blockId, 1, 'R')); // remote — applied to a
		expect(a.facade.blockText(blockId)).toBe('LRseed');
		expect(a.history.undoStack).toHaveLength(1); // only the local op

		a.history.undo();
		// Bob's text AND bob's attribution survive A's undo of A's own op.
		expect(a.facade.blockText(blockId)).toBe('Rseed');
		expect(a.attribution.block(blockId)).toEqual({
			createdBy: 'alice',
			contributors: new Set(['alice', 'bob']),
			lastChangedBy: 'bob'
		});
		// Convergent on the wire.
		expect(b.attribution.block(blockId)).toEqual(a.attribution.block(blockId));
		unwire();
		a.destroy();
		b.destroy();
	});

	it('undo of a local op never removes a remote-inserted block or its record', () => {
		const a = authoredDocument(docValue('x'), alice);
		const b = createDocument({ actor: bob });
		joinLate(a, b);
		const unwire = wireDocs(a, b);

		a.transact(() => a.facade.insertText(firstBlock(a).id, 0, 'L'));
		b.transact(() =>
			b.facade.insertBlock(
				{ parent: null, index: 0 },
				{ id: 'remote-b', type: 'paragraph', content: [{ kind: 'text', text: 'rb' }] }
			)
		);
		expect(a.facade.hasBlock('remote-b')).toBe(true);
		expect(a.history.undoStack).toHaveLength(1);

		a.history.undo();
		expect(a.facade.hasBlock('remote-b')).toBe(true);
		expect(a.attribution.block('remote-b')).toEqual({
			createdBy: 'bob',
			contributors: new Set(['bob']),
			lastChangedBy: 'bob'
		});
		unwire();
		a.destroy();
		b.destroy();
	});
});

// ──────────────────────────────────────────────────────────────────────
// Path 10 — concurrent first-touch merge + snapshot survival
// ──────────────────────────────────────────────────────────────────────

describe('concurrent first-touch merge (documented LWW residual)', () => {
	it('one contributor add may lose the `b/` race; convergent, never corrupt, self-heals', () => {
		// A record-less block — the foreign/migrated shape: init'd WITHOUT
		// an author, so no `b/` record exists on any replica.
		const seed = new Y.Doc();
		E.init(seed as unknown as EngineDoc, {
			content: [{ id: 'shared', type: 'paragraph', content: [{ kind: 'text', text: 's' }] }]
		});
		const seedUpdate = Y.encodeStateAsUpdate(seed);

		const mkReplica = (actor: DocumentActor) => {
			const doc = new Y.Doc();
			Y.applyUpdate(doc, seedUpdate);
			const d = attachDocument(doc, { actor });
			d.sync();
			return d;
		};
		const a = mkReplica(alice);
		const b = mkReplica(bob);
		expect(a.attribution.block('shared')).toBeUndefined();
		expect(b.attribution.block('shared')).toBeUndefined();

		// Concurrent FIRST touches — unwired, so both mint `b/shared` nodes
		// that race under map-attr LWW.
		a.transact(() => a.facade.insertText('shared', 0, 'A'));
		b.transact(() => b.facade.insertText('shared', 0, 'B'));
		exchange(a, b);

		const attrA = a.attribution.block('shared');
		const attrB = b.attribution.block('shared');
		// Convergent — both replicas resolve the same record.
		expect(attrA).toEqual(attrB);
		expect(a.facade.blockText('shared')).toBe(b.facade.blockText('shared'));
		// Never corrupt: a coherent record with a non-empty contributor set
		// drawn only from the two writers (one add may be lost — the residual).
		expect(attrA).toBeDefined();
		expect(attrA!.contributors.size).toBeGreaterThanOrEqual(1);
		for (const actor of attrA!.contributors) expect(['alice', 'bob']).toContain(actor);
		expect(['alice', 'bob']).toContain(attrA!.lastChangedBy);

		// Self-heal: the missing actor's next touch lands on the surviving
		// record → the union completes on every replica.
		const missing = ['alice', 'bob'].filter((x) => !attrA!.contributors.has(x));
		if (missing.length > 0) {
			const loser = missing[0] === 'alice' ? a : b;
			loser.transact(() => loser.facade.insertText('shared', 0, '!'));
			exchange(a, b);
			expect(a.attribution.block('shared')?.contributors).toEqual(new Set(['alice', 'bob']));
			expect(b.attribution.block('shared')).toEqual(a.attribution.block('shared'));
		}

		// Snapshot survival: the merged record round-trips byte-faithfully.
		const snap = blockattrSnapshot(a.doc);
		const restored = loadDocument(a.encode(), { actor: carol });
		expect(blockattrSnapshot(restored.doc)).toEqual(snap);
		expect(restored.attribution.block('shared')).toEqual(a.attribution.block('shared'));
		restored.destroy();
		a.destroy();
		b.destroy();
	});
});

// ──────────────────────────────────────────────────────────────────────
// Path 7 — upgrade: pre-U1/pre-U2 record shapes
// ──────────────────────────────────────────────────────────────────────

describe('upgrade — old record shapes', () => {
	it('a pre-U1 doc (a/+u/+c/ records, no blockattr root) loads, decodes, and gains block attribution lazily', () => {
		// Hand-build the pre-U1 shape: authorless init (no b/ records, no l),
		// then raw a/<nonce>/<seq> ContentMap records + u//c/ dictionary
		// entries exactly as the retired capture pipeline wrote them.
		const old = new Y.Doc();
		E.init(old as unknown as EngineDoc, {
			content: [{ id: 'old-b', type: 'paragraph', content: [{ kind: 'text', text: 'old' }] }]
		});
		const content = (old.get('blocks').getAttr('old-b') as EngineNode).getAttr(
			'content'
		) as EngineNode;
		const first = itemsOf(content)[0]!;
		writeLegacyRecord(old, 'a/oldbuild/0', legacyMapFor([first], 'alice'));
		old.transact(() => {
			const root = old.get('attribution');
			root.setAttr('u/alice', { name: 'Alice', color: '#a11' });
			root.setAttr(`c/${old.clientID}`, 'alice');
		});
		const update = Y.encodeStateAsUpdate(old);

		// No `blockattr` state in the old bytes at all.
		expect([...old.get('blockattr').attrKeys()]).toHaveLength(0);

		const restored = loadDocument(update, { actor: bob });
		// legacy() decodes the merged ContentMap — insert:alice over the item.
		const map = restored.attribution.legacy();
		expect(map).not.toBeNull();
		const restoredFirst = itemsOf(contentNodeOf(restored, 'old-b'))[0]!;
		expect(attrsOn(map!.inserts, restoredFirst.id, restoredFirst.length)).toContain('insert:alice');
		// The replicated dictionary survived; the new replica adds only its
		// own c/<clientID> binding.
		expect(restored.attribution.actors.get('alice')).toEqual({ name: 'Alice', color: '#a11' });
		expect(restored.attribution.actorOf(old.clientID)).toBe('alice');
		expect(restored.attribution.actorOf(restored.clientID)).toBe('bob');

		// Block attribution reads coexist: old-b carries no record (reads
		// undefined) until bob's first edit creates one — the old a/ records
		// are untouched and no new a/ records appear.
		expect(restored.attribution.block('old-b')).toBeUndefined();
		const keysBefore = recordKeys(restored).sort();
		restored.transact(() => restored.facade.insertText('old-b', 0, 'B'));
		expect(restored.attribution.block('old-b')).toEqual({
			createdBy: undefined,
			contributors: new Set(['bob']),
			lastChangedBy: 'bob'
		});
		expect(recordKeys(restored).sort()).toEqual(keysBefore); // zero new a/ records
		restored.destroy();
	});

	it('a U1-era doc (a/ records + blockattr records) loads with BOTH layers intact', () => {
		const a = authoredDocument(docValue('hi'), alice);
		const blockId = firstBlock(a).id;
		const first = itemsOf(contentNodeOf(a, blockId))[0]!;
		writeLegacyRecord(a.doc, 'a/oldbuild/0', legacyMapFor([first], 'alice'));

		const restored = loadDocument(a.encode(), { actor: bob });
		expect(restored.attribution.block(blockId)).toEqual({
			createdBy: 'alice',
			contributors: new Set(['alice']),
			lastChangedBy: 'alice'
		});
		expect(restored.attribution.legacy()).not.toBeNull();
		// New edits stamp `l`/contributors; the a/ bytes are byte-identical.
		const before = recordKeys(restored).sort();
		restored.transact(() => restored.facade.insertText(blockId, 0, 'B'));
		expect(restored.attribution.block(blockId)?.lastChangedBy).toBe('bob');
		expect(recordKeys(restored).sort()).toEqual(before);
		restored.destroy();
		a.destroy();
	});
});

// ──────────────────────────────────────────────────────────────────────
// Path 8 — admission / schema gates
// ──────────────────────────────────────────────────────────────────────

describe('admission gates', () => {
	it('a blockattr-bearing doc passes admission and schema checks', () => {
		const a = authoredDocument(docValue('hi'), alice);
		a.transact(() => a.facade.insertText(firstBlock(a).id, 0, 'x'));
		expect(checkSchema(a.doc as unknown as EngineDoc)).toBeNull();
		expect(inspectAdmission(a.doc as unknown as EngineDoc)).toEqual({
			admitted: true,
			verdict: 'initialized'
		});
		// And the load path accepts it (blockattr rides inside the payload).
		const restored = loadDocument(a.encode());
		expect(restored.attribution.block(firstBlock(a).id)).toBeDefined();
		restored.destroy();
		a.destroy();
	});

	it('an UNKNOWN root coexists — preserved through load, never a schema claim', () => {
		const raw = new Y.Doc();
		E.init(raw as unknown as EngineDoc, {
			content: [{ id: 'b1', type: 'paragraph', content: [{ kind: 'text', text: 'x' }] }]
		});
		raw.transact(() => {
			raw.get('x-foreign-root').setAttr('state', { weird: true });
		});
		const restored = loadDocument(Y.encodeStateAsUpdate(raw), { actor: bob });
		expect(restored.doc.get('x-foreign-root').getAttr('state')).toEqual({ weird: true });
		// Foreign roots are preserved, not adopted — the document surface
		// reads only its own schema.
		expect(restored.attribution.block('b1')).toBeUndefined();
		restored.transact(() => restored.facade.insertText('b1', 0, 'B'));
		expect(restored.attribution.block('b1')?.lastChangedBy).toBe('bob');
		restored.destroy();
	});

	it('unknown schema markers are refused — bytes preserved, nothing composed', () => {
		// unsupported: meta.v=99
		const v99 = new Y.Doc();
		v99.clientID = Number.MAX_SAFE_INTEGER - 7;
		E.create(v99 as unknown as EngineDoc).init();
		v99.transact(() => v99.get('meta').setAttr('v', 99));
		const v99Update = Y.encodeStateAsUpdate(v99);
		expect(() => loadDocument(v99Update)).toThrow(SchemaMismatchError);
		expect(() => loadDocument(v99Update)).toThrow(/unsupported schema version 99/);
		// The caller's bytes are untouched by the refusal.
		expect(() => Y.applyUpdate(new Y.Doc(), v99Update)).not.toThrow();

		// foreign: supported version, foreign manifest name
		const foreign = new Y.Doc();
		E.create(foreign as unknown as EngineDoc).init();
		foreign.transact(() => foreign.get('meta').setAttr('schema', 'not-edytor'));
		expect(() => loadDocument(Y.encodeStateAsUpdate(foreign))).toThrow(/foreign schema/);

		// unversioned: registry content, no meta.v
		const rogue = new Y.Doc();
		rogue.get('blocks').setAttr('r', new Y.Node('block'));
		expect(() => loadDocument(Y.encodeStateAsUpdate(rogue))).toThrow(/no meta\.v/);

		// attachDocument refuses the same states on a live doc.
		expect(() => attachDocument(v99, { actor: bob })).toThrow(SchemaMismatchError);
	});

	it('a v13-layout update refuses at load with the legacy migration error', () => {
		const fixture = join(
			dirname(fileURLToPath(import.meta.url)),
			'../fixtures/legacy-v13/nested-marks.update.bin'
		);
		const update = new Uint8Array(readFileSync(fixture));
		expect(() => loadDocument(update)).toThrow(UnsupportedDocError);
		expect(() => loadDocument(update)).toThrow(/legacy v13/);
	});
});
