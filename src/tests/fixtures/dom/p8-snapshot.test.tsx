/**
 * P8 — first paint from JSON (`<Edytor snapshot>`): while the view's own
 * document is not ready (a room-backed first visit: the provider has not
 * synced), the view shows the snapshot read-only, through its own plugins;
 * once the document is ready the live view replaces it in the same update,
 * with the document's content. A view whose document is ready at mount
 * never shows it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import Edytor, { type EdytorProps } from '$lib/components/Edytor.svelte';
import { Y } from '$lib/crdt/engine.js';
import { createDocument, type EdytorSync, type EdytorSyncPayload } from '$lib/crdt/index.js';
import type { JSONDoc } from '$lib/utils/json.js';

const value: JSONDoc = {
	children: [
		{ id: 'h', type: 'heading', data: { level: 'h1' }, content: [{ text: 'Title' }] },
		{ id: 'p', type: 'paragraph', content: [{ text: 'From the room' }] }
	]
};

const mounted: ReturnType<typeof mount>[] = [];
afterEach(() => {
	for (const view of mounted.splice(0)) unmount(view);
	document.body.innerHTML = '';
});

/** A provider that settles only when the test says so (a room that has not answered yet). */
const pendingSync = () => {
	let payload: EdytorSyncPayload | undefined;
	const sync: EdytorSync = Object.assign(
		(p: EdytorSyncPayload) => {
			payload = p;
		},
		{ bound: Infinity, target: 'test:pending-room' }
	);
	return {
		sync,
		/** The room's state arrives, then the provider reports synced. */
		arrive: (json: JSONDoc) => {
			const room = createDocument({ value: json });
			Y.applyUpdate(payload!.doc as never, Y.encodeStateAsUpdate(room.doc as never));
			room.destroy();
			payload!.synced();
		}
	};
};

const render = (props: EdytorProps) => {
	const target = document.createElement('div');
	document.body.append(target);
	mounted.push(mount(Edytor, { target, props }));
	flushSync();
	return target;
};

const texts = (root: Element) =>
	[...root.querySelectorAll('[data-edytor-text="true"]')].map((t) => t.textContent);

describe('P8 · <Edytor snapshot>', () => {
	it('shows the snapshot read-only until the document is ready, then the live view', async () => {
		const room = pendingSync();
		const target = render({ sync: room.sync, snapshot: value });
		const shown = target.querySelector('[data-edytor-snapshot] [data-edytor]')!;
		expect(shown).not.toBeNull();
		expect(shown.getAttribute('contenteditable')).toBe('false');
		expect(texts(shown)).toEqual(['Title', 'From the room']);
		expect(target.querySelector('h1')?.textContent).toBe('Title');
		// The room answers: the live view replaces the snapshot, with the room's content.
		room.arrive(value);
		await tick();
		flushSync();
		expect(target.querySelector('[data-edytor-snapshot]')).toBeNull();
		const live = target.querySelector('[data-edytor]')!;
		expect(live.getAttribute('contenteditable')).toBe('true');
		expect(texts(live)).toEqual(['Title', 'From the room']);
	});

	it('a view whose document is ready at mount never shows the snapshot', () => {
		const target = render({
			value,
			snapshot: { children: [{ type: 'paragraph', content: [{ text: 'stale' }] }] }
		});
		expect(target.querySelector('[data-edytor-snapshot]')).toBeNull();
		expect(texts(target)).toEqual(['Title', 'From the room']);
	});

	it('without a snapshot a pending view shows nothing (as before)', () => {
		const room = pendingSync();
		const target = render({ sync: room.sync });
		expect(target.querySelector('[data-edytor]')).toBeNull();
	});
});
