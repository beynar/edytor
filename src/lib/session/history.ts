/**
 * History (R7's named exception, R9, L2, O32, §4.3 `session/history`).
 *
 * Undo and redo are the bare engine calls: never inside a transaction and
 * with no tracked write after them — either would empty the redo stack (F4),
 * so nothing normalizes after a history command (D-23).
 *
 * Each stack item carries, per view, the selection values around it
 * (`meta: Map<viewKey, {before, after}>`): `before` is this view's value when
 * the item's first transaction began (whichever view or origin wrote it),
 * unless a gesture that replaced the selection first rewrites it (`began`);
 * `after` is the selection the item's last transaction left — the view's
 * value at its end, then every `select()` of the same gesture (the command's
 * result selection) until a newer gesture, transaction or history command.
 * The replay's own item inherits the entry, so undo and redo alternate
 * between the two. One restorer — this view's, only for the commands it
 * issues — selects the recorded value (unless a peer deleted a recorded
 * caret's place: the view then keeps its own, repaired selection); other
 * views and a headless `document.history` call restore nothing (their
 * carets ride the change, as for a remote undo).
 */
import type { Edytor } from '$lib/edytor.svelte.js';
import { project, textSelection, type SelectionValue } from './selection.js';

type Entry = { before: SelectionValue; after?: SelectionValue };
type StackItem = { meta: Map<string, unknown> };
type StackEvent = { stackItem: StackItem };

const KEY = 'edytor:selection';
/** A stack item's last dispatched write was an insertion (`wrote`): typing may continue it. */
const INSERTING = 'edytor:inserting';

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
	/** Whether this view's dispatched writes in the current transaction were all insertions. */
	#inserting: boolean | null = null;

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
			this.#inserting = null;
		};
		const record = ({ stackItem }: StackEvent) => {
			if (um.undoing || um.redoing) {
				// The replay's item inherits the popped item's entry.
				const popped = um.currStackItem as StackItem | null;
				const entry = popped && entries(popped).get(key);
				if (entry) entries(stackItem).set(key, entry);
				return;
			}
			// Its kind, from the view whose dispatcher wrote it (a raw write keeps the item's).
			if (this.#inserting !== null) stackItem.meta.set(INSERTING, this.#inserting);
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

	/**
	 * This view's top undo step began at `value`: a gesture that replaced the
	 * selection before its step (a handle drag block-selects the blocks it
	 * moves) restores the one the user had.
	 */
	began = (value: SelectionValue) => {
		const { undoManager: um, transaction: key } = this.edytor;
		const item = um?.undoStack.at(-1) as StackItem | undefined;
		const entry = item && entries(item).get(key);
		if (entry) entry.before = value;
	};

	/** The dispatcher wrote in this transaction: an insertion (`inserts`) or not. */
	wrote = (insertion: boolean) => {
		this.#inserting = (this.#inserting ?? true) && insertion;
	};

	/**
	 * An insertion at `value` continues this view's last step: that step is an
	 * insertion's (`wrote`: a resize, a deletion, a data write end it) and the
	 * top undo item's recorded `after` projects where `value` does. Only a
	 * continuation coalesces within `captureTimeout` (O31): after the
	 * selection moved, an insertion starts its own step, however soon it
	 * follows.
	 */
	continues = (value: SelectionValue) => {
		const { undoManager: um, transaction: key, facade } = this.edytor;
		const item = um?.undoStack.at(-1) as StackItem | undefined;
		if (item?.meta.get(INSERTING) !== true) return false;
		const after = (item?.meta.get(KEY) as Map<unknown, Entry> | undefined)?.get(key)?.after;
		if (after?.kind !== 'text' || value.kind !== 'text') return false;
		const [a, b] = [project(after, facade), project(value, facade)];
		const at = (p: typeof a.start, q: typeof a.start) =>
			p !== null && q !== null && p.block === q.block && p.offset === q.offset;
		return at(a.start, b.start) && at(a.end, b.end);
	};

	/**
	 * Replay the top undo (redo) item, under the dispatcher's admission (a
	 * readonly view, or a document it may not write, never rewinds it):
	 * `refused`, `noop` on an empty stack, else `applied`.
	 */
	replay = (command: 'undo' | 'redo'): 'refused' | 'noop' | 'applied' =>
		!this.edytor.dispatcher.permits() ? 'refused' : this.#run(command) ? 'applied' : 'noop';
	/** Replay the top undo item; answers whether one was replayed. */
	undo = () => this.replay('undo') === 'applied';
	/** Replay the top redo item; answers whether one was replayed. */
	redo = () => this.replay('redo') === 'applied';

	#run(command: 'undo' | 'redo'): boolean {
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
		if (!value) return !!item;
		// Anchors recorded before a delete bind items the replay re-created.
		const follow = facade.followUndo;
		const anchor = value.kind === 'text' ? follow(value.anchor) : null;
		const restored =
			value.kind === 'text'
				? textSelection(anchor!, value.focus === value.anchor ? anchor! : follow(value.focus))
				: value;
		// A peer deleted the recorded caret's place: the view keeps its own
		// selection, repaired as after any commit (the replay held that repair
		// back). A dead text value has no block of its own to seam from.
		if (restored.kind === 'text' && !project(restored, facade).start) {
			selection.restoreDeadSelectionEndpoints();
			return true;
		}
		selection.select(restored, 'history');
		return true;
	}
}
