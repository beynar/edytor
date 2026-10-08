import type { Block } from '$lib/block/block.svelte.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { EditorCommand } from '$lib/plugins.js';
import { project, type SelectionValue } from '$lib/session/selection.js';
import { matchesQuery } from '$lib/kinds.js';
import type { BlockAddition } from '$lib/plugins/blockHandles/BlockHandleController.svelte.js';
import { TextTriggerController } from '$lib/plugins/triggers/TriggerController.svelte.js';

export type { TextInsertionPayload } from '$lib/plugins/triggers/TriggerController.svelte.js';

/**
 * The view a `+`'s menu asks `isEnabled` of: the editor, its selection a
 * caret at the start of the block the `+` adds, below `block` (a stand-in
 * over `block`: an empty block of the parent's default kind, at the next
 * index, since it does not exist yet), or `block` itself when the `+`
 * reuses it (already an empty block of that kind). Nothing is written.
 */
const additionView = (edytor: Edytor, { block }: BlockAddition): Edytor => {
	const type = block.parent && edytor.defaultChild(block.parent);
	const reused = block.type === type && block.isEmpty;
	const index = block.index + 1;
	const stand: Record<PropertyKey, unknown> = {
		id: '',
		type,
		index,
		path: [...block.path.slice(0, -1), index],
		data: {},
		content: [],
		children: [],
		hasChildren: false,
		isEmpty: true,
		node: undefined,
		firstText: undefined,
		lastText: undefined,
		movable: true,
		convertible: true
	};
	const through = <T extends object>(target: T, own: Record<PropertyKey, unknown>): T =>
		new Proxy(target, {
			get: (object, key) => {
				if (key in own) return own[key];
				const value = Reflect.get(object, key, object);
				return typeof value === 'function' ? value.bind(object) : value;
			}
		});
	const added = reused ? block : through(block, stand);
	const text = added.firstText ?? null;
	const state: Edytor['selection']['state'] = {
		yStart: 0,
		yEnd: 0,
		isCollapsed: true,
		isReversed: false,
		isBlockSpanning: false,
		isVoidEditableElement: false,
		startText: text,
		endText: text,
		startBlock: added,
		endBlock: added,
		texts: text ? [text] : [],
		blocks: [added]
	};
	const selection = through(edytor.selection, {
		state,
		value: { kind: 'none' },
		selectedBlocks: new Set(),
		selectedInlineBlock: new Set()
	});
	return through(edytor, { selection });
};

/**
 * The slash menu: the `/` trigger (`TextTriggerController`: the range, the
 * query, the keys, the pick), whose rows are the editor's commands, and the
 * menu a handle's `+` opens with a search field of its own (`addition`).
 */
export class SlashMenuController extends TextTriggerController {
	/**
	 * Opened by a handle's `+` (`BLOCK_ADD_EVENT`): no `/` in the text, the
	 * query is the menu's own field, and a picked row adds the block first.
	 */
	addition = $state<BlockAddition | null>(null);
	/** The selection when a `+` opened the menu, given back when it closes unpicked. */
	private held: SelectionValue = { kind: 'none' };

	constructor(edytor: Edytor) {
		super(edytor, '/', 'slash-menu');
	}

	/** A row's element id (page-unique), for `aria-activedescendant`: set it on a custom `item`. */
	optionId = (command: EditorCommand) => this.edytor.popups.idOf(`slash-menu-${command.id}`);

	protected get count() {
		return this.commands.length;
	}

	/** A `/` opens the menu in a block a kind can replace (`convertible`). */
	protected admits(block: Block) {
		return block.convertible;
	}

	/**
	 * A query no command matches is prose (a URL, a path), and so is one
	 * that opens with whitespace (`yes / no`) or holds only hyphens (`/-`):
	 * the menu closes. Words after a space keep it open (`/to do`).
	 */
	protected queried(query: string) {
		const commandCount = this.commands.length;
		if (query && (commandCount === 0 || /^\s/.test(query) || !/[^-\s]/.test(query))) this.close();
		else this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, commandCount - 1));
	}

	/** Matching commands, grouped (groups in first-seen order): the menu's rows and keyboard order. */
	get commands() {
		// A `+`'s rows are the commands that can run in the block it adds.
		const matching = Array.from(this.edytor.commands.values()).filter(
			(command) => this.enabled(command) && matchesQuery(command, this.query)
		);
		// Groups in first-seen order, Notion's "Basic blocks" first.
		const groups = [...new Set(matching.map((command) => command.group ?? ''))].sort(
			(a, b) => Number(b === 'Basic blocks') - Number(a === 'Basic blocks')
		);
		return matching.sort((a, b) => groups.indexOf(a.group ?? '') - groups.indexOf(b.group ?? ''));
	}

	/**
	 * Whether `command` can run here: in a `+`'s menu, in the block it adds
	 * (`additionView`; an `isEnabled` that throws on that stand-in does not).
	 */
	private enabled(command: EditorCommand) {
		if (!this.addition) return command.isEnabled?.(this.edytor) !== false;
		try {
			return command.isEnabled?.(additionView(this.edytor, this.addition)) !== false;
		} catch {
			return false;
		}
	}

	close() {
		super.close();
		this.addition = null;
	}

	/** Open for a `+`: nothing is added until a row is picked. */
	offer(addition: BlockAddition) {
		this.close();
		[this.addition, this.isOpen] = [addition, true];
		this.held = this.edytor.selection.value;
	}

	/** The `+`'s menu typed in its own field (a query that matches nothing shows "No results"). */
	search(query: string) {
		[this.query, this.selectedIndex] = [query, 0];
	}

	/**
	 * Close without picking. A `+`'s menu gives the selection back as it was
	 * and, with `focus` (Escape, the footer), the editor its focus; a press
	 * outside, focus moving away or readonly leave the focus where it went.
	 */
	dismiss(focus = true) {
		const { addition, held } = this;
		this.close();
		if (!addition) return;
		// A held place a delete removed (a peer's) gives way to the repaired selection.
		if (held.kind === 'none' || project(held, this.edytor.facade).start)
			this.edytor.selection.select(held);
		if (!focus || this.edytor.readonly) return;
		this.edytor.expectInternalFocus();
		this.edytor.node?.focus({ preventScroll: true });
	}

	runSelected() {
		return this.run(this.commands[this.selectedIndex]);
	}

	async run(command: EditorCommand | undefined) {
		const { addition } = this;
		if (addition && command) {
			// One that cannot run in the block to add adds nothing (its row is not listed).
			if (!this.enabled(command)) return false;
			this.close();
			// Disabled once the block is added: the addition is taken back.
			const then = () =>
				command.isEnabled?.(this.edytor) !== false && this.edytor.runCommand(command.id);
			return (await addition.insert(then)) === true;
		}
		if (!this.range || !command) return false;
		// The trigger's removal leads the command's first operation (one plan:
		// refusing the command keeps the trigger); a command that plans
		// nothing synchronously runs after it. The caret goes back to where the
		// `/` was while it is still in its text: commands that replace the
		// block (Code, a divider) keep their own.
		const ran = await this.replaceTrigger(
			() => this.edytor.runCommand(command.id),
			(text) => this.edytor.selection.state.startText === text
		);
		return ran ?? false;
	}
}
