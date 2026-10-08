/**
 * Validation (`room.validate.*`, `room.locks`): the index of every shown
 * block's state that `validate` reads, kept from the change reports, and
 * the compensation of a denied frame — the history undo of exactly that
 * frame, as the room's own transaction.
 */
import type { DocChange, YDoc, YUndoManager } from '../../crdt/index.js';
import { asEngineDoc } from '../../crdt/structs.js';
import type { Attachment, FrameValidation, ValidatedBlock } from '../DocumentRoom.js';
import { ROOM_ORIGIN } from './shared.js';
import { lockedBlocks } from '../locks.js';
import { crdt, type RoomContext } from './context.js';

/** The index of `validate`: every shown block's state and each parent's children, kept from the change reports. */
export type Validation = {
	doc: YDoc;
	states: Map<string, ValidatedBlock>;
	children: Map<string | null, readonly string[]>;
	/** Records the frame's transaction, for its compensation (once the document is initialized). */
	history: YUndoManager | null;
	/** The frame being applied: its origin, what it touched and the states before. */
	frame: {
		origin: unknown;
		before: Map<string, ValidatedBlock | null>;
		touched: Set<string>;
		data: boolean;
	} | null;
	off: () => void;
};

/** The ids of `next` that left their order relative to the others both lists hold (a longest increasing run kept). */
const reordered = (previous: readonly string[], next: readonly string[]): string[] => {
	const at = new Map(previous.map((id, i) => [id, i]));
	const common = next.filter((id) => at.has(id));
	// Longest increasing run of previous positions (patience sorting).
	const tails: number[] = [];
	const links: number[] = new Array(common.length).fill(-1);
	const tailAt: number[] = [];
	common.forEach((id, i) => {
		const position = at.get(id)!;
		let lo = 0;
		let hi = tails.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (tails[mid] < position) lo = mid + 1;
			else hi = mid;
		}
		tails[lo] = position;
		tailAt[lo] = i;
		links[i] = lo > 0 ? tailAt[lo - 1] : -1;
	});
	const kept = new Set<number>();
	for (let i = tails.length ? tailAt[tails.length - 1] : -1; i !== -1; i = links[i]) kept.add(i);
	return common.filter((_, i) => !kept.has(i));
};

export class RoomValidation {
	/** The index `validate` reads (built at its first frame, for the live document). */
	private validation: Validation | null = null;
	private _validator: ((frame: FrameValidation) => boolean | void) | null | undefined;

	constructor(private readonly room: RoomContext) {}

	/**
	 * The frame check, resolved at first use: per-block locks (`locks`),
	 * then `validate`; `null` when neither is set (no block index is kept).
	 */
	private get validator(): ((frame: FrameValidation) => boolean | void) | null {
		if (this._validator !== undefined) return this._validator;
		const locks = this.room.options.locks;
		const validate = this.room.options.validate;
		const locked = locks ? lockedBlocks(locks) : null;
		return (this._validator =
			locked === null
				? (validate ?? null)
				: validate === undefined
					? locked
					: (frame) => locked(frame) && validate(frame) !== false);
	}

	/** Whether frames are checked (`locks` or `validate` set). */
	get active(): boolean {
		return this.validator !== null;
	}

	/** The live document was replaced: the index read the old one. */
	reset() {
		this.validation?.off();
		this.validation = null;
	}

	/** A shown block's state, read from the facade (`null`: it does not show). */
	private blockState(id: string): ValidatedBlock | null {
		const facade = this.room.facade;
		if (!facade.isVisibleBlock(id)) return null;
		return {
			id,
			type: facade.blockTypeOf(id) ?? '',
			data: (facade.blockDataOf(id) ?? {}) as Record<string, unknown>,
			content: facade.contentJSON(id) as ValidatedBlock['content'],
			parent: facade.parentOf(id)
		};
	}

	/**
	 * The index `validate` reads, for `doc`, set to record the frame of
	 * `origin`: every shown block's state and each parent's children, built
	 * once and kept from every change report. Its history (once the
	 * document is initialized: a history first initializes its document)
	 * records the frame for its compensation.
	 */
	begin(doc: YDoc, origin: unknown): Validation {
		let v = this.validation;
		if (v === null || v.doc !== doc) {
			v?.off();
			const facade = this.room.facade;
			const states = new Map<string, ValidatedBlock>();
			const children = new Map<string | null, readonly string[]>();
			const walk = (parent: string | null) => {
				const ids = facade.childrenIds(parent);
				children.set(parent, ids);
				for (const id of ids) {
					const state = this.blockState(id);
					if (state !== null) states.set(id, state);
					walk(id);
				}
			};
			walk(null);
			const created: Validation = {
				doc,
				states,
				children,
				history: null,
				frame: null,
				off: () => {}
			};
			created.off = facade.onChange((change) => this.indexChange(created, change));
			v = this.validation = created;
		}
		if (v.history === null && crdt.doc.isInitialized(asEngineDoc(doc))) {
			v.history = this.room.facade.createUndoManager({
				captureTimeout: 0,
				trackedOrigins: new Set()
			});
		}
		v.frame = { origin, before: new Map(), touched: new Set(), data: false };
		return v;
	}

	/** Keep the index from one change report, recording what the frame being validated touched. */
	private indexChange(v: Validation, change: DocChange) {
		const frame = v.frame?.origin === change.origin ? v.frame : null;
		const touch = (id: string) => {
			if (frame === null) return;
			if (!frame.before.has(id)) frame.before.set(id, v.states.get(id) ?? null);
			frame.touched.add(id);
		};
		const drop = (id: string) => {
			touch(id);
			for (const child of v.children.get(id) ?? []) drop(child);
			v.children.delete(id);
			v.states.delete(id);
		};
		const read = (id: string, moved: boolean) => {
			const was = v.states.get(id);
			const state = this.blockState(id);
			if (state === null) return drop(id);
			if (!moved || was === undefined || was.parent !== state.parent) touch(id);
			v.states.set(id, state);
		};
		for (const id of change.removed) drop(id);
		type Added = { id: string; children: readonly Added[] };
		const add = (block: Added) => {
			touch(block.id);
			read(block.id, false);
			v.children.set(block.id, this.room.facade.childrenIds(block.id));
			block.children.forEach(add);
		};
		for (const block of change.added.values()) add(block);
		for (const id of change.moved) read(id, true);
		for (const id of change.meta.keys()) read(id, false);
		for (const id of change.content.keys()) read(id, false);
		// A block moved among its siblings, not shifted by another's move.
		for (const [parent, ids] of change.order) {
			for (const id of reordered(v.children.get(parent) ?? [], ids)) touch(id);
			v.children.set(parent, ids);
		}
		if (frame !== null && change.data !== undefined) frame.data = true;
	}

	/**
	 * Ask `validate` about the frame just applied; a denial is
	 * compensated by the room's own transaction: the history undo of that
	 * frame (`room.validate.inverse`), or, for the frame that initialized
	 * the document (no history recorded it), a delete of the blocks it
	 * added. Stored and sent to every socket, the sender's included.
	 */
	settle(v: Validation, attachment: Attachment) {
		const room = this.room;
		const frame = v.frame;
		v.frame = null;
		if (frame === null || (frame.touched.size === 0 && !frame.data)) {
			if (v.history) room.facade.releaseHistory(v.history);
			return;
		}
		const touched = [...frame.touched];
		let allowed: boolean;
		try {
			allowed =
				this.validator!({
					user: attachment.user,
					replica: attachment.replica,
					touched,
					dataChanged: frame.data,
					before: (id) =>
						frame.before.has(id) ? frame.before.get(id)! : (v.states.get(id) ?? null),
					after: (id) => v.states.get(id) ?? null,
					facade: room.facade
				}) !== false;
		} catch (error) {
			room.note({ reason: 'internal', detail: `validate: ${String(error)}` });
			allowed = false;
		}
		if (!allowed) {
			room.note({ reason: 'denied', detail: { user: attachment.user, touched } });
			room.log({ edytor: 'denied', user: attachment.user, touched: touched.length });
			const history = v.history;
			if (history !== null && history.undoStack.length > 0) {
				history.undo();
			} else {
				const added = touched.filter((id) => frame.before.get(id) === null && v.states.has(id));
				const facade = room.facade;
				if (added.length > 0) {
					facade.transact(() => facade.apply(facade.prepare.deleteBlocks(added)), ROOM_ORIGIN);
				}
			}
		}
		if (v.history) room.facade.releaseHistory(v.history);
	}
}
