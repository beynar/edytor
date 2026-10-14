import { untrack, type Snippet } from 'svelte';
import { blockSelection } from '$lib/session/selection.js';
import type { Attachment } from 'svelte/attachments';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { Block } from '$lib/block/block.svelte.js';
import { InlineBlock } from '$lib/block/inlineBlock.svelte.js';
import { takeKeys } from '$lib/events/onFocus.js';
import { Anchored } from '../anchored.svelte.js';
import { expressionOf, sourceMathml } from './tex.js';

export { TEX, expressionOf, parseEquation, sourceMathml, type EquationData } from './tex.js';
import { all, listen } from '$lib/utils/listen.js';

/** The part of KaTeX the plugin uses: `katex.renderToString`. */
export type KatexLike = {
	renderToString: (tex: string, options?: Record<string, unknown>) => string;
};

/** Loads KaTeX when an equation first shows: `() => import('katex')` from your bundle. */
export type KatexLoader = () => Promise<KatexLike | { default: KatexLike }>;

export type EquationPluginOptions = {
	/**
	 * Where KaTeX comes from, loaded the first time an equation is drawn in a
	 * browser (a server render shows the TeX source and loads nothing):
	 *
	 * - absent: jsDelivr (`KATEX_CDN`, KaTeX `KATEX_VERSION`): its module and
	 *   its stylesheet, added once to the page's head; your app bundles and
	 *   imports nothing.
	 * - a URL: another copy of KaTeX's `dist` files (`katex.mjs`,
	 *   `katex.min.css` and its `fonts/`), as for jsDelivr.
	 * - a loader, `() => import('katex')`: KaTeX from your bundle (the
	 *   optional peer dependency); import its stylesheet,
	 *   `katex/dist/katex.min.css`, in your app.
	 * - `false`: none; an equation shows its TeX source.
	 *
	 * If KaTeX fails to load, equations keep showing their source.
	 */
	katex?: KatexLoader | string | false;
	/** TeX macros every equation reads (`{ '\\RR': '\\mathbb{R}' }`). */
	macros?: Record<string, string>;
	/**
	 * The editor's panel and its words (the source's field, KaTeX's error, Done): it
	 * renders under the edited equation while `editor.target` is set
	 * (centered under a block equation; without it, nothing shows). Put
	 * `{@attach editor.field}` on the source's field.
	 */
	panel?: Snippet<[EquationEditor]>;
	/**
	 * An empty equation's placeholder (default: `√x` and the view's
	 * `equation.blockPlaceholder` or `inlinePlaceholder`). A click on it
	 * opens the editor, as on any equation.
	 */
	placeholder?: Snippet<[EquationPlaceholderPayload]>;
	/**
	 * An equation KaTeX cannot read (default: its source, marked invalid,
	 * KaTeX's message in its title).
	 */
	error?: Snippet<[EquationErrorPayload]>;
};

/** What an equation's `placeholder` snippet receives. */
export type EquationPlaceholderPayload = {
	/** A block equation (`true`) or an inline one. */
	display: boolean;
	/** The view's placeholder for it (`equation.blockPlaceholder`, `inlinePlaceholder`). */
	label: string;
};

/** What an equation's `error` snippet receives. */
export type EquationErrorPayload = {
	/** A block equation (`true`) or an inline one. */
	display: boolean;
	/** Its TeX source. */
	expression: string;
	/** KaTeX's message. */
	error: string;
	/** The view's word for it (`equation.invalid`). */
	label: string;
};

/** What drawing an equation gives: KaTeX's markup, its error, or nothing yet (the source shows). */
export type Drawn = { html: string } | { error: string } | null;

/** The cap of the drawings each renderer keeps. */
const CACHE = 256;

/**
 * KaTeX for one plugin: loaded once, the first time an equation is drawn in
 * a browser, and reactive (an equation drawn before it loads shows its
 * source, then KaTeX's markup). KaTeX runs untrusted (`trust: false`: no
 * `\href`, `\url`, `\includegraphics` or HTML extension), so its markup is
 * safe to insert.
 */
export class EquationRenderer {
	#katex = $state.raw<KatexLike | null>(null);
	#loading = false;
	#drawn = new Map<string, Drawn>();

	constructor(
		private load: KatexLoader | undefined,
		private macros: Record<string, string> | undefined
	) {}

	/** KaTeX, once loaded (reactive). */
	get katex() {
		return this.#katex;
	}

	/** `tex` drawn by KaTeX (display mode for a block), its error, or `null` until KaTeX loads. */
	draw = (tex: string, display: boolean): Drawn => {
		const katex = this.#katex;
		if (!katex) {
			this.#start();
			return null;
		}
		const key = `${display ? 'd' : 'i'}${tex}`;
		const known = this.#drawn.get(key);
		if (known) return known;
		let drawn: Drawn;
		try {
			drawn = { html: katex.renderToString(tex, this.options(display, 'htmlAndMathml')) };
		} catch (error) {
			drawn = { error: error instanceof Error ? error.message : String(error) };
		}
		if (this.#drawn.size >= CACHE) this.#drawn.delete(this.#drawn.keys().next().value!);
		this.#drawn.set(key, drawn);
		return drawn;
	};

	/**
	 * The clipboard's form: MathML whose `application/x-tex` annotation is the
	 * source (KaTeX's, once it is loaded; else the source as text), inside
	 * KaTeX's `katex` class, so other apps and HTML import read it back.
	 */
	mathml = (tex: string, display: boolean): string => {
		const katex = this.#katex;
		if (katex) {
			try {
				return katex.renderToString(tex, this.options(display, 'mathml'));
			} catch {
				// TeX KaTeX cannot read: the source as text, below.
			}
		}
		return sourceMathml(tex, display);
	};

	private options = (display: boolean, output: 'htmlAndMathml' | 'mathml') => ({
		displayMode: display,
		output,
		throwOnError: true,
		trust: false,
		strict: 'ignore',
		// KaTeX writes `\gdef`s into its macros: each drawing gets its own copy.
		macros: { ...this.macros }
	});

	#start = () => {
		if (this.#loading || !this.load || typeof window === 'undefined') return;
		this.#loading = true;
		this.load().then(
			(module) => {
				const katex = 'renderToString' in module ? module : module.default;
				if (typeof katex?.renderToString === 'function') this.#katex = katex;
			},
			(error: unknown) => console.error('[edytor] KaTeX failed to load', error)
		);
	};
}

/** The equation being edited: a block equation, or an inline one (`atom`) in block `block`. */
export type EquationTarget = { block: string; atom?: string };

/**
 * One view's equation editor (Notion's): a click on an equation of an
 * editable view (Enter on a selected one, or a new empty one) opens its
 * TeX source in a field in the overlay, under it. Each keystroke writes
 * `data.expression` (one `patchData` command; the dispatcher groups the
 * typing into one undo step), so the equation itself is the live preview.
 * Enter (Shift+Enter: a newline in a block equation), Escape, Done, a
 * press or a focus outside close it; an inline equation closed empty is
 * removed. The editor then gives the keys back: a block equation stays
 * selected, the caret goes after an inline one.
 *
 * What a `panel` snippet receives: the equation being edited (`target`,
 * `display` for a block one), its source (`expression`, written by
 * `set`), KaTeX's error (`error`) and `close()`.
 * Put `{@attach editor.field}` on the source's field: it takes the focus
 * as the editor opens, Enter (Shift+Enter: a newline in a block equation)
 * and Escape close the editor, and focus leaving the panel closes it.
 */
export class EquationEditor {
	/** The equation being edited (reactive). */
	target = $state.raw<EquationTarget | null>(null);
	/**
	 * The editor's panel under the edited equation: its place, and what closes it.
	 * @internal
	 */
	readonly panel: Anchored;

	/** @internal */
	constructor(
		private edytor: Edytor,
		/** @internal */
		readonly renderer: EquationRenderer
	) {
		this.panel = new Anchored(
			edytor,
			'edytor-equation-editor-host',
			() => (this.target ? this.#node(this.target) : undefined),
			() => this.close(false)
		);
	}

	/** The view is readonly (reactive): the editor closes. */
	get readonly(): boolean {
		return this.edytor.readonly;
	}

	/**
	 * Where the panel stands: under the edited equation (a block one's
	 * middle, an inline one's start), layer-relative.
	 * @internal
	 */
	get place(): { left: number; top: number } | null {
		return this.target && this.panel.place(6, this.display);
	}

	/** A block equation is edited (a field of several lines). */
	get display() {
		return this.target !== null && this.target.atom === undefined;
	}

	/** The edited equation's TeX source (reactive through its block's cell). */
	get expression(): string {
		const target = this.target;
		if (!target) return '';
		const data = target.atom ? this.#atom(target)?.data : this.#block(target)?.data;
		return expressionOf(data);
	}

	/** What the source draws as: KaTeX's error, if it cannot read it. */
	get error(): string | null {
		const drawn = this.renderer.draw(this.expression, this.display);
		return drawn && 'error' in drawn ? drawn.error : null;
	}

	/** Open the editor on `target`: nothing in a readonly view. */
	open = (target: EquationTarget) => {
		if (!this.edytor.dispatcher.permits()) return;
		const live = target.atom ? this.#atom(target) : this.#block(target);
		if (!live) return;
		this.target = target;
		this.edytor.overlay.invalidate();
	};

	/** Whether `target` is the one being edited. */
	editing = (target: EquationTarget) =>
		this.target?.block === target.block && this.target.atom === target.atom;

	/** Write the source as it is typed: one `patchData` command per keystroke, one undo step. */
	set = (expression: string) => {
		const target = this.target;
		if (!target || expression === this.expression) return;
		const at = target.atom ? { block: target.block, atom: target.atom } : target.block;
		if (target.atom ? this.#atom(target) : this.#block(target))
			this.edytor.patchData(at, [{ path: ['expression'], value: expression }]);
	};

	/**
	 * Close the editor. An inline equation left empty is removed; then, with
	 * `keys`, the editor takes the keys back: the block equation selected, the
	 * caret after the inline one.
	 */
	close = (keys = true) => {
		const target = this.target;
		if (!target) return;
		this.target = null;
		this.panel.box = null;
		this.edytor.overlay.invalidate();
		const block = this.#block(target);
		if (!block) return;
		const { selection } = this.edytor;
		if (target.atom) {
			const atom = this.#atom(target);
			if (!atom) return;
			const offset = offsetOf(block, atom);
			if (!expressionOf(atom.data) && this.edytor.dispatcher.permits()) {
				this.edytor.removeInline(block.id, atom.id);
				if (keys) selection.setCaret({ block, offset });
			} else if (keys) selection.setCaret({ block, offset: offset + 1 });
		} else if (keys) selection.select(blockSelection([block.id]));
		if (keys) takeKeys(this.edytor);
	};

	/**
	 * The source's field (`{@attach editor.field}`, a `textarea` or an
	 * `input`): it takes the focus as the editor opens, the caret at the end
	 * of the source. Enter closes the editor (Shift+Enter in a block
	 * equation is a newline), Escape too; the editor's own keys never see
	 * them. Focus leaving the panel for somewhere else closes it.
	 */
	field: Attachment<HTMLTextAreaElement | HTMLInputElement> = (node) =>
		untrack(() => {
			const keydown = (event: KeyboardEvent) => {
				if (event.isComposing) return;
				const enter = event.key === 'Enter' && !(event.shiftKey && this.display);
				if (!enter && event.key !== 'Escape') return;
				event.preventDefault();
				event.stopPropagation();
				this.close();
			};
			const element: HTMLElement = node;
			const off = listen(element, 'keydown', keydown);
			const off2 = listen(element, 'focusout', this.panel.blurred);
			// Each equation the editor opens on: the field takes the focus, the caret at the end.
			$effect(() => {
				if (!this.target) return;
				untrack(() => {
					if (node.ownerDocument.activeElement === node) return;
					node.focus({ preventScroll: true });
					node.setSelectionRange(node.value.length, node.value.length);
				});
			});
			return all(off, off2);
		});

	#block = (target: EquationTarget): Block | undefined => {
		const block = this.edytor.idToBlock.get(target.block);
		return block?.isInTree ? block : undefined;
	};

	#atom = (target: EquationTarget): InlineBlock | undefined => {
		const atom = this.#block(target)?.content.find(
			(part): part is InlineBlock => part instanceof InlineBlock && part.id === target.atom
		);
		return atom?.isInDocument ? atom : undefined;
	};

	/** The element showing the edited equation. */
	#node = (target: EquationTarget): HTMLElement | null => {
		if (target.atom) return this.#atom(target)?.node ?? null;
		return this.#block(target)?.node?.querySelector<HTMLElement>('[data-edytor-equation]') ?? null;
	};
}

/** The block offset of `atom` in `block` (an atom counts 1). */
const offsetOf = (block: Block, atom: InlineBlock) => {
	let offset = 0;
	for (const part of block.content) {
		if (part === atom) return offset;
		offset += part instanceof InlineBlock ? 1 : part.length;
	}
	return offset;
};

/** A view's equations: the first equation plugin listed in it owns them, as its kinds. */
export type EquationView = {
	renderer: EquationRenderer;
	editor: EquationEditor;
	/** The app's markup for an empty equation and an unreadable one, if any. */
	placeholder?: Snippet<[EquationPlaceholderPayload]>;
	error?: Snippet<[EquationErrorPayload]>;
};

/** By view. */
export const equationViews = new WeakMap<Edytor, EquationView>();
