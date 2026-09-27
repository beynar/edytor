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

describe('review — undo frees the id but the stale b/ record poisons re-creation', () => {
	it("re-inserting an undone block id keeps the dead block's createdBy/contributors", () => {
		const a = createDocument({ actor: alice });
		a.sync();
		const b = createDocument({ actor: bob });
		joinLate(a, b);
		const unwire = wireDocs(a, b);

		a.transact(() =>
			a.facade.insertBlock({ parent: null, index: 1 }, { id: 'shared', type: 'paragraph' })
		);
		expect(b.facade.hasBlock('shared')).toBe(true);

		// Undo propagates — the registry item dies on every replica, but the
		// `b/shared` record (outside undo scope) survives carrying c/k alice.
		a.history.undo();
		expect(b.facade.hasBlock('shared')).toBe(false);

		// Bob creates a FRESH block under the recycled id.
		b.transact(() =>
			b.facade.insertBlock({ parent: null, index: 1 }, { id: 'shared', type: 'paragraph' })
		);
		expect(b.facade.hasBlock('shared')).toBe(true);

		const attr = b.attribution.block('shared');
		expect(attr?.createdBy).toBe('bob'); // FAILS — still 'alice'
		expect(attr?.contributors).toEqual(new Set(['bob'])); // FAILS — phantom 'alice'
		expect(attr?.lastChangedBy).toBe('bob');
		// The misattribution is convergent — every replica reads it wrong.
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
