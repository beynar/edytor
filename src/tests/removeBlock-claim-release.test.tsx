/** @jsxImportSource ./jsx */
import { describe, expect, it } from 'vitest';

import { createOperationEdytor } from './test.utils.js';

// Seam regression — a split block shares the source's backing text, so
// atoms typed at the new block's head land INSIDE the predecessor's slice
// claim window. They used to fall back to the covering claim when the block
// was deleted and re-surface in the sibling (observed as a duplicated seam
// char — 'abc!!d' — in collab DST seed 10's cross-block salvage). Since
// arch-v2 D1 (R3, D-14) a delete writes marks only and a deleted block's
// records keep hiding what they win; no content is tombstoned.
describe('removeBlock claim release', () => {
	it('does not leak head-typed atoms into the split predecessor', () => {
		const { edytor } = createOperationEdytor(
			<root>
				<paragraph>abcde</paragraph>
			</root>
		);
		const root = edytor.root!;
		const b0 = root.children[0];
		edytor.splitBlock(b0.id, 3, 'b1');
		const b1 = edytor.idToBlock.get('b1')!;
		expect(b0.firstText.stringContent).toBe('abc');
		expect(b1.firstText.stringContent).toBe('de');

		// Head-of-slice typing prepends into the shared backing text, inside
		// b0's covering claim window (b1's higher-generation record wins it
		// while b1 lives).
		edytor.facade.insertText(b1.id, 0, 'X');
		expect(b1.firstText.stringContent).toBe('Xde');
		expect(b0.firstText.stringContent).toBe('abc');

		edytor.deleteBlock(b1.id);
		// 'X' was b1's content — it must die with the block, not fall back
		// into b0's covering claim.
		expect(b0.firstText.stringContent).toBe('abc');
		expect(root.children).toHaveLength(1);
	});

	it('mid-seam inserts under a dead sibling cannot resurrect in the survivor', () => {
		const { edytor } = createOperationEdytor(
			<root>
				<paragraph>abcde</paragraph>
			</root>
		);
		const root = edytor.root!;
		const b0 = root.children[0];
		edytor.splitBlock(b0.id, 3, 'b1');
		const b1 = edytor.idToBlock.get('b1')!;

		// Several head inserts — every one lands inside b0's window.
		edytor.facade.insertText(b1.id, 0, '!');
		edytor.facade.insertText(b1.id, 0, 'Q');
		expect(b1.firstText.stringContent).toBe('Q!de');

		edytor.deleteBlock(b1.id);
		expect(b0.firstText.stringContent).toBe('abc');
		expect(root.children).toHaveLength(1);
	});

	it('undo restores the block AND its atoms — one capture removes the delete marks', () => {
		const { edytor } = createOperationEdytor(
			<root>
				<paragraph>abcde</paragraph>
			</root>
		);
		const root = edytor.root!;
		const b0 = root.children[0];
		edytor.splitBlock(b0.id, 3, 'b1');
		const b1 = edytor.idToBlock.get('b1')!;
		edytor.facade.insertText(b1.id, 0, 'X');
		edytor.undoManager.stopCapturing();

		edytor.deleteBlock(b1.id);
		expect(root.children).toHaveLength(1);
		expect(b0.firstText.stringContent).toBe('abc');

		edytor.undoManager.undo();
		expect(root.children).toHaveLength(2);
		expect(root.children[1].firstText.stringContent).toBe('Xde');
		expect(b0.firstText.stringContent).toBe('abc');
	});
});
