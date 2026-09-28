/**
 * Adversarial review probes for the landed U1+U2 attribution work.
 * Each test encodes one contract violation found by source inspection;
 * citations are in the review report.
 */
import { describe, expect, it } from 'vitest';
import {
	applyUpdate,
	docValue,
	firstBlock,
	wireDocs,
	authoredDocument
} from '../attribution/helpers.js';
import {
	createDocument,
	type DocumentActor,
	type EdytorDocument
} from '../../../lib/crdt/index.js';

const alice: DocumentActor = { id: 'alice', name: 'Alice' };
const bob: DocumentActor = { id: 'bob', name: 'Bob' };

const joinLate = (a: EdytorDocument, b: EdytorDocument): void => {
	applyUpdate(b.doc, a.encode());
	b.sync();
};

const countUpdates = (document: EdytorDocument, fn: () => void): number => {
	let n = 0;
	const on = () => n++;
	document.doc.on('update', on);
	try {
		fn();
	} finally {
		document.doc.off('update', on);
	}
	return n;
};

/**
 * The review found an undone creation freed its id and the stale `b/` record
 * poisoned a re-creation. Since `hist.undo.withdraw` (2026-09-28) an undo
 * withdraws the block instead of deleting it: the id stays taken (like a
 * deleted block's), so a re-creation is refused and the record stays the
 * creator's.
 */
describe('review — an undone creation keeps its id and its record (hist.undo.withdraw)', () => {
	it('re-inserting an undone block id is refused; the record stays the creator’s', () => {
		const a = createDocument({ actor: alice });
		a.sync();
		const b = createDocument({ actor: bob });
		joinLate(a, b);
		const unwire = wireDocs(a, b);

		a.transact(() =>
			a.facade.insertBlock({ parent: null, index: 1 }, { id: 'shared', type: 'paragraph' })
		);
		expect(b.facade.hasBlock('shared')).toBe(true);

		// Undo propagates: the block is withdrawn (hidden, it holds nothing) on
		// every replica; its node and `b/shared` record stay.
		a.history.undo();
		expect(b.facade.isVisibleBlock('shared')).toBe(false);
		expect(b.facade.hasBlock('shared')).toBe(true);

		// Bob cannot create a block under the withdrawn block's id.
		const again = b.transact(() =>
			b.facade.insertBlock({ parent: null, index: 1 }, { id: 'shared', type: 'paragraph' })
		);
		expect(again.status).toBe('refused');
		expect(b.facade.isVisibleBlock('shared')).toBe(false);

		const attr = b.attribution.block('shared');
		expect(attr?.createdBy).toBe('alice');
		expect(attr?.contributors).toEqual(new Set(['alice']));
		expect(a.attribution.block('shared')).toEqual(attr);
		unwire();
		a.destroy();
		b.destroy();
	});
});

describe('review — setBlock content no-op stamps a phantom change', () => {
	it('setBlock(id, {content:[{text:""}]}) on an empty block stamps b/+l anyway', () => {
		const d = createDocument({ actor: alice });
		d.sync();
		const blockId = firstBlock(d).id; // bootstrap — empty, unattributed
		expect(d.attribution.block(blockId)).toBeUndefined();

		// The facade suppresses the SAME write through insertText('') — but
		// setBlock's guard counts array entries, not written atoms
		// (edytor-doc.ts:2318 `value.content.length > 0`).
		d.transact(() => d.facade.setBlock(blockId, { content: [{ kind: 'text', text: '' }] }));
		expect(d.attribution.block(blockId)).toBeUndefined(); // FAILS — k/alice + l=alice
		d.destroy();
	});
});

describe('review — insertText("") is not a clean no-op', () => {
	it('an empty insert at a segment boundary emits a real update (slice rewrite)', () => {
		const d = authoredDocument(docValue('hi'), alice);
		const blockId = firstBlock(d).id;
		// insertIntoText's inner===0 branch rewrites the covering slice
		// record at a bumped generation even when payload.length === 0
		// (text/model.ts:1338-1392).
		const updates = countUpdates(d, () => {
			d.transact(() => d.facade.insertText(blockId, 0, ''));
		});
		expect(updates).toBe(0); // FAILS — the slice rewrite is a real commit
		d.destroy();
	});
});

// Characterization (documents the delete-attribution gap — passes today):
describe('review — deletes are invisible to attribution', () => {
	it('deleteBlock leaves no trace of the deleter', () => {
		const a = authoredDocument(docValue('hi'), alice);
		const blockId = firstBlock(a).id;
		const b = createDocument({ actor: bob });
		joinLate(a, b);
		const unwire = wireDocs(a, b);
		b.transact(() => b.facade.deleteBlock(blockId));
		const attr = a.attribution.block(blockId);
		expect(attr?.contributors).toEqual(new Set(['alice'])); // bob absent — by design
		expect(attr?.lastChangedBy).toBe('alice');
		unwire();
		a.destroy();
		b.destroy();
	});
});
