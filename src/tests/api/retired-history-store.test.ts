/**
 * A bare KV namespace is no history store any more (migration
 * "Unreleased", Breaking changes): `history.store` takes a `HistoryStore`
 * or a factory, and a KV namespace goes through `kvHistory(namespace)`.
 * Given the namespace itself, the room refuses it with a message that names
 * `kvHistory`.
 */
import { describe, expect, expectTypeOf, test } from 'vitest';
import {
	kvHistory,
	resolveHistoryStore,
	type HistoryOptions,
	type HistoryRoomStorage,
	type KVLike
} from '$lib/cloudflare/history.js';

describe('retired aliases', () => {
	test('a bare KV namespace is no history store: `kvHistory` wraps it', () => {
		type Store = HistoryOptions['store'];
		expectTypeOf<KVLike>().not.toMatchTypeOf<Store>();
		const kv: KVLike = {
			put: async () => undefined,
			get: async () => null,
			list: async () => ({ keys: [], list_complete: true })
		};
		const room = {} as HistoryRoomStorage;
		expect(() => resolveHistoryStore(kv as unknown as Store, room)).toThrow(/kvHistory/);
		const wrapped = kvHistory(kv);
		expect(resolveHistoryStore(wrapped, room)).toBe(wrapped);
	});

});
