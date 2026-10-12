/** @jsxImportSource ../../../jsx */
/**
 * SW10-collab-1: presence colors are CSS hex colors, `#rgb` to `#rrggbbaa`;
 * anything else falls back to `#2563eb` (collaboration/presence). A 5- or
 * 7-digit "hex" passed the check, and the browser dropped it: the caret and
 * its label drew with no color at all.
 */
import { describe, expect, it } from 'vitest';
import { waitFor } from '@testing-library/svelte';

import { flushDomUpdates, renderDomEdytor, setNativeSelection } from '../../../dom/test.utils.js';

const input = (
	<root>
		<paragraph>Hello world</paragraph>
	</root>
);

/**
 * A peer's caret, range and label: the colour each carries (the inline
 * `--edytor-remote-color` a theme paints with), and the backgrounds baked in
 * them (none: the look is the theme's).
 */
const presence = async (color: string) => {
	const { container, edytor } = await renderDomEdytor(input, { autoSelectFixture: false });
	const text = edytor.root!.children[0]!.firstText!;
	await setNativeSelection(edytor, text, 0, text, 5);
	const selections = edytor.awareness.getLocalState()?.selections;
	edytor.awareness.states.set(4242, { user: { name: 'Ada', color }, selections });
	edytor.awareness.emit('change', [{ added: [4242], updated: [], removed: [] }, 'test']);
	await flushDomUpdates();
	let label: HTMLElement | null = null;
	await waitFor(() => {
		label = container.querySelector<HTMLElement>('[data-edytor-remote-cursor-label]');
		expect(label).toBeInstanceOf(HTMLElement);
	});
	const caret = container.querySelector<HTMLElement>('[data-edytor-remote-cursor]')!;
	const ranges = [...container.querySelectorAll<HTMLElement>('[data-edytor-remote-selection]')];
	const parts = [caret, ...ranges];
	return {
		color: [...new Set(parts.map((node) => node.style.getPropertyValue('--edytor-remote-color')))],
		ranges: ranges.length,
		baked: [label!, ...parts].map((node) => node.style.background || node.style.backgroundColor)
	};
};

describe('SW10-collab-1 · a presence color is a CSS hex color or the default', () => {
	it.each([
		['#dc2626', '#dc2626'],
		['#abc', '#abc'],
		['#12345', '#2563eb'],
		['#1234567', '#2563eb'],
		['red', '#2563eb']
	])('%s draws as %s, a variable the theme paints with', async (color, drawn) => {
		const { color: carried, ranges, baked } = await presence(color);
		expect(carried).toEqual([drawn]);
		expect(ranges).toBeGreaterThan(0);
		expect(baked.every((value) => value === '')).toBe(true);
	});
});
