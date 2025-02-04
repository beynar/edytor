<script module lang="ts">
	import type { Edytor } from '$lib/edytor.svelte.js';
	import type { Plugin, MarkSnippetPayload, BlockSnippetPayload } from '$lib/plugins.js';
	import type { SerializableContent } from '$lib/utils/json.js';

	const setMarkAndSelect = (edytor: Edytor, mark: string, value?: SerializableContent) => {
		const { yStart, yEnd, startText } = edytor.selection.state;
		if (startText) {
			edytor.selection.state.startText?.markText({
				mark: mark,
				value,
				toggle: true,
				start: yStart,
				end: yEnd
			});

			edytor.selection.setSelectionAtTextRange(startText, yStart, yEnd);
		}
	};
	export const richTextPlugin: Plugin = (edytor) => {
		return {
			hotkeys: {
				'mod+b': ({ edytor }) => {
					setMarkAndSelect(edytor, 'bold');
				},
				'mod+i': ({ edytor }) => {
					setMarkAndSelect(edytor, 'italic');
				},
				'mod+u': ({ edytor }) => {
					setMarkAndSelect(edytor, 'underline');
				},
				'mod+e': ({ edytor }) => {
					setMarkAndSelect(edytor, 'code');
				},
				'mod+shift+x': ({ edytor }) => {
					setMarkAndSelect(edytor, 'strike');
				},
				'mod+shift+h': ({ edytor }) => {
					setMarkAndSelect(edytor, 'color', 'red');
				}
			},
			onBeforeOperation: ({ operation, payload, text, prevent }) => {
				if (operation === 'insertText' && payload.value === 'a') {
					prevent(() => {
						const { yStart } = edytor.selection.state;
						edytor.doc.transact(() => {
							text.insertText({ value: 'b' });
						});
						edytor.selection.shift(1);
						edytor.selection.setAtTextOffset(text, yStart + 1);
					});
				}
			},
			marks: {
				bold,
				italic,
				underline,
				code,
				link,
				strike,
				superscript,
				subscript,
				color,
				highlight
			},
			blocks: {
				paragraph,
				details,
				heading,
				orderedList,
				unorderedList,
				listItem,
				horizontalRule
			}
		};
	};
</script>

<script>
</script>

{#snippet bold({ content }: MarkSnippetPayload)}
	<b>
		{@render content()}
	</b>
{/snippet}

{#snippet italic({ content }: MarkSnippetPayload)}
	<i>
		{@render content()}
	</i>
{/snippet}

{#snippet underline({ content }: MarkSnippetPayload)}
	<u>
		{@render content()}
	</u>
{/snippet}

{#snippet code({ content }: MarkSnippetPayload)}
	<code>
		{@render content()}
	</code>
{/snippet}

{#snippet link({ mark, content }: MarkSnippetPayload<{ href: string; target?: string }>)}
	<a href={mark.href} target={mark.target}>
		{@render content()}
	</a>
{/snippet}

{#snippet strike({ content }: MarkSnippetPayload)}
	<s>
		{@render content()}
	</s>
{/snippet}

{#snippet superscript({ content }: MarkSnippetPayload)}
	<sup>
		{@render content()}
	</sup>
{/snippet}

{#snippet subscript({ content }: MarkSnippetPayload)}
	<sub>
		{@render content()}
	</sub>
{/snippet}

{#snippet color({ mark, content }: MarkSnippetPayload<{ color: string }>)}
	<span style="color: {mark}">
		{@render content()}
	</span>
{/snippet}

{#snippet highlight({ mark, content }: MarkSnippetPayload<string>)}
	<span style="background-color: {mark}">
		{@render content()}
	</span>
{/snippet}

{#snippet paragraph({ block, content, children }: BlockSnippetPayload)}
	<div use:block.attach>
		<p>
			{@render content()}
		</p>
		{#if children}
			<div style:padding-left="10px">
				{@render children()}
			</div>
		{/if}
	</div>
{/snippet}
{#snippet details({ block, content, children }: BlockSnippetPayload)}
	<details use:block.attach>
		<summary>
			{@render content()}
		</summary>
		{#if children}
			<div>
				{@render children()}
			</div>
		{/if}
	</details>
{/snippet}
{#snippet heading({ block, content, children }: BlockSnippetPayload<{ level: number }>)}
	<svelte:element this={block.level || 'h1'} use:block.attach>
		{@render content()}
		{#if children}
			<div>
				{@render children()}
			</div>
		{/if}
	</svelte:element>
{/snippet}

{#snippet orderedList({ block, content, children }: BlockSnippetPayload)}
	<ol use:block.attach>
		{#if children}
			<div>
				{@render children()}
			</div>
		{/if}
	</ol>
{/snippet}

{#snippet unorderedList({ block, content, children }: BlockSnippetPayload)}
	<ul use:block.attach>
		{#if children}
			<div>
				{@render children()}
			</div>
		{/if}
	</ul>
{/snippet}

{#snippet listItem({ block, content, children }: BlockSnippetPayload)}
	<li use:block.attach>
		<div>{@render content()}</div>
		{#if children}
			<div>
				{@render children()}
			</div>
		{/if}
	</li>
{/snippet}

{#snippet horizontalRule({ block, content, children }: BlockSnippetPayload)}
	<hr use:block.attach={true} />
{/snippet}
