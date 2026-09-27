import type { Block } from '$lib/block/block.svelte.js';
import type { JSONBlock } from '$lib/utils/json.js';
import type { Plugin } from '$lib/plugins.js';

type Shortcut =
	| { type: 'heading'; level: 'h1' | 'h2' | 'h3' }
	| { type: 'bulleted-list-item' }
	| { type: 'numbered-list-item' }
	| { type: 'todo-item' }
	| { type: 'quote' }
	| { type: 'divider' }
	| { type: 'code' };

const getShortcut = (prefix: string, insertedText: string): Shortcut | null => {
	if (insertedText === ' ') {
		if (prefix === '#') {
			return { type: 'heading', level: 'h1' };
		}
		if (prefix === '##') {
			return { type: 'heading', level: 'h2' };
		}
		if (prefix === '###') {
			return { type: 'heading', level: 'h3' };
		}
		if (prefix === '-' || prefix === '*') {
			return { type: 'bulleted-list-item' };
		}
		if (prefix === '1.') {
			return { type: 'numbered-list-item' };
		}
		if (prefix === '[ ]' || prefix === '[]') {
			return { type: 'todo-item' };
		}
		if (prefix === '>') {
			return { type: 'quote' };
		}
	}
	if (insertedText === '-' && prefix === '--') {
		return { type: 'divider' };
	}
	if (insertedText === '`' && prefix === '``') {
		return { type: 'code' };
	}
	return null;
};

const canApplyShortcut = (block: Block, prefixLength: number) => {
	const { selection } = block.edytor;
	return (
		selection.state.isCollapsed &&
		selection.state.startText === block.firstText &&
		selection.state.yStart === prefixLength &&
		selection.state.yStart === selection.state.startText.length &&
		block.convertible
	);
};

/** The conversion a shortcut asks for; content-replacing kinds drop the text. */
const conversionOf = (shortcut: Shortcut): Partial<JSONBlock> & { type: string } => {
	switch (shortcut.type) {
		case 'heading':
			return { type: 'heading', data: { level: shortcut.level } };
		case 'todo-item':
			return { type: 'todo-item', data: { checked: false } };
		case 'divider':
			return { type: 'divider', data: {}, content: [], children: [] };
		case 'code':
			return {
				type: 'code',
				data: {},
				content: [],
				children: [{ type: 'codeLine', content: [{ text: '' }] }]
			};
		default:
			return { type: shortcut.type };
	}
};

/**
 * Convert `block`, the shortcut's prefix removal leading the conversion: one
 * plan, so a refusal of either refuses both (F-M3). The caret lands at the
 * start of the converted kind's first text. Answers whether it applied.
 */
const applyShortcut = (block: Block, shortcut: Shortcut, prefixLength: number) => {
	const { edytor } = block;
	const value = conversionOf(shortcut);
	if (!edytor.blocks.has(value.type) || (value.type === 'code' && !edytor.blocks.has('codeLine')))
		return false;
	const prefix = edytor.facade.prepare.deleteText(block.model!.id, 0, prefixLength);
	edytor.dispatcher.lead(prefix, () => block.setBlock({ value }));
	if (edytor.dispatcher.last?.status !== 'applied') return false;
	const target = value.type === 'code' ? block.children[0] : block;
	edytor.dispatcher.caret(target?.firstText, 0);
	return true;
};

export const markdownShortcutsPlugin: Plugin = (edytor) => {
	/** The typed text landing as typed after a refused conversion. */
	let fallback = false;
	return {
		onBeforeOperation: ({ operation, payload, block, prevent }) => {
			if (fallback || operation !== 'insertText' || block !== edytor.selection.state.startBlock) {
				return;
			}

			const { startText, yStart } = edytor.selection.state;
			if (!startText || startText !== block.firstText) {
				return;
			}

			const prefix = startText.stringContent.slice(0, yStart);
			const shortcut = getShortcut(prefix, payload.value);
			if (!shortcut || !canApplyShortcut(block, prefix.length)) {
				return;
			}

			prevent(() => {
				if (applyShortcut(block, shortcut, prefix.length)) return;
				fallback = true;
				try {
					startText.insertText(payload);
				} finally {
					fallback = false;
				}
				edytor.dispatcher.caret(startText, (payload.start ?? yStart) + payload.value.length);
			});
		}
	};
};
