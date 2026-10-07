/**
 * WU-14 (API-11, API-13, API-14): naming and papercuts, on the headless view.
 *
 * - API-13 — the bindings option is `hotkeys`, as a plugin's field is;
 *   `hotKeys` stays a deprecated alias for one release. The `value` the
 *   view takes and the value `onChange` hands back are one type
 *   (`JSONDoc`), so a saved value goes back in as it is.
 * - API-14 — a snippet override naming no registered kind, mark or inline
 *   kind registers nothing and warns in development (a typo used to
 *   register a phantom kind).
 *
 * The cloudflare renames (`attachRoom`, `moveBlocksBetweenRooms`) are
 * checked against the API report in `public-surface.test.ts` and in the
 * room lane (`tests/do`).
 */
import { afterEach, describe, expect, expectTypeOf, test, vi } from 'vitest';
import { createRawSnippet } from 'svelte';
import { createDocument, type EdytorInstance, type JSONDoc, type Plugin } from '$lib/index.js';
import type { EdytorProps } from '$lib/components/Edytor.svelte';
import { Edytor, type EdytorOptions } from '$lib/edytor.svelte.js';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';

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

	test('`hotKeys` is a deprecated alias of `hotkeys`', () => {
		const calls: string[] = [];
		const edytor = view({ hotKeys: { 'mod+j': ({ prevent }) => prevent(() => void calls.push('alias')) } });
		expect(edytor.keymap.run('mod+j', key().event)).toBe(true);
		expect(calls).toEqual(['alias']);
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
		edytor.idToBlock.get('a')!.firstText!.insertText({ value: 'x', start: 0, end: 0 });
		expect(saved?.children.map((b) => b.id)).toEqual(['a']);
		const again = new Edytor({ document: createDocument({ value: saved }), plugins: [richTextPlugin] });
		expect(again.value.children).toEqual(edytor.value.children);
	});
});

describe('API-14 · a snippet override names a registered kind', () => {
	const snippet = createRawSnippet(() => ({ render: () => '<span></span>' }));

	test('an override of a known kind replaces its snippet, silently', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const edytor = view({ snippets: { paragraphBlock: snippet, boldMark: snippet } });
		expect(edytor.blocks.get('paragraph')?.snippet).toBe(snippet);
		expect(edytor.marks.get('bold')?.snippet).toBe(snippet);
		expect(warn).not.toHaveBeenCalled();
	});

	test('an override naming no kind registers nothing and warns', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const edytor = view({
			// `boldMrk` is no override name at all: only the `Snippets` cast lets it through.
			snippets: {
				paragrphBlock: snippet,
				boldMrk: snippet,
				mentonInlineBlock: snippet
			} as unknown as EdytorOptions['snippets']
		});
		expect(edytor.blocks.has('paragrph')).toBe(false);
		expect(edytor.inlineBlocks.has('menton')).toBe(false);
		const messages = warn.mock.calls.map((call) => String(call[0]));
		expect(messages.some((m) => m.includes('paragrphBlock'))).toBe(true);
		expect(messages.some((m) => m.includes('mentonInlineBlock'))).toBe(true);
		// `boldMrk` ends in no known suffix: it is no override at all.
		expect(messages.some((m) => m.includes('boldMrk'))).toBe(true);
	});
});
