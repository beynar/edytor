<script lang="ts" module>
	// `EdytorClass` alias: the emitted `.svelte.d.ts` also declares `Edytor`
	// (the component + its bindable instance type) — an unaliased import
	// collides there (TS2440 for bundler-resolution consumers).
	import { Edytor as EdytorClass, useEdytor, type Snippets } from '../edytor.svelte.js';
	import type { Awareness, YDoc } from '../crdt/index.js';
	import type { EdytorSync } from '$lib/collaboration/index.js';
	export { EdytorClass as EdytorContext, useEdytor };
	import type { Plugin } from '$lib/plugins.js';
	import type { Block as BlockType } from '$lib/block/block.svelte.js';
	const defaultValue: JSONDoc = {
		children: [
			// {
			// 	type: 'paragraph',
			// 	content: [{ text: 'One', marks: { bold: true } }],
			// 	children: [
			// 		{
			// 			type: 'paragraph',
			// 			content: [{ text: 'Two', marks: { bold: true } }],
			// 			children: [
			// 				{
			// 					type: 'paragraph',
			// 					content: [{ text: 'Three', marks: { bold: true } }]
			// 				}
			// 			]
			// 		}
			// 	]
			// },

			// {
			// 	type: 'image',
			// 	content: [{ text: 'Caption' }]
			// },
			// {
			// 	type: 'paragraph',
			// 	content: [
			// 		{ text: 'One', marks: { bold: true } },
			// 		{ text: ' Two', marks: { italic: true } }
			// 	]
			// },
			// {
			// 	type: 'paragraph',
			// 	content: [{ text: '' }]
			// },
			// {
			// 	type: 'paragraph',
			// 	content: [
			// 		{ text: 'Three', marks: { italic: true } },
			// 		{ text: ' Four', marks: { bold: true } },
			// 		{ text: '' }
			// 	]
			// },

			// {
			// 	type: 'paragraph',
			// 	content: [
			// 		{ text: 'Hello', marks: { bold: true } },
			// 		{ text: '', marks: { void: true } },
			// 		{ text: ' World', marks: { bold: true } }
			// 	]
			// },
			{
				type: 'paragraph',
				content: [
					{ text: 'hello', marks: { bold: true } },
					{
						type: 'mention'
					},
					{ text: 'World', marks: { bold: true } },
					{
						type: 'mention'
					},
					{ text: 'Prout', marks: { bold: true } }
				],

				children: [
					{
						type: 'paragraph',
						content: [{ text: 'One', marks: { bold: true } }],
						children: [
							{
								type: 'paragraph',
								content: [{ text: 'Two', marks: { bold: true } }]
							}
						]
					}
				]
			},
			{
				type: 'code',
				content: [{ text: 'caption yo' }],
				children: [{ type: 'codeLine', content: [{ text: '\t\tconsole.log("hello")' }] }]
			}
		]
	};

	export type EdytorProps = Snippets & {
		plugins?: Plugin[];
		class?: string;
		edytor?: EdytorClass;
		doc?: YDoc;
		awareness?: Awareness;
		readonly?: boolean;
		hotKeys?: Record<string, HotKey>;
		onChange?: (value: JSONBlock) => void;
		onSelectionChange?: (selection: EdytorSelection) => void;
		value?: JSONDoc;
		placeholder?: string | Snippet<[{ block: BlockType }]>;
		translate?: 'yes' | 'no';
		spellcheck?: boolean;
		autocorrect?: 'on' | 'off';
		autocomplete?: 'on' | 'off';
		autocapitalize?: 'off' | 'none' | 'on' | 'sentences' | 'words' | 'characters';
		sync?: EdytorSync;
	};
</script>

<script lang="ts">
	import type { JSONBlock, JSONDoc } from '../utils/json.js';
	import { onMount, setContext, type Snippet, untrack } from 'svelte';
	import type { HotKey } from '$lib/hotkeys.js';
	import type { EdytorSelection } from '$lib/selection/selection.svelte.js';
	import ReadonlyEditor from './ReadonlyEditor.svelte';
	import Block from './Block.svelte';
	import RemoteSelections from '$lib/collaboration/RemoteSelections.svelte';

	let {
		plugins,
		class: className,
		edytor = $bindable(),
		doc,
		readonly = false,
		value = $bindable(defaultValue),
		hotKeys,
		sync,
		awareness,
		onChange,
		onSelectionChange,
		placeholder,
		translate = 'no',
		spellcheck = true,
		autocorrect = 'off',
		autocomplete = 'off',
		autocapitalize = 'none',
		...snippets
	}: EdytorProps = $props();

	const initialEdytorOptions = untrack(() => ({
		snippets,
		readonly,
		plugins,
		doc,
		awareness,
		hotKeys,
		onSelectionChange,
		onChange,
		sync: !!sync,
		value,
		placeholder
	}));

	edytor = new EdytorClass(initialEdytorOptions);

	const rethrowAsyncCleanupError = (error: unknown) => {
		setTimeout(() => {
			throw error;
		});
	};

	onMount(() => {
		let destroySync: ReturnType<NonNullable<EdytorProps['sync']>> | undefined;
		if (!initialEdytorOptions.readonly && sync) {
			destroySync = sync({
				doc: edytor.doc,
				awareness: edytor.awareness,
				synced: () => {
					edytor.sync(initialEdytorOptions.value);
				}
			});
		}

		return () => {
			if (typeof destroySync === 'function') {
				try {
					const cleanupResult = destroySync();
					if (cleanupResult && typeof cleanupResult === 'object' && 'catch' in cleanupResult) {
						void cleanupResult.catch(rethrowAsyncCleanupError);
					}
				} catch (error) {
					rethrowAsyncCleanupError(error);
				}
			}

			// The component owns the Edytor — release its doc/awareness/facade/
			// undo-manager listeners so a shared doc doesn't retain dead mounts.
			edytor.destroy();
		};
	});

	$effect(() => {
		edytor.readonly = readonly;
	});

	setContext('edytor', edytor);
	const noWhiteSpace = (node: HTMLElement) => {
		const observe = (mutation?: MutationRecord[]) => {
			// Create a TreeWalker to find all text nodes
			const treeWalker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, {
				acceptNode: (node) => {
					// Accept empty text nodes and nodes with only whitespace
					if (!node.textContent || node.textContent.match(/^[\s\u200B-\u200D\uFEFF]*$/)) {
						return NodeFilter.FILTER_ACCEPT;
					}
					return NodeFilter.FILTER_REJECT;
				}
			});

			// Process each text node
			let currentNode;
			while ((currentNode = treeWalker.nextNode())) {
				// Only remove if the node is not inside a block
				const parentElement = currentNode.parentElement;
				if (parentElement && !parentElement.closest('[data-block]')) {
					currentNode.parentNode?.removeChild(currentNode);
				}
			}

			// Remove comments
			const commentWalker = document.createTreeWalker(node, NodeFilter.SHOW_COMMENT);
			while (commentWalker.nextNode()) {
				const commentNode = commentWalker.currentNode;
				commentNode.parentNode?.removeChild(commentNode);
			}
		};
		const observer = new MutationObserver(observe);
		observer.observe(node, { childList: true, subtree: true });
		observe();
	};

	type EditableRootBrowserAttributes = {
		spellcheck: boolean;
		autocorrect: 'on' | 'off';
		autocomplete: 'on' | 'off';
		autocapitalize: 'off' | 'none' | 'on' | 'sentences' | 'words' | 'characters';
	};

	const browserMutationGuardAttributes = $derived({
		spellcheck,
		autocorrect,
		autocomplete,
		autocapitalize
	});

	const editableRootBrowserAttributes = (
		node: HTMLElement,
		attributes: EditableRootBrowserAttributes
	) => {
		const apply = (nextAttributes: EditableRootBrowserAttributes) => {
			node.setAttribute('spellcheck', String(nextAttributes.spellcheck));
			node.setAttribute('autocorrect', nextAttributes.autocorrect);
			node.setAttribute('autocomplete', nextAttributes.autocomplete);
			node.setAttribute('autocapitalize', nextAttributes.autocapitalize);
		};

		apply(attributes);

		return {
			update: apply
		};
	};

	const nonNativeEditableBlockChromeSelection = (node: HTMLElement) => {
		const handlePointerDown = (event: PointerEvent) => {
			edytor.selection.handleNonNativeEditableBlockChromePointerDown(event);
		};

		node.addEventListener('pointerdown', handlePointerDown, true);

		return {
			destroy: () => {
				node.removeEventListener('pointerdown', handlePointerDown, true);
			}
		};
	};

	const getBlockRenderKey = (block: BlockType) => block.id;
</script>

{#if edytor.synced || readonly}
	{#key edytor.editorDomRevision}
		<div
			class={className}
			use:edytor.attach
			use:editableRootBrowserAttributes={browserMutationGuardAttributes}
			use:nonNativeEditableBlockChromeSelection
			data-edytor
			contenteditable={!readonly}
			role="textbox"
			aria-multiline="true"
			aria-readonly={readonly ? 'true' : 'false'}
			{translate}
		>
			{#each edytor.root?.children || [] as block (getBlockRenderKey(block))}<Block
					{block}
				/>{/each}<span
				data-edytor-render-anchor
				contenteditable="false"
				aria-hidden="true"
				style="display: none"
			></span>
		</div>
	{/key}
	<RemoteSelections {edytor} />
{/if}
