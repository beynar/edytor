/**
 * The command dispatcher: one per view.
 *
 * Every write a view makes is one of the document's operations
 * (`DocumentWrites`, dispatched under its own name and arguments:
 * `edytor.insertBlocks(…)`), or a named command that is one prepared plan of
 * them (`plan`: a table row, a find-and-replace). It is admitted (readonly,
 * `document.writable`), prepared, shown to every extension hook before any
 * write — the command itself, then each planned step as the operation it
 * performs — applied in one transaction, normalized once per touched block at
 * the end of that transaction (normalizers read handles over the index), and
 * reported (`refused | noop | applied | failed`). A user command (`run`)
 * wraps the operations one gesture issues and closes the undo policy table.
 * `prevent()` is caught here, once (`prevented`).
 */
import type { Block } from '$lib/block/block.svelte.js';
import type { BlockId } from '$lib/crdt/index.js';
import type { DocumentWrites } from '$lib/crdt/operations.js';
import type { OpResult, Plan, PlanStep, Prepared } from '$lib/crdt/edytor-doc.js';
import type { DocPosition } from '$lib/crdt/rangeDelete.js';
import { refused } from '$lib/crdt/doc/plan.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { AfterOperationPayload, ChangePayload, InitializedPlugin } from '$lib/plugins.js';
import type { SelectionValue } from '$lib/session/selection.js';
import type { Text } from '$lib/text/text.svelte.js';
import type { Caret } from '$lib/selection/selection.svelte.js';
import { viewOf } from '$lib/selection/visibility.js';
import { reveal } from '$lib/selection/replaceSelection.js';
import { DEV } from 'esm-env';
import { PreventionError, vetoable } from '$lib/utils.js';
import { kindOf } from './attempt.js';
import { insertionMarksAt } from './editing/text.js';

/**
 * The result of the last command a view ran (`edytor.dispatcher.last`): its
 * operation and its status.
 */
export type CommandResult = {
	operation: string;
	status: 'refused' | 'noop' | 'applied' | 'failed';
	error?: unknown;
	/** The result selection the command authored, selected once. */
	selection?: SelectionValue;
};

/** A document write's name. */
export type Write = keyof DocumentWrites;

/** A command the view refused (readonly, a read-only document) or a hook prevented. */
const PREVENTED = refused('view');

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
 * The undo policy, owned here: a user command (`run`) applies it
 * by its kind, and an operation dispatched outside one (a menu action, a
 * plugin, a headless call) by its name. Every kind cuts the capture before
 * it writes — deletions, paste, drop, formatting and structural operations,
 * and any kind this table does not list (`run('myConvert')`), so a plugin's
 * write never joins the typing before it — except an insertion
 * (`insertion`), which coalesces within `captureTimeout` when it continues
 * the step before it (that step is an insertion's, `inserts`, and it starts
 * where that step left this view's selection, `history.continues`), else it
 * cuts: an insertion after the caret moved is its own step whatever the
 * pause, so the grouping never depends on timing alone. The kinds listed
 * here also cut after them. A conversion (a markdown or slash trigger with
 * the kind it completes, `lead`) is its own step, so undo gives the typed
 * trigger back. A composition session groups like an insertion and is one
 * capture group: `session/composition` holds it open between its writes,
 * and no operation cuts while it is live.
 */
const CUT: Record<string, 'both'> = {
	// A paragraph split.
	insertParagraph: 'both',
	// A text drag's drop: typing after it is a step of its own.
	moveText: 'both',
	// An accepted suggestion: typing after it is a step of its own.
	acceptSuggestion: 'both',
	// A DOM change no input occurrence owns (a foreign script): its own step.
	foreignChange: 'both'
};
/** The origin of `Dispatcher.outside`'s transactions: no history tracks it. */
const OUTSIDE_HISTORY = Symbol('edytor.outsideHistory');
/**
 * The kinds that may continue a step: the input types that insert text
 * (`insertText`, the operation too), a soft break, an atom and a link.
 */
const insertion = (kind: string) =>
	kindOf(kind) === 'text' || ['insertLineBreak', 'insertInline', 'insertLink'].includes(kind);
type Policy = 'before' | 'both' | 'continue' | undefined;
/**
 * Whether a `kind` command's writes are text editing an insertion may
 * continue (`history.continues`): the insertions, a composition and a text
 * deletion (Delete then typing is one step), never a led conversion.
 * Anything else — a paste, a structural edit, a data write such as a
 * column resize — ends the step for the typing after it.
 */
const inserts = (kind: string, led: boolean) =>
	!led && (kind.includes('Composition') || insertion(kind) || kindOf(kind) === 'delete');
const policyOf = (kind: string): Policy =>
	CUT[kind] ?? (kind.includes('Composition') ? undefined : insertion(kind) ? 'continue' : 'before');

/** The one place a `prevent()` is recognized; anything else propagates. */
const prevented = (error: unknown): PreventionError => {
	if (error instanceof PreventionError) return error;
	throw error;
};

/** A text `patchData`: its target and paths (`key`) and the strings it sets. */
type TextPatch = { key: string; values: string[] };

/**
 * What a text `patchData` writes, or `null`: only a patch setting strings can
 * be typing into a bound field; a flag, a number, a delete or an object is a
 * discrete edit, its own step.
 */
const textPatch = (args: unknown): TextPatch | null => {
	const [target, ops] = args as [unknown, { path?: unknown; value?: unknown }[]];
	if (!Array.isArray(ops) || ops.length === 0 || ops.some((o) => typeof o?.value !== 'string'))
		return null;
	return {
		key: JSON.stringify([target, ops.map((o) => o.path)]),
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

/** A kind's normalizer (`BlockDefinition.normalizeContent`/`normalizeChildren`). */
export type Normalizer = 'normalizeContent' | 'normalizeChildren';
type Pass = [id: string, normalize: Normalizer];
/** Passes one normalizer may take on one block per command: the first and 50 re-requests. */
const MAX_PASSES = 51;

/**
 * The block a write's first argument names: a block, a list's first, a
 * destination's parent, a position's or a target's block (`null`: the root).
 */
const subjectOf = (arg: unknown): BlockId | null => {
	if (typeof arg === 'string') return arg;
	if (Array.isArray(arg)) return subjectOf(arg[0]);
	if (arg === null || typeof arg !== 'object') return null;
	const at = arg as { block?: unknown; parent?: unknown; replace?: unknown; slot?: unknown };
	return subjectOf(at.block ?? at.parent ?? at.replace ?? at.slot);
};

type Step<K extends PlanStep['op']> = Extract<PlanStep, { op: K }>;
/** A planned step as the operation it performs, with that operation's arguments. */
const ARGS: { [K in PlanStep['op']]: (w: Step<K>, keepChildren: boolean) => unknown[] } = {
	insertBlocks: (w) => [{ parent: w.parent, index: w.index }, w.specs],
	moveBlocks: (w) => [w.ids, { parent: w.parent, index: w.index }],
	deleteBlock: (w, keepChildren) => [w.id, { keepChildren }],
	splitBlock: (w) => [w.id, w.offset, w.newId, w.tail],
	mergeBlocks: (w) => [w.from, w.into],
	setBlockType: (w) => [w.id, w.type],
	patchData: (w) => [
		w.inlineId !== undefined ? { block: w.id, atom: w.inlineId } : (w.id ?? null),
		w.ops
	],
	insertText: (w) => [w.id, w.offset, w.text, w.marks],
	insertInline: (w) => [w.id, w.offset, w.atom],
	deleteText: (w) => [w.id, w.offset, w.length],
	removeInline: (w) => [w.id, w.inlineId],
	formatRange: (w) => [w.id, w.offset, w.length, w.marks]
};

export class Dispatcher {
	#last: CommandResult | null = null;
	/** The last operation's result (read-only: the dispatcher records it). */
	get last(): CommandResult | null {
		return this.#last;
	}
	/**
	 * Record `result` as the last operation's: a refusal or result decided
	 * outside a dispatch (a key or input no command took, a gesture the
	 * layout refused, a history replay).
	 * @internal
	 */
	record(result: CommandResult | null): void {
		this.#last = result;
	}
	/**
	 * The result selection a command in flight declared before its operations: the seam repair leaves this view's endpoints to it.
	 * @internal
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
	#draining = false;
	/** A plan the next dispatched operation composes before its own (`lead`). */
	private leading: Plan | null = null;
	/** The next dispatched operation is a step of its own, as a led one is (`alone`). */
	#alone = false;
	/** What the last `patchData` set to text: typing on the same paths continues its step (a bound field). */
	private patched: TextPatch | null = null;
	/** `outside` is running: its commands cut no step and enter none. */
	private untracked = false;

	/** @internal */
	constructor(private edytor: Edytor) {}

	/**
	 * Run `body`'s commands outside the undo history (one transaction of
	 * their own, under an origin no history tracks): admitted, shown to hooks
	 * and recorded in `last` as any command, but they cut no step and enter
	 * none. For a write that completes a step already taken, whose undo
	 * already covers it: an upload's URL filling the image block its paste
	 * placed. That step's undo withdraws the block, URL included
	 * (`hist.undo.withdraw`), and its redo shows it again, so the paste stays
	 * one step whatever the upload's delay, and the typing around it groups
	 * as if it never came. Throws, writing nothing, when a transaction is
	 * already open: its writes would take that transaction's origin and join
	 * its step (call it from a later task, as an upload's answer is).
	 */
	outside = <T>(body: () => T): T => {
		if (this.edytor.doc._transaction)
			throw new Error(
				'dispatcher.outside: called inside a transaction, where its writes would join that step'
			);
		const outer = this.untracked;
		this.untracked = true;
		try {
			return this.edytor.doc.transact(body, OUTSIDE_HISTORY);
		} finally {
			this.untracked = outer;
		}
	};

	/**
	 * The plan `lead` holds for the next dispatched operation (a slash trigger's removal), if any.
	 * @internal
	 */
	get pendingLead(): Plan | null {
		return this.leading;
	}

	/**
	 * Whether this view accepts writes now: not readonly, its document
	 * writable, and decided when it requires hydration. Every command asks
	 * it first; a plugin's own write outside a command asks it too.
	 */
	permits = () =>
		!this.edytor.readonly &&
		this.edytor.document.writable &&
		(this.edytor.document.ready || !this.edytor.document.requireHydration);

	/**
	 * Apply the undo policy's cut before a `kind` command writes.
	 * @internal
	 */
	cut = (kind: string, phase: 'before' | 'after' = 'before') => {
		if (this.untracked) return;
		const policy = this.decide(policyOf(kind));
		if (policy === 'both' || (phase === 'before' && policy === 'before'))
			this.edytor.undoManager?.stopCapturing();
	};

	/**
	 * Run `body` as a prevention scope: a `prevent()` from a hook in it, or a
	 * veto of an operation it issues, aborts it; `onPrevent` runs, then the
	 * replacement callback.
	 * @internal
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

	/**
	 * Run every extension's `call`; answer whether one of them prevented.
	 * @internal
	 */
	intercept = (call: (plugin: InitializedPlugin) => void, onPrevent?: () => void) => {
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
	 * several sibling groups where one cannot move).
	 */
	run = <T>(kind: string, body: () => T): T | undefined => {
		if (this.running) return body();
		if (!this.permits()) return void this.#refused(kind);
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
			this.#last = this.applied;
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
	 * the others still run, as one undo step. Answers each part's
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
		// A led operation, or one `alone` runs: its own step, never an insertion's.
		const led = !!lead || this.#alone;
		this.#alone = false;
		if (!this.permits()) {
			this.#refused(operation);
			return undefined;
		}
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
						out = vetoable((prevent) =>
							plugin.onBeforeOperation?.({ ...change, prevent } as ChangePayload)
						);
					} catch (error) {
						const stop = prevented(error);
						if (stop.cb && this.replacing.has(plugin)) {
							if (DEV) console.warn(`[edytor] ${operation}: an extension replaces a command once`);
							continue;
						}
						stop.by = plugin;
						this.#refused(operation);
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
			this.#refused(operation);
			return body(payload, plan);
		}
		const version = this.edytor.facade.version;
		// A text patch typing into the strings the previous command set on the
		// same paths (a bound field) continues its step, within the capture
		// window, as typing does; another value of them is its own step.
		const patch = operation === 'patchData' ? textPatch(payload) : null;
		const again = continuesTyping(this.patched, patch) && this.last?.operation === operation;
		// A write outside the history continues nothing and leaves the typing's record.
		if (!this.untracked) this.patched = patch;
		const cut = again ? undefined : this.policy(operation, led);
		if (cut) this.edytor.undoManager?.stopCapturing();
		let result: R;
		try {
			result = this.edytor.transact(() => {
				// What the step holds, recorded as the transaction ends: only an
				// insertion's step may be continued (`history.continues`).
				this.edytor.history.wrote(inserts(this.kind ?? operation, led));
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
			this.#last = { operation, status: 'failed', error };
			throw error;
		}
		if (cut === 'both') this.edytor.undoManager?.stopCapturing();
		const own: CommandResult = {
			operation,
			status: this.edytor.facade.version === version ? 'noop' : 'applied'
		};
		this.#last = own;
		if (this.running && own.status === 'applied') this.applied = own;
		const effect = plan && 'writes' in plan ? plan.effect : undefined;
		const change = { operation, payload: original, ...context, effect } as AfterOperationPayload;
		for (const plugin of this.edytor.plugins) plugin.onAfterOperation?.(change);
		return result;
	};

	/**
	 * Dispatch `operation` as the plan `prepare` makes of `payload` (a hook's
	 * replacement payload is prepared again), about `block` (the root by
	 * default): hooks see it and each planned step before any write; one
	 * transaction; the blocks it touched normalized and the blocks it moved
	 * shown (closed toggles open); the caret it decides (`plan.at`: a range
	 * deletion, a placed flow) selected. Answers its result: `refused` when
	 * the document refused it, `refused` with the reason `'view'` when the
	 * view did (readonly, a read-only document) or a hook prevented it.
	 */
	plan = <P>(
		operation: string,
		payload: P,
		prepare: (payload: P) => Prepared,
		block?: Block,
		text?: Text
	): OpResult => {
		let at: DocPosition | undefined;
		const out = this.dispatch(
			operation,
			payload,
			{ block: block ?? this.edytor.root, ...(text && { text }) },
			(p, plan = prepare(p)) => {
				at = 'writes' in plan ? plan.at : undefined;
				return this.write(plan);
			},
			prepare
		);
		if (at && !this.active && out && out.status !== 'refused') this.caret(at);
		return out ?? PREVENTED;
	};

	/**
	 * Dispatch the document write `operation` with `args` (`edytor.<op>(…)`):
	 * the view's own arguments filled in — an insertion without marks takes
	 * the insertion's (`marksForInsertion`), a range or a flow is read in
	 * this view (`viewOf`) — then {@link plan}.
	 * @internal
	 */
	operate = <K extends Write>(operation: K, args: Parameters<DocumentWrites[K]>): OpResult => {
		const { edytor } = this;
		const own = (edytor.facade.prepare as unknown as Record<string, (...a: unknown[]) => Prepared>)[
			operation
		]!;
		const prepare = (a: unknown[]) => {
			if (operation === 'insertText' && a[3] === undefined)
				return own(a[0], a[1], a[2], insertionMarksAt(edytor, a[0] as BlockId, a[1] as number));
			if (/^(deleteRange|replaceRange|insertFlow)$/.test(operation) && a[2] === undefined)
				return own(a[0], a[1], viewOf(edytor));
			return own(...a);
		};
		const block = edytor.idToBlock.block(subjectOf(args[0]) ?? 'root');
		const text =
			typeof args[0] === 'string' && typeof args[1] === 'number'
				? block.textAtOffset(args[1])?.text
				: undefined;
		return this.plan(operation, args as unknown[], prepare, block, text);
	};

	/**
	 * Write `plan` in the running command's transaction (a composed command's
	 * body writes its stages here): request the normalization of what its
	 * steps touch (read before the write), apply it, and show the blocks it
	 * moved. The caret's pending marks are a text insertion's at the caret,
	 * which consumes them; an atom inserted at the caret passes them to the
	 * caret after it. A refusal passes through.
	 * @internal
	 */
	write = (plan: Prepared): OpResult => {
		if (!('writes' in plan)) return plan;
		const { facade, idToBlock, selection } = this.edytor;
		const touched = plan.writes.flatMap((w) => this.#touched(w));
		const { caret, pending } = selection;
		const at = (op: 'insertText' | 'insertInline') =>
			!!pending &&
			!!caret &&
			plan.writes.some((w) => w.op === op && w.id === caret.block.id && w.offset === caret.offset);
		const [typed, atom] = [at('insertText'), at('insertInline')];
		const result = facade.apply(plan);
		for (const [id, hook] of touched) this.request(id, hook);
		if (typed) selection.stage(undefined);
		const after = atom ? caret!.block.textAtOffset(caret!.offset + 1) : null;
		const value = after ? selection.textValue(after.text, after.offset) : null;
		if (value?.kind === 'text') selection.select(Object.freeze({ ...value, pending }));
		for (const id of plan.effect.moves) {
			const block = idToBlock.get(id);
			if (block) reveal(block);
		}
		return result;
	};

	/** The normalization a step asks for: the blocks whose content it writes, the parents whose children it changes. */
	#touched(w: PlanStep): Pass[] {
		const { facade } = this.edytor;
		const parent = (id: BlockId) => facade.parentOf(id);
		const children = (...ids: (BlockId | null)[]): Pass[] =>
			ids.map((id) => [id ?? 'root', 'normalizeChildren']);
		if (w.op === 'insertBlocks')
			return [...children(w.parent), ...w.specs.map(({ id }): Pass => [id, 'normalizeContent'])];
		if (w.op === 'moveBlocks') return children(w.parent, ...w.ids.map(parent));
		if (w.op === 'deleteBlock') return children(parent(w.id));
		if (w.op === 'splitBlock')
			return [[w.id, 'normalizeContent'], ...children(w.parent, parent(w.id))];
		if (w.op === 'mergeBlocks') return [[w.into, 'normalizeContent'], ...children(parent(w.from))];
		if (w.op === 'setBlockType') return [[w.id, 'normalizeContent'], ...children(w.id)];
		if (w.op === 'patchData') return w.id === undefined ? [] : [[w.id, 'normalizeContent']];
		return [[w.id, 'normalizeContent']];
	}

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
	 * @internal Run `body` with the first operation it dispatches a step of
	 * its own, as a led one is, even inside a command: an input rule's
	 * replacement of the typed text alone, which no removal leads.
	 */
	alone = <T>(body: () => T): T => {
		this.#alone = true;
		try {
			return body();
		} finally {
			this.#alone = false;
		}
	};

	/** @internal The running user command's kind (`insertText`, `insertFromPaste`, …), `null` outside one. */
	get command(): string | null {
		return this.running ? this.kind : null;
	}

	/**
	 * A command's result caret: selected once and recorded on the result;
	 * the projector displays it after the flush. With `ops`, the
	 * caret is declared before the command's operations run — minted while its
	 * text is live, so it survives them — and written only when they applied;
	 * meanwhile the seam repair leaves this view's endpoints to it. Takes a
	 * text segment and an offset in it, or a `{ block, offset }` caret in
	 * block offsets (an inline atom counting 1).
	 */
	caret: {
		(text: Text | null | undefined, offset: number, ops?: () => OpResult): OpResult | undefined;
		(caret: Caret | DocPosition | null | undefined, ops?: () => OpResult): OpResult | undefined;
	} = (
		target: Text | Caret | DocPosition | null | undefined,
		...rest: [number, (() => OpResult)?] | [(() => OpResult)?]
	): OpResult | undefined => {
		// The form is the arguments', not the target's: a nullish caret still runs its `ops`.
		if (typeof rest[0] === 'number') {
			return this.#caret(target as Text | null | undefined, rest[0], rest[1]);
		}
		const ops = rest[0] as (() => OpResult) | undefined;
		const caret = target as Caret | DocPosition | null | undefined;
		// `{ block, offset }`: block offsets (a handle or an id), mapped to the text segment that shows the offset.
		const block =
			typeof caret?.block === 'string' ? this.edytor.idToBlock.get(caret.block) : caret?.block;
		const at = block?.textAtOffset(Math.max(0, caret!.offset));
		return this.#caret(at?.text, at?.offset ?? 0, ops);
	};

	#caret = (text: Text | null | undefined, offset: number, ops?: () => OpResult) => {
		const selection = this.edytor.selection;
		const at = text ? Math.max(0, Math.min(offset, text.length)) : 0;
		const value = text ? selection.textValue(text, at) : null;
		let out: OpResult | undefined;
		if (ops) {
			const outer = this.authoring;
			this.authoring = value;
			try {
				out = ops();
			} finally {
				this.authoring = outer;
			}
			if (out.status === 'refused') return out;
		}
		if (!text || !value || value.kind === 'none') return out;
		selection.select(value);
		// Declared before its operations: gone with them after all, the seam.
		if (!selection.projection.start) selection.restoreDeadSelectionEndpoints();
		if (this.#last) this.#last = { ...this.#last, selection: selection.value };
		return out;
	};

	/**
	 * Request a normalization pass of block `id` (deduped against the pending
	 * ones): it runs at the end of the command's transaction, inside it.
	 * @internal
	 */
	request = (id: string, normalize: Normalizer) => {
		const pending = this.queue.slice(this.current ? this.queue.indexOf(this.current) + 1 : 0);
		if (!pending.some(([i, n]) => i === id && n === normalize)) this.queue.push([id, normalize]);
	};

	/**
	 * Run the requested normalization at the end of the outermost transaction,
	 * inside it, also when the transaction's callback threw: its writes stay.
	 * A pass is the block's kind's normalizer, over handles that read the
	 * index, so it sees what the command (and the previous pass) wrote; the
	 * work it answers runs in the same transaction (its operations are
	 * steps), and the block is normalized again, at most {@link MAX_PASSES}
	 * times.
	 * @internal
	 */
	drain = () => {
		if (this.#draining) return;
		this.#draining = true;
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
							`edytor: ${normalize} on block "${id}" exceeded ${MAX_PASSES - 1} passes — a plugin normalizer is not converging; skipping further passes`
						);
					continue;
				}
				this.current = entry;
				this.active = true;
				try {
					const work = edytor.definitionOf(block.type)[normalize]?.({ block });
					if (work) {
						edytor.transact(work);
						this.request(id, normalize);
					}
				} finally {
					this.active = false;
				}
			}
		} finally {
			this.queue = [];
			this.current = null;
			this.#draining = false;
		}
	};

	/**
	 * The cut an operation applies as it writes. Inside a user command none
	 * (the command cut); outside one, its bare policy. A led operation is a
	 * conversion: its own step even inside one. None while a composition is
	 * live (its writes are one group).
	 */
	private policy(operation: string, led: boolean) {
		if (this.edytor.composition.live || this.untracked) return undefined;
		if (led) return 'before';
		return this.running ? undefined : this.decide(policyOf(operation));
	}

	/** A continuation continues this view's last step, or cuts before it writes. */
	private decide(policy: Policy) {
		if (policy !== 'continue') return policy;
		const { history, selection } = this.edytor;
		return history.continues(selection.value) ? undefined : 'before';
	}

	/** Record `operation` as refused; answers that result. */
	#refused(operation: string): CommandResult {
		return (this.#last = { operation, status: 'refused' });
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
	 * The planned steps as hooks see them: each as the operation it performs,
	 * with that operation's arguments (`ARGS`), about the block it writes
	 * (the root for the document's data). A step that is the command itself
	 * (same name, same block) is not repeated; a write into a block the plan
	 * creates is part of that creation.
	 */
	private steps(
		writes: readonly PlanStep[],
		creates: readonly BlockId[],
		command: Change
	): Change[] {
		const { idToBlock, root, facade } = this.edytor;
		const created = new Set(creates);
		const out: Change[] = [];
		for (const w of writes) {
			const keeps =
				w.op === 'deleteBlock' && facade.childrenIds(w.id).some((c) => !w.removes.includes(c));
			const args = (ARGS[w.op] as (w: PlanStep, keeps: boolean) => unknown[])(w, keeps);
			const target = subjectOf(args[0]);
			const block = target === null ? root : idToBlock.get(target);
			if ((target !== null && created.has(target)) || !block) continue;
			if (w.op === command.operation && block === command.block) continue;
			const text = typeof args[1] === 'number' ? block.textAtOffset(args[1])?.text : undefined;
			out.push({ operation: w.op, block, payload: args, ...(text && { text }) });
		}
		return out;
	}
}
