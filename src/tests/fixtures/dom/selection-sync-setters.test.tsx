/** @jsxImportSource ../../jsx */
/**
 * arch-v2 phase 2, checkpoint P2.2 — the selection setters are synchronous.
 *
 * `select()` is the one synchronous commit point (V2) and the projector
 * displays the value after the flush (V4), so the text writer (`selectText`)
 * and a block's lines (`selectLines`) have nothing to wait
 * for: each returns nothing and the model selection holds the new value on
 * the next line. `replaceSelectionWithCollapsedTarget` (folded with its
 * former `…Sync` twin) answers its target synchronously too.
 *
 * Expected values come from the fixture text, never from running the code.
 */
import { describe, expect, test } from 'vitest';
import { renderDomEdytor } from '../../dom/test.utils.js';
import { replaceSelectionWithCollapsedTarget } from '$lib/selection/replaceSelection.js';
import { selectionState } from '../../selection.js';

const render = () =>
	renderDomEdytor(
		<root>
			<paragraph>hello world</paragraph>
			<paragraph>second</paragraph>
		</root>,
		{ autoSelectFixture: false }
	);

describe('P2.2 — synchronous selection setters', () => {
	test('a caret write commits the caret before it returns', async () => {
		const { edytor } = await render();
		const text = edytor.root!.children[0]!.firstText!;
		const result = edytor.selection.selectText(text, 3);
		expect(result).toBeUndefined();
		const { startText, yStart, isCollapsed } = selectionState(edytor);
		expect([startText, yStart, isCollapsed]).toEqual([text, 3, true]);
	});

	test('a range write commits the range before it returns, direction included', async () => {
		const { edytor } = await render();
		const text = edytor.root!.children[0]!.firstText!;
		const result = edytor.selection.selectText(text, 1, text, 4, true);
		expect(result).toBeUndefined();
		const { yStart, yEnd, isReversed, isCollapsed } = selectionState(edytor);
		expect([yStart, yEnd, isReversed, isCollapsed]).toEqual([1, 4, true, false]);
	});

	test('a range across texts and a block range commit before they return', async () => {
		const { edytor } = await render();
		const first = edytor.root!.children[0]!;
		const second = edytor.root!.children[1]!;
		expect(edytor.selection.selectText(first.firstText!, 0, second.firstText!, 6)).toBeUndefined();
		let state = selectionState(edytor);
		expect([state.startText, state.yStart, state.endText, state.yEnd]).toEqual([
			first.firstText,
			0,
			second.firstText,
			6
		]);
		expect(edytor.selection.selectLines(second)).toBeUndefined();
		state = selectionState(edytor);
		expect([state.startText, state.yStart, state.yEnd]).toEqual([second.firstText, 0, 6]);
	});

	test('replaceSelectionWithCollapsedTarget answers its target synchronously', async () => {
		const { edytor } = await render();
		const text = edytor.root!.children[0]!.firstText!;
		edytor.selection.selectText(text, 5, text, 11);
		const target = replaceSelectionWithCollapsedTarget(edytor);
		expect(target).toEqual({ text, offset: 5 });
		expect(text.stringContent).toBe('hello');
	});
});
