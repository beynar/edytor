/** @jsxImportSource ../../jsx */
/**
 * Who is online (site `collaboration/presence`): `edytor.presence.peers` is
 * every client but this one, by client id, each `{ clientId, ...user }`;
 * reactive, it listens to the awareness only while something reads it.
 *
 * Expected values come from the page, never from a run.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { flushSync } from 'svelte';
import { render } from '@testing-library/svelte';

import { Y } from '$lib/crdt/engine.js';
import {
	Awareness,
	applyAwarenessUpdate,
	encodeAwarenessUpdate,
	removeAwarenessStates
} from '$lib/crdt/protocols/awareness.js';
import { createTestEdytor } from '../../test.utils.js';
import PeersList from '../../dom/PeersList.svelte';

afterEach(() => {
	document.body.innerHTML = '';
});

const listeners = (awareness: Awareness) =>
	(awareness as unknown as { _observers?: Map<string, Set<unknown>> })._observers?.get('change')
		?.size ?? 0;

/** This view's awareness and another client's, whose state reaches it as the wire would carry it. */
const setup = () => {
	const doc = new Y.Doc();
	const awareness = new Awareness(doc);
	const { edytor } = createTestEdytor(
		<root>
			<paragraph>Hi</paragraph>
		</root>,
		{ doc, awareness }
	);
	const other = new Awareness(new Y.Doc());
	const relay = () =>
		applyAwarenessUpdate(awareness, encodeAwarenessUpdate(other, [other.clientID]), 'remote');
	return { edytor, awareness, other, relay };
};

describe('presence.peers', () => {
	it('lists the other client with its user fields, never this one', () => {
		const { edytor, awareness, other, relay } = setup();
		awareness.setLocalState({ ...awareness.getLocalState(), user: { name: 'Me' } });
		other.setLocalState({ user: { name: 'Ada', color: '#f00', role: 'editor' } });
		relay();
		expect(edytor.presence.peers).toEqual([
			{ clientId: other.clientID, name: 'Ada', color: '#f00', role: 'editor' }
		]);
	});

	it('updates on a state change and drops a client that leaves', () => {
		const { edytor, other, awareness, relay } = setup();
		other.setLocalState({ user: { name: 'Ada' } });
		relay();
		other.setLocalState({ user: { name: 'Grace' } });
		relay();
		expect(edytor.presence.peers.map((p) => p.name)).toEqual(['Grace']);
		removeAwarenessStates(awareness, [other.clientID], 'left');
		expect(edytor.presence.peers).toEqual([]);
	});

	it('is reactive in a component and listens only while it is read', () => {
		const { edytor, awareness, other, relay } = setup();
		const before = listeners(awareness);
		const view = render(PeersList, { props: { edytor } });
		expect(view.container.querySelectorAll('li')).toHaveLength(0);
		expect(listeners(awareness)).toBe(before + 1);

		other.setLocalState({ user: { name: 'Ada' } });
		relay();
		flushSync();
		expect([...view.container.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['Ada']);

		other.setLocalState({ user: { name: 'Grace' } });
		relay();
		flushSync();
		expect(view.container.querySelector('li')!.textContent).toBe('Grace');

		removeAwarenessStates(awareness, [other.clientID], 'left');
		flushSync();
		expect(view.container.querySelectorAll('li')).toHaveLength(0);

		view.unmount();
		expect(listeners(awareness)).toBe(before);
		edytor.destroy();
		expect(listeners(awareness)).toBe(before);
	});
});
