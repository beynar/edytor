import type { Block } from './block.svelte.js';

export const compareBlockPath = (left: Block, right: Block) => {
	const length = Math.max(left.path.length, right.path.length);
	for (let index = 0; index < length; index++) {
		const leftSegment = left.path[index] ?? -1;
		const rightSegment = right.path[index] ?? -1;
		if (leftSegment !== rightSegment) {
			return leftSegment - rightSegment;
		}
	}
	return 0;
};

export const sortBlocksByPath = (blocks: Block[]) => [...blocks].sort(compareBlockPath);
