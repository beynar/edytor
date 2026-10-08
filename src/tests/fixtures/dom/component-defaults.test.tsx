/** @jsxImportSource ../../jsx */
/**
 * Component-level regression coverage for the review fixes:
 *
 * - D1: `<Edytor>`'s default value is `{ children: [] }` — mounting with
 *   no `value` and no optional plugins can't crash on undefined
 *   `mention`/`code` definitions; the facade seeds the canonical
 *   bootstrap block.
 * - S8: `*InlineBlock` snippet overrides merge over the plugin
 *   definition — `mentionInlineBlock` maps to the bare `mention` type
 *   and replaces only the snippet.
 * - D16: `clear()` reseeds a block of the injected document's semantic
 *   `defaultType` instead of a hardcoded paragraph.
 */
import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { expect, test, describe, vi } from 'vitest';
import { createRawSnippet } from 'svelte';

import EdytorComponent from '$lib/components/Edytor.svelte';
import { createDocument } from '$lib/crdt/index.js';
import { mentionPlugin } from '../../atMention.svelte';
import {
	blockHandlesPlugin,
	createBlockHandlesPlugin,
	type BlockHandleActivation
} from '$lib/plugins/blockHandles/blockHandlesPlugin.js';
import type { InlineBlockSnippetPayload } from '$lib/plugins.js';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { renderDomEdytor } from '../../dom/test.utils.js';

describe('component defaults and overrides', () => {
	test('mounts with no value and no optional plugins — the facade seeds the bootstrap block (D1)', async () => {
		const rendered = render(EdytorComponent, {
			props: { plugins: [richTextPlugin] }
		});

		// The default value is an empty document; the document facade seeds
		// one paragraph (the semantic default) rather than dereferencing
		// absent `mention`/`code` definitions.
		await waitFor(() => {
			expect(rendered.container.querySelector('[data-edytor]')).toBeTruthy();
			expect(
				rendered.container.querySelector('[data-edytor-block][data-edytor-type="paragraph"]')
			).toBeTruthy();
			expect(rendered.container.querySelectorAll('[data-testid="block-handle"]')).toHaveLength(1);
		});
	});

	test('blockHandles=false hides the built-in handles', async () => {
		const rendered = render(EdytorComponent, {
			props: { plugins: [richTextPlugin], blockHandles: false }
		});

		await waitFor(() => {
			expect(rendered.container.querySelector('[data-edytor-block]')).toBeTruthy();
		});
		expect(rendered.container.querySelector('[data-testid="block-handle"]')).toBeNull();
	});

	test('a retired `blockDnd={false}` prop hides nothing and warns, naming `blockHandles`', async () => {
		const warn = vi.spyOn(console, 'warn');
		try {
			const rendered = render(EdytorComponent, {
				props: { plugins: [richTextPlugin], ...({ blockDnd: false } as object) }
			});
			await waitFor(() => {
				expect(rendered.container.querySelector('[data-edytor-block]')).toBeTruthy();
			});
			expect(rendered.container.querySelectorAll('[data-testid="block-handle"]')).toHaveLength(1);
			expect(warn.mock.calls.map(([message]) => String(message))).toContainEqual(
				expect.stringMatching(/`blockDnd`.*removed.*`blockHandles`/)
			);
		} finally {
			warn.mockRestore();
		}
	});

	test('blockHandles=false hides handles even when the default plugin is listed', async () => {
		const rendered = render(EdytorComponent, {
			props: {
				plugins: [richTextPlugin, blockHandlesPlugin],
				blockHandles: false
			}
		});

		await waitFor(() => {
			expect(rendered.container.querySelector('[data-edytor-block]')).toBeTruthy();
		});
		expect(rendered.container.querySelector('[data-testid="block-handle"]')).toBeNull();
	});

	test('uses one configured handle plugin when it is supplied explicitly', async () => {
		const configured = createBlockHandlesPlugin({ draggable: false });
		const rendered = render(EdytorComponent, {
			props: { plugins: [richTextPlugin, configured] }
		});

		await waitFor(() => {
			expect(rendered.container.querySelectorAll('[data-testid="block-handle"]')).toHaveLength(1);
		});
		expect(
			rendered.container.querySelector<HTMLButtonElement>('[data-testid="block-handle"]')?.draggable
		).toBe(false);
	});

	test('blockHandles=false removes an explicitly supplied configured plugin', async () => {
		const rendered = render(EdytorComponent, {
			props: {
				plugins: [richTextPlugin, createBlockHandlesPlugin()],
				blockHandles: false
			}
		});

		await waitFor(() => {
			expect(rendered.container.querySelector('[data-edytor-block]')).toBeTruthy();
		});
		expect(rendered.container.querySelector('[data-testid="block-handle"]')).toBeNull();
	});

	test('non-draggable handles retain typed activation and block selection', async () => {
		const onActivate = vi.fn((activation: BlockHandleActivation) => activation);
		const rendered = render(EdytorComponent, {
			props: {
				plugins: [richTextPlugin],
				blockHandles: { draggable: false, onActivate }
			}
		});
		const handle = await waitFor(() => {
			const node = rendered.container.querySelector<HTMLButtonElement>(
				'[data-testid="block-handle"]'
			);
			expect(node).toBeTruthy();
			if (!node) {
				throw new Error('Missing block handle');
			}
			return node;
		});
		expect(handle.draggable).toBe(false);
		expect(handle.dataset.draggable).toBeUndefined();
		let legacyMenuEvents = 0;
		rendered.container.addEventListener('edytor:block-menu', () => legacyMenuEvents++);

		await fireEvent.click(handle);

		expect(onActivate).toHaveBeenCalledOnce();
		const { block, anchor } = onActivate.mock.calls[0][0];
		expect(anchor).toBe(handle);
		expect(block.type).toBe('paragraph');
		expect(block.edytor.selection.selectedBlocks.has(block)).toBe(true);
		expect(legacyMenuEvents).toBe(0);
	});

	test('applies a *InlineBlock snippet override over the plugin definition (S8)', async () => {
		const mentionInlineBlock = createRawSnippet<[InlineBlockSnippetPayload]>(() => ({
			render: () => '<kbd data-custom-mention>custom mention</kbd>'
		}));

		const rendered = render(EdytorComponent, {
			props: {
				plugins: [richTextPlugin, mentionPlugin],
				value: {
					children: [
						{
							type: 'paragraph',
							content: [{ text: 'a ' }, { type: 'mention' }, { text: ' b' }]
						}
					]
				},
				mentionInlineBlock
			}
		});

		await waitFor(() => {
			expect(rendered.container.querySelector('[data-custom-mention]')).toBeTruthy();
		});
		// The override replaces the plugin snippet — the plugin's own
		// marker never renders.
		expect(rendered.container.querySelector('[data-edytor-mention]')).toBeNull();
	});

	test('keeps the plugin inline-block snippet when no override is supplied', async () => {
		const rendered = render(EdytorComponent, {
			props: {
				plugins: [richTextPlugin, mentionPlugin],
				value: {
					children: [
						{
							type: 'paragraph',
							content: [{ text: 'a ' }, { type: 'mention' }, { text: ' b' }]
						}
					]
				}
			}
		});

		await waitFor(() => {
			expect(rendered.container.querySelector('[data-edytor-mention]')).toBeTruthy();
		});
	});

	test('clear() reseeds a block of the injected document semantic defaultType (D16)', async () => {
		const document = createDocument({
			semantics: { defaultType: 'heading' },
			value: { children: [] }
		});
		// The fixture input only feeds the harness's cursor scan — the
		// injected document's synced content (a `heading` bootstrap block)
		// is what actually renders.
		const { edytor, container } = await renderDomEdytor(
			<root>
				<paragraph>seed</paragraph>
			</root>,
			{ document }
		);

		// The injected document already bootstrapped its semantic default.
		expect(edytor.root!.children[0].type).toBe('heading');

		edytor.clear();

		await waitFor(() => {
			expect(container.querySelector('[data-edytor-type="heading"]')).toBeTruthy();
		});
		expect(edytor.root!.children.map((block) => block.type)).toEqual(['heading']);
	});
});
