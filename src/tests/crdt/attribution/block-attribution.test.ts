/**
 * U1 — compact per-BLOCK attribution contract.
 *
 * Every block-level change records durable actor ids — never replica
 * clientIDs — under `b/<blockId>` records on the `blockattr` root
 * (`c` createdBy, `k/<actor>` contributor union) plus the `l`
 * lastChangedBy attr on the block node itself. All writes commit INSIDE
 * the owning op's transaction — one update carries content+metadata.
 */
import { describe, expect, it } from 'vitest';
import { Y } from '../../../lib/crdt/engine.js';
import { bindEdytorDoc } from '../../../lib/crdt/edytor-doc.js';
import { applyUpdate, docValue, firstBlock, wireDocs, authoredDocument } from './helpers.js';
import {
	attachDocument,
	createDocument,
	loadDocument,
	type DocumentActor,
	type EdytorDocument
} from '../../../lib/crdt/index.js';
import type { EngineDoc, EngineNode } from '../../../lib/crdt/engine-api.js';

const alice: DocumentActor = { id: 'alice', name: 'Alice' };
const bob: DocumentActor = { id: 'bob', name: 'Bob' };

const joinLate = (a: EdytorDocument, b: EdytorDocument): void => {
	applyUpdate(b.doc, a.encode());
	b.sync();
};

const isNodeLike = (v: unknown): v is EngineNode =>
	v != null && typeof (v as { getAttr?: unknown }).getAttr === 'function';

/** The topmost type on `type`'s item-parent chain (a doc root). */
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
 * `blockattr`-root change or an `l` sub on a block node.
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

/** Collect `{content, attr}` classifications for every update during `fn`. */
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

describe('block attribution — creation and identity', () => {
	// D-3 / R13 §2.1: `createDocument({value})` applies the deterministic
	// seed update — identical on every replica, so it carries no actor.
	it('createDocument({value}) seeds without an attribution stamp', () => {
		const d = createDocument({ value: docValue('hi'), actor: alice });
		expect(d.attribution.block(firstBlock(d).id)).toBeUndefined();
		d.destroy();
	});

	it('authored initial content is attributed to its author', () => {
		const d = authoredDocument(docValue('hi'), alice);
		const block = firstBlock(d);
		expect(d.attribution.block(block.id)).toEqual({
			createdBy: 'alice',
			contributors: new Set(['alice']),
			lastChangedBy: 'alice'
		});
		d.destroy();
	});

	it('the auto-created bootstrap block is system-made — no attribution', () => {
		const d = createDocument({ actor: alice });
		d.sync();
		const block = firstBlock(d);
		expect(d.attribution.block(block.id)).toBeUndefined();
		d.destroy();
	});

	it('facade insertBlock authors the whole spec subtree', () => {
		const d = createDocument({ actor: alice });
		d.sync();
		d.transact(() =>
			d.facade.insertBlock(
				{ parent: null, index: 0 },
				{
					id: 'parent',
					type: 'paragraph',
					content: [{ kind: 'text', text: 'p' }],
					children: [{ id: 'kid', type: 'paragraph', content: [{ kind: 'text', text: 'k' }] }]
				}
			)
		);
		for (const id of ['parent', 'kid']) {
			expect(d.attribution.block(id)).toEqual({
				createdBy: 'alice',
				contributors: new Set(['alice']),
				lastChangedBy: 'alice'
			});
		}
		d.destroy();
	});
});

describe('block attribution — content and metadata edits', () => {
	it('a second actor editing content joins contributors and takes lastChangedBy', () => {
		const a = authoredDocument(docValue('hi'), alice);
		const blockId = firstBlock(a).id;
		const b = createDocument({ actor: bob });
		joinLate(a, b);
		const unwire = wireDocs(a, b);
		b.transact(() => b.facade.insertText(blockId, 2, '!'));
		const attr = a.attribution.block(blockId);
		expect(attr).toEqual({
			createdBy: 'alice',
			contributors: new Set(['alice', 'bob']),
			lastChangedBy: 'bob'
		});
		expect(b.attribution.block(blockId)).toEqual(attr);
		unwire();
		a.destroy();
		b.destroy();
	});

	it('inline insert/remove and setInlineData stamp the block', () => {
		const a = authoredDocument(docValue('hi'), alice);
		const blockId = firstBlock(a).id;
		const b = createDocument({ actor: bob });
		joinLate(a, b);
		const unwire = wireDocs(a, b);
		b.transact(() => b.facade.insertInline(blockId, 2, { id: 'm1', type: 'mention' }));
		expect(a.attribution.block(blockId)?.lastChangedBy).toBe('bob');
		b.transact(() => b.facade.setInlineData(blockId, 'm1', { k: 1 }));
		expect(a.attribution.block(blockId)?.lastChangedBy).toBe('bob');
		// Same-value inline data rewrite → suppressed: no commit at all.
		const noopCommits = commitsDuring(b, () => {
			b.transact(() => expect(b.facade.setInlineData(blockId, 'm1', { k: 1 })).toBe(true));
		});
		expect(noopCommits.filter((c) => c.attr || c.content)).toHaveLength(0);
		b.transact(() => b.facade.removeInline(blockId, 'm1'));
		const attr = a.attribution.block(blockId);
		expect(attr?.lastChangedBy).toBe('bob');
		expect(attr?.contributors).toEqual(new Set(['alice', 'bob']));
		unwire();
		b.destroy();
		a.destroy();
	});

	it('mark writes stamp the block; same-value and no-mark writes are suppressed', () => {
		const d = authoredDocument(docValue('hello'), alice);
		const blockId = firstBlock(d).id;
		d.transact(() => d.facade.setMark(blockId, 0, 3, 'bold', true));
		expect(d.attribution.block(blockId)?.lastChangedBy).toBe('alice');

		// Same-value mark rewrite: the engine writes zero items → no
		// commit at all (no content, no attribution).
		const dupCommits = commitsDuring(d, () => {
			d.transact(() => d.facade.setMark(blockId, 0, 3, 'bold', true));
		});
		expect(dupCommits.filter((c) => c.attr || c.content)).toHaveLength(0);

		// formatRange with identical marks → same suppression.
		const fmtCommits = commitsDuring(d, () => {
			d.transact(() => d.facade.formatRange(blockId, 0, 3, { bold: true }));
		});
		expect(fmtCommits.filter((c) => c.attr || c.content)).toHaveLength(0);

		// unsetMark for a mark the range doesn't carry → semantic no-op.
		const unCommits = commitsDuring(d, () => {
			d.transact(() => d.facade.unsetMark(blockId, 0, 3, 'italic'));
		});
		expect(unCommits.filter((c) => c.attr || c.content)).toHaveLength(0);

		// clearMarks over a range carrying no marks → early true, no write.
		const clearCommits = commitsDuring(d, () => {
			d.transact(() => expect(d.facade.clearMarks(blockId, 3, 2)).toBe(true));
		});
		expect(clearCommits.filter((c) => c.attr || c.content)).toHaveLength(0);

		// A REAL mark change still stamps.
		d.transact(() => d.facade.unsetMark(blockId, 0, 3, 'bold'));
		expect(d.attribution.block(blockId)?.lastChangedBy).toBe('alice');
		expect(d.attribution.block(blockId)?.contributors).toEqual(new Set(['alice']));

		// Empty-range format → false → no stamp write.
		const before = d.attribution.block(blockId);
		expect(d.facade.formatRange(blockId, 99, 10, { italic: true })).toBe(false);
		expect(d.attribution.block(blockId)).toEqual(before);
		d.destroy();
	});

	it('setBlockType / setBlockData stamp on change and suppress same-value writes', () => {
		const a = authoredDocument(docValue('hi'), alice);
		const blockId = firstBlock(a).id;
		const b = createDocument({ actor: bob });
		joinLate(a, b);
		const unwire = wireDocs(a, b);

		const commits = commitsDuring(b, () => {
			b.transact(() => b.facade.setBlockType(blockId, 'heading'));
		});
		expect(commits.filter((c) => c.content && c.attr)).toHaveLength(1);
		expect(a.attribution.block(blockId)?.lastChangedBy).toBe('bob');
		expect([...a.attribution.block(blockId)!.contributors].sort()).toEqual(['alice', 'bob']);

		// Same-value rewrite: fully suppressed — no content commit at all.
		const commits2 = commitsDuring(b, () => {
			b.transact(() => b.facade.setBlockType(blockId, 'heading'));
		});
		expect(commits2.filter((c) => c.content || c.attr)).toHaveLength(0);
		expect(a.attribution.block(blockId)?.lastChangedBy).toBe('bob');

		b.transact(() => b.facade.setBlockData(blockId, { x: 1 }));
		expect(a.attribution.block(blockId)?.lastChangedBy).toBe('bob');
		const commits3 = commitsDuring(b, () => {
			b.transact(() => b.facade.setBlockData(blockId, { x: 1 }));
		});
		expect(commits3.filter((c) => c.content || c.attr)).toHaveLength(0);
		unwire();
		a.destroy();
		b.destroy();
	});

	it('setBlock content replacement stamps; DocBlock handle delegates the same', () => {
		const d = authoredDocument(docValue('hi'), alice);
		const blockId = firstBlock(d).id;
		d.transact(() => d.facade.setBlock(blockId, { content: [{ kind: 'text', text: 'new' }] }));
		expect(d.attribution.block(blockId)?.lastChangedBy).toBe('alice');
		// The typed-node surface sees the same record.
		expect(d.facade.block(blockId).attribution).toEqual(d.attribution.block(blockId));
		d.destroy();
	});
});

describe('block attribution — structure', () => {
	it('pure moves write no attribution (no `b/` or `l` writes in the commit)', () => {
		const a = authoredDocument(
			{
				children: [
					{ type: 'paragraph', id: 'one', content: [{ text: 'one' }] },
					{ type: 'paragraph', id: 'two', content: [{ text: 'two' }] }
				]
			},
			alice
		);
		const before = a.attribution.block('two');
		const commits = commitsDuring(a, () => {
			a.transact(() => a.facade.moveBlock('two', { parent: null, index: 0 }));
		});
		expect(commits.filter((c) => c.attr)).toHaveLength(0);
		expect(a.attribution.block('two')).toEqual(before);
		a.destroy();
	});

	it('nest/unnest write no attribution on the moved block or its parents', () => {
		const a = authoredDocument(
			{
				children: [
					{ type: 'paragraph', id: 'p', content: [{ text: 'p' }] },
					{ type: 'paragraph', id: 'c', content: [{ text: 'c' }] }
				]
			},
			alice
		);
		const commits = commitsDuring(a, () => {
			a.transact(() => a.facade.nestBlock('c', 'p'));
		});
		expect(commits.filter((c) => c.attr)).toHaveLength(0);
		expect(a.attribution.block('p')?.contributors).toEqual(new Set(['alice']));
		expect(a.attribution.block('c')?.contributors).toEqual(new Set(['alice']));
		a.destroy();
	});

	it('split: tail authored by splitter, inherits source contributors; source records the split', () => {
		const a = authoredDocument(docValue('onetwo'), alice);
		const src = firstBlock(a).id;
		const b = createDocument({ actor: bob });
		joinLate(a, b);
		const unwire = wireDocs(a, b);
		b.transact(() => b.facade.splitBlock(src, 3, 'tail'));
		const source = a.attribution.block(src);
		const tail = a.attribution.block('tail');
		expect(source?.lastChangedBy).toBe('bob');
		expect(source?.contributors).toEqual(new Set(['alice', 'bob']));
		expect(tail?.createdBy).toBe('bob');
		expect(tail?.lastChangedBy).toBe('bob');
		// Literal inherit: the tail's contributor set equals the source's
		// set at split time — the splitter's authorship is carried by
		// createdBy/lastChangedBy.
		expect(tail?.contributors).toEqual(new Set(['alice']));
		expect(b.attribution.block('tail')).toEqual(tail);
		unwire();
		a.destroy();
		b.destroy();
	});

	it('merge: survivor keeps createdBy, unions contributors, records merger', () => {
		const a = authoredDocument(
			{
				children: [
					{ type: 'paragraph', id: 'A', content: [{ text: 'aa' }] },
					{ type: 'paragraph', id: 'B', content: [{ text: 'bb' }] }
				]
			},
			alice
		);
		const b = createDocument({ actor: bob });
		joinLate(a, b);
		const unwire = wireDocs(a, b);
		// bob touches B so the absorbed block carries him as a contributor.
		b.transact(() => b.facade.insertText('B', 2, '!'));
		b.transact(() => b.facade.mergeBlocks('B', 'A'));
		const attr = a.attribution.block('A');
		expect(attr?.createdBy).toBe('alice');
		expect(attr?.lastChangedBy).toBe('bob');
		expect(attr?.contributors).toEqual(new Set(['alice', 'bob']));
		unwire();
		a.destroy();
		b.destroy();
	});

	it('duplicateBlock authors the copy under the duplicator', () => {
		const a = authoredDocument(docValue('hi'), alice);
		const src = firstBlock(a).id;
		const b = createDocument({ actor: bob });
		joinLate(a, b);
		wireDocs(a, b);
		b.transact(() => b.facade.duplicateBlock(src, (old) => `${old}-copy`));
		const copy = a.attribution.block(`${src}-copy`);
		expect(copy).toEqual({
			createdBy: 'bob',
			contributors: new Set(['bob']),
			lastChangedBy: 'bob'
		});
		a.destroy();
		b.destroy();
	});

	it('deleteBlock writes nothing; the record persists by block id', () => {
		const a = authoredDocument(docValue('hi'), alice);
		const blockId = firstBlock(a).id;
		const before = a.attribution.block(blockId);
		const commits = commitsDuring(a, () => {
			a.transact(() => a.facade.deleteBlock(blockId));
		});
		expect(commits.filter((c) => c.attr)).toHaveLength(0);
		expect(a.attribution.block(blockId)).toEqual(before);
		a.destroy();
	});
});

describe('block attribution — commit boundaries', () => {
	it('a typed keystroke commits content AND metadata in exactly one update', () => {
		const d = createDocument({ actor: alice });
		d.sync();
		const blockId = firstBlock(d).id;
		const commits = commitsDuring(d, () => {
			d.transact(() => d.facade.insertText(blockId, 0, 'x'));
		});
		// Exactly one update carries content+metadata together; no update
		// carries metadata alone (the legacy a/ capture's follow-up update
		// touches only the `attribution` root — classified neither).
		expect(commits.filter((c) => c.content && c.attr)).toHaveLength(1);
		expect(commits.filter((c) => c.attr && !c.content)).toHaveLength(0);
		d.destroy();
	});

	it('steady-state typing grows zero attribution bytes (suppression)', () => {
		const d = createDocument({ actor: alice });
		d.sync();
		const blockId = firstBlock(d).id;
		d.transact(() => d.facade.insertText(blockId, 0, 'x'));
		// Second keystroke: contributor already present, `l` already alice
		// on this replica → the commit carries NO attribution writes.
		const commits = commitsDuring(d, () => {
			d.transact(() => d.facade.insertText(blockId, 1, 'y'));
		});
		expect(commits.filter((c) => c.attr)).toHaveLength(0);
		expect(commits.filter((c) => c.content)).toHaveLength(1);
		d.destroy();
	});

	it('a compound document.transact batches several ops into one commit', () => {
		const d = createDocument({ actor: alice });
		d.sync();
		const blockId = firstBlock(d).id;
		const commits = commitsDuring(d, () => {
			d.transact(() => {
				d.facade.insertText(blockId, 0, 'x');
				d.facade.insertBlock(
					{ parent: null, index: 1 },
					{ id: 'b2', type: 'paragraph', content: [{ kind: 'text', text: 'y' }] }
				);
			});
		});
		expect(commits.filter((c) => c.content && c.attr)).toHaveLength(1);
		expect(commits.filter((c) => c.attr && !c.content)).toHaveLength(0);
		d.destroy();
	});
});

describe('block attribution — remote, load, unknown authors', () => {
	it("remote application never relabels: receivers read the author's stamp", () => {
		const a = authoredDocument(docValue('hi'), alice);
		const blockId = firstBlock(a).id;
		const b = createDocument({ actor: bob });
		joinLate(a, b);
		// b never wrote anything — the record is alice's, read back verbatim.
		expect(b.attribution.block(blockId)).toEqual({
			createdBy: 'alice',
			contributors: new Set(['alice']),
			lastChangedBy: 'alice'
		});
		a.destroy();
		b.destroy();
	});

	it('loadDocument preserves block attribution verbatim', () => {
		const a = authoredDocument(docValue('hi'), alice);
		const blockId = firstBlock(a).id;
		a.transact(() => a.facade.setMark(blockId, 0, 1, 'bold', true));
		const restored = loadDocument(a.encode(), { actor: bob });
		expect(restored.attribution.block(blockId)).toEqual({
			createdBy: 'alice',
			contributors: new Set(['alice']),
			lastChangedBy: 'alice'
		});
		restored.destroy();
		a.destroy();
	});

	it('blocks written without an actor stay unattributed (unknown stays unknown)', () => {
		// A raw facade without an actor writes no attribution at all.
		const doc = new Y.Doc();
		const facade = bindEdytorDoc(Y).create(doc as unknown as EngineDoc);
		facade.init({ content: [{ id: 'raw', type: 'paragraph' }] });
		expect(facade.blockAttribution('raw')).toBeUndefined();

		const d = attachDocument(doc, { actor: bob });
		d.sync();
		expect(d.attribution.block('raw')).toBeUndefined();
		// Bob editing later stamps only what he actually changed — the
		// unknown creator is never relabeled.
		d.transact(() => d.facade.insertText('raw', 0, 'x'));
		const attr = d.attribution.block('raw');
		expect(attr?.createdBy).toBeUndefined();
		expect(attr?.lastChangedBy).toBe('bob');
		expect([...attr!.contributors]).toEqual(['bob']);
		d.destroy();
	});

	it('init() called directly (import/seed path) writes no attribution', () => {
		const doc = new Y.Doc();
		const binding = bindEdytorDoc(Y);
		binding.init(doc as unknown as EngineDoc, {
			content: [{ id: 'seeded', type: 'paragraph' }]
		});
		const facade = binding.create(doc as unknown as EngineDoc);
		expect(facade.blockAttribution('seeded')).toBeUndefined();
	});
});
