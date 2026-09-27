<script module lang="ts">
	/**
	 * arch-v2 S6 extension-cost fixture (§10 (a), (b)): a NEW block kind and a
	 * NEW mark, each ONE record. Nothing else in the tree names `banner` or
	 * `glow`: the slash menu, markdown shortcuts, block menus (`edytor.kinds`)
	 * and the clipboard's HTML/plain export read these records.
	 */
	import type { BlockSnippetPayload, MarkSnippetPayload, Plugin } from '$lib/plugins.js';

	export const bannerPlugin: Plugin = () => ({
		blocks: {
			banner: {
				snippet: banner,
				presets: [
					{
						label: 'Banner',
						icon: '⚑',
						keywords: ['announce'],
						data: { tone: 'info' },
						markdown: ['!! ']
					}
				],
				html: (block, content, children) =>
					`<aside data-tone="${block.data?.tone}">${content}</aside>${children}`,
				plain: (_, content, children) => [`! ${content}`, children].filter(Boolean).join('\n')
			}
		},
		marks: {
			glow: {
				snippet: glow,
				html: 'mark',
				toolbar: { label: 'Glow', icon: '✧' }
			}
		}
	});
</script>

{#snippet banner({ block, content, children }: BlockSnippetPayload)}
	<aside use:block.attach data-edytor-type="banner">
		<div>{@render content()}</div>
		{@render children?.()}
	</aside>
{/snippet}

{#snippet glow({ content }: MarkSnippetPayload)}
	<mark>{@render content()}</mark>
{/snippet}
