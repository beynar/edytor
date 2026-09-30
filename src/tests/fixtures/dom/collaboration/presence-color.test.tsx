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

const labelBackground = async (color: string) => {
	const { container, edytor } = await renderDomEdytor(input, { autoSelectFixture: false });
	await setNativeSelection(edytor, edytor.root!.children[0]!.firstText!, 5);
	const selections = edytor.awareness.getLocalState()?.selections;
	edytor.awareness.states.set(4242, { user: { name: 'Ada', color }, selections });
	edytor.awareness.emit('change', [{ added: [4242], updated: [], removed: [] }, 'test']);
	await flushDomUpdates();
	let label: HTMLElement | null = null;
	await waitFor(() => {
		label = container.querySelector<HTMLElement>('[data-edytor-remote-cursor-label]');
		expect(label).toBeInstanceOf(HTMLElement);
	});
	return label!.style.background;
};

describe('SW10-collab-1 · a presence color is a CSS hex color or the default', () => {
	it.each([
		['#dc2626', 'rgb(220, 38, 38)'],
		['#abc', 'rgb(170, 187, 204)'],
		['#12345', 'rgb(37, 99, 235)'],
		['#1234567', 'rgb(37, 99, 235)'],
		['red', 'rgb(37, 99, 235)']
	])('%s draws as %s', async (color, drawn) => {
		expect(await labelBackground(color)).toBe(drawn);
	});
});
