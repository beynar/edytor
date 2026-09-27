/**
 * History (R7's named exception, R9, L2, O32, §4.3 `session/history`).
 *
 * Undo and redo are the bare engine calls: never inside a transaction and
 * with no tracked write after them — either would empty the redo stack (F4),
 * so nothing normalizes after a history command (D-23).
 *
 * Each stack item carries, per view, the selection values around it
 * (`meta: Map<viewKey, {before, after}>`): `before` is this view's value when
 * the item's first transaction began (whichever view or origin wrote it);
 * `after` is the selection the item's last transaction left — the view's
 * value at its end, then every `select()` of the same gesture (the command's
 * result selection) until a newer gesture, transaction or history command.
 * The replay's own item inherits the entry, so undo and redo alternate
 * between the two. One restorer — this view's, only for the commands it
 * issues — selects the recorded value; other views and a headless
 * `document.history` call restore nothing (their carets ride the change, as
 * for a remote undo).
 */
import type { Edytor } from '$lib/edytor.svelte.js';
import { textSelection, type SelectionValue } from './selection.js';

type Entry = { before: SelectionValue; after?: SelectionValue };
type StackItem = { meta: Map<string, unknown> };
type StackEvent = { stackItem: StackItem };

const KEY = 'edytor:selection';

const entries = (item: StackItem): Map<unknown, Entry> => {
	let map = item.meta.get(KEY) as Map<unknown, Entry> | undefined;
	if (!map) item.meta.set(KEY, (map = new Map()));
	return map;
};

export class History {
	/** This view's value when the current outer transaction began. */
	#start: SelectionValue | null = null;
	/** The entry whose `after` follows this view's selection, and the gesture it belongs to. */
	#open: { entry: Entry; gesture: number } | null = null;
	#off: (() => void) | null = null;

	constructor(private edytor: Edytor) {}

	/** Record this view's entries on the document's history (idempotent). */
	bind = () => {
		this.unbind();
		const { doc, undoManager: um, transaction: key } = this.edytor;
		// Read at event time: the view binds before its selection exists.
		const value = () => this.edytor.selection.value;
		const begin = () => {
			this.#start = value();
			this.#open = null;
		};
		const record = ({ stackItem }: StackEvent) => {
			if (um.undoing || um.redoing) {
				// The replay's item inherits the popped item's entry.
				const popped = um.currStackItem as StackItem | null;
				const entry = popped && entries(popped).get(key);
				if (entry) entries(stackItem).set(key, entry);
				return;
			}
			const map = entries(stackItem);
			const entry = map.get(key) ?? { before: this.#start ?? value() };
			entry.after = value();
			map.set(key, entry);
			this.#open = { entry, gesture: this.edytor.intentSerial };
		};
		doc.on('beforeTransaction', begin);
		um.on('stack-item-added', record);
		um.on('stack-item-updated', record);
		this.#off = () => {
			doc.off('beforeTransaction', begin);
			um.off('stack-item-added', record);
			um.off('stack-item-updated', record);
		};
	};

	unbind = () => {
		this.#off?.();
		this.#off = null;
	};

	/** A `select()` of this view: the open step's result selection, while its gesture lasts. */
	selected = (value: SelectionValue) => {
		const open = this.#open;
		if (!open) return;
		if (open.gesture === this.edytor.intentSerial) open.entry.after = value;
		else this.#open = null;
	};

	undo = () => this.#run('undo');
	redo = () => this.#run('redo');

	#run(command: 'undo' | 'redo') {
		const { undoManager: um, transaction: key, selection, facade } = this.edytor;
		this.#open = null;
		// Other writers (remote-apply and repair restores) stand aside while the
		// replay commits: this view's recorded value decides.
		selection.expectHistoryRestore = true;
		let item: StackItem | null;
		try {
			item = (command === 'undo' ? um.undo() : um.redo()) as StackItem | null;
		} finally {
			selection.expectHistoryRestore = false;
		}
		const entry = item && entries(item).get(key);
		const value = command === 'undo' ? entry?.before : entry?.after;
		if (!value) return;
		// Anchors recorded before a delete bind items the replay re-created.
		const follow = facade.followUndo;
		const anchor = value.kind === 'text' ? follow(value.anchor) : null;
		selection.select(
			value.kind === 'text'
				? textSelection(anchor!, value.focus === value.anchor ? anchor! : follow(value.focus))
				: value,
			'history'
		);
	}
}
