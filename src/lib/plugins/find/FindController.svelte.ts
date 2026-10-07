import type { Action } from 'svelte/action';
import type { BlockOperations } from '$lib/block/block.utils.js';
import type { DocAnchor } from '$lib/crdt/index.js';
import type { Prepared } from '$lib/crdt/edytor-doc.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { CommandResult } from '$lib/session/commands.js';
import { marksForInsertion } from '$lib/session/editing/text.js';
import { reveal } from '$lib/selection/replaceSelection.js';
import { findMatches, type FindMatch } from './search.js';

/** What `replaceMatches` (one command, one undo step) writes: each match replaced by `replacement`. */
export type ReplaceMatches = BlockOperations['replaceMatches'];

/**
 * The find bar's state and actions (`plugins/find`): the query, the matches
 * in reading order, the current one and the replacements. It reads the
 * document through the facade and the handles and writes it through one
 * dispatcher command; the bar and the highlights render from it.
 */
export class FindController {
	isOpen = $state(false);
	/** The replacement text. */
	replacement = $state('');
	#query = $state('');
	#caseSensitive = $state(false);
	/** Bumped by every commit while the bar is open: the matches are read again. */
	#revision = $state(0);
	/**
	 * Where the current match starts, by anchor, so it follows edits (a
	 * peer's too): the current match is the first one at or after it.
	 */
	#at = $state.raw<DocAnchor | null>(null);
	#off: (() => void) | null = null;
	#field: HTMLInputElement | null = null;

	constructor(private edytor: Edytor) {}

	/** What the bar searches for; setting it shows the current match. */
	get query() {
		return this.#query;
	}
	set query(value: string) {
		this.#query = value;
		this.#show();
	}

	/** Match case exactly (default: ignore it). */
	get caseSensitive() {
		return this.#caseSensitive;
	}
	set caseSensitive(value: boolean) {
		this.#caseSensitive = value;
		this.#show();
	}

	/** Every match while the bar is open, in reading order (none while closed). */
	readonly matches: FindMatch[] = $derived.by(() => {
		void this.#revision;
		if (!this.isOpen) return [];
		return findMatches(this.edytor, this.#query, { caseSensitive: this.#caseSensitive });
	});

	/** The current match's index in `matches`; `-1` when there is none. */
	readonly current: number = $derived.by(() => {
		const { matches } = this;
		if (!matches.length) return -1;
		const at = this.#at && this.edytor.facade.resolveAnchor(this.#at);
		if (!at) return 0;
		const { compare } = this.edytor.facade;
		const index = matches.findIndex(
			(match) =>
				(match.block === at.blockId && match.offset >= at.offset) ||
				(match.block !== at.blockId && compare(match.block, at.blockId) > 0)
		);
		// Past the last one: the search wraps.
		return Math.max(index, 0);
	});

	/** Replacing is possible: an editable view of a writable document. */
	get canReplace() {
		return this.edytor.dispatcher.permits();
	}

	/**
	 * Open the bar (or focus it again) and search from the caret. With
	 * `query`, search for it.
	 */
	open = (query?: string) => {
		if (!this.isOpen || query !== undefined) {
			const { startText, yStart } = this.edytor.selection.state;
			this.#at = startText?.isInDocument
				? this.edytor.facade.anchorAt(startText.blockId, startText.segStart + yStart, 'right')
				: null;
		}
		if (!this.isOpen) {
			this.#off = this.edytor.facade.onChange(() => this.#revision++);
			this.isOpen = true;
		}
		if (query !== undefined) this.#query = query;
		this.#show();
		this.#focus();
	};

	/**
	 * Close the bar. With `select` (the default), the current match becomes
	 * the editor's selection and the editor takes the focus back.
	 */
	close = ({ select = true }: { select?: boolean } = {}) => {
		if (!this.isOpen) return;
		const match = this.matches[this.current];
		this.isOpen = false;
		this.#off?.();
		this.#off = null;
		if (!select) return;
		const block = match && this.edytor.idToBlock.get(match.block);
		const start = block?.textAtOffset(match!.offset);
		const end = block?.textAtOffset(match!.offset + match!.length);
		if (start && end)
			this.edytor.selection.setAtRange(start.text, start.offset, end.text, end.offset);
		this.edytor.expectInternalFocus();
		this.edytor.node?.focus({ preventScroll: true });
	};

	/** The next match becomes the current one (after the last, the first). */
	next = () => this.#step(1);

	/** The previous match becomes the current one (before the first, the last). */
	previous = () => this.#step(-1);

	/**
	 * Replace the current match, then go to the next one. Answers the
	 * command's status (`noop` without a match).
	 */
	replace = (): CommandResult['status'] => {
		const match = this.matches[this.current];
		if (!match) return 'noop';
		const status = this.#replace([match]);
		if (status === 'applied') {
			const offset = match.offset + this.replacement.length;
			this.#at = this.edytor.facade.anchorAt(match.block, offset, 'left');
			this.#show();
		}
		return status;
	};

	/** Replace every match: one command, one undo step. Answers its status. */
	replaceAll = (): CommandResult['status'] => this.#replace(this.matches);

	/** The query field (`use:find.field`): focused on each Mod+F; Enter, Shift+Enter, Escape, Mod+F. */
	field: Action<HTMLInputElement> = (node) => {
		this.#field = node;
		this.#focus();
		const keydown = (event: KeyboardEvent) => {
			if (event.isComposing) return;
			const mod = this.edytor.hotKeys.isMac ? event.metaKey : event.ctrlKey;
			if (event.key === 'Enter') (event.shiftKey ? this.previous : this.next)();
			else if (event.key === 'Escape') this.close();
			else if (mod && event.key.toLowerCase() === 'f') node.select();
			else return;
			event.preventDefault();
		};
		node.addEventListener('keydown', keydown);
		return {
			destroy: () => {
				node.removeEventListener('keydown', keydown);
				if (this.#field === node) this.#field = null;
			}
		};
	};

	/** The replacement field (`use:find.replaceField`): Enter replaces, Escape closes. */
	replaceField: Action<HTMLInputElement> = (node) => {
		const keydown = (event: KeyboardEvent) => {
			if (event.isComposing) return;
			if (event.key === 'Enter') this.replace();
			else if (event.key === 'Escape') this.close();
			else return;
			event.preventDefault();
		};
		node.addEventListener('keydown', keydown);
		return { destroy: () => node.removeEventListener('keydown', keydown) };
	};

	/** Stop following the document (the editor is going away). */
	destroy = () => this.close({ select: false });

	#step = (by: 1 | -1) => {
		const { matches } = this;
		if (!matches.length) return;
		const index = (this.current + by + matches.length) % matches.length;
		const match = matches[index]!;
		this.#at = this.edytor.facade.anchorAt(match.block, match.offset, 'right');
		this.#show();
	};

	/**
	 * The current match shows: the closed toggles it sits in open (Notion),
	 * and it scrolls into view. The editor's selection stays where it was.
	 */
	#show = () => {
		const match = this.matches[this.current];
		const block = match && this.edytor.idToBlock.get(match.block);
		if (block) {
			reveal(block);
			block.textAtOffset(match!.offset)?.text.node?.scrollIntoView?.({
				block: 'nearest',
				inline: 'nearest'
			});
		}
		this.edytor.overlay.invalidate();
	};

	#focus = () => {
		if (!this.isOpen || !this.#field) return;
		this.#field.focus();
		this.#field.select();
	};

	/**
	 * The one write (`replaceMatches`): admission, hooks (the command, then
	 * each `deleteContentAtRange` and `insertText` step), one transaction,
	 * one undo step. Each replacement takes the marks its match had in
	 * common, as typing over a selection does (`marksForInsertion`).
	 */
	#replace = (matches: FindMatch[]): CommandResult['status'] => {
		const { edytor } = this;
		const { facade, dispatcher, idToBlock } = edytor;
		if (!matches.length) return 'noop';
		const prepare = ({ matches, replacement }: ReplaceMatches): Prepared =>
			// Last first: a step's offsets never depend on an earlier step's writes.
			facade.compose(
				...[...matches].reverse().flatMap(({ block, offset, length }) => {
					const hit = idToBlock.get(block)?.textAtOffset(offset);
					const marks = hit
						? marksForInsertion(hit.text, hit.offset, {
								replaced: hit.text.getMarksAtRange(hit.offset, hit.offset + length)
							})
						: undefined;
					return [
						facade.prepare.deleteText(block, offset, length),
						facade.prepare.insertText(block, offset, replacement, marks)
					];
				})
			);
		const payload: ReplaceMatches = { matches, replacement: this.replacement };
		const block = idToBlock.get(matches[0]!.block) ?? edytor.root!;
		dispatcher.dispatch(
			'replaceMatches',
			payload,
			{ block },
			(payload, plan = prepare(payload)) => {
				if ('writes' in plan) facade.apply(plan);
			},
			prepare
		);
		return dispatcher.last?.operation === 'replaceMatches' ? dispatcher.last.status : 'refused';
	};
}
