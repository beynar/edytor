/** @jsxImportSource ../../jsx */
/**
 * The block-edge behavior matrix: keys × kinds × states, one row per cell,
 * each expected outcome hand-authored from Notion's behavior (or the product
 * rule the docs state where Notion leaves it open).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { JSONBlock } from '$lib/utils/json.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { Block } from '$lib/block/block.svelte.js';
import { codePlugin } from '$lib/plugins/code/CodePlugin.svelte';
import { imagePlugin } from '$lib/plugins/image/ImagePlugin.svelte';
import { mentionPlugin } from '$lib/plugins/mention/MentionPlugin.svelte';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { flushDomUpdates, renderDomEdytor } from '../../dom/test.utils.js';

afterEach(() => {
	document.body.innerHTML = '';
});

const KINDS = {
	paragraph: { type: 'paragraph' },
	heading: { type: 'heading', data: { level: 'h2' } },
	bulleted: { type: 'bulleted-list-item' },
	numbered: { type: 'numbered-list-item' },
	todo: { type: 'todo-item', data: { checked: false } },
	'toggle open': { type: 'toggle' },
	'toggle closed': { type: 'toggle' },
	callout: { type: 'callout', data: { icon: '💡' } },
	quote: { type: 'quote' },
	'code line': { type: 'codeLine' },
	'next to a divider': { type: 'paragraph' },
	'next to an image': { type: 'paragraph' }
} satisfies Record<string, Partial<JSONBlock>>;
type Kind = keyof typeof KINDS;
type State = 'empty' | 'text' | 'with children' | 'nested';

const ABBR: Record<string, string> = {
	paragraph: 'p',
	heading: 'h',
	'bulleted-list-item': 'ul',
	'numbered-list-item': 'ol',
	'todo-item': 'todo',
	toggle: 'tg',
	callout: 'co',
	quote: 'q',
	code: 'code',
	codeLine: 'l',
	divider: 'hr',
	image: 'img'
};

const p = (text: string, children?: JSONBlock[]): JSONBlock => ({
	id: text,
	type: 'paragraph',
	content: [{ text }],
	...(children && { children })
});

/** The blocks between `pre` and `post` for a cell; the subject block's id is `x`. */
const subject = (kind: Kind, state: State): JSONBlock[] => {
	const x: JSONBlock = {
		id: 'x',
		...KINDS[kind],
		content: state === 'empty' ? [] : [{ text: 'x' }],
		...(state === 'with children' && { children: [p('c')] })
	};
	if (kind === 'code line')
		return [
			{
				id: 'code',
				type: 'code',
				children: [{ id: 'a', type: 'codeLine', content: [{ text: 'a' }] }, x]
			}
		];
	const blocks = state === 'nested' ? [p('par', [p('s'), x])] : [x];
	if (kind === 'next to a divider')
		return [{ id: 'hr1', type: 'divider' }, ...blocks, { id: 'hr2', type: 'divider' }];
	if (kind === 'next to an image') {
		const image = (id: string): JSONBlock => ({
			id,
			type: 'image',
			data: { src: 'https://example.com/i.png' }
		});
		return [image('img1'), ...blocks, image('img2')];
	}
	return blocks;
};

type Key = 'Enter' | 'Shift+Enter' | 'Backspace' | 'Delete' | 'Tab' | 'Shift+Tab';
const KEYS: Record<
	Key,
	{ key: string; shiftKey?: boolean; inputType?: string; at: 'start' | 'end' }
> = {
	Enter: { key: 'Enter', inputType: 'insertParagraph', at: 'end' },
	'Shift+Enter': { key: 'Enter', shiftKey: true, inputType: 'insertLineBreak', at: 'end' },
	Backspace: { key: 'Backspace', inputType: 'deleteContentBackward', at: 'start' },
	Delete: { key: 'Delete', inputType: 'deleteContentForward', at: 'end' },
	Tab: { key: 'Tab', at: 'start' },
	'Shift+Tab': { key: 'Tab', shiftKey: true, at: 'start' }
};

const textOf = (block: Block) => block.firstText?.stringContent ?? '';
const label = (block: Block) => {
	const node = block.node as HTMLDetailsElement | undefined;
	const open = block.type === 'toggle' ? (node?.open ? '+' : '-') : '';
	return `${ABBR[block.type] ?? block.type}${open}:${textOf(block).replaceAll('\n', '⏎')}`;
};
/** The tree as `kind:text[children]`, toggles marked open (+) or closed (-). */
const tree = (blocks: Block[]): string =>
	blocks.map((b) => label(b) + (b.children.length ? `[${tree(b.children)}]` : '')).join(' ');
/** The selection: `text@offset` for a caret, `{…}` for a block selection. */
const caret = (edytor: Edytor) => {
	const blocks = [...edytor.selection.selectedBlocks];
	if (blocks.length) return `{${blocks.map(label).join(' ')}}`;
	const { startBlock, yStart, isCollapsed } = edytor.selection.state;
	return startBlock ? `${label(startBlock)}@${yStart}${isCollapsed ? '' : '…'}` : 'none';
};

/**
 * A key press as a browser delivers it: the keydown, then — in the same task,
 * when nothing prevented it — the `beforeinput` of its editing intent.
 */
const press = async (
	editor: HTMLElement,
	{ key, shiftKey = false }: { key: string; shiftKey?: boolean },
	inputType?: string
) => {
	const keydown = new KeyboardEvent('keydown', {
		key,
		code: key,
		shiftKey,
		bubbles: true,
		cancelable: true
	});
	if (editor.dispatchEvent(keydown) && inputType) {
		const beforeinput = new Event('beforeinput', { bubbles: true, cancelable: true });
		Object.defineProperties(beforeinput, {
			inputType: { value: inputType },
			data: { value: null },
			dataTransfer: { value: null }
		});
		editor.dispatchEvent(beforeinput);
	}
	await flushDomUpdates();
};

const run = async (kind: Kind, state: State, key: Key) => {
	const children = [p('pre'), ...subject(kind, state), p('post')];
	const { edytor, editor } = await renderDomEdytor(
		<root>
			<paragraph>|</paragraph>
		</root>,
		{ plugins: [richTextPlugin, mentionPlugin, codePlugin, imagePlugin], value: { children } }
	);
	const x = edytor.idToBlock.get('x')!;
	if (kind === 'toggle open') (x.node as HTMLDetailsElement).open = true;
	const { at, inputType, ...keydown } = KEYS[key];
	const text = at === 'start' ? x.firstText! : x.lastText!;
	edytor.selection.setAtTextOffset(text, at === 'start' ? 0 : text.length);
	await flushDomUpdates();
	await press(editor, keydown, inputType);
	return `${tree(edytor.root!.children)} | ${caret(edytor)}`;
};

/**
 * Expected outcome per cell: the tree (`kind:text[children]`, a toggle `+`
 * open or `-` closed), then the selection (`text@offset`, `{…}` for a block
 * selection). The document is `[p 'pre', subject, p 'post']`; the subject
 * is block `x` (text 'x'), with a child 'c', or nested as the last child of
 * `par` after 's'; a code line is the second line of a code block after 'a';
 * the void kinds put a divider or image on each side of `x`. The caret is at
 * the end of `x` for Enter, Shift+Enter and Delete, at its start otherwise.
 *
 * Cells Notion leaves unclear are left out:
 * - Delete in an empty block of a kind other than text (Notion may keep
 *   either kind of the two blocks it joins);
 * - Enter in a callout without children (Notion's callouts take a first
 *   child or a line break depending on its version);
 * - Tab on the block right after a divider or image (whether a void block
 *   takes children);
 * - a code line with children or nested (a line has neither).
 *
 * Rows the docs state as product rules where Notion differs or is unclear
 * keep that rule ([Enter and Backspace by role](hotkeys.mdx)): Enter at the
 * end of a block with text and children splits it and the new block takes
 * the children; Backspace merging a block with children leaves them in its
 * place; Backspace after a void block selects it.
 */
const EXPECTED: Record<Kind, Partial<Record<State, Partial<Record<Key, string>>>>> = {
	paragraph: {
		empty: {
			Enter: 'p:pre p: p: p:post | p:@0',
			'Shift+Enter': 'p:pre p:⏎ p:post | p:⏎@1',
			Backspace: 'p:pre p:post | p:pre@3',
			Delete: 'p:pre p:post | p:post@0',
			Tab: 'p:pre[p:] p:post | p:@0',
			'Shift+Tab': 'p:pre p: p:post | p:@0'
		},
		text: {
			Enter: 'p:pre p:x p: p:post | p:@0',
			'Shift+Enter': 'p:pre p:x⏎ p:post | p:x⏎@2',
			Backspace: 'p:prex p:post | p:prex@3',
			Delete: 'p:pre p:xpost | p:xpost@1',
			Tab: 'p:pre[p:x] p:post | p:x@0',
			'Shift+Tab': 'p:pre p:x p:post | p:x@0'
		},
		'with children': {
			Enter: 'p:pre p:x p:[p:c] p:post | p:@0',
			'Shift+Enter': 'p:pre p:x⏎[p:c] p:post | p:x⏎@2',
			Backspace: 'p:prex p:c p:post | p:prex@3',
			Delete: 'p:pre p:xc p:post | p:xc@1',
			Tab: 'p:pre[p:x[p:c]] p:post | p:x@0',
			'Shift+Tab': 'p:pre p:x[p:c] p:post | p:x@0'
		},
		nested: {
			Enter: 'p:pre p:par[p:s p:x p:] p:post | p:@0',
			'Shift+Enter': 'p:pre p:par[p:s p:x⏎] p:post | p:x⏎@2',
			Backspace: 'p:pre p:par[p:s] p:x p:post | p:x@0',
			Delete: 'p:pre p:par[p:s p:xpost] | p:xpost@1',
			Tab: 'p:pre p:par[p:s[p:x]] p:post | p:x@0',
			'Shift+Tab': 'p:pre p:par[p:s] p:x p:post | p:x@0'
		}
	},
	heading: {
		empty: {
			Enter: 'p:pre h: p: p:post | p:@0',
			'Shift+Enter': 'p:pre h:⏎ p:post | h:⏎@1',
			Backspace: 'p:pre p: p:post | p:@0',
			Tab: 'p:pre[h:] p:post | h:@0',
			'Shift+Tab': 'p:pre h: p:post | h:@0'
		},
		text: {
			Enter: 'p:pre h:x p: p:post | p:@0',
			'Shift+Enter': 'p:pre h:x⏎ p:post | h:x⏎@2',
			Backspace: 'p:pre p:x p:post | p:x@0',
			Delete: 'p:pre h:xpost | h:xpost@1',
			Tab: 'p:pre[h:x] p:post | h:x@0',
			'Shift+Tab': 'p:pre h:x p:post | h:x@0'
		},
		'with children': {
			Enter: 'p:pre h:x h:[p:c] p:post | h:@0',
			'Shift+Enter': 'p:pre h:x⏎[p:c] p:post | h:x⏎@2',
			Backspace: 'p:pre p:x[p:c] p:post | p:x@0',
			Delete: 'p:pre h:xc p:post | h:xc@1',
			Tab: 'p:pre[h:x[p:c]] p:post | h:x@0',
			'Shift+Tab': 'p:pre h:x[p:c] p:post | h:x@0'
		},
		nested: {
			Enter: 'p:pre p:par[p:s h:x p:] p:post | p:@0',
			'Shift+Enter': 'p:pre p:par[p:s h:x⏎] p:post | h:x⏎@2',
			Backspace: 'p:pre p:par[p:s p:x] p:post | p:x@0',
			Delete: 'p:pre p:par[p:s h:xpost] | h:xpost@1',
			Tab: 'p:pre p:par[p:s[h:x]] p:post | h:x@0',
			'Shift+Tab': 'p:pre p:par[p:s] h:x p:post | h:x@0'
		}
	},
	bulleted: {
		empty: {
			Enter: 'p:pre p: p:post | p:@0',
			'Shift+Enter': 'p:pre ul:⏎ p:post | ul:⏎@1',
			Backspace: 'p:pre p: p:post | p:@0',
			Tab: 'p:pre[ul:] p:post | ul:@0',
			'Shift+Tab': 'p:pre ul: p:post | ul:@0'
		},
		text: {
			Enter: 'p:pre ul:x ul: p:post | ul:@0',
			'Shift+Enter': 'p:pre ul:x⏎ p:post | ul:x⏎@2',
			Backspace: 'p:pre p:x p:post | p:x@0',
			Delete: 'p:pre ul:xpost | ul:xpost@1',
			Tab: 'p:pre[ul:x] p:post | ul:x@0',
			'Shift+Tab': 'p:pre ul:x p:post | ul:x@0'
		},
		'with children': {
			Enter: 'p:pre ul:x ul:[p:c] p:post | ul:@0',
			'Shift+Enter': 'p:pre ul:x⏎[p:c] p:post | ul:x⏎@2',
			Backspace: 'p:pre p:x[p:c] p:post | p:x@0',
			Delete: 'p:pre ul:xc p:post | ul:xc@1',
			Tab: 'p:pre[ul:x[p:c]] p:post | ul:x@0',
			'Shift+Tab': 'p:pre ul:x[p:c] p:post | ul:x@0'
		},
		nested: {
			Enter: 'p:pre p:par[p:s ul:x ul:] p:post | ul:@0',
			'Shift+Enter': 'p:pre p:par[p:s ul:x⏎] p:post | ul:x⏎@2',
			Backspace: 'p:pre p:par[p:s p:x] p:post | p:x@0',
			Delete: 'p:pre p:par[p:s ul:xpost] | ul:xpost@1',
			Tab: 'p:pre p:par[p:s[ul:x]] p:post | ul:x@0',
			'Shift+Tab': 'p:pre p:par[p:s] ul:x p:post | ul:x@0'
		}
	},
	numbered: {
		empty: {
			Enter: 'p:pre p: p:post | p:@0',
			'Shift+Enter': 'p:pre ol:⏎ p:post | ol:⏎@1',
			Backspace: 'p:pre p: p:post | p:@0',
			Tab: 'p:pre[ol:] p:post | ol:@0',
			'Shift+Tab': 'p:pre ol: p:post | ol:@0'
		},
		text: {
			Enter: 'p:pre ol:x ol: p:post | ol:@0',
			'Shift+Enter': 'p:pre ol:x⏎ p:post | ol:x⏎@2',
			Backspace: 'p:pre p:x p:post | p:x@0',
			Delete: 'p:pre ol:xpost | ol:xpost@1',
			Tab: 'p:pre[ol:x] p:post | ol:x@0',
			'Shift+Tab': 'p:pre ol:x p:post | ol:x@0'
		},
		'with children': {
			Enter: 'p:pre ol:x ol:[p:c] p:post | ol:@0',
			'Shift+Enter': 'p:pre ol:x⏎[p:c] p:post | ol:x⏎@2',
			Backspace: 'p:pre p:x[p:c] p:post | p:x@0',
			Delete: 'p:pre ol:xc p:post | ol:xc@1',
			Tab: 'p:pre[ol:x[p:c]] p:post | ol:x@0',
			'Shift+Tab': 'p:pre ol:x[p:c] p:post | ol:x@0'
		},
		nested: {
			Enter: 'p:pre p:par[p:s ol:x ol:] p:post | ol:@0',
			'Shift+Enter': 'p:pre p:par[p:s ol:x⏎] p:post | ol:x⏎@2',
			Backspace: 'p:pre p:par[p:s p:x] p:post | p:x@0',
			Delete: 'p:pre p:par[p:s ol:xpost] | ol:xpost@1',
			Tab: 'p:pre p:par[p:s[ol:x]] p:post | ol:x@0',
			'Shift+Tab': 'p:pre p:par[p:s] ol:x p:post | ol:x@0'
		}
	},
	todo: {
		empty: {
			Enter: 'p:pre p: p:post | p:@0',
			'Shift+Enter': 'p:pre todo:⏎ p:post | todo:⏎@1',
			Backspace: 'p:pre p: p:post | p:@0',
			Tab: 'p:pre[todo:] p:post | todo:@0',
			'Shift+Tab': 'p:pre todo: p:post | todo:@0'
		},
		text: {
			Enter: 'p:pre todo:x todo: p:post | todo:@0',
			'Shift+Enter': 'p:pre todo:x⏎ p:post | todo:x⏎@2',
			Backspace: 'p:pre p:x p:post | p:x@0',
			Delete: 'p:pre todo:xpost | todo:xpost@1',
			Tab: 'p:pre[todo:x] p:post | todo:x@0',
			'Shift+Tab': 'p:pre todo:x p:post | todo:x@0'
		},
		'with children': {
			Enter: 'p:pre todo:x todo:[p:c] p:post | todo:@0',
			'Shift+Enter': 'p:pre todo:x⏎[p:c] p:post | todo:x⏎@2',
			Backspace: 'p:pre p:x[p:c] p:post | p:x@0',
			Delete: 'p:pre todo:xc p:post | todo:xc@1',
			Tab: 'p:pre[todo:x[p:c]] p:post | todo:x@0',
			'Shift+Tab': 'p:pre todo:x[p:c] p:post | todo:x@0'
		},
		nested: {
			Enter: 'p:pre p:par[p:s todo:x todo:] p:post | todo:@0',
			'Shift+Enter': 'p:pre p:par[p:s todo:x⏎] p:post | todo:x⏎@2',
			Backspace: 'p:pre p:par[p:s p:x] p:post | p:x@0',
			Delete: 'p:pre p:par[p:s todo:xpost] | todo:xpost@1',
			Tab: 'p:pre p:par[p:s[todo:x]] p:post | todo:x@0',
			'Shift+Tab': 'p:pre p:par[p:s] todo:x p:post | todo:x@0'
		}
	},
	'toggle open': {
		empty: {
			Enter: 'p:pre p: p:post | p:@0',
			'Shift+Enter': 'p:pre tg+:⏎ p:post | tg+:⏎@1',
			Backspace: 'p:pre p: p:post | p:@0',
			Tab: 'p:pre[tg+:] p:post | tg+:@0',
			'Shift+Tab': 'p:pre tg+: p:post | tg+:@0'
		},
		text: {
			Enter: 'p:pre tg+:x[p:] p:post | p:@0',
			'Shift+Enter': 'p:pre tg+:x⏎ p:post | tg+:x⏎@2',
			Backspace: 'p:pre p:x p:post | p:x@0',
			Delete: 'p:pre tg+:xpost | tg+:xpost@1',
			Tab: 'p:pre[tg+:x] p:post | tg+:x@0',
			'Shift+Tab': 'p:pre tg+:x p:post | tg+:x@0'
		},
		'with children': {
			Enter: 'p:pre tg+:x[p: p:c] p:post | p:@0',
			'Shift+Enter': 'p:pre tg+:x⏎[p:c] p:post | tg+:x⏎@2',
			Backspace: 'p:pre p:x[p:c] p:post | p:x@0',
			Delete: 'p:pre tg+:xc p:post | tg+:xc@1',
			Tab: 'p:pre[tg+:x[p:c]] p:post | tg+:x@0',
			'Shift+Tab': 'p:pre tg+:x[p:c] p:post | tg+:x@0'
		},
		nested: {
			Enter: 'p:pre p:par[p:s tg+:x[p:]] p:post | p:@0',
			'Shift+Enter': 'p:pre p:par[p:s tg+:x⏎] p:post | tg+:x⏎@2',
			Backspace: 'p:pre p:par[p:s p:x] p:post | p:x@0',
			Delete: 'p:pre p:par[p:s tg+:xpost] | tg+:xpost@1',
			Tab: 'p:pre p:par[p:s[tg+:x]] p:post | tg+:x@0',
			'Shift+Tab': 'p:pre p:par[p:s] tg+:x p:post | tg+:x@0'
		}
	},
	'toggle closed': {
		empty: {
			Enter: 'p:pre p: p:post | p:@0',
			'Shift+Enter': 'p:pre tg-:⏎ p:post | tg-:⏎@1',
			Backspace: 'p:pre p: p:post | p:@0',
			Tab: 'p:pre[tg-:] p:post | tg-:@0',
			'Shift+Tab': 'p:pre tg-: p:post | tg-:@0'
		},
		text: {
			Enter: 'p:pre tg-:x tg-: p:post | tg-:@0',
			'Shift+Enter': 'p:pre tg-:x⏎ p:post | tg-:x⏎@2',
			Backspace: 'p:pre p:x p:post | p:x@0',
			Delete: 'p:pre tg-:xpost | tg-:xpost@1',
			Tab: 'p:pre[tg-:x] p:post | tg-:x@0',
			'Shift+Tab': 'p:pre tg-:x p:post | tg-:x@0'
		},
		'with children': {
			Enter: 'p:pre tg-:x[p:c] tg-: p:post | tg-:@0',
			'Shift+Enter': 'p:pre tg-:x⏎[p:c] p:post | tg-:x⏎@2',
			Backspace: 'p:pre p:x[p:c] p:post | p:x@0',
			Delete: 'p:pre tg-:xpost[p:c] | tg-:xpost@1',
			Tab: 'p:pre[tg-:x[p:c]] p:post | tg-:x@0',
			'Shift+Tab': 'p:pre tg-:x[p:c] p:post | tg-:x@0'
		},
		nested: {
			Enter: 'p:pre p:par[p:s tg-:x tg-:] p:post | tg-:@0',
			'Shift+Enter': 'p:pre p:par[p:s tg-:x⏎] p:post | tg-:x⏎@2',
			Backspace: 'p:pre p:par[p:s p:x] p:post | p:x@0',
			Delete: 'p:pre p:par[p:s tg-:xpost] | tg-:xpost@1',
			Tab: 'p:pre p:par[p:s[tg-:x]] p:post | tg-:x@0',
			'Shift+Tab': 'p:pre p:par[p:s] tg-:x p:post | tg-:x@0'
		}
	},
	callout: {
		empty: {
			'Shift+Enter': 'p:pre co:⏎ p:post | co:⏎@1',
			Backspace: 'p:pre p: p:post | p:@0',
			Tab: 'p:pre[co:] p:post | co:@0',
			'Shift+Tab': 'p:pre co: p:post | co:@0'
		},
		text: {
			'Shift+Enter': 'p:pre co:x⏎ p:post | co:x⏎@2',
			Backspace: 'p:pre p:x p:post | p:x@0',
			Delete: 'p:pre co:xpost | co:xpost@1',
			Tab: 'p:pre[co:x] p:post | co:x@0',
			'Shift+Tab': 'p:pre co:x p:post | co:x@0'
		},
		'with children': {
			Enter: 'p:pre co:x[p: p:c] p:post | p:@0',
			'Shift+Enter': 'p:pre co:x⏎[p:c] p:post | co:x⏎@2',
			Backspace: 'p:pre p:x[p:c] p:post | p:x@0',
			Delete: 'p:pre co:xc p:post | co:xc@1',
			Tab: 'p:pre[co:x[p:c]] p:post | co:x@0',
			'Shift+Tab': 'p:pre co:x[p:c] p:post | co:x@0'
		},
		nested: {
			Enter: 'p:pre p:par[p:s co:x p:] p:post | p:@0',
			'Shift+Enter': 'p:pre p:par[p:s co:x⏎] p:post | co:x⏎@2',
			Backspace: 'p:pre p:par[p:s p:x] p:post | p:x@0',
			Delete: 'p:pre p:par[p:s co:xpost] | co:xpost@1',
			Tab: 'p:pre p:par[p:s[co:x]] p:post | co:x@0',
			'Shift+Tab': 'p:pre p:par[p:s] co:x p:post | co:x@0'
		}
	},
	quote: {
		empty: {
			Enter: 'p:pre q: p: p:post | p:@0',
			'Shift+Enter': 'p:pre q:⏎ p:post | q:⏎@1',
			Backspace: 'p:pre p: p:post | p:@0',
			Tab: 'p:pre[q:] p:post | q:@0',
			'Shift+Tab': 'p:pre q: p:post | q:@0'
		},
		text: {
			Enter: 'p:pre q:x p: p:post | p:@0',
			'Shift+Enter': 'p:pre q:x⏎ p:post | q:x⏎@2',
			Backspace: 'p:pre p:x p:post | p:x@0',
			Delete: 'p:pre q:xpost | q:xpost@1',
			Tab: 'p:pre[q:x] p:post | q:x@0',
			'Shift+Tab': 'p:pre q:x p:post | q:x@0'
		},
		'with children': {
			Enter: 'p:pre q:x[p: p:c] p:post | p:@0',
			'Shift+Enter': 'p:pre q:x⏎[p:c] p:post | q:x⏎@2',
			Backspace: 'p:pre p:x[p:c] p:post | p:x@0',
			Delete: 'p:pre q:xc p:post | q:xc@1',
			Tab: 'p:pre[q:x[p:c]] p:post | q:x@0',
			'Shift+Tab': 'p:pre q:x[p:c] p:post | q:x@0'
		},
		nested: {
			Enter: 'p:pre p:par[p:s q:x p:] p:post | p:@0',
			'Shift+Enter': 'p:pre p:par[p:s q:x⏎] p:post | q:x⏎@2',
			Backspace: 'p:pre p:par[p:s p:x] p:post | p:x@0',
			Delete: 'p:pre p:par[p:s q:xpost] | q:xpost@1',
			Tab: 'p:pre p:par[p:s[q:x]] p:post | q:x@0',
			'Shift+Tab': 'p:pre p:par[p:s] q:x p:post | q:x@0'
		}
	},
	'code line': {
		empty: {
			// The empty last line leaves the code block (Enter by role, island of lines).
			Enter: 'p:pre code:[l:a] p: p:post | p:@0',
			'Shift+Enter': 'p:pre code:[l:a l: l:] p:post | l:@0',
			Backspace: 'p:pre code:[l:a] p:post | l:a@1',
			Delete: 'p:pre code:[l:a l:] p:post | l:@0',
			Tab: 'p:pre code:[l:a l:\t] p:post | l:\t@1',
			'Shift+Tab': 'p:pre code:[l:a l:] p:post | l:@0'
		},
		text: {
			Enter: 'p:pre code:[l:a l:x l:] p:post | l:@0',
			'Shift+Enter': 'p:pre code:[l:a l:x l:] p:post | l:@0',
			Backspace: 'p:pre code:[l:ax] p:post | l:ax@1',
			Delete: 'p:pre code:[l:a l:x] p:post | l:x@1',
			Tab: 'p:pre code:[l:a l:\tx] p:post | l:\tx@1',
			'Shift+Tab': 'p:pre code:[l:a l:x] p:post | l:x@0'
		}
	},
	'next to a divider': {
		empty: {
			Enter: 'p:pre hr: p: p: hr: p:post | p:@0',
			'Shift+Enter': 'p:pre hr: p:⏎ hr: p:post | p:⏎@1',
			Backspace: 'p:pre hr: p: hr: p:post | {hr:}',
			Delete: 'p:pre hr: p: hr: p:post | {hr:}',
			'Shift+Tab': 'p:pre hr: p: hr: p:post | p:@0'
		},
		text: {
			Enter: 'p:pre hr: p:x p: hr: p:post | p:@0',
			'Shift+Enter': 'p:pre hr: p:x⏎ hr: p:post | p:x⏎@2',
			Backspace: 'p:pre hr: p:x hr: p:post | {hr:}',
			Delete: 'p:pre hr: p:x hr: p:post | {hr:}',
			'Shift+Tab': 'p:pre hr: p:x hr: p:post | p:x@0'
		},
		'with children': {
			Enter: 'p:pre hr: p:x p:[p:c] hr: p:post | p:@0',
			'Shift+Enter': 'p:pre hr: p:x⏎[p:c] hr: p:post | p:x⏎@2',
			Backspace: 'p:pre hr: p:x[p:c] hr: p:post | {hr:}',
			Delete: 'p:pre hr: p:xc hr: p:post | p:xc@1',
			'Shift+Tab': 'p:pre hr: p:x[p:c] hr: p:post | p:x@0'
		},
		nested: {
			Enter: 'p:pre hr: p:par[p:s p:x p:] hr: p:post | p:@0',
			'Shift+Enter': 'p:pre hr: p:par[p:s p:x⏎] hr: p:post | p:x⏎@2',
			Backspace: 'p:pre hr: p:par[p:s] p:x hr: p:post | p:x@0',
			Delete: 'p:pre hr: p:par[p:s p:x] hr: p:post | {hr:}',
			Tab: 'p:pre hr: p:par[p:s[p:x]] hr: p:post | p:x@0',
			'Shift+Tab': 'p:pre hr: p:par[p:s] p:x hr: p:post | p:x@0'
		}
	},
	'next to an image': {
		empty: {
			Enter: 'p:pre img: p: p: img: p:post | p:@0',
			'Shift+Enter': 'p:pre img: p:⏎ img: p:post | p:⏎@1',
			Backspace: 'p:pre img: p: img: p:post | {img:}',
			Delete: 'p:pre img: p: img: p:post | {img:}',
			'Shift+Tab': 'p:pre img: p: img: p:post | p:@0'
		},
		text: {
			Enter: 'p:pre img: p:x p: img: p:post | p:@0',
			'Shift+Enter': 'p:pre img: p:x⏎ img: p:post | p:x⏎@2',
			Backspace: 'p:pre img: p:x img: p:post | {img:}',
			Delete: 'p:pre img: p:x img: p:post | {img:}',
			'Shift+Tab': 'p:pre img: p:x img: p:post | p:x@0'
		},
		'with children': {
			Enter: 'p:pre img: p:x p:[p:c] img: p:post | p:@0',
			'Shift+Enter': 'p:pre img: p:x⏎[p:c] img: p:post | p:x⏎@2',
			Backspace: 'p:pre img: p:x[p:c] img: p:post | {img:}',
			Delete: 'p:pre img: p:xc img: p:post | p:xc@1',
			'Shift+Tab': 'p:pre img: p:x[p:c] img: p:post | p:x@0'
		},
		nested: {
			Enter: 'p:pre img: p:par[p:s p:x p:] img: p:post | p:@0',
			'Shift+Enter': 'p:pre img: p:par[p:s p:x⏎] img: p:post | p:x⏎@2',
			Backspace: 'p:pre img: p:par[p:s] p:x img: p:post | p:x@0',
			Delete: 'p:pre img: p:par[p:s p:x] img: p:post | {img:}',
			Tab: 'p:pre img: p:par[p:s[p:x]] img: p:post | p:x@0',
			'Shift+Tab': 'p:pre img: p:par[p:s] p:x img: p:post | p:x@0'
		}
	}
};

describe('block-edge behavior matrix', () => {
	const cells = (Object.keys(EXPECTED) as Kind[]).flatMap((kind) =>
		(Object.keys(EXPECTED[kind]) as State[]).flatMap((state) =>
			(Object.entries(EXPECTED[kind][state]!) as [Key, string][]).map(
				([key, expected]) => [key, kind, state, expected] as const
			)
		)
	);

	it.each(cells)('%s in %s (%s)', async (key, kind, state, expected) => {
		expect(await run(kind, state, key)).toBe(expected);
	});
});
