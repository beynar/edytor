/** @jsxImportSource ./jsx */
import { describe, expect, it } from 'vitest';

import { createOperationEdytor } from './test.utils.js';

// Seam regression — a split block shares the source's backing text, so
// atoms typed at the new block's head land INSIDE the predecessor's slice
// claim window. `model.delete` only hides the block: its released atoms
// fell back to the covering claim and re-surfaced in the sibling
// (observed as a duplicated seam char — 'abc!!d' — in collab DST seed
// 10's cross-block salvage). `removeBlock` must tombstone the doomed
// block's displayed content first.
describe('removeBlock claim release', () => {
	it('does not leak head-typed atoms into the split predecessor', () => {
		const { edytor } = createOperationEdytor(
			<root>
				<paragraph>abcde</paragraph>
			</root>
		);
		const root = edytor.root!;
		const b0 = root.children[0];
		const b1 = b0.splitBlock({ index: 3, text: b0.firstText })!;
		expect(b0.firstText.stringContent).toBe('abc');
		expect(b1.firstText.stringContent).toBe('de');

		// Head-of-slice typing prepends into the shared backing text, inside
		// b0's covering claim window (b1's higher-generation record wins it
		// while b1 lives).
		b1.firstText.insertAt(0, 'X');
		expect(b1.firstText.stringContent).toBe('Xde');
		expect(b0.firstText.stringContent).toBe('abc');

		b1.removeBlock();
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
		const b1 = b0.splitBlock({ index: 3, text: b0.firstText })!;

		// Several head inserts — every one lands inside b0's window.
		b1.firstText.insertAt(0, '!');
		b1.firstText.insertAt(0, 'Q');
		expect(b1.firstText.stringContent).toBe('Q!de');

		b1.removeBlock();
		expect(b0.firstText.stringContent).toBe('abc');
		expect(root.children).toHaveLength(1);
	});

	it('undo restores the block AND its atoms — tombstones ride the same capture', () => {
		const { edytor } = createOperationEdytor(
			<root>
				<paragraph>abcde</paragraph>
			</root>
		);
		const root = edytor.root!;
		const b0 = root.children[0];
		const b1 = b0.splitBlock({ index: 3, text: b0.firstText })!;
		b1.firstText.insertAt(0, 'X');
		edytor.undoManager.stopCapturing();

		b1.removeBlock();
		expect(root.children).toHaveLength(1);
		expect(b0.firstText.stringContent).toBe('abc');

		edytor.undoManager.undo();
		expect(root.children).toHaveLength(2);
		expect(root.children[1].firstText.stringContent).toBe('Xde');
		expect(b0.firstText.stringContent).toBe('abc');
	});
});
