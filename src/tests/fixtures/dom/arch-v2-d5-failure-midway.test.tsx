/** @jsxImportSource ../../jsx */
/**
 * arch-v2 — F-M4 (§8.8, failure midway), written at D5, gated at S1.
 *
 * `ordered-list > [list-item "ab|cd"]`; the list's `normalizeChildren`
 * throws on its first call, which is the parent normalization Enter runs
 * right after the split. Expected (plan row): the command reports `failed`;
 * one undo restores the pre-command document; the Surface shows the model.
 *
 * The command result belongs to the dispatcher (S1) and does not exist
 * before it, so that half is a `todo` here. The undo and Surface halves are
 * observable today.
 *
 * Expected values come from the plan row, never from running the code.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { dispatchDomBeforeInput, flushDomUpdates, renderDomEdytor } from '../../dom/test.utils.js';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import type { Plugin } from '$lib/plugins.js';
import type { Edytor } from '$lib/edytor.svelte.js';

/** richText whose list normalizer throws on its first call only. */
const throwingOnce = (): Plugin & { calls: () => number } => {
	let calls = 0;
	const plugin: Plugin = (editor) => {
		const defs = richTextPlugin(editor);
		const list = defs.blocks!['ordered-list']!;
		defs.blocks!['ordered-list'] = {
			...list,
			normalizeChildren: () => {
				calls += 1;
				if (calls === 1) throw new Error('normalizer failed');
			}
		};
		return defs;
	};
	return Object.assign(plugin, { calls: () => calls });
};

const texts = (edytor: Edytor) =>
	(edytor.value.children?.[0]?.children ?? []).map((child) =>
		(child.content ?? []).map((part) => ('text' in part ? part.text : '')).join('')
	);

/** The text each rendered list item shows, read from the DOM. */
const shown = (editor: HTMLElement) =>
	[...editor.querySelectorAll('li')].map((li) =>
		(li.textContent ?? '').replace(/\u200b/g, '').trim()
	);

describe('F-M4 — throw after partial writes (a normalizer throws during a split)', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test('one undo restores the pre-command document, and the Surface shows the model', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const plugin = throwingOnce();
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<ordered-list>
					<list-item>ab|cd</list-item>
				</ordered-list>
			</root>,
			{ plugins: [plugin] }
		);
		const errors: unknown[] = [];
		const onError = (event: ErrorEvent) => {
			errors.push(event.error);
			event.preventDefault();
		};
		window.addEventListener('error', onError);
		try {
			await dispatchDomBeforeInput(editor, { inputType: 'insertParagraph' }).catch((error) => {
				errors.push(error);
			});
		} finally {
			window.removeEventListener('error', onError);
		}
		await flushDomUpdates();
		expect(plugin.calls(), 'the normalizer ran (and threw) during the split').toBeGreaterThan(0);
		expect(shown(editor), 'the Surface shows the model after the failure').toEqual(texts(edytor));

		edytor.historyUndo();
		await flushDomUpdates();
		expect(texts(edytor), 'one undo restores the pre-command document').toEqual(['abcd']);
		expect(shown(editor), 'the Surface shows the model after the undo').toEqual(['abcd']);
	});

	test.todo('the command reports `failed` (the dispatcher result — S1)');
});
