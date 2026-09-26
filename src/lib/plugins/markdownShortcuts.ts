import type { Block } from '$lib/block/block.svelte.js';
import type { SerializableContent } from '$lib/utils/json.js';
import type { Plugin } from '$lib/plugins.js';
import { tick } from 'svelte';

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
		!block.definition.void &&
		!block.definition.island &&
		!block.insideIsland &&
		block.type !== 'codeLine'
	);
};

const clearShortcutText = (block: Block, length: number) => {
	const text = block.firstText;
	if (length > 0) {
		text.deleteAt(0, length);
	}
};

const restoreConvertedBlockSelection = (block: Block, offset: number) => {
	const getTarget = () => block.firstText;
	const setModelState = () => {
		const target = getTarget();
		block.edytor.selection.setCollapsedStateAtTextOffset(target, Math.min(offset, target.length));
	};

	setModelState();
	void block.edytor.selection.setAtTextOffset(getTarget(), Math.min(offset, getTarget().length));
	void tick().then(() => {
		const target = getTarget();
		void block.edytor.selection.setAtTextOffset(target, Math.min(offset, target.length));
	});
};

const convertToCodeBlock = (block: Block) => {
	if (!block.edytor.blocks.has('code') || !block.edytor.blocks.has('codeLine')) {
		return;
	}
	block.setBlock({
		value: {
			type: 'code',
			data: {},
			content: [],
			children: [{ type: 'codeLine', content: [{ text: '' }] }]
		}
	});
	const codeLine = block.children[0];
	if (codeLine) {
		restoreConvertedBlockSelection(codeLine, 0);
	}
};

const convertCurrentBlock = (
	block: Block,
	value: {
		type: string;
		data?: Record<string, SerializableContent>;
		content?: [];
		children?: [];
	}
) => {
	if (!block.edytor.blocks.has(value.type)) {
		return;
	}
	block.setBlock({ value });
	restoreConvertedBlockSelection(block, 0);
};

const applyShortcut = (block: Block, shortcut: Shortcut, prefixLength: number) => {
	clearShortcutText(block, prefixLength);

	if (shortcut.type === 'heading') {
		convertCurrentBlock(block, {
			type: 'heading',
			data: { level: shortcut.level }
		});
		return;
	}
	if (shortcut.type === 'bulleted-list-item') {
		convertCurrentBlock(block, {
			type: 'bulleted-list-item'
		});
		return;
	}
	if (shortcut.type === 'numbered-list-item') {
		convertCurrentBlock(block, {
			type: 'numbered-list-item'
		});
		return;
	}
	if (shortcut.type === 'todo-item') {
		convertCurrentBlock(block, {
			type: 'todo-item',
			data: { checked: false }
		});
		return;
	}
	if (shortcut.type === 'quote') {
		convertCurrentBlock(block, {
			type: 'quote'
		});
		return;
	}
	if (shortcut.type === 'divider') {
		convertCurrentBlock(block, {
			type: 'divider',
			data: {},
			content: [],
			children: []
		});
		return;
	}
	if (shortcut.type === 'code') {
		convertToCodeBlock(block);
	}
};

export const markdownShortcutsPlugin: Plugin = (edytor) => ({
	onBeforeOperation: ({ operation, payload, block, prevent }) => {
		if (operation !== 'insertText' || block !== edytor.selection.state.startBlock) {
			return;
		}

		const startText = edytor.selection.state.startText;
		if (!startText || startText !== block.firstText) {
			return;
		}

		const prefix = startText.stringContent.slice(0, edytor.selection.state.yStart);
		const shortcut = getShortcut(prefix, payload.value);
		if (!shortcut || !canApplyShortcut(block, prefix.length)) {
			return;
		}

		prevent(() => {
			applyShortcut(block, shortcut, prefix.length);
		});
	}
});
