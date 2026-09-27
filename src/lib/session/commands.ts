/**
 * The command dispatcher (R7, §4.3 `session/commands`): one per view.
 *
 * An operation is admitted (readonly, `document.writable`), prepared, shown
 * to every extension hook before any write — the command itself, then each
 * planned step under its documented operation name (D-10) — applied in one
 * transaction, normalized once per requested block, and reported
 * (`refused | noop | applied | failed`). A user command (`run`) wraps the
 * operations one gesture issues and closes the undo policy table. `prevent()`
 * is caught here, once (`prevented`).
 */
import type { Block } from '$lib/block/block.svelte.js';
import type { InlineBlock } from '$lib/block/inlineBlock.svelte.js';
import type { BlockId, BlockSpec } from '$lib/crdt/index.js';
import type { Plan, PlanStep, Prepared } from '$lib/crdt/edytor-doc.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { ChangePayload } from '$lib/plugins.js';
import type { Text } from '$lib/text/text.svelte.js';
import { DEV } from 'esm-env';
import { prevent, PreventionError } from '$lib/utils.js';

export type CommandResult = {
	operation: string;
	status: 'refused' | 'noop' | 'applied' | 'failed';
	error?: unknown;
};

/**
 * What a hook sees: an operation name, its payload, the block (and text) it
 * is about and, on a prepared command, its effect.
 */
type Change = {
	operation: string;
	payload: unknown;
	block: unknown;
	text?: Text;
	effect?: Plan['effect'];
};

/**
 * The undo policy (O31, FP-2) — today's grouping: deletions, paste, drop and
 * structural commands cut the capture before they write; a paragraph split
 * also cuts after; everything else (insertions) coalesces within
 * `captureTimeout`. A composition session's own deletion stays in its group.
 */
const CUT: Record<string, 'before' | 'both'> = {
	insertParagraph: 'both',
	insertFromPaste: 'before',
	insertFromPasteAsQuotation: 'before',
	insertFromDrop: 'before',
	insertBlock: 'before',
	replaceInlineBlock: 'before',
	nestBlock: 'before',
	unNestBlock: 'before',
	format: 'before'
};
const policyOf = (kind: string) =>
	CUT[kind] ??
	(kind.startsWith('delete') && kind !== 'deleteCompositionText' ? 'before' : undefined);

/** The one place a `prevent()` is recognized; anything else propagates. */
const prevented = (error: unknown): PreventionError => {
	if (error instanceof PreventionError) return error;
	throw error;
};

type Part = Text | InlineBlock;
const isText = (part: Part): part is Text => 'insertAt' in part;

/** The text part showing display offset `offset` of `block`: its index and local offset. */
const partAt = (block: Block, offset: number) => {
	let at = 0;
	const parts = block.content as Part[];
	for (let index = 0; index < parts.length; index++) {
		const part = parts[index]!;
		if (isText(part) && offset <= at + part.length) return { index, offset: offset - at, part };
		at += isText(part) ? part.length : 1;
	}
	// Past the end (a later step of the plan writes there): its last text's end.
	const index = parts.findLastIndex(isText);
	const part = parts[index] as Text | undefined;
	return part ? { index, offset: part.length, part } : null;
};

const specJSON = (spec: BlockSpec): unknown => ({
	id: spec.id,
	type: spec.type,
	data: spec.data ?? {},
	content: (spec.content ?? []).map((item) =>
		item.kind === 'text'
			? { text: item.text, ...(item.marks ? { marks: item.marks } : {}) }
			: { id: item.id, type: item.type, data: item.data ?? {} }
	),
	children: (spec.children ?? []).map(specJSON)
});

export class Dispatcher {
	/** The last operation's result (L5). */
	last: CommandResult | null = null;
	/** An operation's body is running: nested operations are its steps. */
	private active = false;
	/** A user command's synchronous part is running: nested commands are its steps. */
	private running = false;
	/** Open prevention scopes: a veto inside one aborts it. */
	private depth = 0;
	/** Extensions whose replacement is running (a command is replaced at most once per extension). */
	private replacing = new Set<unknown>();
	private queue: [Block, () => void][] = [];
	private current: [Block, () => void] | null = null;
	/** A plan the next dispatched operation composes before its own (`lead`). */
	private leading: Plan | null = null;

	constructor(private edytor: Edytor) {}

	/** Admission: a readonly view or a read-only document refuses every mutating command. */
	permits = () => !this.edytor.readonly && this.edytor.document.writable;

	/** Apply the undo policy's cut before a `kind` command writes. */
	cut = (kind: string, phase: 'before' | 'after' = 'before') => {
		const policy = policyOf(kind);
		if (policy === 'both' || (policy === 'before' && phase === 'before'))
			this.edytor.undoManager?.stopCapturing();
	};

	/**
	 * Run `body` as a prevention scope: a `prevent()` from a hook in it, or a
	 * veto of an operation it issues, aborts it; `onPrevent` runs, then the
	 * replacement callback.
	 */
	scope = <T>(body: () => T, onPrevent?: () => void): T | undefined => {
		let out: T;
		this.depth++;
		try {
			out = body();
		} catch (error) {
			this.depth--;
			return this.settle(error, onPrevent);
		}
		this.depth--;
		return out instanceof Promise
			? (out.catch((error) => this.settle(error, onPrevent)) as T)
			: out;
	};

	/** Run every extension's `call`; answer whether one of them prevented. */
	intercept = (call: (plugin: Edytor['plugins'][number]) => void, onPrevent?: () => void) => {
		let hit = false;
		this.scope(
			() => this.edytor.plugins.forEach(call),
			() => {
				hit = true;
				onPrevent?.();
			}
		);
		return hit;
	};

	/** A user command: admission, the undo policy around it, and one prevention scope. */
	run = <T>(kind: string, body: () => T): T | undefined => {
		if (this.running) return body();
		if (!this.permits()) return this.refuse(kind);
		this.cut(kind);
		const out = this.scope(() => {
			this.running = true;
			try {
				return body();
			} finally {
				this.running = false;
			}
		});
		const after = () => this.cut(kind, 'after');
		if (out instanceof Promise) return out.finally(after) as T;
		after();
		return out;
	};

	/**
	 * Dispatch one operation. `prepare` (when the operation is one document
	 * plan) makes its steps visible to hooks; `body` applies it (with the
	 * plan) inside the command's one transaction.
	 */
	dispatch = <P, R>(
		operation: string,
		payload: P,
		context: { block: unknown; text?: Text },
		body: (payload: P, plan?: Prepared) => R,
		prepare?: (payload: P) => Prepared
	): R | undefined => {
		if (this.active) return body(payload);
		const lead = this.leading;
		this.leading = null;
		if (!this.permits()) return this.refuse(operation);
		const original = payload;
		const replaced = new Set<unknown>();
		// A lead composes with the command's plan (both prepared at this version);
		// its steps on a block whose content the plan replaces are subsumed.
		const prepared = (p: P) => {
			const own = prepare?.(p);
			if (!lead || !own || !('writes' in own)) return own;
			const { displayLength, compose } = this.edytor.facade;
			const whole = own.writes.flatMap((w) =>
				w.op === 'deleteText' && w.offset === 0 && w.length === displayLength(w.id) ? [w.id] : []
			);
			const writes = lead.writes.filter((w) => !('id' in w) || !whole.includes(w.id));
			return compose({ ...lead, writes }, own);
		};
		let plan = prepared(payload);
		hooks: for (;;) {
			// A command refused at preparation is still shown (without steps): an
			// extension may replace or retarget it.
			const planned = plan && 'writes' in plan ? plan : undefined;
			const command: Change = { operation, payload, ...context, effect: planned?.effect };
			const steps = [...(lead && !plan ? lead.writes : []), ...(planned?.writes ?? [])];
			const changes = [command, ...this.steps(steps, planned?.effect.creates ?? [], command)];
			for (const change of changes) {
				for (const plugin of this.edytor.plugins) {
					let out: unknown;
					try {
						out = plugin.onBeforeOperation?.({ ...change, prevent } as ChangePayload);
					} catch (error) {
						const stop = prevented(error);
						if (stop.cb && this.replacing.has(plugin)) {
							if (DEV) console.warn(`[edytor] ${operation}: an extension replaces a command once`);
							continue;
						}
						stop.by = plugin;
						this.refuse(operation);
						if (this.depth > 0) throw stop;
						this.replace(stop);
						return undefined;
					}
					if (!out) continue;
					if (change !== command) {
						if (DEV)
							console.warn(`[edytor] ${change.operation}: a nested step's payload is ignored`);
					} else if (!replaced.has(plugin) && !this.replacing.has(plugin)) {
						replaced.add(plugin);
						payload = out as P;
						plan = prepared(payload);
						continue hooks;
					}
				}
			}
			break;
		}
		// Refused at preparation, and no extension replaced it.
		if (plan && !('writes' in plan)) {
			this.refuse(operation);
			return body(payload, plan);
		}
		const version = this.edytor.facade.version;
		let result: R;
		try {
			result = this.edytor.transact(() => {
				this.active = true;
				try {
					// An unplanned command runs after its lead, reading the state it leaves.
					if (lead && !plan) this.edytor.facade.apply(lead);
					const out = body(payload, plan);
					this.drain();
					return out;
				} finally {
					this.active = false;
					this.queue = [];
				}
			});
		} catch (error) {
			this.last = { operation, status: 'failed', error };
			throw error;
		}
		this.last = {
			operation,
			status: this.edytor.facade.version === version ? 'noop' : 'applied'
		};
		const change = { operation, payload: original, ...context } as Omit<ChangePayload, 'prevent'>;
		for (const plugin of this.edytor.plugins) plugin.onAfterOperation?.(change);
		return result;
	};

	/**
	 * Run `body` with `lead` (a plan prepared now) composed into the first
	 * operation it dispatches: one plan, so a veto of any step, or a refusal,
	 * refuses both (a slash or markdown trigger removal with its conversion).
	 * Answers `body`'s result and whether an operation took the lead.
	 */
	lead = <T>(lead: Prepared, body: () => T): { out: T | undefined; taken: boolean } => {
		if (!('writes' in lead)) return { out: undefined, taken: false };
		this.leading = lead;
		try {
			return { out: body(), taken: this.leading === null };
		} finally {
			this.leading = null;
		}
	};

	/**
	 * A command's result caret, shown once after its commit: the model first,
	 * then the DOM, through today's selection API (V2 replaces it by `select`).
	 */
	caret = (text: Text | null | undefined, offset: number) => {
		if (!text) return;
		const at = Math.max(0, Math.min(offset, text.length));
		this.edytor.selection.setCollapsedStateAtTextOffset(text, at);
		void this.edytor.selection.setAtTextOffset(text, at);
	};

	/**
	 * Inside an operation, normalization is requested, not run: each (block,
	 * normalizer) runs once, at the end of the command's transaction. Answers
	 * whether the request was queued.
	 */
	defer = (block: Block, normalize: () => void): boolean => {
		if (!this.active || (this.current?.[0] === block && this.current[1] === normalize))
			return false;
		const pending = this.queue.slice(this.queue.indexOf(this.current!) + 1);
		if (!pending.some(([b, n]) => b === block && n === normalize))
			this.queue.push([block, normalize]);
		return true;
	};

	private drain() {
		for (let i = 0; i < this.queue.length; i++) {
			if (i === 1000) {
				console.warn('[edytor] normalization is not converging; skipping further passes');
				break;
			}
			this.current = this.queue[i]!;
			const [block, normalize] = this.current;
			if (block.isRoot || block._live) normalize.call(block);
		}
		this.current = null;
	}

	private refuse(operation: string): undefined {
		this.last = { operation, status: 'refused' };
		return undefined;
	}

	private settle(error: unknown, onPrevent?: () => void): undefined {
		const stop = prevented(error);
		onPrevent?.();
		this.replace(stop);
		return undefined;
	}

	/**
	 * Run a prevention's replacement: a command of its own, so a veto of one
	 * of its operations refuses that operation (the replacement reads the
	 * result) instead of unwinding it. Its extension cannot replace again
	 * meanwhile.
	 */
	private replace({ cb, by }: PreventionError) {
		if (!cb) return;
		const fresh = by !== undefined && !this.replacing.has(by);
		if (fresh) this.replacing.add(by);
		const depth = this.depth;
		this.depth = 0;
		try {
			const out: unknown = cb();
			if (out instanceof Promise) out.catch((error) => this.settle(error));
		} catch (error) {
			this.settle(error);
		} finally {
			this.depth = depth;
			if (fresh) this.replacing.delete(by);
		}
	}

	/**
	 * The planned steps as hooks see them (D-10), under the documented
	 * operation names. A step that is the command itself (same name, same
	 * block) is not repeated; a write into a block the plan creates is part
	 * of that creation. (A `removeInline` step is only ever its own command,
	 * `removeInlineBlock`; `formatRange` and `setInlineData` steps belong to no
	 * dispatched plan yet: they have no mapping.)
	 */
	private steps(
		writes: readonly PlanStep[],
		creates: readonly BlockId[],
		command: Change
	): Change[] {
		const { idToBlock, root } = this.edytor;
		const created = new Set(creates);
		const block = (id: BlockId | null) => (id === null ? root : idToBlock.get(id));
		const path = (parent: BlockId | null, index: number) =>
			parent === null ? [index] : [...(block(parent)?.path ?? []), index];
		const out: Change[] = [];
		const show = (operation: string, block: unknown, payload: unknown, text?: Text) =>
			out.push({ operation, block, payload, ...(text ? { text } : {}) });
		for (const w of writes) {
			const target = 'id' in w ? w.id : w.op === 'mergeBlocks' ? w.from : w.parent;
			const b = block(target);
			if ((target !== null && created.has(target)) || !b) continue;
			const at = (offset: number) => partAt(b, offset) ?? { index: 0, offset: 0, part: undefined };
			// A text step shows on a text: a block without one shows none.
			const t = 'offset' in w ? at(w.offset) : undefined;
			const text = t?.part as Text;
			if (/^(insertText|insertInline|splitBlock)$/.test(w.op) && !text) continue;
			if (w.op === 'insertBlocks')
				show('addChildBlocks', b, { blocks: w.specs.map(specJSON), index: w.index });
			else if (w.op === 'moveBlocks' && w.ids.length === 1)
				show('moveBlock', block(w.ids[0]!), { path: path(w.parent, w.index) });
			else if (w.op === 'moveBlocks')
				show('moveBlocks', block(w.ids[0]!), {
					blocks: w.ids.map(block),
					path: path(w.parent, w.index)
				});
			else if (w.op === 'deleteBlock')
				show('removeBlock', b, {
					keepChildren: b.children.some((child) => !w.removes.includes(child.id))
				});
			else if (w.op === 'splitBlock') show('splitBlock', b, { index: t!.offset, text });
			else if (w.op === 'mergeBlocks') show('mergeBlockBackward', b, {});
			else if (w.op === 'setBlockType') show('setBlock', b, { value: { type: w.type } });
			else if (w.op === 'setBlockData') show('setBlock', b, { value: { data: w.data } });
			else if (w.op === 'insertText') {
				const [start, end, value, marks] = [t!.offset, t!.offset, w.text, w.marks];
				show('insertText', b, { value, start, end, marks }, text);
			} else if (w.op === 'insertInline')
				show('addInlineBlock', b, {
					index: t!.offset,
					text,
					block: { ...w.atom, data: w.atom.data ?? {} }
				});
			else if (w.op === 'deleteText') {
				const end = at(w.offset + w.length);
				show('deleteContentAtRange', b, {
					start: [t!.index, t!.offset],
					end: [end.index, end.offset]
				});
			}
		}
		return out.filter((c) => c.operation !== command.operation || c.block !== command.block);
	}
}
