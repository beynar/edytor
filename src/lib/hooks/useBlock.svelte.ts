import { type Text as YText } from 'yjs';
import { useEdytor } from './useEdytor.svelte.js';
import { onMount } from 'svelte';
import { blockToJson, partialBlockToJson, type YBlock, type JSONBlock } from '$lib/utils/json.js';

export const useBlock = (yBlock: YBlock) => {
	const edytor = useEdytor();
	let block = $state<JSONBlock>(partialBlockToJson(yBlock));
	let children = $state<YBlock[]>(yBlock.get('children').toArray());

	const setBlock = () => {
		block = partialBlockToJson(yBlock);
	};
	const setChildren = () => (children = yBlock.get('children').toArray());

	return {
		get block() {
			return block;
		},

		observe: () => {
			onMount(() => {
				yBlock.observe(setBlock);
				yBlock.get('children').observe(setChildren);

				return () => {
					yBlock?.unobserve(setBlock);
					yBlock?.get('children')?.unobserve(setChildren);
				};
			});
		},
		get children() {
			return children;
		},
		get content() {
			return yBlock.get('content') as YText;
		},
		node: (node: HTMLElement) => {
			edytor.YElementsToNodes.set(yBlock, node);
			edytor.nodesToYElements.set(node, yBlock);
			node.setAttribute('data-edytor-id', `${yBlock._item?.id.client}-${yBlock._item?.id.clock}`);

			return {
				destroy: () => {
					edytor.YElementsToNodes.delete(yBlock);
					edytor.nodesToYElements.delete(node);
				}
			};
		}
	};
};
