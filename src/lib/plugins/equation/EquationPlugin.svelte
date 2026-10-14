<script module lang="ts">
	import { equationForms } from '$lib/export/forms.js';
	import './equation.css';
	import type {
		BlockSnippetPayload,
		InlineBlockSnippetPayload,
		InputRule,
		Plugin
	} from '$lib/plugins.js';
	import type { Edytor } from '$lib/edytor.svelte.js';
	import { InlineBlock } from '$lib/block/inlineBlock.svelte.js';

	import { equationEnglish, keywordsOf, labelsOf } from '$lib/labels.js';
	import { id } from '$lib/utils.js';
	import EquationView from './EquationView.svelte';
	import EquationEditorPanel from './EquationEditor.svelte';
	import {
		EquationEditor,
		EquationRenderer,
		equationViews,
		expressionOf,
		type EquationData,
		type EquationErrorPayload,
		type EquationPlaceholderPayload,
		type EquationPluginOptions,
		type EquationTarget,
		type KatexLike,
		type KatexLoader
	} from './equation.svelte.js';
	import { katexLoaderOf } from './katex.js';
	import { placeAtom, withRulesAndTriggers } from '../triggers/triggers.js';

	export type {
		EquationData,
		EquationEditor,
		EquationErrorPayload,
		EquationPlaceholderPayload,
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
		const { startText, endText } = edytor.selection.textRange();
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
		const { startText, endText, yStart, yEnd } = edytor.selection.textRange();
		const { isCollapsed } = edytor.selection.projection;
		const from = startText!.segStart + yStart;
		const atom = id('i');
		if (isCollapsed) {
			const spec = { id: atom, type: INLINE, data: { expression: '' } };
			if (edytor.insertInline(block.id, from, spec).status !== 'applied') return false;
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
			edytor.insertInline(block.id, from, { id: atom, type: INLINE, data: { expression } })
		);
		const written = run.taken && dispatcher.last?.status === 'applied';
		if (written) edytor.selection.setCaret({ block, offset: from + 1 });
		return written;
	};

	/** `$$E=mc^2$$` typed in text: an inline equation (Notion). */
	const dollars: InputRule = {
		find: /\$\$([^$\n]*[^$\s][^$\n]*)\$\$$/,
		replace: ([, tex], ctx) =>
			ctx.remove(() => placeAtom(ctx, { type: INLINE, data: { expression: tex!.trim() } }))
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
			const labels = labelsOf(edytor, 'equation', equationEnglish);
			const renderer = new EquationRenderer(katexLoaderOf(options.katex), options.macros);
			/** The kinds' forms: MathML by KaTeX once it is loaded. */
			const forms = equationForms(renderer.mathml);
			// The records read with no view (`plugin(undefined)`) keep no state.
			if (edytor && !equationViews.has(edytor))
				equationViews.set(edytor, {
					renderer,
					editor: new EquationEditor(edytor, renderer),
					placeholder: options.placeholder,
					error: options.error
				});
			const owns = () => equationViews.get(edytor)?.renderer === renderer;
			return withRulesAndTriggers(
				edytor,
				{
					onEdytorAttached: ({ node }) => {
						const view = equationViews.get(edytor);
						if (!view || !owns()) return;
						const { editor } = view;
						const { panel } = options;
						return panel && editor.panel.mount(node, EquationEditorPanel, { editor, panel });
					},
					// A block equation this view just created empty (a slash pick, Turn into) opens its editor.
					onAfterOperation: (change) => {
						const view = equationViews.get(edytor);
						if (!view || !owns() || edytor.dispatcher.last?.status !== 'applied') return;
						const ids =
							change.operation === 'setBlock'
								? [change.block.id]
								: change.operation === 'insertBlocks'
									? (change.effect?.creates ?? [])
									: [];
						const created = ids
							.map((id) => edytor.idToBlock.get(id))
							.find((block) => block?.type === 'equation');
						if (created && !expressionOf(created.data)) view.editor.open({ block: created.id });
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
							keywords: keywordsOf(edytor, 'equation.inline', [
								'math',
								'tex',
								'latex',
								'katex',
								'formula',
								'inline'
							]),
							group: 'Inline',
							isEnabled: (view) => textBlock(view) !== null,
							run: () => insertInline(edytor)
						}
					],
					blocks: {
						equation: {
							...forms.blocks.equation,
							snippet: equation,
							empty: { content: [], children: [] },
							presets: [
								{
									label: labels.block,
									icon: '√x',
									keywords: keywordsOf(edytor, 'block.equation', [
										'math',
										'tex',
										'latex',
										'katex',
										'formula',
										'equation'
									]),
									group: 'Advanced blocks'
								}
							]
						}
					},
					inlineBlocks: {
						[INLINE]: {
							...forms.inlineBlocks.inlineEquation,
							snippet: inlineEquation
						}
					}
				},
				{ inputRules: [dollars] }
			);
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
