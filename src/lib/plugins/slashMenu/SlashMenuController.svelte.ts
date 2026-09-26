import type { Block } from '$lib/block/block.svelte.js';
import type { Text } from '$lib/text/text.svelte.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { EditorCommand } from '$lib/plugins.js';

type ActiveSlashRange = {
	text: Text;
	triggerStart: number;
	queryEnd: number;
};

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

const canOpenInBlock = (block: Block) =>
	!block.definition.void &&
	!block.definition.island &&
	!block.insideIsland &&
	block.type !== 'codeLine';

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
		if (payload.value === '/' && start === end && canOpenInBlock(block)) {
			this.open(text, start, start + payload.value.length);
			return;
		}

		if (!this.activeRange) {
			return;
		}

		if (text !== this.activeRange.text || start !== this.activeRange.queryEnd) {
			this.close();
			return;
		}

		this.activeRange.queryEnd = start + payload.value.length;
		this.syncQueryFromText();
	}

	reconcileSelection() {
		if (!this.activeRange || this.isExecutingCommand) {
			return;
		}

		const { startText, yStart, isCollapsed } = this.edytor.selection.state;
		if (
			!isCollapsed ||
			startText !== this.activeRange.text ||
			yStart <= this.activeRange.triggerStart ||
			this.activeRange.text.stringContent.at(this.activeRange.triggerStart) !== '/'
		) {
			this.close();
			return;
		}

		this.activeRange.queryEnd = yStart;
		this.syncQueryFromText();
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
		if (!this.activeRange || !command) {
			return false;
		}

		this.isExecutingCommand = true;
		try {
			const { text, triggerStart, queryEnd } = this.activeRange;
			this.removeTriggerText(text, triggerStart, queryEnd);
			this.close();
			this.edytor.selection.setCollapsedStateAtTextOffset(text, triggerStart);
			const didRun = await this.edytor.runCommand(command.id);
			// Commands that replace the block (for example, Code) choose their own
			// caret. Only restore the slash caret when it still owns the selection.
			if (this.edytor.selection.state.startText === text) {
				await this.edytor.selection.setAtTextOffset(text, triggerStart);
			}
			return didRun;
		} finally {
			this.isExecutingCommand = false;
		}
	}

	private open(text: Text, triggerStart: number, queryEnd: number) {
		this.activeRange = { text, triggerStart, queryEnd };
		this.isOpen = true;
		this.syncQueryFromText();
	}

	private syncQueryFromText() {
		if (!this.activeRange) {
			return;
		}

		const { text, triggerStart, queryEnd } = this.activeRange;
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
