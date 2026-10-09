<script module lang="ts">
	import type {
		BlockSnippetPayload,
		InlineBlockSnippetPayload,
		InputRule,
		Plugin
	} from '$lib/plugins.js';
	import type { Edytor } from '$lib/edytor.svelte.js';
	import { InlineBlock } from '$lib/block/inlineBlock.svelte.js';
	import { equationKinds } from '$lib/crdt/semantics.js';
	import { keywordsOf, labelsWith } from '$lib/labels.js';
	import { onPress } from '$lib/events/onFocus.js';
	import { id } from '$lib/utils.js';
	import EquationView from './EquationView.svelte';
	import EquationEditorPanel from './EquationEditor.svelte';
	import {
		EquationEditor,
		EquationRenderer,
		equationLabels,
		equationViews,
		expressionOf,
		parseEquation,
		type EquationData,
		type EquationPluginOptions,
		type EquationTarget,
		type KatexLike,
		type KatexLoader
	} from './equation.svelte.js';
	import { katexLoaderOf } from './katex.js';

	export type {
		EquationData,
		EquationEditor,
		EquationPluginOptions,
		EquationTarget,
		KatexLike,
		KatexLoader
	};
	export { KATEX_CDN, KATEX_VERSION } from './katex.js';

	/** The inline equation's atom kind. */
	const INLINE = 'inlineEquation';

	/** The block that holds the caret or a text range in one block, when an atom may go there. */
	const textBlock = (edytor: Edytor) => {
		const { startText, endText } = edytor.selection.state;
		const block = startText?.parent;
		if (!block || endText?.parent !== block || edytor.selection.value.kind !== 'text') return null;
		// Not in a code line (an island of lines holds text only).
		return block.parent && edytor.facade.isLines(block.parent.id) ? null : block;
	};

	/**
	 * Insert an inline equation at the selection (Notion's Mod+Shift+E and
	 * "Inline equation"): over a text range in one block, the range's text
	 * becomes the equation (one undo step); at a caret, an empty one is
	 * inserted and its editor opens. Answers whether it wrote.
	 */
	const insertInline = (edytor: Edytor): boolean => {
		const block = textBlock(edytor);
		const view = equationViews.get(edytor);
		if (!block || !view || !edytor.dispatcher.permits()) return false;
		const { startText, endText, yStart, yEnd, isCollapsed } = edytor.selection.state;
		const from = startText!.segStart + yStart;
		const atom = id('i');
		if (isCollapsed) {
			const after = block.addInlineBlock({
				offset: from,
				block: { id: atom, type: INLINE, data: { expression: '' } }
			});
			if (!after) return false;
			edytor.selection.setCaret({ block, offset: from + 1 });
			view.editor.open({ block: block.id, atom });
			return true;
		}
		const parts = block.content;
		const [first, last] = [parts.indexOf(startText!), parts.indexOf(endText!)];
		const expression = parts
			.slice(first, last + 1)
			.map((part) => {
				if (part instanceof InlineBlock) return '';
				const start = part === startText ? yStart : 0;
				return part.stringContent.slice(start, part === endText ? yEnd : undefined);
			})
			.join('')
			.trim();
		// The range's removal leads the insertion: one plan, so a veto or a refusal of
		// either keeps the text (and is its own undo step).
		const { dispatcher, facade } = edytor;
		const removal = facade.prepare.deleteText(block.id, from, endText!.segStart + yEnd - from);
		const run = dispatcher.lead(removal, () =>
			block.addInlineBlock({
				offset: from,
				block: { id: atom, type: INLINE, data: { expression } }
			})
		);
		const written = run.taken && dispatcher.last?.status === 'applied';
		if (written) edytor.selection.setCaret({ block, offset: from + 1 });
		return written;
	};

	/** `$$E=mc^2$$` typed in text: an inline equation (Notion). */
	const dollars: InputRule = {
		find: /\$\$([^$\n]*[^$\s][^$\n]*)\$\$$/,
		replace: ([, tex], { block, from, caret, remove }) =>
			remove(() => {
				const after = block.addInlineBlock({
					offset: from,
					block: { type: INLINE, data: { expression: tex!.trim() } }
				});
				if (after) caret(from + 1);
				return !!after;
			})
	};

	/** The equation a block selection or an atom selection stands for, if any. */
	const selectedEquation = (edytor: Edytor) => {
		const value = edytor.selection.value;
		if (value.kind === 'blocks' && value.ids.length === 1) {
			const block = value.ids[0]!;
			return edytor.facade.blockTypeOf(block) === 'equation' ? { block } : null;
		}
		if (value.kind !== 'atom') return null;
		const atom = edytor.idToBlock
			.get(value.blockId)
			?.content.find(
				(part): part is InlineBlock => part instanceof InlineBlock && part.id === value.atomId
			);
		return atom?.type === INLINE ? { block: value.blockId, atom: value.atomId } : null;
	};

	/**
	 * Equations (Notion's): a block equation (`equation`, void, its TeX in
	 * `data.expression`) and an inline equation atom (`inlineEquation`), both
	 * drawn by KaTeX, loaded the first time an equation shows in a browser:
	 * from jsDelivr by default, or as `katex` says (a URL, your loader). A
	 * click on one, or Enter on a selected one, opens its TeX source in an
	 * editor under it; the equation is the live preview. "Block equation"
	 * and "Inline equation" are slash commands, `$$…$$` typed in text is an
	 * inline equation, and Mod+Shift+E turns the selected text into one.
	 * Copied, an equation is MathML carrying its TeX; pasted HTML with KaTeX
	 * or MathML math becomes equations again.
	 */
	export const createEquationPlugin =
		(options: EquationPluginOptions = {}): Plugin =>
		(edytor) => {
			const labels = labelsWith('equation', options.labels);
			equationLabels.claim(edytor, labels);
			const renderer = new EquationRenderer(katexLoaderOf(options.katex), options.macros);
			// The records read with no view (`plugin(undefined)`) keep no state.
			if (edytor && !equationViews.has(edytor))
				equationViews.set(edytor, {
					renderer,
					editor: new EquationEditor(edytor, renderer, labels)
				});
			const owns = () => equationViews.get(edytor)?.renderer === renderer;
			return {
				onEdytorAttached: ({ node }) => {
					const view = equationViews.get(edytor);
					if (!view || !owns()) return;
					const { editor } = view;
					const offPress = onPress(edytor, node.ownerDocument, editor.pressed, true);
					const unmount = edytor.overlay.mount(
						EquationEditorPanel,
						{ editor, readonly: () => edytor.readonly, panel: options.panel },
						'edytor-equation-editor-host',
						// Above the block handles (5), as the image chrome.
						7,
						editor.measure
					);
					return () => {
						offPress();
						unmount();
						editor.close(false);
					};
				},
				// A block equation this view just created empty (a slash pick, Turn into) opens its editor.
				onAfterOperation: (change) => {
					const view = equationViews.get(edytor);
					if (!view || !owns() || edytor.dispatcher.last?.status !== 'applied') return;
					const created =
						change.operation === 'setBlock' && change.payload.value.type === 'equation'
							? change.block
							: change.operation === 'insertBlockAfter' && change.payload.block.type === 'equation'
								? change.block.nextBlock
								: change.operation === 'insertBlockBefore' &&
									  change.payload.block.type === 'equation'
									? change.block.previousBlock
									: null;
					if (created?.type === 'equation' && !expressionOf(created.data))
						view.editor.open({ block: created.id });
				},
				hotkeys: {
					'mod+shift+e': ({ prevent }) => {
						if (textBlock(edytor)) prevent(() => insertInline(edytor));
					},
					enter: ({ prevent }) => {
						const target = selectedEquation(edytor);
						if (target && edytor.dispatcher.permits())
							prevent(() => equationViews.get(edytor)?.editor.open(target));
					}
				},
				commands: [
					{
						id: 'equation.inline',
						label: labels.inline,
						icon: '√x',
						keywords: keywordsOf(
							'equation.inline',
							['math', 'tex', 'latex', 'katex', 'formula', 'inline'],
							options.keywords
						),
						group: 'Inline',
						isEnabled: (view) => textBlock(view) !== null,
						run: () => insertInline(edytor)
					}
				],
				inputRules: [dollars],
				blocks: {
					equation: {
						...equationKinds.equation,
						snippet: equation,
						empty: { content: [], children: [] },
						presets: [
							{
								label: labels.block,
								icon: '√x',
								keywords: keywordsOf(
									'block.equation',
									['math', 'tex', 'latex', 'katex', 'formula', 'equation'],
									options.keywords
								),
								group: 'Advanced blocks'
							}
						],
						html: (block) =>
							`<div data-edytor-equation>${renderer.mathml(expressionOf(block.data), true)}</div>`,
						plain: (block) => expressionOf(block.data),
						parse: (element) => parseEquation(element, true)
					}
				},
				inlineBlocks: {
					[INLINE]: {
						snippet: inlineEquation,
						plain: (data) => expressionOf(data),
						html: (data) => renderer.mathml(expressionOf(data), false),
						parse: (element) => parseEquation(element, false)
					}
				}
			};
		};
</script>

{#snippet equation({ block }: BlockSnippetPayload<EquationData>)}
	{@const view = block.handle ? equationViews.get(block.handle.edytor) : undefined}
	{@const expression = expressionOf(block.data)}
	<div
		use:block.void
		data-edytor-equation
		data-empty={expression ? undefined : 'true'}
		data-editing={view?.editor.editing({ block: block.id }) ? 'true' : undefined}
		onclick={() => view?.editor.open({ block: block.id })}
		role="presentation"
	>
		<EquationView {expression} display={true} />
	</div>
{/snippet}

{#snippet inlineEquation({ block }: InlineBlockSnippetPayload<EquationData>)}
	{@const atom = block.handle}
	{@const view = atom ? equationViews.get(atom.edytor) : undefined}
	<span
		data-edytor-inline-equation
		data-empty={expressionOf(block.data) ? undefined : 'true'}
		data-selected={block.selected ? 'true' : undefined}
		data-editing={atom && view?.editor.editing({ block: atom.blockId, atom: atom.id })
			? 'true'
			: undefined}
		onclick={() => atom && view?.editor.open({ block: atom.blockId, atom: atom.id })}
		role="presentation"><EquationView expression={expressionOf(block.data)} display={false} /></span
	>
{/snippet}

<style>
	[data-edytor-equation] {
		padding: 4px 0;
		border-radius: 4px;
		overflow-x: auto;
		overflow-y: hidden;
		text-align: center;
		cursor: pointer;
	}

	[data-edytor-equation]:hover,
	[data-edytor-equation][data-editing='true'] {
		background: rgba(55, 53, 47, 0.06);
	}

	[data-edytor-inline-equation] {
		border-radius: 3px;
		cursor: pointer;
	}

	[data-edytor-inline-equation][data-editing='true'],
	[data-edytor-inline-equation][data-selected='true'] {
		background: rgba(35, 131, 226, 0.14);
	}

	[data-edytor-equation] :global([data-edytor-equation-placeholder]),
	[data-edytor-inline-equation] :global([data-edytor-equation-placeholder]) {
		color: rgba(55, 53, 47, 0.5);
	}

	[data-edytor-equation] :global([data-edytor-equation-placeholder]) {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 12px;
		border-radius: 4px;
		background: rgba(242, 241, 238, 0.6);
		text-align: left;
	}

	:global([data-edytor-equation-icon]) {
		font-style: italic;
		margin-right: 4px;
	}

	:global([data-edytor-equation-error]),
	:global([data-edytor-equation-source]) {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.9em;
		white-space: pre-wrap;
	}

	:global([data-edytor-equation-error]) {
		color: rgb(212, 76, 71);
	}
</style>
