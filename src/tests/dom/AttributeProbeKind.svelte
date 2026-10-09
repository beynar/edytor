<script module lang="ts">
	/**
	 * A text kind whose declared element attributes count their reads: each
	 * build of a block element's attributes (`Block.svelte`) spreads them, so
	 * `reads` names the blocks whose attributes were built again.
	 */
	import type { BlockSnippetPayload, Plugin } from '$lib/plugins.js';

	export const attributeProbePlugin =
		(reads: string[]): Plugin =>
		() => ({
			blocks: {
				probe: {
					snippet: probe,
					element: (_data: Record<string, unknown>, id: string) => ({
						tag: 'div',
						attributes: {
							get 'data-probe'() {
								reads.push(id);
								return 'true';
							}
						}
					})
				}
			}
		});
</script>

{#snippet probe({ content, children }: BlockSnippetPayload)}
	<div>{@render content()}</div>
	{@render children?.()}
{/snippet}
