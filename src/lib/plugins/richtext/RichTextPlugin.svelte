<script module lang="ts">
	import type { Plugin, MarkSnippetPayload, BlockSnippetPayload } from '$lib/plugins.js';
	import type { SerializableContent } from '$lib/utils/json.js';
	import type { HotKey } from '$lib/hotkeys.js';
	import type { Edytor } from '$lib/edytor.svelte.js';

	export const richTextOperations = (edytor: Edytor) => ({
		removeAllMarksAtRange: () => {
			const { yStart, yEnd, startText, texts } = edytor.selection.state;
			texts.forEach((text) => {
				const marks = text.yText.getAttributes();
				Object.entries(marks).forEach(([key]) => {
					text.yText.removeAttribute(key);
				});
			});
			edytor.selection.setAtTextRange(startText, yStart, yEnd);
		},
		setMarkAtRange: (
			mark:
				| 'bold'
				| 'italic'
				| 'underline'
				| 'code'
				| 'link'
				| 'strike'
				| 'superscript'
				| 'subscript'
				| 'color'
				| 'highlight',
			value?: SerializableContent
		) => {
			const { yStart, yEnd, startText, texts } = edytor.selection.state;
			console.table(texts.map((text) => ({ text: text.yText.toJSON() })));
			texts.forEach((text, index) => {
				const isFirst = index === 0;
				const isLast = index === texts.length - 1;
				text.markText({
					mark,
					value,
					toggle: true,
					start: isFirst ? yStart : 0,
					end: isLast ? yEnd : text.yText.length
				});
			});
			edytor.selection.setAtTextRange(startText, yStart, yEnd);
		}
	});

	export const richTextPlugin: Plugin = (edytor) => {
		const setMarkAndSelect =
			(
				mark:
					| 'bold'
					| 'italic'
					| 'underline'
					| 'code'
					| 'link'
					| 'strike'
					| 'superscript'
					| 'subscript'
					| 'color'
					| 'highlight',
				value?: SerializableContent
			): HotKey =>
			({ prevent }) => {
				prevent(() => {
					richTextOperations(edytor).setMarkAtRange(mark, value);
				});
			};
		return {
			defaultBlock: (parent) => {
				if (parent.type === 'ordered-list') {
					return 'list-item';
				}
				if (parent.type === 'unordered-list') {
					return 'list-item';
				}
				return 'paragraph';
			},
			hotkeys: {
				'mod+b': setMarkAndSelect('bold'),
				'mod+i': setMarkAndSelect('italic'),
				'mod+u': setMarkAndSelect('underline'),
				'mod+e': setMarkAndSelect('code'),
				'mod+shift+x': setMarkAndSelect('strike'),
				'mod+shift+h': setMarkAndSelect('color', 'red')
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
				'ordered-list': orderedList,
				'unordered-list': unorderedList,
				'list-item': listItem,
				horizontalRule
			}
		};
	};
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
	<div class="rounded bg-opacity-25 p-1 my-1" use:block.attach>
		<p>
			{@render content()}
		</p>
		{@render children?.()}
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

{#snippet horizontalRule({ block }: BlockSnippetPayload)}
	<hr use:block.attach use:block.void />
{/snippet}
