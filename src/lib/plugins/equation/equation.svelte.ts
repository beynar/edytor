import type { Edytor } from '$lib/edytor.svelte.js';
import type { Block } from '$lib/block/block.svelte.js';
import { InlineBlock } from '$lib/block/inlineBlock.svelte.js';
import { takeKeys } from '$lib/events/onFocus.js';
import { englishLabels, viewLabels, type EquationLabels, type PartialLabels } from '$lib/labels.js';

/** The part of KaTeX the plugin uses: `katex.renderToString`. */
export type KatexLike = {
	renderToString: (tex: string, options?: Record<string, unknown>) => string;
};

/** Loads KaTeX when an equation first shows: `() => import('katex')`. */
export type KatexLoader = () => Promise<KatexLike | { default: KatexLike }>;

export type EquationPluginOptions = {
	/**
	 * Loads KaTeX, lazily, the first time an equation is drawn in a browser:
	 * `() => import('katex')` (KaTeX is an optional peer dependency; import
	 * its stylesheet, `katex/dist/katex.min.css`, in your app). Without it,
	 * an equation shows its TeX source.
	 */
	katex?: KatexLoader;
	/** TeX macros every equation reads (`{ '\\RR': '\\mathbb{R}' }`). */
	macros?: Record<string, string>;
	/** The words the equations and their editor show, over the English ones. */
	labels?: PartialLabels<'equation'>;
	/** The slash menu's keywords by command id (`block.equation`, `equation.inline`), which replace its own. */
	keywords?: Partial<Record<string, string[]>>;
};

/** The data of a block equation and of an inline one: its TeX source. */
export type EquationData = { expression?: string };

/** What drawing an equation gives: KaTeX's markup, its error, or nothing yet (the source shows). */
export type Drawn = { html: string } | { error: string } | null;

/** The MathML annotation that carries an equation's TeX source. */
export const TEX = 'application/x-tex';

/** An equation's TeX source: its `expression`, a string. */
export const expressionOf = (data: unknown): string => {
	const value = (data as EquationData | undefined)?.expression;
	return typeof value === 'string' ? value : '';
};

const escape = (value: string) =>
	value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

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
		const source = escape(tex);
		return (
			`<span class="katex"><math xmlns="http://www.w3.org/1998/Math/MathML"${display ? ' display="block"' : ''}>` +
			`<semantics><mrow><mtext>${source}</mtext></mrow><annotation encoding="${TEX}">${source}</annotation></semantics></math></span>`
		);
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

/**
 * HTML import: the TeX source an equation's element carries — a `<math>`'s
 * `application/x-tex` annotation (or its `alttext`), alone or in KaTeX's
 * markup (`.katex`, `.katex-display`) — when the element is an equation of
 * the display asked (`display="block"`: a block), else `undefined`.
 */
export const parseEquation = (element: HTMLElement, display: boolean): EquationData | undefined => {
	const own = element.localName === 'math';
	const wrapper =
		element.classList.contains('katex') ||
		element.classList.contains('katex-display') ||
		element.hasAttribute('data-edytor-equation');
	if (!own && !wrapper) return undefined;
	const math = own ? element : element.querySelector('math');
	if (!math) return undefined;
	const block =
		math.getAttribute('display') === 'block' || element.classList.contains('katex-display');
	if (block !== display) return undefined;
	const tex =
		math.querySelector(`annotation[encoding="${TEX}"]`)?.textContent ??
		math.getAttribute('alttext');
	return tex?.trim() ? { expression: tex.trim() } : undefined;
};

/** Each view's equation labels: the first equation plugin listed claims them, as its kinds. */
export const equationLabels = viewLabels('equation');

/** The equation being edited: a block equation, or an inline one (`atom`) in block `block`. */
export type EquationTarget = { block: string; atom?: string };

/** The edited equation's box, layer-relative. */
export type EquationBox = { x: number; y: number; width: number; height: number };

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
 */
export class EquationEditor {
	/** The equation being edited (reactive). */
	target = $state.raw<EquationTarget | null>(null);
	/** Its box, measured in the overlay's frame. */
	box = $state.raw<EquationBox | null>(null);

	constructor(
		private edytor: Edytor,
		readonly renderer: EquationRenderer,
		readonly labels: EquationLabels = englishLabels.equation
	) {}

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
		const data = target.atom ? this.#atom(target)?.data : this.#block(target)?.data;
		if (data) data.expression = expression;
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
		this.box = null;
		this.edytor.overlay.invalidate();
		const block = this.#block(target);
		if (!block) return;
		const { selection } = this.edytor;
		if (target.atom) {
			const atom = this.#atom(target);
			if (!atom) return;
			const offset = offsetOf(block, atom);
			if (!expressionOf(atom.data) && this.edytor.dispatcher.permits()) {
				block.removeInlineBlock({ index: atom.index });
				if (keys) selection.setCaret({ block, offset });
			} else if (keys) selection.setCaret({ block, offset: offset + 1 });
		} else if (keys) selection.selectBlocks(block);
		if (keys) takeKeys(this.edytor);
	};

	/** The view turned readonly: the editor closes, the equation as it is. */
	lock = () => this.close(false);

	/** A press anywhere (capture): one outside the editor and its equation closes it. */
	pressed = (event: MouseEvent) => {
		const target = this.target;
		if (!target) return;
		const at = event.target as Element | null;
		if (at?.closest?.('[data-edytor-equation-editor]')) return;
		if (at instanceof Node && this.#node(target)?.contains(at)) return;
		this.close(false);
	};

	/** Focus left the field for somewhere outside the editor: it closes. */
	blurred = (event: FocusEvent) => {
		const to = event.relatedTarget;
		const panel = (event.currentTarget as Element | null)?.closest('[data-edytor-equation-editor]');
		// No new focus (the window went to the background): it stays.
		if (!(to instanceof Node) || panel?.contains(to)) return;
		this.close(false);
	};

	/** The overlay measure: the edited equation's box; gone, the editor closes. */
	measure = (host: HTMLElement, origin: DOMRect) => {
		const target = this.target;
		const node = target ? this.#node(target) : null;
		const rect = node?.isConnected ? node.getBoundingClientRect() : null;
		const box = rect
			? {
					x: rect.left - origin.left,
					y: rect.top - origin.top,
					width: rect.width,
					height: rect.height
				}
			: null;
		return () => {
			Object.assign(host.style, { position: 'absolute', left: '0px', top: '0px' });
			if (target && !node) return this.close(false);
			if (!sameBox(box, this.box)) this.box = box;
		};
	};

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
export type EquationView = { renderer: EquationRenderer; editor: EquationEditor };

/** By view. */
export const equationViews = new WeakMap<Edytor, EquationView>();

const sameBox = (a: EquationBox | null, b: EquationBox | null) =>
	a === b ||
	(a !== null &&
		b !== null &&
		a.x === b.x &&
		a.y === b.y &&
		a.width === b.width &&
		a.height === b.height);
