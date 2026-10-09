/**
 * A code block's header (`code.language`): the block's language, a button
 * that opens the view's language list (`LanguageMenu`) and Copy. One per
 * rendered code block; the default markup (`CodeHeader.svelte`) and an
 * app's `header` snippet read the same controller and share its
 * attachment (`button`), so a custom header keeps the keys and the ARIA.
 */
import { untrack } from 'svelte';
import type { Attachment } from 'svelte/attachments';
import type { Block } from '$lib/block/block.svelte.js';
import type { CodeLabels } from '$lib/labels.js';
import type { BlockView } from '$lib/plugins.js';
import { Text } from '$lib/text/text.svelte.js';
import { attribute } from '../chrome.js';
import { languageLabel, languageOf, type CodeSettings } from './languages.js';
import type { LanguageMenu, LanguageRow } from './languageMenu.svelte.js';

/** How long Copy reads Copied after a copy, in milliseconds. */
const COPIED_FOR = 1200;

/** A code block's text: its lines, joined by newlines. */
const codeText = (code: Block) =>
	code.children
		.map((line) =>
			line.content.map((part) => (part instanceof Text ? part.stringContent : '')).join('')
		)
		.join('\n');

/**
 * What a code plugin's `header` snippet receives: the code block's
 * language (`language`, its id; `label`, as shown), the languages the
 * plugin lists (`languages`), whether the language may be changed here
 * (`editable`: an editable view, not a suggestion's preview), the list's
 * state (`expanded`), the actions (`setLanguage`, `toggle`, `copy`, and
 * `copied` for a moment after a copy) and the plugin's `labels`. Put
 * `{@attach header.button}` on the element that opens the language list:
 * it opens it on a click, ArrowDown or ArrowUp, Escape gives the keys back
 * to the editor, the toolbar's shortcut at a caret in the block reaches it, and it carries
 * the ARIA (`aria-haspopup`, `aria-expanded`, `aria-controls`, its name).
 */
export class CodeHeader {
	/** Copy just copied: the button may read Copied (reactive, for a moment). */
	copied = $state(false);
	#timer: ReturnType<typeof setTimeout> | undefined;

	/** @internal */
	constructor(
		/**
		 * The code block as its snippet reads it.
		 * @internal
		 */
		readonly view: () => BlockView<{ language?: string }>,
		/** @internal */
		readonly settings: CodeSettings,
		/**
		 * The view's language list (none in a view without one).
		 * @internal
		 */
		readonly menu: LanguageMenu | undefined
	) {}

	/** The code block; `undefined` in a suggestion's preview. */
	get block(): Block | undefined {
		return this.view().handle;
	}

	/** The block's language id: its `data.language`, else the plugin's default (reactive). */
	get language(): string {
		return languageOf(this.view().data, this.settings);
	}

	/** The language's label; a language the plugin does not list shows its id (reactive). */
	get label(): string {
		const language = this.language;
		const row = this.settings.languages.find((row) => row.id === language);
		return row ? languageLabel(row, this.settings) : language;
	}

	/** The languages the plugin lists, labeled, in order. */
	get languages(): LanguageRow[] {
		return this.settings.languages.map((row) => ({
			id: row.id,
			label: languageLabel(row, this.settings)
		}));
	}

	/** The plugin's words (`language`, `copy`, `copied`, …). */
	get labels(): CodeLabels {
		return this.settings.labels;
	}

	/** The view is readonly (reactive). */
	get readonly(): boolean {
		return this.view().handle?.edytor.readonly ?? true;
	}

	/** The language may be changed here: an editable view, not a suggestion's preview (reactive). */
	get editable(): boolean {
		return Boolean(this.menu && this.view().handle && !this.readonly);
	}

	/** The language list is open on this block (reactive). */
	get expanded(): boolean {
		const block = this.view().handle;
		return Boolean(block && this.menu?.isOpenFor(block.id));
	}

	/** Set the block's language (one undo step); nothing where it is not `editable`. */
	setLanguage = (id: string) => {
		const block = this.view().handle;
		if (!this.editable || !block?.isInTree || id === this.language) return;
		block.data.language = id;
	};

	/**
	 * Open the language list under the header's button, or close it (`keys`:
	 * the keyboard opened it, so the keys go back to the button after).
	 */
	toggle = (keys = false) => {
		const block = this.view().handle;
		if (block && this.editable) this.menu?.toggle(block.id, keys);
	};

	/** Copy the block's code to the clipboard; `copied` reads true for a moment. */
	copy = async () => {
		const block = this.view().handle;
		// A suggestion's preview has no block to copy.
		if (!block) return;
		await navigator.clipboard.writeText(codeText(block));
		this.copied = true;
		clearTimeout(this.#timer);
		this.#timer = setTimeout(() => (this.copied = false), COPIED_FOR);
	};

	/**
	 * The element that opens the language list (`{@attach header.button}`, a
	 * `button`): a click opens or closes it (from Enter or Space, the keys
	 * opened it and get it back), ArrowDown or ArrowUp opens it, Escape gives
	 * the keys back to the editor; a press keeps the editor's selection. It
	 * carries `aria-haspopup="listbox"`, `aria-expanded`, `aria-controls`
	 * while the list is open, and its name ("Code language: SQL") unless
	 * you set one; the toolbar's shortcut at a caret in the block focuses it.
	 */
	button: Attachment<HTMLElement> = (node) =>
		untrack(() => {
			node.setAttribute('data-edytor-code-language-button', '');
			node.setAttribute('aria-haspopup', 'listbox');
			const named = node.hasAttribute('aria-label') || node.hasAttribute('aria-labelledby');
			const mousedown = (event: MouseEvent) => event.preventDefault();
			// A click from Enter or Space has no pointer (`detail` 0): the keys opened it.
			const click = (event: MouseEvent) => this.toggle(event.detail === 0);
			const keydown = (event: KeyboardEvent) => {
				if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
					if (!this.expanded) this.toggle(true);
				} else if (event.key === 'Escape') this.menu?.release();
				else return;
				event.preventDefault();
			};
			node.addEventListener('mousedown', mousedown);
			node.addEventListener('click', click);
			node.addEventListener('keydown', keydown);
			$effect(() => {
				const expanded = this.expanded;
				attribute(node, 'aria-expanded', String(expanded));
				attribute(node, 'aria-controls', expanded ? this.menu?.listId : undefined);
				if (!named) attribute(node, 'aria-label', `${this.labels.language}: ${this.label}`);
			});
			return () => {
				node.removeEventListener('mousedown', mousedown);
				node.removeEventListener('click', click);
				node.removeEventListener('keydown', keydown);
			};
		});

	/**
	 * The header is gone: Copied's timer goes with it.
	 * @internal
	 */
	dispose = () => clearTimeout(this.#timer);
}
