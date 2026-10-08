import type { Block } from '$lib/block/block.svelte.js';

/**
 * Start the body of `block`, a container whose body shows and is empty
 * (`body.hint`): a block of its default child kind as its first child, the
 * caret in it. One command, one undo step (refused in a view that may not
 * write). A body that has a child by now (a peer's) takes the caret in its
 * first child instead. Answers the first child.
 */
export const openBody = (block: Block): Block | undefined => {
	const { edytor } = block;
	return edytor.dispatcher.run('openBody', () => {
		const child =
			block.children[0] ??
			block.addChildBlock({ block: { type: edytor.defaultChild(block) }, index: 0 });
		edytor.dispatcher.caret(child?.firstText, 0);
		return child ?? undefined;
	});
};
