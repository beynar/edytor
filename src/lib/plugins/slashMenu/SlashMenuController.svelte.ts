import type { Block } from '$lib/block/block.svelte.js';
import type { Text } from '$lib/text/text.svelte.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { EditorCommand } from '$lib/plugins.js';
import type { TextAnchor } from '$lib/selection/selection.svelte.js';

/** The trigger `/` and the query's end, held as anchors so peers' edits move them (L52). */
type ActiveSlashRange = { trigger: TextAnchor; end: TextAnchor };

type TextInsertionPayload = {
	value: string;
	start?: number;
	end?: number;
};

const normalize = (value: string) => value.trim().toLowerCase();

const commandMatchesQuery = (command: EditorCommand, query: string) => {
	if (!query) {
		return true;
	}

	const searchable = [command.id, command.label, ...(command.keywords ?? [])].map(normalize);
	return searchable.some((value) => value.includes(query));
};

export class SlashMenuController {
	isOpen = $state(false);
	query = $state('');
	selectedIndex = $state(0);
	private activeRange: ActiveSlashRange | null = null;
	private isExecutingCommand = false;

	constructor(private edytor: Edytor) {}

	get commands() {
		const query = normalize(this.query);
		return Array.from(this.edytor.commands.values()).filter((command) => {
			if (command.isEnabled?.(this.edytor) === false) {
				return false;
			}
			return commandMatchesQuery(command, query);
		});
	}

	handleTextInsertion(text: Text, block: Block, payload: TextInsertionPayload) {
		if (this.edytor.readonly) {
			this.close();
			return;
		}

		const start = payload.start ?? this.edytor.selection.state.yStart;
		const end = payload.end ?? this.edytor.selection.state.yEnd;
		// A trigger typed alone, or committed by an IME with its query (`/h`).
		if (payload.value.startsWith('/') && start === end && block.convertible) {
			this.open(text, start, start + payload.value.length);
			return;
		}

		const range = this.range;
		if (!this.activeRange) {
			return;
		}

		if (text !== range?.text || start !== range.queryEnd) {
			this.close();
			return;
		}

		this.setEnd(text, start + payload.value.length);
	}

	reconcileSelection() {
		if (!this.activeRange || this.isExecutingCommand) {
			return;
		}

		const range = this.range;
		const { startText, yStart, isCollapsed } = this.edytor.selection.state;
		if (
			!range ||
			!isCollapsed ||
			startText !== range.text ||
			yStart <= range.triggerStart ||
			range.text.stringContent.at(range.triggerStart) !== '/'
		) {
			this.close();
			return;
		}

		this.setEnd(range.text, yStart);
	}

	moveSelection(delta: number) {
		if (!this.isOpen) {
			return false;
		}

		const commands = this.commands;
		if (commands.length === 0) {
			this.selectedIndex = 0;
			return true;
		}

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
		if (!range || !command) {
			return false;
		}

		this.isExecutingCommand = true;
		try {
			const { edytor } = this;
			const { text, triggerStart, queryEnd } = range;
			const end = Math.min(queryEnd, text.length);
			this.close();
			edytor.selection.setCollapsedStateAtTextOffset(text, triggerStart);
			// The trigger's removal leads the command's first operation (one plan:
			// refusing the command keeps the trigger); a command that plans
			// nothing synchronously runs after it.
			const at = text.parent.partOffsetOf(text) + triggerStart;
			const trigger = edytor.facade.prepare.deleteText(
				text.parent.model!.id,
				at,
				end - triggerStart
			);
			const run = edytor.dispatcher.lead(trigger, () => edytor.runCommand(command.id));
			if (!run.taken) this.removeTriggerText(text, triggerStart, end);
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
		if (!range) {
			return;
		}

		const { text, triggerStart, queryEnd } = range;
		this.query = text.stringContent.slice(triggerStart + 1, queryEnd);
		const commandCount = this.commands.length;
		this.selectedIndex = commandCount === 0 ? 0 : Math.min(this.selectedIndex, commandCount - 1);
	}

	private removeTriggerText(text: Text, triggerStart: number, queryEnd: number) {
		const contentIndex = text.parent.content.indexOf(text);
		if (contentIndex === -1) {
			return;
		}

		text.parent.deleteContentAtRange({
			start: [contentIndex, triggerStart],
			end: [contentIndex, Math.min(queryEnd, text.length)]
		});
	}
}
