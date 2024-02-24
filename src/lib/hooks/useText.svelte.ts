import { onMount } from 'svelte';
import { useEdytor } from './useEdytor.svelte.js';
import * as Y from 'yjs';
import { yTextToJSON, type JSONText } from '$lib/utils/json.js';

export const useText = (yText: Y.Text) => {
	const edytor = useEdytor();
	let marks = $state<JSONText[]>(yTextToJSON(yText));
	const setText = () => (marks = yTextToJSON(yText));
	return {
		get marks() {
			return marks;
		},
		observe: () => {
			onMount(() => {
				yText.observe(setText);
				return () => {
					yText.unobserve(setText);
				};
			});
		},
		node: (node: HTMLElement) => {
			edytor.YElementsToNodes.set(yText, node);
			edytor.nodesToYElements.set(node, yText);
			node.setAttribute('data-edytor-id', `${yText._item?.id.client}-${yText._item?.id.clock}`);
			return {
				destroy: () => {
					edytor.YElementsToNodes.delete(yText);
					edytor.nodesToYElements.delete(node);
				}
			};
		}
	};
};
