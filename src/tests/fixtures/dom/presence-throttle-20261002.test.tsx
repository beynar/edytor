/** @jsxImportSource ../../jsx */
/**
 * Presence cost at scale (site `collaboration/presence`): a view's presence
 * writes can be throttled (`presence.throttle`, ms: the first write goes at
 * once, later ones within the window collapse into one trailing write of the
 * newest value) and narrowed to blocks (`presence.share: 'block'`: the
 * focused block only, so moving inside it publishes nothing; peers draw a bar
 * beside it instead of a caret), or turned off (`'none'`).
 *
 * Expected values come from the page, never from a run.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/svelte';

import type { Edytor } from '$lib/edytor.svelte.js';
import { flushDomUpdates, renderDomEdytor } from '../../dom/test.utils.js';

const input = (
	<root>
		<paragraph>Hello world</paragraph>
		<paragraph>Second line</paragraph>
	</root>
);

afterEach(() => {
	vi.useRealTimers();
	document.body.innerHTML = '';
});

type Entry = Record<string, unknown>;
const entries = (edytor: Edytor) =>
	Object.values((edytor.awareness.getLocalState()?.selections ?? {}) as Record<string, Entry>);
const strip = ({ t: _t, ...entry }: Entry) => entry;

const caret = (edytor: Edytor, block: number, offset: number) =>
	edytor.selection.setAtTextOffset(edytor.root!.children[block]!.firstText!, offset);

const mount = async () => {
	const view = await renderDomEdytor(input, { autoSelectFixture: false });
	const writes = vi.spyOn(view.edytor.awareness, 'setLocalState');
	return { ...view, writes };
};

describe('presence throttle', () => {
	it('the first write goes at once; writes within the window collapse into one trailing write of the newest', async () => {
		const { edytor, writes } = await mount();
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
		edytor.presence.throttle = 200;

		caret(edytor, 0, 1);
		expect(writes).toHaveBeenCalledTimes(1);
		caret(edytor, 0, 2);
		caret(edytor, 0, 3);
		expect(writes).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(199);
		expect(writes).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(1);
		expect(writes).toHaveBeenCalledTimes(2);
		const [entry] = entries(edytor);
		expect(entry!.start).toEqual((edytor.selection.value as { anchor: unknown }).anchor);

		// A window with no write in it: the next one goes at once again.
		vi.advanceTimersByTime(500);
		caret(edytor, 0, 4);
		expect(writes).toHaveBeenCalledTimes(3);
	});

	it('a view destroyed with a write pending clears its entry and never writes again', async () => {
		const { edytor, writes, unmount } = await mount();
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
		edytor.presence.throttle = 200;
		caret(edytor, 0, 1);
		caret(edytor, 0, 2);
		unmount();
		const after = writes.mock.calls.length;
		expect(entries(edytor)).toEqual([]);
		vi.advanceTimersByTime(1000);
		expect(writes).toHaveBeenCalledTimes(after);
	});

	it('no throttle (the default) writes every change at once', async () => {
		const { edytor, writes } = await mount();
		expect(edytor.presence.throttle).toBe(0);
		caret(edytor, 0, 1);
		caret(edytor, 0, 2);
		expect(writes).toHaveBeenCalledTimes(2);
	});
});

describe("presence share: 'block'", () => {
	it('publishes the focused block only; moving inside it publishes nothing', async () => {
		const { edytor, writes } = await mount();
		edytor.presence.share = 'block';
		const [first, second] = edytor.root!.children.map((block) => block.id);

		caret(edytor, 0, 2);
		expect(entries(edytor).map(strip)).toEqual([{ blocks: [first] }]);
		const count = writes.mock.calls.length;
		caret(edytor, 0, 7);
		expect(writes).toHaveBeenCalledTimes(count);

		caret(edytor, 1, 3);
		expect(entries(edytor).map(strip)).toEqual([{ blocks: [second] }]);
	});

	it('a range across blocks publishes the block holding its focus', async () => {
		const { edytor } = await mount();
		edytor.presence.share = 'block';
		const [first, second] = edytor.root!.children;
		edytor.selection.setAtRange(first!.firstText!, 2, second!.firstText!, 3);
		expect(entries(edytor).map(strip)).toEqual([{ blocks: [second!.id] }]);
		edytor.selection.setAtRange(first!.firstText!, 2, second!.firstText!, 3, { isReversed: true });
		expect(entries(edytor).map(strip)).toEqual([{ blocks: [first!.id] }]);
	});

	it("'none' publishes nothing and removes the view's entry", async () => {
		const { edytor } = await mount();
		caret(edytor, 0, 2);
		expect(entries(edytor)).toHaveLength(1);
		edytor.presence.share = 'none';
		expect(entries(edytor)).toEqual([]);
		caret(edytor, 0, 4);
		expect(entries(edytor)).toEqual([]);
	});
});

describe('a peer publishing blocks', () => {
	it('is drawn as a bar beside the block, with its name', async () => {
		const { edytor, container } = await mount();
		const id = edytor.root!.children[1]!.id;
		edytor.awareness.states.set(4242, {
			user: { name: 'Ada', color: '#e11d48' },
			selections: { 'view-1': { blocks: [id], t: 1 } }
		});
		edytor.awareness.emit('change', [{ added: [4242], updated: [], removed: [] }, 'test']);
		await flushDomUpdates();
		await waitFor(() =>
			expect(
				container.querySelector('[data-edytor-remote-cursor][data-edytor-remote-block]')
			).not.toBeNull()
		);
		expect(container.querySelector('[data-edytor-remote-cursor-label]')?.textContent?.trim()).toBe(
			'Ada'
		);
		expect(container.querySelector('[data-edytor-remote-selection]')).toBeNull();
	});
});
