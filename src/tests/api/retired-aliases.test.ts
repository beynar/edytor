/**
 * The deprecated aliases whose release has passed are gone (migration
 * "Unreleased", Breaking changes): each old name is neither typed nor read,
 * and the two that took a value at run time refuse it with a message that
 * names the new form.
 *
 * - `hotKeys` (the `Edytor` option and the `<Edytor>` prop): `hotkeys`.
 * - `blockDnd` (the `<Edytor>` prop): `blockHandles`.
 * - `serverUrl`/`roomName` (`createWebsocketSync`, `prefetch`,
 *   `lastUpdated`, `documentSnapshot`): `server`/`room`.
 * - A bare KV namespace as `history.store`: `kvHistory(namespace)`
 *   (`retired-history-store.test.ts`: the room's module needs the Workers
 *   types, which this file's type check does not load).
 * - `block.suggestText`, `block.suggestions`, `block.acceptSuggestedText`:
 *   `edytor.suggestions` with `{ end: block.id }`.
 * - `MigrateOptions.leaseMs`/`waitMs`/`pollMs`/`owner` (accepted no-ops).
 *
 * A retired name passed anyway (an untyped caller: `hotKeys` as an option or
 * a prop, `blockDnd` as a prop, whatever its value) registers nothing and
 * warns in development, naming its replacement.
 *
 * `edytor/cloudflare`'s `attachDocument`, `AttachDocumentOptions` and
 * `moveBlocks` are checked against the API report in
 * `public-surface.test.ts`.
 */
import { afterEach, describe, expect, expectTypeOf, test, vi } from 'vitest';
import {
	createDocument,
	createWebsocketSync,
	documentSnapshot,
	lastUpdated,
	prefetch,
	type JSONDoc
} from '$lib/index.js';
import type { EdytorProps } from '$lib/components/Edytor.svelte';
import { Edytor, type EdytorOptions } from '$lib/edytor.svelte.js';
import type { Block } from '$lib/block/block.svelte.js';
import type { MigrateOptions } from '$lib/crdt/migration/migrate.js';
import type { WebsocketSyncOptions } from '$lib/collaboration/providers.js';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';

const value: JSONDoc = { children: [{ id: 'a', type: 'paragraph', content: [{ text: 'aa' }] }] };

describe('retired aliases', () => {
	afterEach(() => void vi.restoreAllMocks());
	const warnings = () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		return () => warn.mock.calls.map(([message]) => String(message));
	};

	test('`hotKeys` as an option warns in development, naming `hotkeys`', () => {
		const read = warnings();
		new Edytor({
			document: createDocument({ value }),
			plugins: [richTextPlugin],
			...({ hotKeys: { 'mod+j': () => {} } } as object)
		});
		expect(read()).toEqual([expect.stringMatching(/`hotKeys`.*removed.*`hotkeys`/)]);
	});

	test('`hotKeys` and `blockDnd` as props (an object, a boolean) warn, naming their replacements', () => {
		const read = warnings();
		new Edytor({
			document: createDocument({ value }),
			plugins: [richTextPlugin],
			snippets: { hotKeys: { 'mod+j': () => {} }, blockDnd: false } as never
		});
		expect(read()).toEqual([
			expect.stringMatching(/`hotKeys`.*removed.*`hotkeys`/),
			expect.stringMatching(/`blockDnd`.*removed.*`blockHandles`/)
		]);
	});

	test('`hotKeys` is no option or prop, and binds nothing', () => {
		expectTypeOf<EdytorOptions>().not.toHaveProperty('hotKeys');
		expectTypeOf<EdytorProps>().not.toHaveProperty('hotKeys');
		const calls: string[] = [];
		const edytor = new Edytor({
			document: createDocument({ value }),
			plugins: [richTextPlugin],
			...({ hotKeys: { 'mod+j': () => void calls.push('alias') } } as object)
		});
		const event = { preventDefault() {}, stopPropagation() {} } as unknown as KeyboardEvent;
		expect(edytor.keymap.run('mod+j', event)).toBe(false);
		expect(calls).toEqual([]);
	});

	test('`blockDnd` is no prop', () => {
		expectTypeOf<EdytorProps>().not.toHaveProperty('blockDnd');
		expectTypeOf<EdytorProps>().toHaveProperty('blockHandles');
	});

	test('`serverUrl`/`roomName` are no websocket target, and are refused by name', () => {
		type Keys = WebsocketSyncOptions extends infer O ? (O extends unknown ? keyof O : never) : never;
		expectTypeOf<'serverUrl'>().not.toMatchTypeOf<Keys>();
		expectTypeOf<'roomName'>().not.toMatchTypeOf<Keys>();
		expect(() =>
			createWebsocketSync({ serverUrl: 'wss://x.test', roomName: 'r' } as unknown as WebsocketSyncOptions)
		).toThrow(/^createWebsocketSync: .*`server` and `room`/);
	});

	test('each websocket entry point names itself when it refuses the old target', async () => {
		const old = { serverUrl: 'wss://x.test', roomName: 'r' } as never;
		expect(() => prefetch(old)).toThrow(/^prefetch: .*`server` and `room`/);
		await expect(lastUpdated(old)).rejects.toThrow(/^lastUpdated: .*`server` and `room`/);
		await expect(documentSnapshot(old)).rejects.toThrow(/^documentSnapshot: .*`server` and `room`/);
	});

	test('the block suggestion wrappers are gone: `edytor.suggestions` places `{ end }` content', () => {
		expectTypeOf<Block>().not.toHaveProperty('suggestText');
		expectTypeOf<Block>().not.toHaveProperty('suggestions');
		expectTypeOf<Block>().not.toHaveProperty('acceptSuggestedText');
		const edytor = new Edytor({ document: createDocument({ value }), plugins: [richTextPlugin] });
		const block = edytor.idToBlock.get('a')!;
		expect('suggestText' in block).toBe(false);
		expect('acceptSuggestedText' in block).toBe(false);
		expect('suggestions' in block).toBe(false);
	});

	test('the migrator takes no lease options', () => {
		expectTypeOf<MigrateOptions>().not.toHaveProperty('leaseMs');
		expectTypeOf<MigrateOptions>().not.toHaveProperty('waitMs');
		expectTypeOf<MigrateOptions>().not.toHaveProperty('pollMs');
		expectTypeOf<MigrateOptions>().not.toHaveProperty('owner');
	});
});
