/**
 * U06 unit tests — the assembled `EdytorDoc` facade.
 *
 * Single-doc coverage of the unified operation surface: deterministic
 * bootstrap, schema/version record, canonical reads, the full op set,
 * island/void enforcement, identity discipline, and the JSON boundary.
 * Replica-side bootstrap/convergence lives in `scenarios/active-doc.ts`
 * (SY03); the event-driven mirror lives in `doc/mirror.test.ts`.
 */
// @ts-nocheck -- vendored upstream source is plain JS; checked structurally, not via types.
import { describe, expect, it } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { bindEdytorDoc, SCHEMA_VERSION, SCHEMA_NAME, META_KEY } from '../../../lib/crdt/index.js';
import { DEFAULT_SEED_ID } from '../default-seed.js';

const E = bindEdytorDoc(Y);

const newDoc = () => {
	const doc = new Y.Doc();
	doc.clientID = 7;
	return doc;
};

/** Count update events — the strongest "did this write?" signal. */
const updateCount = (doc) => {
	let n = 0;
	doc.on('update', () => n++);
	return () => n;
};

const seed = (ed) => {
	// b1 'hello world' | b2 'second' | b3 'parent' { b3a 'child a', b3b 'child b' }
	expect(
		ed.init({
			content: [
				{ id: 'b1', type: 'paragraph', content: [{ kind: 'text', text: 'hello world' }] },
				{
					id: 'b2',
					type: 'paragraph',
					content: [
						{ kind: 'text', text: 'second', marks: { bold: true } },
						{ kind: 'text', text: ' block' }
					]
				},
				{
					id: 'b3',
					type: 'list',
					content: [{ kind: 'text', text: 'parent' }],
					children: [
						{ id: 'b3a', type: 'paragraph', content: [{ kind: 'text', text: 'child a' }] },
						{ id: 'b3b', type: 'paragraph', content: [{ kind: 'text', text: 'child b' }] }
					]
				}
			]
		})
	);
	return ed;
};

const topIds = (ed) => ed.project().children.map((b) => b.id);
const kidIds = (ed, id) =>
	ed
		.project()
		.children.find((b) => b.id === id)
		?.children.map((b) => b.id);

// ── bootstrap / schema ────────────────────────────────────────────────────

describe('bootstrap + schema record', () => {
	it('init writes one canonical bootstrap block + the version record', () => {
		const doc = newDoc();
		E.init(doc);
		const ed = E.create(doc);
		expect(ed.isInitialized()).toBe(true);
		expect(ed.schemaVersion()).toBe(SCHEMA_VERSION);
		expect(topIds(ed)).toEqual([DEFAULT_SEED_ID]);
		expect(ed.project().children[0].type).toBe('paragraph');
		// The replicated record is on the meta root — readable by any replica.
		expect(doc.get(META_KEY).getAttr('v')).toBe(SCHEMA_VERSION);
		expect(doc.get(META_KEY).getAttr('schema')).toBe(SCHEMA_NAME);
	});

	it('init is idempotent — no duplicate bootstrap block', () => {
		const doc = newDoc();
		E.init(doc);
		E.init(doc);
		const ed = E.create(doc);
		expect(topIds(ed)).toEqual([DEFAULT_SEED_ID]);
		expect(ed.listBlockIds()).toEqual([DEFAULT_SEED_ID]);
	});

	it('init with content inserts the given spec (ids preserved)', () => {
		const doc = newDoc();
		E.init(doc, {
			content: [{ id: 'first', type: 'paragraph', content: [{ kind: 'text', text: 'hi' }] }]
		});
		const ed = E.create(doc);
		expect(topIds(ed)).toEqual(['first']);
		expect(ed.blockText('first')).toBe('hi');
	});

	it('init never downgrades a higher recorded version', () => {
		const doc = newDoc();
		doc.get(META_KEY).setAttr('v', 99);
		E.init(doc);
		expect(E.schemaVersion(doc)).toBe(99);
	});

	it('a replica reads the version record without ever calling init', () => {
		const a = newDoc();
		E.init(a);
		const replica = new Y.Doc();
		replica.clientID = 8;
		Y.applyUpdate(replica, Y.encodeStateAsUpdate(a));
		expect(E.schemaVersion(replica)).toBe(SCHEMA_VERSION);
		expect(E.isInitialized(replica)).toBe(true);
		// And the replica projects the bootstrap block without writing.
		const count = updateCount(replica);
		const ed = E.create(replica);
		expect(topIds(ed)).toEqual([DEFAULT_SEED_ID]);
		expect(count()).toBe(0);
	});

	it('read paths write nothing — projection, JSON, and observers are pure', () => {
		const doc = newDoc();
		const count = updateCount(doc);
		const ed = E.create(doc); // attaches the runs view — must not write
		ed.project();
		ed.toJSON();
		ed.listBlockIds();
		ed.isInitialized();
		ed.schemaVersion();
		ed.onChange(() => {}); // observer attach is read-only
		ed.subscribeBlock('ghost', () => {});
		expect(count()).toBe(0);
		ed.dispose();
	});
});

// ── structural ops ────────────────────────────────────────────────────────

describe('structural operations', () => {
	it('insert/move/nest/unnest preserve ids and engine identity', () => {
		const doc = newDoc();
		const ed = seed(E.create(doc));
		const idBefore = ed.crdtId('b1');
		expect(ed.insertBlock({ parent: null, index: 1 }, { id: 'x', type: 'paragraph' }).status).toBe(
			'applied'
		);
		expect(topIds(ed)).toEqual(['b1', 'x', 'b2', 'b3']);
		expect(ed.moveBlock('x', { parent: null, index: 0 }).status).toBe('applied');
		expect(topIds(ed)).toEqual(['x', 'b1', 'b2', 'b3']);
		expect(ed.nestBlock('x', 'b2').status).toBe('applied');
		expect(ed.positionOf('x')).toEqual({ parent: 'b2', index: 0 });
		expect(ed.unNestBlock('x').status).toBe('applied');
		expect(ed.positionOf('x')).toEqual({ parent: null, index: 2 });
		expect(ed.crdtId('b1')).toBe(idBefore); // untouched blocks keep identity
		// moving the moved block kept ITS identity too
		expect(ed.crdtId('x')).not.toBeNull();
	});

	it('moveBlocks relocates a group in one transaction', () => {
		const doc = newDoc();
		const ed = seed(E.create(doc));
		expect(ed.moveBlocks(['b1', 'b2'], { parent: 'b3', index: 1 }).status).toBe('applied');
		expect(topIds(ed)).toEqual(['b3']);
		expect(kidIds(ed, 'b3')).toEqual(['b3a', 'b1', 'b2', 'b3b']);
	});

	it('split keeps identity and moves the tail slice + children', () => {
		const doc = newDoc();
		const ed = seed(E.create(doc));
		const crdtB3 = ed.crdtId('b3');
		expect(ed.splitBlock('b3', 3, 'b3-tail').status).toBe('applied');
		expect(ed.blockText('b3')).toBe('par');
		expect(ed.blockText('b3-tail')).toBe('ent');
		// baseline split: children follow the tail
		expect(kidIds(ed, 'b3-tail')).toEqual(['b3a', 'b3b']);
		expect(kidIds(ed, 'b3')).toEqual([]);
		expect(ed.crdtId('b3')).toBe(crdtB3);
		expect(topIds(ed)).toEqual(['b1', 'b2', 'b3', 'b3-tail']);
	});

	it('mergeBlocks (engine primitive) claims content and adopts children', () => {
		const doc = newDoc();
		const ed = seed(E.create(doc));
		expect(ed.mergeBlocks('b3', 'b1').status).toBe('applied');
		expect(ed.blockText('b1')).toBe('hello worldparent');
		expect(kidIds(ed, 'b1')).toEqual(['b3a', 'b3b']);
		expect(topIds(ed)).toEqual(['b1', 'b2']);
		// b3 is hidden via the merge claim, not destroyed — undo restores it
		// (U04 contract): out of the projection but still a live registry node.
		expect(ed.positionOf('b3')).toBeNull();
		expect(ed.listBlockIds()).not.toContain('b3');
		expect(ed.resolveBlock('b3')).not.toBeNull();
	});

	it('mergeBackward unnests children to the vacated slot (baseline shape)', () => {
		const doc = newDoc();
		const ed = seed(E.create(doc));
		// b3 'parent' + children merges BACKWARD into b2 — its children must
		// unnest to b3's vacated root slot, NOT into b2.
		expect(ed.mergeBackward('b3').ids).toEqual(['b2']);
		expect(ed.blockText('b2')).toBe('second blockparent');
		expect(kidIds(ed, 'b2')).toEqual([]);
		expect(topIds(ed)).toEqual(['b1', 'b2', 'b3a', 'b3b']);
	});

	it('mergeBackward on a first child merges into the parent', () => {
		const doc = newDoc();
		const ed = seed(E.create(doc));
		expect(ed.mergeBackward('b3a').ids).toEqual(['b3']);
		expect(ed.blockText('b3')).toBe('parentchild a');
		expect(kidIds(ed, 'b3')).toEqual(['b3b']);
	});

	it('mergeBackward with no previous block merges forward when empty', () => {
		const doc = newDoc();
		const ed = seed(E.create(doc));
		// b1 has content → refused when it cannot go anywhere? b1 IS the first
		// block — baseline falls back to mergeForward only when EMPTY.
		expect(ed.mergeBackward('b1').status).toBe('refused');
		// Empty it, then retry → forward merge pulls b2 in.
		ed.deleteText('b1', 0, 'hello world'.length);
		expect(ed.mergeBackward('b1').ids).toEqual(['b1']);
		expect(ed.blockText('b1')).toBe('second block');
		expect(topIds(ed)).toEqual(['b1', 'b3']);
	});

	it('mergeForward pulls the next sibling in, unnesting its children', () => {
		const doc = newDoc();
		const ed = seed(E.create(doc));
		expect(ed.mergeForward('b2').ids).toEqual(['b2']);
		expect(ed.blockText('b2')).toBe('second blockparent');
		expect(topIds(ed)).toEqual(['b1', 'b2', 'b3a', 'b3b']);
	});

	it('deleteBlock keepChildren reparents children with identity preserved', () => {
		const doc = newDoc();
		const ed = seed(E.create(doc));
		const idA = ed.crdtId('b3a');
		const idB = ed.crdtId('b3b');
		expect(ed.deleteBlock('b3', { keepChildren: true }).status).toBe('applied');
		expect(topIds(ed)).toEqual(['b1', 'b2', 'b3a', 'b3b']);
		expect(ed.crdtId('b3a')).toBe(idA);
		expect(ed.crdtId('b3b')).toBe(idB);
	});

	it('deleteBlock without keepChildren hides the whole subtree', () => {
		const doc = newDoc();
		const ed = seed(E.create(doc));
		expect(ed.deleteBlock('b3').status).toBe('applied');
		expect(topIds(ed)).toEqual(['b1', 'b2']);
		expect(ed.listBlockIds()).not.toContain('b3a');
		expect(ed.resolveBlock('b3')).toBeNull(); // del flag set on the root
		expect(ed.positionOf('b3a')).toBeNull(); // b3a hidden with its parent
	});

	it('duplicateBlock copies a subtree under fresh ids, keeping the source', () => {
		const doc = newDoc();
		const ed = seed(E.create(doc));
		const newId = ed.duplicateBlock('b3', (old) => `${old}-copy`).ids[0];
		expect(newId).toBe('b3-copy');
		expect(topIds(ed)).toEqual(['b1', 'b2', 'b3', 'b3-copy']);
		expect(ed.blockText('b3-copy')).toBe('parent');
		expect(kidIds(ed, 'b3-copy')).toEqual(['b3a-copy', 'b3b-copy']);
		// source untouched
		expect(ed.blockText('b3')).toBe('parent');
		expect(kidIds(ed, 'b3')).toEqual(['b3a', 'b3b']);
	});

	it('setBlockType/setBlockData update the block in place', () => {
		const doc = newDoc();
		const ed = seed(E.create(doc));
		const idBefore = ed.crdtId('b1');
		expect(ed.setBlockType('b1', 'heading').status).toBe('applied');
		expect(ed.setBlockData('b1', { level: 2 }).status).toBe('applied');
		expect(ed.blockTypeOf('b1')).toBe('heading');
		expect(ed.blockDataOf('b1')).toEqual({ level: 2 });
		expect(ed.crdtId('b1')).toBe(idBefore);
	});

	it('setBlock replaces content/children wholesale (new-identity op)', () => {
		const doc = newDoc();
		const ed = seed(E.create(doc));
		expect(
			ed.setBlock('b1', {
				content: [
					{ kind: 'text', text: 'replaced ' },
					{ kind: 'inline', id: 'in1', type: 'mention', data: { u: 'a' } }
				],
				children: [{ id: 'nb', type: 'paragraph' }]
			}).status
		).toBe('applied');
		expect(ed.blockText('b1')).toBe('replaced ');
		expect(ed.project().children[0].content).toEqual([
			{ kind: 'text', text: 'replaced ' },
			{ kind: 'inline', id: 'in1', type: 'mention', data: { u: 'a' } }
		]);
		expect(kidIds(ed, 'b1')).toEqual(['nb']);
	});

	it('insertBlock refuses an already-used id (whole spec atomic)', () => {
		const doc = newDoc();
		const ed = seed(E.create(doc));
		expect(ed.insertBlock({ parent: null, index: 0 }, { id: 'b1', type: 'x' }).status).toBe(
			'refused'
		);
		expect(
			ed.insertBlock(
				{ parent: null, index: 0 },
				{
					id: 'ok',
					type: 'x',
					children: [{ id: 'b2', type: 'x' }]
				}
			).status
		).toBe('refused');
		expect(topIds(ed)).toEqual(['b1', 'b2', 'b3']);
	});
});

// ── content ops ───────────────────────────────────────────────────────────

describe('content operations', () => {
	it('insert/delete text and marks', () => {
		const doc = newDoc();
		const ed = seed(E.create(doc));
		expect(ed.insertText('b1', 0, 'XX').status).toBe('applied');
		expect(ed.blockText('b1')).toBe('XXhello world');
		expect(ed.deleteText('b1', 0, 2).status).toBe('applied');
		expect(ed.blockText('b1')).toBe('hello world');
		expect(ed.setMark('b1', 0, 5, 'italic', true).status).toBe('applied');
		expect(ed.unsetMark('b1', 0, 5, 'italic').status).toBe('applied');
		expect(ed.formatRange('b1', 0, 5, { italic: true, link: 'x' }).status).toBe('applied');
		expect(ed.clearMarks('b1', 0, 5).status).toBe('applied');
		expect(ed.project().children[0].content).toEqual([{ kind: 'text', text: 'hello world' }]);
	});

	it('inline atoms insert, carry data, update, remove', () => {
		const doc = newDoc();
		const ed = seed(E.create(doc));
		expect(ed.insertInline('b1', 5, { id: 'm1', type: 'mention', data: { u: 'x' } }).status).toBe(
			'applied'
		);
		expect(ed.project().children[0].content[1]).toEqual({
			kind: 'inline',
			id: 'm1',
			type: 'mention',
			data: { u: 'x' }
		});
		expect(ed.setInlineData('b1', 'm1', { u: 'y' }).status).toBe('applied');
		expect(ed.project().children[0].content[1].data).toEqual({ u: 'y' });
		expect(ed.removeInline('b1', 'm1').status).toBe('applied');
		expect(ed.blockText('b1')).toBe('hello world');
	});
});

// ── reads ─────────────────────────────────────────────────────────────────

describe('canonical reads', () => {
	it('positionOf / pathOf / ancestorsOf / parentOf', () => {
		const doc = newDoc();
		const ed = seed(E.create(doc));
		expect(ed.positionOf('b3a')).toEqual({ parent: 'b3', index: 0 });
		expect(ed.pathOf('b3b')).toEqual([2, 1]);
		expect(ed.ancestorsOf('b3a')).toEqual(['b3']);
		expect(ed.parentOf('b3b')).toBe('b3');
		expect(ed.parentOf('b1')).toBeNull();
		expect(ed.pathOf('ghost')).toBeNull();
	});

	it('childrenIds / displayLength / listBlockIds', () => {
		const doc = newDoc();
		const ed = seed(E.create(doc));
		expect(ed.childrenIds(null)).toEqual(['b1', 'b2', 'b3']);
		expect(ed.childrenIds('b3')).toEqual(['b3a', 'b3b']);
		expect(ed.displayLength('b1')).toBe(11);
		expect(ed.listBlockIds()).toEqual(['b1', 'b2', 'b3', 'b3a', 'b3b']);
	});
});

// ── island / void ─────────────────────────────────────────────────────────

describe('island/void enforcement', () => {
	const roles = { void: { void: true }, island: { island: true } };
	const roleOf = (t: string) => roles[t];

	const islandSeed = (ed) => {
		ed.init({
			content: [
				{ id: 'p1', type: 'paragraph', content: [{ kind: 'text', text: 'aaa' }] },
				{
					id: 'isl',
					type: 'island',
					content: [{ kind: 'text', text: 'island' }],
					children: [{ id: 'ic', type: 'paragraph', content: [{ kind: 'text', text: 'inner' }] }]
				},
				{ id: 'v1', type: 'void', content: [{ kind: 'text', text: 'caption' }] },
				{ id: 'p2', type: 'paragraph', content: [{ kind: 'text', text: 'bbb' }] }
			]
		});
		return ed;
	};

	it('void blocks reject children, splits and merges — but allow content edits', () => {
		const doc = newDoc();
		const ed = islandSeed(E.create(doc, { roleOf }));
		expect(ed.insertBlock({ parent: 'v1', index: 0 }, { id: 'n', type: 'paragraph' }).status).toBe(
			'refused'
		);
		expect(ed.moveBlock('p1', { parent: 'v1', index: 0 }).status).toBe('refused');
		expect(ed.nestBlock('p1', 'v1').status).toBe('refused');
		expect(ed.splitBlock('v1', 2, 'v-tail').status).toBe('refused');
		expect(ed.mergeBlocks('v1', 'p1').status).toBe('refused');
		expect(ed.mergeBlocks('p2', 'v1').status).toBe('refused');
		expect(ed.mergeBackward('v1').status).toBe('refused');
		// caption stays editable
		expect(ed.insertText('v1', 0, 'edited ').status).toBe('applied');
		expect(ed.blockText('v1')).toBe('edited caption');
	});

	it('island interior is sealed: no moves out, no moves in, no merges across', () => {
		const doc = newDoc();
		const ed = islandSeed(E.create(doc, { roleOf }));
		// inside → out
		expect(ed.moveBlock('ic', { parent: null, index: 0 }).status).toBe('refused');
		expect(ed.unNestBlock('ic').status).toBe('refused');
		// outside → in
		expect(ed.moveBlock('p1', { parent: 'isl', index: 1 }).status).toBe('refused');
		expect(ed.moveBlock('p1', { parent: 'ic', index: 0 }).status).toBe('refused');
		// merges across the boundary refused, interior merge allowed
		expect(ed.mergeBlocks('p1', 'ic').status).toBe('refused');
		expect(ed.mergeBlocks('ic', 'isl').status).toBe('applied'); // child merges into its island
		expect(ed.blockText('isl')).toBe('islandinner');
		// ...but building the interior via insertBlock is allowed
		expect(
			ed.insertBlock({ parent: 'isl', index: 0 }, { id: 'ic2', type: 'paragraph' }).status
		).toBe('applied');
		expect(kidIds(ed, 'isl')).toEqual(['ic2']);
	});

	it('merging an island unnests children and resets them to the default type', () => {
		const doc = newDoc();
		const ed = islandSeed(E.create(doc, { roleOf }));
		// ic is a 'paragraph' child; tag it to observe the reset.
		ed.setBlockType('ic', 'list');
		expect(ed.mergeBackward('isl').ids).toEqual(['p1']);
		expect(ed.blockText('p1')).toBe('aaaisland');
		// child unnested to the island's vacated slot and reset to 'paragraph'
		expect(topIds(ed)).toEqual(['p1', 'ic', 'v1', 'p2']);
		expect(ed.blockTypeOf('ic')).toBe('paragraph');
	});

	it('no roles configured → pure engine behavior (moves into any block allowed)', () => {
		const doc = newDoc();
		const ed = islandSeed(E.create(doc)); // no roleOf
		expect(ed.moveBlock('ic', { parent: null, index: 0 }).status).toBe('applied');
		expect(ed.moveBlock('p1', { parent: 'v1', index: 0 }).status).toBe('applied');
	});
});

// ── JSON boundary ─────────────────────────────────────────────────────────

describe('toJSON', () => {
	it('exports the baseline JSONDoc shape (data always present, empties omitted)', () => {
		const doc = newDoc();
		const ed = seed(E.create(doc));
		expect(ed.toJSON()).toEqual({
			children: [
				{ type: 'paragraph', id: 'b1', data: {}, content: [{ text: 'hello world' }] },
				{
					type: 'paragraph',
					id: 'b2',
					data: {},
					content: [{ text: 'second', marks: { bold: true } }, { text: ' block' }]
				},
				{
					type: 'list',
					id: 'b3',
					data: {},
					content: [{ text: 'parent' }],
					children: [
						{ type: 'paragraph', id: 'b3a', data: {}, content: [{ text: 'child a' }] },
						{ type: 'paragraph', id: 'b3b', data: {}, content: [{ text: 'child b' }] }
					]
				}
			]
		});
	});

	it('inline atoms serialize as {id, type, data}', () => {
		const doc = newDoc();
		const ed = seed(E.create(doc));
		ed.insertInline('b1', 5, { id: 'm1', type: 'mention', data: { u: 'x' } });
		const b1 = ed.toJSON().children[0];
		expect(b1.content).toEqual([
			{ text: 'hello' },
			{ id: 'm1', type: 'mention', data: { u: 'x' } },
			{ text: ' world' }
		]);
	});

	it('empty block serializes without content/children', () => {
		const doc = newDoc();
		E.init(doc);
		const ed = E.create(doc);
		expect(ed.toJSON()).toEqual({
			children: [{ type: 'paragraph', id: DEFAULT_SEED_ID, data: {} }]
		});
	});
});

// ── events smoke (full mirror coverage is mirror.test.ts) ────────────────

describe('onChange', () => {
	it('emits one semantic change per transaction, suppresses no-op writes', () => {
		const doc = newDoc();
		const ed = seed(E.create(doc));
		const seen = [];
		ed.onChange((c) => seen.push(c));
		ed.insertText('b1', 0, 'X');
		expect(seen).toHaveLength(1);
		expect(seen[0].local).toBe(true);
		expect(seen[0].content.has('b1')).toBe(true);
		// A meta-only write that does not change the projection is suppressed.
		const v = seen[0].version;
		doc.get(META_KEY).setAttr('unrelated', 1);
		expect(seen.every((c) => c.version <= v)).toBe(true);
	});

	it('emits DocChange for a claim-only merge commit even after a mid-transaction read', () => {
		// Regression: `syncTransaction`'s read-your-writes fold advances the
		// block recs mid-transaction — the browser delete path does exactly
		// this when the batch's post-merge selection write reads model state.
		// The commit-time claim refinement must compare against the COMMITTED
		// fingerprint, not the already-advanced rec, or a pure order change
		// (merge, move) is misclassified as record churn, keeps `fast` set,
		// and `diffFast` — which never diffs order — drops the commit: every
		// `onChange` subscriber (mirror, `edytor.value`, plugin hooks) misses it.
		const doc = newDoc();
		const ed = E.create(doc);
		ed.init({
			content: [
				{ id: 'a', type: 'paragraph', content: [{ kind: 'text', text: 'x' }] },
				{ id: 'b', type: 'paragraph', content: [{ kind: 'text', text: '' }] },
				{ id: 'c', type: 'paragraph', content: [{ kind: 'text', text: 'y' }] }
			]
		});
		const seen = [];
		ed.onChange((c) => seen.push(c));
		ed.transact(() => {
			expect(ed.mergeBackward('b').ids).toEqual(['a']);
			ed.project(); // modelCtx read — folds the in-flight claim write
		});
		expect(seen).toHaveLength(1);
		expect(seen[0].removed.has('b')).toBe(true);
		expect(seen[0].order.get(null)).toEqual(['a', 'c']);
	});
});
