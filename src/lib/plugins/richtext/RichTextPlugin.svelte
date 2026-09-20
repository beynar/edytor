<script module lang="ts">
	import type { Plugin, MarkSnippetPayload, BlockSnippetPayload } from '$lib/plugins.js';
	import type { SerializableContent } from '$lib/utils/json.js';
	import type { HotKey } from '$lib/hotkeys.js';
	import type { Text } from '$lib/text/text.svelte.js';
	import { createRichTextCommands } from './richTextCommands.js';
	import { richTextOperations, type RichTextMark } from './richTextOperations.js';

	export { richTextOperations };

	const nativeFormatMarks = {
		formatBold: 'bold',
		formatItalic: 'italic',
		formatUnderline: 'underline',
		formatStrikeThrough: 'strike',
		formatSuperscript: 'superscript',
		formatSubscript: 'subscript'
	} as const;

	const isNativeFormatInputType = (
		inputType: string
	): inputType is keyof typeof nativeFormatMarks => inputType in nativeFormatMarks;

	const getMarksBeforeOffset = (text: Text, offset: number) => {
		let currentOffset = 0;

		for (const part of text.value) {
			const nextOffset = currentOffset + part.text.length;
			if (offset > currentOffset && offset <= nextOffset) {
				return part.marks ?? {};
			}
			currentOffset = nextOffset;
		}

		return null;
	};

	const getMarksAfterOffset = (text: Text, offset: number) => {
		let currentOffset = 0;

		for (const part of text.value) {
			const nextOffset = currentOffset + part.text.length;
			if (offset >= currentOffset && offset < nextOffset) {
				return part.marks ?? {};
			}
			currentOffset = nextOffset;
		}

		return null;
	};

	const withoutLinkMark = (marks: Record<string, SerializableContent>) => {
		const nextMarks = { ...marks };
		delete nextMarks.link;
		return nextMarks;
	};

	const isInsideLinkMark = (node: Node | null) => {
		if (typeof Element === 'undefined' || !node) {
			return false;
		}

		const element = node.nodeType === 3 ? node.parentElement : (node as Element | null);
		return Boolean(element?.closest('[data-edytor-mark="link"]'));
	};

	export const richTextPlugin: Plugin = (edytor) => {
		const setMarkAndSelect =
			(mark: RichTextMark, value?: SerializableContent): HotKey =>
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
			commands: createRichTextCommands(edytor),
			onBeforeOperation: (change) => {
				if (change.operation !== 'insertText') {
					return;
				}

				const { payload, text } = change;
				if (payload.marks || text.markOnNextInsert) {
					return;
				}

				const start = payload.start ?? edytor.selection.state.yStart;
				const end = payload.end ?? edytor.selection.state.yEnd;
				if (start !== end) {
					return;
				}

				const marksBefore = getMarksBeforeOffset(text, start);
				if (!marksBefore?.link) {
					return;
				}

				const marksAfter = getMarksAfterOffset(text, start);
				if (marksAfter?.link) {
					return;
				}

				return {
					...payload,
					marks: isInsideLinkMark(edytor.selection.state.startNode)
						? marksBefore
						: withoutLinkMark(marksAfter ?? marksBefore)
				};
			},
			onBeforeInput: ({ e, prevent }) => {
				if (isNativeFormatInputType(e.inputType)) {
					const mark = nativeFormatMarks[e.inputType];
					prevent(() => {
						richTextOperations(edytor).setMarkAtRange(mark);
					});
					return;
				}

				if (e.inputType === 'formatRemove') {
					prevent(() => {
						richTextOperations(edytor).removeAllMarksAtRange();
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
				toggle,
				heading,
				quote,
				callout,
				'todo-item': todoItem,
				'bulleted-list-item': bulletedListItem,
				'numbered-list-item': numberedListItem,
				'ordered-list': orderedList,
				'unordered-list': unorderedList,
				'list-item': listItem,
				divider: {
					snippet: divider,
					void: true
				},
				horizontalRule: {
					snippet: horizontalRule,
					void: true
				}
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
{#snippet toggle({ block, content, children }: BlockSnippetPayload)}
	<details use:block.attach data-edytor-type="toggle">
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
	<svelte:element this={block.data.level || 'h1'} use:block.attach>
		{@render content()}
		{#if children}
			<div>
				{@render children()}
			</div>
		{/if}
	</svelte:element>
{/snippet}

{#snippet quote({ block, content, children }: BlockSnippetPayload)}
	<blockquote use:block.attach data-edytor-type="quote">
		{@render content()}
		{#if children}
			<div>
				{@render children()}
			</div>
		{/if}
	</blockquote>
{/snippet}

{#snippet callout({ block, content, children }: BlockSnippetPayload<{ icon?: string }>)}
	<div use:block.attach data-edytor-type="callout">
		<span contenteditable="false">{block.data.icon || '!'}</span>
		<div>
			{@render content()}
		</div>
		{#if children}
			<div>
				{@render children()}
			</div>
		{/if}
	</div>
{/snippet}

{#snippet todoItem({ block, content, children }: BlockSnippetPayload<{ checked?: boolean }>)}
	<div use:block.attach data-edytor-type="todo-item">
		<input type="checkbox" checked={Boolean(block.data.checked)} contenteditable="false" readonly />
		<div>
			{@render content()}
		</div>
		{#if children}
			<div>
				{@render children()}
			</div>
		{/if}
	</div>
{/snippet}

{#snippet bulletedListItem({ block, content, children }: BlockSnippetPayload)}
	<li use:block.attach data-edytor-type="bulleted-list-item">
		<div>{@render content()}</div>
		{#if children}
			<div>
				{@render children()}
			</div>
		{/if}
	</li>
{/snippet}

{#snippet numberedListItem({ block, content, children }: BlockSnippetPayload)}
	<li use:block.attach data-edytor-type="numbered-list-item">
		<div>{@render content()}</div>
		{#if children}
			<div>
				{@render children()}
			</div>
		{/if}
	</li>
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

{#snippet divider({ block }: BlockSnippetPayload)}
	<hr use:block.attach use:block.void data-edytor-type="divider" />
{/snippet}
