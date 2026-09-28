/** @jsxImportSource ../../jsx */
/**
 * U8a — native selection write dedupe + emit fanout dedupe.
 *
 * The selection path used to rewrite the DOM selection
 * (removeAllRanges + addRange — each a synchronous layout trigger in
 * real browsers) on EVERY programmatic setter call, and re-emit
 * `onSelectionChange` (+ the awareness publish) for every derive that
 * produced an identical selection. These tests pin:
 *
 *  - a second write to the same caret/range performs ZERO native
 *    selection mutations while still re-deriving model state;
 *  - a write to a DIFFERENT position still performs the native write;
 *  - identical re-derives do not re-notify `onSelectionChange`;
 *  - a changed selection still notifies once.
 */
import { describe, expect, test, vi } from 'vitest';
import {
	renderDomEdytor,
	flushDomUpdates,
	setNativeSelection,
	dragSelection,
	expectNativeSelection
} from '../../dom/test.utils.js';

const selectionSpies = () => {
	const selection = document.getSelection() ?? window.getSelection();
	const proto = Object.getPrototypeOf(selection!);
	return {
		addRange: vi.spyOn(proto, 'addRange'),
		removeAllRanges: vi.spyOn(proto, 'removeAllRanges'),
		setBaseAndExtent: vi.spyOn(proto, 'setBaseAndExtent')
	};
};

describe('U8a — native selection write dedupe', () => {
	test('setAtTextOffset to the already-set caret performs no native writes', async () => {
		const rendered = await renderDomEdytor(
			<root>
				<paragraph>hello world</paragraph>
			</root>,
			{ autoSelectFixture: false }
		);
		const { edytor } = rendered;
		const text = edytor.root!.children[0]!.firstText!;
		const spies = selectionSpies();
		try {
			await edytor.selection.setAtTextOffset(text, 3);
			await flushDomUpdates();
			expect(spies.addRange).toHaveBeenCalled();
			expect(edytor.selection.state.yStart).toBe(3);
			expect(edytor.selection.state.isCollapsed).toBe(true);

			spies.addRange.mockClear();
			spies.removeAllRanges.mockClear();
			spies.setBaseAndExtent.mockClear();

			// Same caret again — the live selection already matches, so no
			// native mutation may run; the model re-derive still lands.
			await edytor.selection.setAtTextOffset(text, 3);
			await flushDomUpdates();
			expect(spies.addRange).not.toHaveBeenCalled();
			expect(spies.removeAllRanges).not.toHaveBeenCalled();
			expect(spies.setBaseAndExtent).not.toHaveBeenCalled();
			expect(edytor.selection.state.yStart).toBe(3);

			// A different offset still writes natively.
			await edytor.selection.setAtTextOffset(text, 5);
			await flushDomUpdates();
			expect(spies.addRange).toHaveBeenCalled();
			expect(edytor.selection.state.yStart).toBe(5);
			expectNativeSelection({ collapsed: true, anchorOffset: 5 });
		} finally {
			spies.addRange.mockRestore();
			spies.removeAllRanges.mockRestore();
			spies.setBaseAndExtent.mockRestore();
		}
	});

	test('setAtRange covering the live selection performs no native writes', async () => {
		const rendered = await renderDomEdytor(
			<root>
				<paragraph>hello world</paragraph>
			</root>,
			{ autoSelectFixture: false }
		);
		const { edytor } = rendered;
		const text = edytor.root!.children[0]!.firstText!;
		await setNativeSelection(edytor, text, 2, text, 7);
		const spies = selectionSpies();
		try {
			await edytor.selection.setAtRange(text, 2, text, 7);
			await flushDomUpdates();
			expect(spies.addRange).not.toHaveBeenCalled();
			expect(spies.removeAllRanges).not.toHaveBeenCalled();
			expect(spies.setBaseAndExtent).not.toHaveBeenCalled();
			expect(edytor.selection.state.yStart).toBe(2);
			expect(edytor.selection.state.yEnd).toBe(7);
			expect(edytor.selection.state.isCollapsed).toBe(false);
		} finally {
			spies.addRange.mockRestore();
			spies.removeAllRanges.mockRestore();
			spies.setBaseAndExtent.mockRestore();
		}
	});

	test('setAtRange with a reversed target still writes when the live selection is forward', async () => {
		const rendered = await renderDomEdytor(
			<root>
				<paragraph>hello world</paragraph>
			</root>,
			{ autoSelectFixture: false }
		);
		const { edytor } = rendered;
		const text = edytor.root!.children[0]!.firstText!;
		await setNativeSelection(edytor, text, 2, text, 7);
		const spies = selectionSpies();
		try {
			// Direction is part of the match: requesting the same range
			// REVERSED must not be deduped against the forward live
			// selection (a plain boundary match would silently drop the
			// direction change).
			await edytor.selection.setAtRange(text, 2, text, 7, { isReversed: true });
			await flushDomUpdates();
			const nativeWrites =
				spies.addRange.mock.calls.length + spies.setBaseAndExtent.mock.calls.length;
			expect(nativeWrites).toBeGreaterThan(0);
			expect(edytor.selection.state.isReversed).toBe(true);
		} finally {
			spies.addRange.mockRestore();
			spies.removeAllRanges.mockRestore();
			spies.setBaseAndExtent.mockRestore();
		}
	});

	// Lexical #1482 analogue: when a programmatic write is deduped (the
	// DOM already matches), WebKit fires no `selectionchange` echo, so a
	// boolean "ignore next" flag would stay raised and could swallow the
	// NEXT real user selectionchange. The current design is safe — the
	// flag only suppresses while an inline-atom selection is live, and
	// every site that raises it has just cleared that set — these tests
	// pin the non-swallow invariant.
	test('after a deduped write, the next real caret selectionchange is adopted', async () => {
		const rendered = await renderDomEdytor(
			<root>
				<paragraph>hello world</paragraph>
			</root>,
			{ autoSelectFixture: false }
		);
		const { edytor } = rendered;
		const text = edytor.root!.children[0]!.firstText!;
		await edytor.selection.setAtTextOffset(text, 2);
		await flushDomUpdates();

		// The programmatic write was deduped → no echo arrived; the user's
		// real selectionchange is a gesture, adopted (no ignore flag, V5).
		await setNativeSelection(edytor, text, 8);

		expect(edytor.selection.state.yStart).toBe(8);
		expect(edytor.selection.state.isCollapsed).toBe(true);
	});

	test('a real inline-atom selectionchange selects the atom', async () => {
		const rendered = await renderDomEdytor(
			<root>
				<paragraph>
					<mention />
					tail
				</paragraph>
			</root>,
			{ autoSelectFixture: false }
		);
		const { edytor } = rendered;

		// A real drag covering exactly the mention atom selects it.
		await dragSelection(edytor, [0, 0], 0, [0, 2], 0);

		expect(edytor.selection.selectedInlineBlock.size).toBe(1);
	});

	test('emitSelectionChange dedupes identical derives but emits real changes', async () => {
		const onSelectionChange = vi.fn();
		const rendered = await renderDomEdytor(
			<root>
				<paragraph>hello world</paragraph>
			</root>,
			{ autoSelectFixture: false, onSelectionChange }
		);
		const { edytor } = rendered;
		const text = edytor.root!.children[0]!.firstText!;

		await setNativeSelection(edytor, text, 3);
		const afterFirst = onSelectionChange.mock.calls.length;
		expect(afterFirst).toBeGreaterThan(0);

		// Re-derive the identical selection — no new notify.
		await edytor.selection.setAtTextOffset(text, 3);
		await flushDomUpdates();
		expect(onSelectionChange.mock.calls.length).toBe(afterFirst);

		// A real move notifies once more.
		await setNativeSelection(edytor, text, 8);
		expect(onSelectionChange.mock.calls.length).toBeGreaterThan(afterFirst);
	});
});
