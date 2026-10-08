/** @jsxImportSource ../../jsx */
/**
 * arch-v2 phase 2, checkpoint P2.2 — the selection setters are synchronous.
 *
 * `select()` is the one synchronous commit point (V2) and the projector
 * displays the value after the flush (V4), so `setAtTextOffset`,
 * `setAtRange`, `setAtTextsRange` and `setAtBlockRange` have nothing to wait
 * for: each returns nothing and the model selection holds the new value on
 * the next line. `replaceSelectionWithCollapsedTarget` (folded with its
 * former `…Sync` twin) answers its target synchronously too.
 *
 * Expected values come from the fixture text, never from running the code.
 */
import { describe, expect, test } from 'vitest';
import { renderDomEdytor } from '../../dom/test.utils.js';
import { replaceSelectionWithCollapsedTarget } from '$lib/selection/replaceSelection.js';

const render = () =>
	renderDomEdytor(
		<root>
			<paragraph>hello world</paragraph>
			<paragraph>second</paragraph>
		</root>,
		{ autoSelectFixture: false }
	);

describe('P2.2 — synchronous selection setters', () => {
	test('setAtTextOffset commits the caret before it returns', async () => {
		const { edytor } = await render();
		const text = edytor.root!.children[0]!.firstText!;
		const result = edytor.selection.setAtTextOffset(text, 3);
		expect(result).toBeUndefined();
		const { startText, yStart, isCollapsed } = edytor.selection.state;
		expect([startText, yStart, isCollapsed]).toEqual([text, 3, true]);
	});

	test('setAtRange commits the range before it returns, direction included', async () => {
		const { edytor } = await render();
		const text = edytor.root!.children[0]!.firstText!;
		const result = edytor.selection.setAtRange(text, 1, text, 4, { isReversed: true });
		expect(result).toBeUndefined();
		const { yStart, yEnd, isReversed, isCollapsed } = edytor.selection.state;
		expect([yStart, yEnd, isReversed, isCollapsed]).toEqual([1, 4, true, false]);
	});

	test('setAtTextsRange and setAtBlockRange commit before they return', async () => {
		const { edytor } = await render();
		const first = edytor.root!.children[0]!;
		const second = edytor.root!.children[1]!;
		expect(edytor.selection.setAtTextsRange(first.firstText!, second.firstText!)).toBeUndefined();
		let state = edytor.selection.state;
		expect([state.startText, state.yStart, state.endText, state.yEnd]).toEqual([
			first.firstText,
			0,
			second.firstText,
			6
		]);
		expect(edytor.selection.setAtBlockRange(second, 1, 3)).toBeUndefined();
		state = edytor.selection.state;
		expect([state.startText, state.yStart, state.yEnd]).toEqual([second.firstText, 1, 3]);
	});

	test('replaceSelectionWithCollapsedTarget answers its target synchronously', async () => {
		const { edytor } = await render();
		const text = edytor.root!.children[0]!.firstText!;
		edytor.selection.setAtRange(text, 5, text, 11);
		const target = replaceSelectionWithCollapsedTarget(edytor);
		expect(target).toEqual({ text, offset: 5 });
		expect(text.stringContent).toBe('hello');
	});
});
