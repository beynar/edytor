/**
 * A listener that throws is isolated (FW-08 and its sweep): the providers
 * and awareness log it and run the rest, and their own work after the
 * emit still happens.
 *
 * - Awareness: a `change` listener that throws (an app's presence UI) does
 *   not stop the `update` a provider publishes presence from.
 * - IndexedDB: a `synced` listener that throws neither skips the next
 *   listener nor reports the hydrated store as a `load-error`.
 */
// @ts-nocheck -- tests reach raw provider internals (excluded lane).
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Y } from '../../../lib/crdt/engine.js';
import { Awareness } from '../../../lib/crdt/protocols/awareness.js';
import { bindProviders } from '../../../lib/crdt/providers/index.js';

const providers = bindProviders(Y);

afterEach(() => vi.restoreAllMocks());

describe('a listener that throws is isolated', () => {
	it('awareness: a throwing change listener still lets update publish the presence', () => {
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
		const awareness = new Awareness(new Y.Doc());
		const published = [];
		awareness.on('change', () => {
			throw new Error('presence UI failed');
		});
		awareness.on('update', ({ updated }) => published.push(updated));
		awareness.setLocalStateField('user', { name: 'Ada' });
		expect(published).toEqual([[awareness.clientID]]);
		expect(logged).toHaveBeenCalledTimes(1);
		awareness.destroy();
	});

	it('indexeddb: a throwing synced listener runs the next one and reports no load-error', async () => {
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
		const provider = new providers.IndexeddbPersistence(`isolation-${Math.random()}`, new Y.Doc());
		const heard = [];
		const loadErrors = [];
		provider.on('synced', () => {
			throw new Error('app callback failed');
		});
		provider.on('synced', () => heard.push('second'));
		provider.on('load-error', (error) => loadErrors.push(error));
		await provider.whenSynced;
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(heard).toEqual(['second']);
		expect(loadErrors).toEqual([]);
		expect(provider.loadError).toBeNull();
		expect(logged).toHaveBeenCalledTimes(1);
		await provider.destroy();
	});
});
