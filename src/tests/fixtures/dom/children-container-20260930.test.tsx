/** @jsxImportSource ../../jsx */
/**
 * Nesting is owned in one place: every rich text kind that has children
 * renders them in ONE container marked `data-edytor-children`, a direct
 * child of the block element, which the default styles and the Notion theme
 * indent by one nesting step (`--edytor-nest-indent`). A block without
 * children renders no container. The measured indent is Chromium's:
 * `tests/editor-dom/nest-indent.spec.ts`. Expected states are hand-authored.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { JSONBlock } from '$lib/utils/json.js';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { renderDomEdytor } from '../../dom/test.utils.js';

afterEach(() => {
	document.body.innerHTML = '';
});

const kid = (id: string): JSONBlock => ({ id, type: 'paragraph', content: [{ text: id }] });
const parent = (type: string, data?: Record<string, unknown>): JSONBlock => ({
	id: type,
	type,
	...(data && { data }),
	content: [{ text: type }],
	children: [kid(`${type}-child`)]
});

const KINDS: [string, Record<string, unknown>?][] = [
	['paragraph'],
	['heading', { level: 'h2' }],
	['quote'],
	['callout', { icon: '💡' }],
	['bulleted-list-item'],
	['numbered-list-item'],
	['todo-item', { checked: false }],
	['toggle']
];

describe('the children container', () => {
	it('each kind with children holds them in one marked container, a direct child', async () => {
		const { editor } = await renderDomEdytor(
			<root>
				<paragraph>|</paragraph>
			</root>,
			{
				plugins: [richTextPlugin],
				value: { children: [...KINDS.map(([type, data]) => parent(type, data)), kid('alone')] },
				autoSelectFixture: false
			}
		);
		const containers = KINDS.map(([type]) => {
			const block = editor.querySelector<HTMLElement>(`[data-edytor-id="${type}"]`)!;
			const own = block.querySelectorAll(':scope > [data-edytor-children]');
			const child = block.querySelector(`[data-edytor-id="${type}-child"]`);
			return [type, own.length, child?.parentElement === own[0]];
		});
		expect(containers).toEqual(KINDS.map(([type]) => [type, 1, true]));
		// No container without children; none inside a heading's or quote's own tag.
		const alone = editor.querySelector('[data-edytor-id="alone"]')!;
		expect(alone.querySelector('[data-edytor-children]')).toBeNull();
		expect(
			editor.querySelectorAll(':is(h1, h2, h3, blockquote, p) [data-edytor-children]')
		).toHaveLength(0);
	});
});
