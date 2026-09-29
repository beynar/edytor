import type { Block } from '$lib/block/block.svelte.js';
import type { Text } from '$lib/text/text.svelte.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { EditorCommand } from '$lib/plugins.js';
import type { TextAnchor } from '$lib/selection/selection.svelte.js';
import { matchesQuery } from '$lib/kinds.js';

/** The trigger `/` and the query's end, held as anchors so peers' edits move them (L52). */
type ActiveSlashRange = { trigger: TextAnchor; end: TextAnchor };

export type TextInsertionPayload = {
	value: string;
	start?: number;
	end?: number;
};

/** A `/` opens the menu at a text's start or after whitespace, never inside a word (`1/2`, `and/or`). */
const startsTrigger = (text: Text, offset: number) =>
	offset === 0 || /\s/.test(text.stringContent[offset - 1] ?? '');

export class SlashMenuController {
	isOpen = $state(false);
	query = $state('');
	selectedIndex = $state(0);
	private activeRange: ActiveSlashRange | null = null;
	private isExecutingCommand = false;

	constructor(private edytor: Edytor) {}

	/** The editor is readonly: the menu closes. */
	get readonly() {
		return this.edytor.readonly;
	}

	/** Matching commands, grouped (groups in first-seen order): the menu's rows and keyboard order. */
	get commands() {
		const matching = Array.from(this.edytor.commands.values()).filter(
			(command) => command.isEnabled?.(this.edytor) !== false && matchesQuery(command, this.query)
		);
		// Groups in first-seen order, Notion's "Basic blocks" first.
		const groups = [...new Set(matching.map((command) => command.group ?? ''))].sort(
			(a, b) => Number(b === 'Basic blocks') - Number(a === 'Basic blocks')
		);
		return matching.sort((a, b) => groups.indexOf(a.group ?? '') - groups.indexOf(b.group ?? ''));
	}

	handleTextInsertion(text: Text, block: Block, payload: TextInsertionPayload) {
		const start = payload.start ?? this.edytor.selection.state.yStart;
		const end = payload.end ?? this.edytor.selection.state.yEnd;
		if (this.edytor.readonly) this.close();
		// A trigger typed alone, or committed by an IME with its query (`/h`).
		else if (
			payload.value.startsWith('/') &&
			start === end &&
			block.convertible &&
			startsTrigger(text, start)
		)
			this.open(text, start, start + payload.value.length);
		// Typing at the query's end extends it; typing anywhere else closes the menu.
		else if (this.activeRange) {
			const range = this.range;
			if (text === range?.text && start === range.queryEnd)
				this.setEnd(text, start + payload.value.length);
			else this.close();
		}
	}

	reconcileSelection() {
		if (!this.activeRange || this.isExecutingCommand) return;
		const range = this.range;
		const { startText, yStart, isCollapsed } = this.edytor.selection.state;
		// The caret stays after the trigger, in its text: it marks the query's end.
		if (
			range &&
			isCollapsed &&
			startText === range.text &&
			yStart > range.triggerStart &&
			range.text.stringContent.at(range.triggerStart) === '/'
		)
			this.setEnd(range.text, yStart);
		else this.close();
	}

	moveSelection(delta: number) {
		// Nothing to move through: the arrows stay the caret's.
		const commands = this.isOpen ? this.commands : [];
		if (!commands.length) return false;
		this.selectedIndex = (this.selectedIndex + delta + commands.length) % commands.length;
		return true;
	}

	close() {
		this.isOpen = false;
		this.query = '';
		this.selectedIndex = 0;
		this.activeRange = null;
	}

	runSelected() {
		return this.run(this.commands[this.selectedIndex]);
	}

	async run(command: EditorCommand | undefined) {
		const range = this.range;
		if (!range || !command) return false;
		this.isExecutingCommand = true;
		try {
			const { edytor } = this;
			const { text, triggerStart, queryEnd } = range;
			const end = Math.min(queryEnd, text.length);
			this.close();
			edytor.selection.setAtTextOffset(text, triggerStart);
			// The trigger's removal leads the command's first operation (one plan:
			// refusing the command keeps the trigger); a command that plans
			// nothing synchronously runs after it.
			const at = text.segStart + triggerStart;
			const trigger = edytor.facade.prepare.deleteText(text.parent.id, at, end - triggerStart);
			const run = edytor.dispatcher.lead(trigger, () => edytor.runCommand(command.id));
			// Nothing took the lead: the trigger goes on its own.
			const index = text.index;
			if (!run.taken && index !== -1)
				text.parent.deleteContentAtRange({ start: [index, triggerStart], end: [index, end] });
			const refused = run.taken && edytor.dispatcher.last?.status === 'refused';
			const didRun = await run.out;
			// Commands that replace the block (for example, Code) choose their own
			// caret. Only restore the slash caret when it still owns the selection.
			if (edytor.selection.state.startText === text) {
				edytor.dispatcher.caret(text, refused ? end : triggerStart);
			}
			return didRun ?? false;
		} finally {
			this.isExecutingCommand = false;
		}
	}

	/** The range where its anchors resolve now: one text, the trigger before the query end. */
	private get range() {
		const { selection } = this.edytor;
		const trigger = this.activeRange && selection.resolveTextAnchor(this.activeRange.trigger);
		const end = this.activeRange && selection.resolveTextAnchor(this.activeRange.end);
		if (!trigger || !end || trigger.text !== end.text || end.offset <= trigger.offset) return null;
		return { text: trigger.text, triggerStart: trigger.offset, queryEnd: end.offset };
	}

	private setEnd(text: Text, queryEnd: number) {
		const end = this.edytor.selection.createTextAnchor(text, queryEnd, 'left');
		if (this.activeRange && end) this.activeRange.end = end;
		this.syncQueryFromText();
	}

	private open(text: Text, triggerStart: number, queryEnd: number) {
		const { selection } = this.edytor;
		const trigger = selection.createTextAnchor(text, triggerStart, 'right');
		const end = selection.createTextAnchor(text, queryEnd, 'left');
		if (!trigger || !end) return;
		this.activeRange = { trigger, end };
		this.isOpen = true;
		this.syncQueryFromText();
	}

	private syncQueryFromText() {
		const range = this.range;
		if (!range) return;
		const { text, triggerStart, queryEnd } = range;
		const query = text.stringContent.slice(triggerStart + 1, queryEnd);
		// A new query highlights its first match again (Notion).
		if (query !== this.query) this.selectedIndex = 0;
		this.query = query;
		const commandCount = this.commands.length;
		// A query no command matches is prose (a URL, a path), and so is one
		// that opens with whitespace (`yes / no`) or holds only hyphens (`/-`):
		// the menu closes. Words after a space keep it open (`/to do`).
		if (this.query && (commandCount === 0 || /^\s/.test(this.query) || !/[^-\s]/.test(this.query)))
			this.close();
		else this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, commandCount - 1));
	}
}
