/**
 * The command dispatcher (R7, §4.3 `session/commands`): one per view.
 *
 * An operation is admitted (readonly, `document.writable`), prepared, shown
 * to every extension hook before any write — the command itself, then each
 * planned step under its documented operation name (D-10) — applied in one
 * transaction, normalized once per requested block at the end of that
 * transaction (normalizers read handles over the index), and reported (`refused | noop | applied | failed`). A user command (`run`) wraps the
 * operations one gesture issues and closes the undo policy table. `prevent()`
 * is caught here, once (`prevented`).
 */
import type { Block } from '$lib/block/block.svelte.js';
import type { InlineBlock } from '$lib/block/inlineBlock.svelte.js';
import type { BlockId, BlockSpec } from '$lib/crdt/index.js';
import type { Plan, PlanStep, Prepared } from '$lib/crdt/edytor-doc.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { ChangePayload } from '$lib/plugins.js';
import type { SelectionValue } from '$lib/session/selection.js';
import type { Text } from '$lib/text/text.svelte.js';
import { DEV } from 'esm-env';
import { prevent, PreventionError } from '$lib/utils.js';
import { kindOf } from './attempt.js';

export type CommandResult = {
	operation: string;
	status: 'refused' | 'noop' | 'applied' | 'failed';
	error?: unknown;
	/** The result selection the command authored (R9), selected once. */
	selection?: SelectionValue;
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
 * The undo policy (O31, FP-2), owned here: a user command (`run`) applies it
 * by its kind, and an operation dispatched outside one (a menu action, a
 * plugin, a headless call) by its name. Deletions, paste, drop, formatting
 * and structural operations cut the capture before they write; a paragraph
 * split also cuts after; an insertion (`INSERTIONS`) coalesces within
 * `captureTimeout` when it continues the step before it (that step is an
 * insertion's, `inserts`, and it starts where that step left this view's
 * selection, `history.continues`), else it cuts: an
 * insertion after the caret moved is its own step whatever the pause, so the
 * grouping never depends on timing alone. Every other kind or operation —
 * one the table does not list included (`run('myConvert')`) — cuts before
 * it writes, so a plugin's write never joins the typing before it. A
 * conversion (a markdown or slash trigger with the kind it completes,
 * `lead`) is its own step, so undo gives the typed trigger back. A composition session groups like an insertion and is
 * one capture group: `session/composition` holds it open between its writes,
 * and no operation cuts while it is live.
 */
const CUT: Record<string, 'before' | 'both'> = {
	insertParagraph: 'both',
	insertFromPaste: 'before',
	insertFromPasteAsQuotation: 'before',
	insertFromDrop: 'before',
	insertBlock: 'before',
	format: 'before',
	// An accepted suggestion: typing after it is a step of its own.
	acceptSuggestion: 'both',
	// A DOM change no input occurrence owns (a foreign script): its own step.
	foreignChange: 'both'
};
/**
 * The kinds that may continue a step: the insertion operations (`insertText`,
 * `addInlineBlock`) and the input types that insert text. Any other kind — a
 * structural or formatting input type, a kind the table does not list
 * (`run('myConvert')`) — cuts before it writes.
 */
const INSERTIONS = new Set([
	'insertText',
	'addInlineBlock',
	'insertReplacementText',
	'insertLineBreak',
	'insertFromYank',
	'insertTranspose',
	'insertLink'
]);
type Policy = 'before' | 'both' | 'continue' | undefined;
/**
 * Whether a `kind` command's writes are text editing an insertion may
 * continue (`history.continues`): the insertions, a composition and a text
 * deletion (FP-2: Delete then typing is one step), never a led conversion.
 * Anything else — a paste, a structural edit, a data write such as a
 * column resize — ends the step for the typing after it.
 */
const inserts = (kind: string, lead: Plan | null) =>
	!lead && (kind.includes('Composition') || INSERTIONS.has(kind) || kindOf(kind) === 'delete');
const policyOf = (kind: string): Policy =>
	CUT[kind] ??
	(kind.includes('Composition') ? undefined : INSERTIONS.has(kind) ? 'continue' : 'before');

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

/** A text `patchData`: its target and paths (`key`) and the strings it sets. */
type TextPatch = { key: string; values: string[] };

/**
 * What a text `patchData` writes, or `null`: only a patch setting strings can
 * be typing into a bound field; a flag, a number, a delete or an object is a
 * discrete edit, its own step.
 */
const textPatch = (block: Block, payload: unknown): TextPatch | null => {
	const { ops, atom } = payload as { ops?: { path?: unknown; value?: unknown }[]; atom?: string };
	if (!Array.isArray(ops) || ops.length === 0 || ops.some((o) => typeof o?.value !== 'string'))
		return null;
	return {
		key: JSON.stringify([block.id, atom, ops.map((o) => o.path)]),
		values: ops.map((o) => o.value as string)
	};
};

/**
 * `next` is `previous` with one contiguous run typed in or deleted (their
 * common prefix and suffix cover the shorter one): what typing and Backspace
 * produce. Another value ('todo' → 'done', 'doing' → 'done') is not.
 */
const typedFrom = (previous: string, next: string) => {
	const shorter = Math.min(previous.length, next.length);
	let prefix = 0;
	while (prefix < shorter && previous[prefix] === next[prefix]) prefix++;
	let suffix = 0;
	while (
		suffix < shorter - prefix &&
		previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]
	)
		suffix++;
	return prefix + suffix === shorter;
};

/** `patch` continues `previous`: the same paths, each string edited by typing. */
const continuesTyping = (previous: TextPatch | null, patch: TextPatch | null) =>
	patch !== null &&
	previous !== null &&
	patch.key === previous.key &&
	patch.values.every((value, i) => typedFrom(previous.values[i]!, value));

type Normalizer = (this: Block) => void;
type Pass = [id: string, normalize: Normalizer];
/** Passes one normalizer may take on one block per command: the first and 50 re-requests (D25). */
const MAX_PASSES = 51;

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
	/**
	 * The result selection a command in flight declared before its operations
	 * (R9): the seam repair leaves this view's endpoints to it.
	 */
	authoring: SelectionValue | null = null;
	/** An operation's body is running: nested operations are its steps. */
	private active = false;
	/** A user command's synchronous part is running: nested commands are its steps. */
	private running = false;
	/** The running user command's kind (its policy decides whether its writes are an insertion). */
	private kind: string | null = null;
	/** The running user command's last step that applied. */
	private applied: CommandResult | null = null;
	/** Open prevention scopes: a veto inside one aborts it. */
	private depth = 0;
	/** Extensions whose replacement is running (a command is replaced at most once per extension). */
	private replacing = new Set<unknown>();
	/** Requested normalization passes: (block id, normalizer). */
	private queue: Pass[] = [];
	private current: Pass | null = null;
	/** The drain is entering `current`'s normalizer (its own request runs it). */
	private entering = false;
	private draining = false;
	/** A plan the next dispatched operation composes before its own (`lead`). */
	private leading: Plan | null = null;
	/** What the last `patchData` set to text: typing on the same paths continues its step (a bound field). */
	private patched: TextPatch | null = null;

	constructor(private edytor: Edytor) {}

	/** The plan `lead` holds for the next dispatched operation (a slash trigger's removal), if any. */
	get pendingLead(): Plan | null {
		return this.leading;
	}

	/** Admission: a readonly view or a read-only document refuses every mutating command. */
	/** Admission: not readonly, a writable document, and one decided when it requires hydration (H12). */
	permits = () =>
		!this.edytor.readonly &&
		this.edytor.document.writable &&
		(this.edytor.document.ready || !this.edytor.document.requireHydration);

	/** Apply the undo policy's cut before a `kind` command writes. */
	cut = (kind: string, phase: 'before' | 'after' = 'before') => {
		const policy = this.decide(policyOf(kind));
		if (policy === 'both' || (phase === 'before' && policy === 'before'))
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

	/**
	 * A user command: admission, the undo policy around it, and one
	 * prevention scope. Its result is its steps': one that applied is not
	 * overwritten by a later step refused or changing nothing (a Tab over
	 * several sibling groups where one cannot move, ZW-07).
	 */
	run = <T>(kind: string, body: () => T): T | undefined => {
		if (this.running) return body();
		if (!this.permits()) return this.refuse(kind);
		this.cut(kind);
		this.applied = null;
		const out = this.scope(() => {
			this.running = true;
			this.kind = kind;
			try {
				return body();
			} finally {
				this.running = false;
				this.kind = null;
			}
		});
		if (this.applied && this.last?.status !== 'applied' && this.last?.status !== 'failed')
			this.last = this.applied;
		this.applied = null;
		const after = () => this.cut(kind, 'after');
		if (out instanceof Promise) return out.finally(after) as T;
		after();
		return out;
	};

	/**
	 * A user command over several parts (Turn into over several blocks, Tab
	 * over several runs of siblings): each part is its own prevention scope,
	 * so a part the document refuses or an extension vetoes is skipped and
	 * the others still run (BW-02), as one undo step. Answers each part's
	 * result (`undefined` when vetoed).
	 */
	each = <T, R>(kind: string, parts: readonly T[], part: (item: T) => R): (R | undefined)[] =>
		this.run(kind, () => parts.map((item) => this.scope(() => part(item)))) ?? [];

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
			const writes = lead.writes.filter((w) => !('id' in w && w.id && whole.includes(w.id)));
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
		// A text patch typing into the strings the previous command set on the
		// same paths (a bound field) continues its step, within the capture
		// window, as typing does; another value of them is its own step.
		const patch = operation === 'patchData' ? textPatch(context.block as Block, payload) : null;
		const again = continuesTyping(this.patched, patch) && this.last?.operation === operation;
		this.patched = patch;
		const cut = again ? undefined : this.policy(operation, lead);
		if (cut) this.edytor.undoManager?.stopCapturing();
		let result: R;
		try {
			result = this.edytor.transact(() => {
				// What the step holds, recorded as the transaction ends: only an
				// insertion's step may be continued (`history.continues`).
				this.edytor.history.wrote(inserts(this.kind ?? operation, lead));
				this.active = true;
				try {
					// An unplanned command runs after its lead, reading the state it leaves.
					if (lead && !plan) this.edytor.facade.apply(lead);
					return body(payload, plan);
				} finally {
					this.active = false;
				}
			});
		} catch (error) {
			this.last = { operation, status: 'failed', error };
			throw error;
		}
		if (cut === 'both') this.edytor.undoManager?.stopCapturing();
		this.last = {
			operation,
			status: this.edytor.facade.version === version ? 'noop' : 'applied'
		};
		if (this.running && this.last.status === 'applied') this.applied = this.last;
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
	 * A command's result caret (R9): selected once and recorded on the result;
	 * the projector displays it after the flush (R10). With `ops`, the
	 * caret is declared before the command's operations run — minted while its
	 * text is live, so it survives them — and written only when they applied;
	 * meanwhile the seam repair leaves this view's endpoints to it.
	 */
	caret = <T>(text: Text | null | undefined, offset: number, ops?: () => T): T | undefined => {
		const selection = this.edytor.selection;
		const at = text ? Math.max(0, Math.min(offset, text.length)) : 0;
		const value = text ? selection.textValue(text, at) : null;
		let out: T | undefined;
		if (ops) {
			const outer = this.authoring;
			this.authoring = value;
			try {
				out = ops();
			} finally {
				this.authoring = outer;
			}
			if (!out) return out;
		}
		if (!text || !value || value.kind === 'none') return out;
		selection.clearModelSelectionPreservation();
		selection.select(value);
		// Declared before its operations: gone with them after all, the seam.
		if (!selection.projection.start) selection.restoreDeadSelectionEndpoints();
		if (this.last) this.last = { ...this.last, selection: selection.value };
		return out;
	};

	/**
	 * Inside an operation (or a normalization pass), normalization is
	 * requested, not run: each (block, normalizer) runs once per request, at
	 * the end of the command's transaction. Answers whether the request was
	 * queued.
	 */
	defer = (block: Block, normalize: Normalizer): boolean => {
		const [id, fn] = this.current ?? [];
		if (this.entering && id === block.id && fn === normalize) return (this.entering = false);
		if (!this.active) return false;
		this.request(block.id, normalize);
		return true;
	};

	/** A normalizer's work: part of the command's transaction (its operations are steps). */
	write = (work: () => void) => this.edytor.transact(work);

	/** Request a normalization pass of block `id` (deduped against the pending ones). */
	request = (id: string, normalize: Normalizer) => {
		const pending = this.queue.slice(this.current ? this.queue.indexOf(this.current) + 1 : 0);
		if (!pending.some(([i, n]) => i === id && n === normalize)) this.queue.push([id, normalize]);
	};

	/**
	 * Run the requested normalization at the end of the outermost transaction,
	 * inside it, also when the transaction's callback threw: its writes stay
	 * (GX-07). A pass reads handles over the index, so a normalizer sees what
	 * the command (and the previous pass) wrote; a pass that asks for its
	 * block again runs again, at most {@link MAX_PASSES} times.
	 */
	drain = () => {
		if (this.draining) return;
		this.draining = true;
		const passes = new Map<Normalizer, Map<string, number>>();
		const { edytor } = this;
		try {
			for (let i = 0; i < this.queue.length; i++) {
				if (i === 1000) {
					console.warn('[edytor] normalization is not converging; skipping further passes');
					break;
				}
				const entry = this.queue[i]!;
				const [id, normalize] = entry;
				const block = edytor.idToBlock.get(id);
				if (!block) continue;
				const counts = passes.get(normalize) ?? passes.set(normalize, new Map()).get(normalize)!;
				const count = (counts.get(id) ?? 0) + 1;
				counts.set(id, count);
				if (count > MAX_PASSES) {
					if (count === MAX_PASSES + 1)
						console.warn(
							`edytor: ${normalize.name} on block "${id}" exceeded ${MAX_PASSES - 1} passes — a plugin normalizer is not converging; skipping further passes`
						);
					continue;
				}
				this.current = entry;
				this.entering = true;
				this.active = true;
				try {
					normalize.call(block);
				} finally {
					this.active = false;
					this.entering = false;
				}
			}
		} finally {
			this.queue = [];
			this.current = null;
			this.draining = false;
		}
	};

	/**
	 * The cut an operation applies as it writes. Inside a user command none
	 * (the command cut); outside one, its bare policy. A led operation is a
	 * conversion: its own step even inside one. None while a composition is
	 * live (its writes are one group).
	 */
	private policy(operation: string, lead: Plan | null) {
		if (this.edytor.composition.live) return undefined;
		if (lead) return 'before';
		return this.running ? undefined : this.decide(policyOf(operation));
	}

	/** A continuation continues this view's last step, or cuts before it writes. */
	private decide(policy: Policy) {
		if (policy !== 'continue') return policy;
		const { history, selection } = this.edytor;
		return history.continues(selection.value) ? undefined : 'before';
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
	 * `removeInlineBlock`; `formatRange` steps belong to no dispatched plan
	 * yet: no mapping. A document data patch shows on the root.)
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
			const target =
				w.op === 'patchData'
					? (w.id ?? null)
					: 'id' in w
						? w.id
						: w.op === 'mergeBlocks'
							? w.from
							: w.parent;
			const b = block(target);
			if ((target !== null && created.has(target)) || !b) continue;
			const at = (offset: number) => partAt(b, offset) ?? { index: 0, offset: 0, part: undefined };
			// A text step shows on a text: a block without one shows none.
			const t = 'offset' in w && w.offset !== undefined ? at(w.offset) : undefined;
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
			else if (w.op === 'patchData')
				show('patchData', b, { ops: w.ops, ...(w.inlineId !== undefined && { atom: w.inlineId }) });
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
