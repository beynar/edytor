/**
 * Naming and papercuts, on the headless view.
 *
 * - API-13 — the bindings option is `hotkeys`, as a plugin's field is
 *   (`hotKeys`, its alias, is gone: `retired-aliases.test.ts`). The `value` the
 *   view takes and the value `onChange` hands back are one type
 *   (`JSONDoc`), so a saved value goes back in as it is.
 *
 * The cloudflare renames (`attachRoom`, `moveBlocksBetweenRooms`) are
 * checked against the API report in `public-surface.test.ts` and in the
 * room lane (`tests/do`).
 */
import { afterEach, describe, expect, expectTypeOf, test, vi } from 'vitest';
import { createDocument, type EdytorInstance, type JSONDoc, type Plugin } from '$lib/index.js';
import type { EdytorProps } from '$lib/components/Edytor.svelte';
import { Edytor, type EdytorOptions } from '$lib/edytor.svelte.js';
import { richTextPlugin } from '$registry/edytor/chrome/plugins.js';

afterEach(() => vi.restoreAllMocks());

const value: JSONDoc = { children: [{ id: 'a', type: 'paragraph', content: [{ text: 'aa' }] }] };
const view = (options: Partial<EdytorOptions> = {}) =>
	new Edytor({ document: createDocument({ value }), plugins: [richTextPlugin], ...options });

/** A key event the keymap reads (`preventDefault`/`stopPropagation`), without a DOM. */
const key = () => {
	let prevented = false;
	const event = {
		preventDefault: () => void (prevented = true),
		stopPropagation: () => {}
	} as unknown as KeyboardEvent;
	return { event, prevented: () => prevented };
};

describe('API-13 · hotkeys', () => {
	test('the `hotkeys` option binds chords before plugins and built-ins', () => {
		const calls: string[] = [];
		const edytor = view({
			hotkeys: { 'mod+j': ({ prevent }) => prevent(() => void calls.push('app')) },
			plugins: [
				richTextPlugin,
				(() => ({ hotkeys: { 'mod+j': () => void calls.push('plugin') } })) as Plugin
			]
		});
		const { event, prevented } = key();
		expect(edytor.keymap.run('mod+j', event)).toBe(true);
		expect(calls).toEqual(['app']);
		expect(prevented()).toBe(true);
	});
});

describe('API-13 · value and onChange are one type', () => {
	test('types: the component prop, the view option, onChange and edytor.value', () => {
		type Value = NonNullable<EdytorProps['value']>;
		type Changed = Parameters<NonNullable<EdytorProps['onChange']>>[0];
		expectTypeOf<Changed>().toEqualTypeOf<Value>();
		expectTypeOf<Value>().toEqualTypeOf<JSONDoc>();
		expectTypeOf<EdytorInstance['value']>().toEqualTypeOf<JSONDoc>();
		expectTypeOf<Parameters<NonNullable<ReturnType<Plugin>['onChange']>>[0]>().toEqualTypeOf<JSONDoc>();
	});

	test('what onChange hands back opens as the same document', () => {
		let saved: JSONDoc | undefined;
		const edytor = view({ onChange: (next) => void (saved = next) });
		edytor.insertText('a', 0, 'x');
		expect(saved?.children.map((b) => b.id)).toEqual(['a']);
		const again = new Edytor({ document: createDocument({ value: saved }), plugins: [richTextPlugin] });
		expect(again.value.children).toEqual(edytor.value.children);
	});
});

