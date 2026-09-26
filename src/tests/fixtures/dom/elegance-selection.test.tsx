/** @jsxImportSource ../../jsx */
/**
 * Elegance-review regression pins for the selection layer — see
 * docs/elegance-review-2026-09-23.md:
 *
 *  - D3: `applySelectionSnapshot` derived `currentMarks` over
 *    `[0, yEnd)` — the whole prefix — instead of the caret-local
 *    convention the model writers use (char before the caret for a
 *    collapsed caret, the start edge of the range otherwise). A caret
 *    inside a plain run after marked text reported the mark.
 *  - D7: `setAtBlockRange` had no staleness guard — a foreign selection
 *    landing mid-await got stomped by the stale write. `setAtRange` had
 *    no `getTextNode` rejection handling — an unresolvable endpoint
 *    escaped as an unhandled rejection instead of falling back to the
 *    model-side write like `setAtTextOffset`.
 *  - D8: `applySelectionSnapshot` cleared `selectedInlineBlock` without
 *    clearing `inlineBlockDeletionTarget`, leaving an armed delete
 *    target after the atom was no longer selected.
 */
import { describe, expect, test, vi } from 'vitest';
import {
	renderDomEdytor,
	flushDomUpdates,
	setNativeSelection,
	dragSelection
} from '../../dom/test.utils.js';

describe('D3 — caret-local currentMarks on native derives', () => {
	test('a caret inside a plain run after marked text does not report the mark', async () => {
		const rendered = await renderDomEdytor(
			<root>
				<paragraph>
					<bold>ab</bold>cd
				</paragraph>
			</root>,
			{ autoSelectFixture: false }
		);
		const { edytor } = rendered;
		const text = edytor.root!.children[0]!.firstText!;
		expect(text.stringContent).toBe('abcd');

		// Caret inside the plain run — the char BEFORE the caret is 'c'
		// (unmarked), so currentMarks must not carry `bold`. The D3 bound
		// (getMarksAtRange(0, yEnd)) unioned the whole prefix → {bold}.
		await setNativeSelection(edytor, text, 3);
		expect(edytor.selection.state.isCollapsed).toBe(true);
		expect(edytor.selection.state.currentMarks?.bold).toBeUndefined();

		await setNativeSelection(edytor, text, 4);
		expect(edytor.selection.state.currentMarks?.bold).toBeUndefined();

		// Char-before-caret convention: the caret right after the bold run
		// still inherits bold (typed text continues the bold run) — the
		// same answer `setCollapsedStateAtTextOffset` gives.
		await setNativeSelection(edytor, text, 2);
		expect(edytor.selection.state.currentMarks?.bold).toBe(true);

		// Caret inside the bold run keeps it.
		await setNativeSelection(edytor, text, 1);
		expect(edytor.selection.state.currentMarks?.bold).toBe(true);
	});

	test('a non-collapsed range reports marks at its start edge, like the model writers', async () => {
		const rendered = await renderDomEdytor(
			<root>
				<paragraph>
					<bold>ab</bold>cd
				</paragraph>
			</root>,
			{ autoSelectFixture: false }
		);
		const { edytor } = rendered;
		const text = edytor.root!.children[0]!.firstText!;

		// Range starting inside the plain run — marks of the start edge
		// ('c'), not the union of the range.
		await setNativeSelection(edytor, text, 2, text, 4);
		expect(edytor.selection.state.isCollapsed).toBe(false);
		expect(edytor.selection.state.currentMarks?.bold).toBeUndefined();

		// Range starting inside the bold run reports bold.
		await setNativeSelection(edytor, text, 0, text, 3);
		expect(edytor.selection.state.currentMarks?.bold).toBe(true);
	});
});

describe('D8 — inline-block selection and deletion target cannot diverge', () => {
	test('deriving a text caret after an inline-atom selection clears the armed deletion target', async () => {
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

		// Drag covering exactly the mention atom selects the inline block
		// and arms the deletion target.
		await dragSelection(edytor, [0, 0], 0, [0, 2], 0);
		expect(edytor.selection.selectedInlineBlock.size).toBe(1);
		expect(edytor.selection.inlineBlockDeletionTarget).not.toBeNull();

		// A subsequent plain caret derive must clear BOTH — the D8 site
		// cleared the set only, leaving a stale armed target that
		// Backspace-delete would still consume.
		const tail = edytor.root!.children[0]!.lastText!;
		await setNativeSelection(edytor, tail, 1);
		expect(edytor.selection.selectedInlineBlock.size).toBe(0);
		expect(edytor.selection.inlineBlockDeletionTarget).toBeNull();
	});
});

describe('D7 — aligned guards on the DOM writers', () => {
	test('a stale setAtBlockRange write cannot stomp a caret that landed mid-await', async () => {
		const rendered = await renderDomEdytor(
			<root>
				<paragraph>hello world</paragraph>
			</root>,
			{ autoSelectFixture: false }
		);
		const { edytor } = rendered;
		const text = edytor.root!.children[0]!.firstText!;

		await edytor.selection.setAtTextOffset(text, 1);
		expect(edytor.selection.state.yStart).toBe(1);

		// Start the block-range write — its getTextNode lookups await at
		// least one tick, so a fresher caret lands before the DOM write.
		const pending = edytor.selection.setAtBlockRange(edytor.root!.children[0]!);
		await edytor.selection.setAtTextOffset(text, 4);
		await pending;
		await flushDomUpdates();

		// The caret that arrived mid-flight wins — before the guard the
		// stale write re-derived the whole-block range over it.
		expect(edytor.selection.state.isCollapsed).toBe(true);
		expect(edytor.selection.state.startText).toBe(text);
		expect(edytor.selection.state.yStart).toBe(4);
	});

	test('a newer gesture supersedes a deferred caret write even when it re-picks the call position', async () => {
		const rendered = await renderDomEdytor(
			<root>
				<paragraph>hello world</paragraph>
			</root>,
			{ autoSelectFixture: false }
		);
		const { edytor } = rendered;
		const text = edytor.root!.children[0]!.firstText!;

		await edytor.selection.setAtTextOffset(text, 1);
		expect(edytor.selection.state.yStart).toBe(1);

		// Deferred write @1→@4 (its getTextNode lookup awaits); a newer
		// user gesture lands mid-flight and re-picks @1 — position
		// equality cannot tell the newer decision apart, only the
		// gesture serial can. The stale write must abort.
		const pending = edytor.selection.setAtTextOffset(text, 4);
		edytor.markUserGesture();
		await pending;
		await flushDomUpdates();

		expect(edytor.selection.state.isCollapsed).toBe(true);
		expect(edytor.selection.state.startText).toBe(text);
		expect(edytor.selection.state.yStart).toBe(1);
	});

	test('a newer gesture supersedes a deferred setAtRange write the same way', async () => {
		const rendered = await renderDomEdytor(
			<root>
				<paragraph>hello world</paragraph>
			</root>,
			{ autoSelectFixture: false }
		);
		const { edytor } = rendered;
		const text = edytor.root!.children[0]!.firstText!;

		await edytor.selection.setAtTextOffset(text, 1);
		const pending = edytor.selection.setAtRange(text, 2, text, 6);
		edytor.markUserGesture();
		await pending;
		await flushDomUpdates();

		expect(edytor.selection.state.isCollapsed).toBe(true);
		expect(edytor.selection.state.startText).toBe(text);
		expect(edytor.selection.state.yStart).toBe(1);
	});

	test('a string-id setAtTextOffset write is gated by the gesture serial too', async () => {
		const rendered = await renderDomEdytor(
			<root>
				<paragraph>hello world</paragraph>
			</root>,
			{ autoSelectFixture: false }
		);
		const { edytor } = rendered;
		const text = edytor.root!.children[0]!.firstText!;

		await edytor.selection.setAtTextOffset(text, 1);
		expect(edytor.selection.state.yStart).toBe(1);

		// String-id writes used to bypass the staleness guard entirely —
		// the guard resolved `null` for non-Text arguments and skipped.
		// Assert before flushing: the DOM caret never moved, so a later
		// selectionchange echo can mask a stale commit.
		const pending = edytor.selection.setAtTextOffset(text.id, 4);
		edytor.markUserGesture();
		await pending;

		expect(edytor.selection.state.isCollapsed).toBe(true);
		expect(edytor.selection.state.startText).toBe(text);
		expect(edytor.selection.state.yStart).toBe(1);
	});

	test('a newer gesture supersedes a setAtRange write whose endpoint lookup FAILS', async () => {
		const rendered = await renderDomEdytor(
			<root>
				<paragraph>hello world</paragraph>
			</root>,
			{ autoSelectFixture: false }
		);
		const { edytor } = rendered;
		const text = edytor.root!.children[0]!.firstText!;

		await edytor.selection.setAtTextOffset(text, 0);

		// The lookup-error branch wrote the old range BEFORE the stale
		// check ran — a delayed rejection restored [2,4] over a newer
		// collapsed caret. Assert BEFORE flushDomUpdates: the DOM caret
		// never moved, so a selectionchange echo can re-derive @0 and mask
		// the stale commit.
		const spy = vi
			.spyOn(edytor, 'getTextNode')
			.mockImplementation(() => Promise.reject(new Error('endpoint gone')));
		try {
			const pending = edytor.selection.setAtRange(text, 2, text, 4);
			edytor.markUserGesture();
			await pending;

			expect(edytor.selection.state.isCollapsed).toBe(true);
			expect(edytor.selection.state.startText).toBe(text);
			expect(edytor.selection.state.yStart).toBe(0);
		} finally {
			spy.mockRestore();
		}
	});

	test('a newer gesture supersedes a setAtBlockRange write whose endpoint lookup FAILS', async () => {
		const rendered = await renderDomEdytor(
			<root>
				<paragraph>hello world</paragraph>
			</root>,
			{ autoSelectFixture: false }
		);
		const { edytor } = rendered;
		const text = edytor.root!.children[0]!.firstText!;
		const block = edytor.root!.children[0]!;

		await edytor.selection.setAtTextOffset(text, 0);

		const spy = vi
			.spyOn(edytor, 'getTextNode')
			.mockImplementation(() => Promise.reject(new Error('endpoint gone')));
		try {
			// `syncModelState: false` — the default sync path commits at
			// call time (by design); this exercises the DEFERRED catch-branch
			// write, which ran before the stale check existed. Assert before
			// the next flush — the unmoved DOM caret can otherwise mask a
			// stale commit.
			const pending = edytor.selection.setAtBlockRange(block, 0, 4, { syncModelState: false });
			edytor.markUserGesture();
			await pending;

			expect(edytor.selection.state.isCollapsed).toBe(true);
			expect(edytor.selection.state.startText).toBe(text);
			expect(edytor.selection.state.yStart).toBe(0);
		} finally {
			spy.mockRestore();
		}
	});

	test('setAtRange falls back to the model write when an endpoint cannot resolve', async () => {
		const rendered = await renderDomEdytor(
			<root>
				<paragraph>hello world</paragraph>
			</root>,
			{ autoSelectFixture: false }
		);
		const { edytor } = rendered;
		const text = edytor.root!.children[0]!.firstText!;

		const spy = vi.spyOn(edytor, 'getTextNode').mockRejectedValue(new Error('endpoint gone'));
		try {
			// Must resolve — not reject — and land the model-side range
			// (the setAtTextOffset catch contract).
			await edytor.selection.setAtRange(text, 1, text, 4);
			const state = edytor.selection.state;
			expect(state.isCollapsed).toBe(false);
			expect(state.startText).toBe(text);
			expect(state.endText).toBe(text);
			expect(state.yStart).toBe(1);
			expect(state.yEnd).toBe(4);
			expect(state.content).toBe('ell');
		} finally {
			spy.mockRestore();
		}
	});

	test('setAtBlockRange falls back to the model write when an endpoint cannot resolve', async () => {
		const rendered = await renderDomEdytor(
			<root>
				<paragraph>hello world</paragraph>
			</root>,
			{ autoSelectFixture: false }
		);
		const { edytor } = rendered;
		const block = edytor.root!.children[0]!;

		const spy = vi.spyOn(edytor, 'getTextNode').mockRejectedValue(new Error('endpoint gone'));
		try {
			await edytor.selection.setAtBlockRange(block);
			const state = edytor.selection.state;
			expect(state.isCollapsed).toBe(false);
			expect(state.startText).toBe(block.firstText);
			expect(state.endText).toBe(block.lastText);
			expect(state.yStart).toBe(0);
			expect(state.yEnd).toBe(block.lastText.length);
		} finally {
			spy.mockRestore();
		}
	});
});
