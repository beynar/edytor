/**
 * The virtual paragraph of an emptied document (`doc.empty.virtual`, the
 * 2026-09-28 contract; y-prosemirror's approach).
 *
 * While the document is ready and shows no block, the view reads it through
 * this lens: one empty block of the root's default type, local to the view
 * (id `v_…`, never written). Its cell renders it, a caret rests in it, a
 * seam lands in it, a peer's caret in its own virtual paragraph shows in this
 * one. The first edit in it — typing, an atom, paste, Enter, a block-kind
 * command — is prepared as the creation of a real block with that id and the
 * edit folded in: one plan, one transaction, one update. No replica writes a
 * block for having seen the document empty, and two replicas typing into
 * their own virtual paragraphs keep both lines. Everything else passes
 * through to the document; its JSON never shows the virtual paragraph.
 */
import type { BlockId, BlockSpec, DocChange, ProjectedBlock } from '../crdt/index.js';
import type { DocAnchor, DocFacade, EdytorDoc, Prepared } from '../crdt/edytor-doc.js';
import { placedEnd, type Flow, type FlowTarget } from '../crdt/flow.js';
import { bindNodes } from '../crdt/nodes.js';
import { applyPatch } from '../crdt/data.js';
import { REFUSED } from '../crdt/doc/plan.js';
import { id } from '../utils.js';
import { asBlockSpec } from '../utils/json.js';

/** A virtual paragraph's id (materialized blocks keep theirs): what a peer's caret names. */
export const isVirtualId = (value: string): boolean => value.startsWith('v_');

/** The document as a view reads it: `virtual()` names the shown virtual paragraph, if any. */
export type ViewDoc = DocFacade & { virtual: () => BlockId | null };

export const virtualLens = (
	base: DocFacade,
	/** The document decided its content (a pending document shows nothing). */
	ready: () => boolean,
	/** The root's default child type. */
	type: () => string,
	/** A kind's roles, for where a paste's caret ends (`placedEnd`). */
	roleOf: (kind: string) => { void: boolean; rendersContent: boolean }
): ViewDoc => {
	let vid = id('v');
	/** The document shows no block: the virtual paragraph is shown (a fresh id once the last one was written). */
	const active = (): boolean => {
		if (!ready() || base.childSlots(null).length > 0) return false;
		if (base.hasBlock(vid)) vid = id('v');
		return true;
	};
	const on = (block: BlockId | null | undefined) => block === vid && active();
	const projected = (): ProjectedBlock => ({ id: vid, type: type(), content: [], children: [] });
	const spec = (extra: Partial<BlockSpec> = {}): BlockSpec => ({ id: vid, type: type(), ...extra });

	// ── writes: the edit folded into the virtual paragraph's creation ─────
	const noop = (): Prepared => base.prepare.insertBlocks({ parent: null, index: 0 }, []);
	const at = (p: Prepared, block: BlockId, offset: number): Prepared =>
		'writes' in p ? { ...p, at: { block, offset } } : p;
	/** The blocks created at the root; the virtual paragraph answers last (a command reads the first). */
	const create = (specs: BlockSpec[]): Prepared => {
		const p = base.prepare.insertBlocks({ parent: null, index: 0 }, specs);
		if (!('writes' in p) || p.ids.length < 2) return p;
		const last = (ids: readonly BlockId[]) => [...ids.filter((i) => i !== vid), vid];
		return { ...p, ids: last(p.ids), effect: { ...p.effect, creates: last(p.effect.creates) } };
	};
	/**
	 * Lines of a flow as blocks; unless `whole`, the first one is the virtual
	 * paragraph. The caret ends the last one as the flow places it
	 * (`placedEnd`): its own line — a toggle's header, never its hidden body —
	 * or a list's last item, a code block's last line. Lines that end on no
	 * line (a divider) get an empty one of the root's kind after them to hold
	 * it, as a paste at the end of a line does (`flow.apart`).
	 */
	const flowInto = (flow: Flow, keep: boolean): Prepared => {
		const lines = flow.lines.map((l) => ({ ...l, type: l.type ?? type() }));
		if (lines.length === 0) return noop();
		const endOf = placedEnd(roleOf);
		if (!endOf(lines.at(-1)!)) lines.push({ id: id('b'), type: type() });
		if (keep) lines[0] = { ...lines[0]!, id: vid };
		const end = endOf(lines.at(-1)!)!;
		return at(create(lines), end.block, end.offset);
	};

	const prepare: EdytorDoc['prepare'] = Object.create(base.prepare);
	const over = <K extends keyof EdytorDoc['prepare']>(
		name: K,
		when: (...args: Parameters<EdytorDoc['prepare'][K]>) => Prepared | undefined
	) => {
		const own = base.prepare[name] as (...args: unknown[]) => Prepared;
		(prepare as Record<string, unknown>)[name] = (...args: Parameters<EdytorDoc['prepare'][K]>) =>
			when(...args) ?? own(...args);
	};
	/** An op naming a block first: on the virtual paragraph, `when` plans it from the other arguments. */
	type Rest<K extends keyof EdytorDoc['prepare']> =
		Parameters<EdytorDoc['prepare'][K]> extends [unknown, ...infer R] ? R : never;
	const onIt = <K extends keyof EdytorDoc['prepare']>(
		name: K,
		when: (...rest: Rest<K>) => Prepared
	) => {
		const plan = when as (...rest: unknown[]) => Prepared;
		over(name, (b: unknown, ...rest: unknown[]) => (on(b as BlockId) ? plan(...rest) : undefined));
	};
	onIt('insertText', (_o, text, marks) =>
		text ? create([spec({ content: [{ kind: 'text', text, marks }] })]) : noop()
	);
	onIt('insertInline', (_o, atom) => create([spec({ content: [{ kind: 'inline', ...atom }] })]));
	onIt('splitBlock', (_o, newId, tail) =>
		create([spec(), { id: newId, type: tail?.type ?? type(), data: tail?.data }])
	);
	onIt('setBlockType', (t) => create([spec({ type: t })]));
	onIt('setBlockData', (data) => create([spec({ data })]));
	onIt('patchData', (ops) => {
		const data = applyPatch({}, ops);
		return data ? create([spec({ data })]) : REFUSED;
	});
	onIt('setBlock', (value) =>
		create([spec({ ...value, type: value.type ?? type() } as Partial<BlockSpec>)])
	);
	over('insertBlocks', (dest, specs) => {
		if (specs.length > 0 && dest.parent === null && dest.index > 0 && active())
			return create([spec(), ...specs.map(asBlockSpec)]);
		return on(dest.parent) ? create([spec({ children: specs.map(asBlockSpec) })]) : undefined;
	});
	over('insertBlock', (dest, s) => prepare.insertBlocks(dest, [s]));
	over('insertFlow', (target: FlowTarget, flow: Flow) => {
		if ('replace' in target) return target.replace.some(on) ? flowInto(flow, false) : undefined;
		// At a slot beside or under it (a suggestion), the lines take its place.
		if ('slot' in target)
			return (target.slot.parent === null || on(target.slot.parent)) && active()
				? flowInto(flow, false)
				: undefined;
		return on(target.block) ? flowInto(flow, !flow.whole) : undefined;
	});
	for (const name of ['deleteRange', 'replaceRange'] as const)
		over(name, (from, to) => (on(from.block) || on(to.block) ? at(noop(), vid, 0) : undefined));
	for (const name of [
		'deleteText',
		'formatRange',
		'setMark',
		'unsetMark',
		'clearMarks',
		'removeInline',
		'setInlineData',
		'mergeBackward',
		'mergeForward',
		'deleteBlock'
	] as const)
		onIt(name, noop);
	over('deleteBlocks', (ids) =>
		ids.some(on) ? prepare.deleteBlocks(ids.filter((i) => !on(i))) : undefined
	);
	// A move, nest, outdent or duplicate of it is refused: the document holds no such block.

	const lens: ViewDoc = Object.create(base);
	const ops = Object.fromEntries(
		Object.keys(base.prepare).map((name) => [
			name,
			(...args: unknown[]) =>
				base.apply((prepare as Record<string, (...a: unknown[]) => Prepared>)[name]!(...args))
		])
	);
	let nodes: ReturnType<typeof bindNodes> | undefined;
	Object.assign(lens, ops, {
		prepare,
		virtual: () => (active() ? vid : null),
		block: (b: BlockId) => (nodes ??= bindNodes(lens)).block(b),
		// ── reads ────────────────────────────────────────────────────────
		// The document answers an id it does not hold as a block with no
		// parent, ancestors, neighbours, children, content, data items or
		// place to move to or merge with: those reads pass through.
		project: () => (active() ? { children: [projected()] } : base.project()),
		childrenIds: (p: BlockId | null) => (p === null && active() ? [vid] : base.childrenIds(p)),
		childSlots: (p: BlockId | null) =>
			p === null && active() ? [{ id: vid, rank: '' }] : base.childSlots(p),
		order: () => (active() ? [vid] : base.order()),
		slotOf: (b: BlockId) => (on(b) ? { parent: null, rank: '' } : base.slotOf(b)),
		positionOf: (b: BlockId) => (on(b) ? { parent: null, index: 0 } : base.positionOf(b)),
		pathOf: (b: BlockId) => (on(b) ? [0] : base.pathOf(b)),
		isVisibleBlock: (b: BlockId) => on(b) || base.isVisibleBlock(b),
		blockTypeOf: (b: BlockId) => (on(b) ? type() : base.blockTypeOf(b)),
		blockDataOf: (b: BlockId) => (on(b) ? {} : base.blockDataOf(b)),
		blockJSON: (b: BlockId) => (on(b) ? { id: vid, type: type(), data: {} } : base.blockJSON(b)),
		blockText: (b: BlockId) => (on(b) ? '' : base.blockText(b)),
		// Never computed (and cached) by the index for an id it does not hold.
		runs: (b: BlockId) => (on(b) ? [] : base.runs(b)),
		anchorAt: (b: BlockId, offset: number, affinity: 'left' | 'right' = 'left') =>
			on(b)
				? { b: vid, a: { i: null, a: affinity === 'left' ? -1 : 0 } }
				: base.anchorAt(b, offset, affinity),
		/** An unwritten virtual anchor (this view's, or a peer's) rests in the shown one. */
		resolveAnchor: (anchor: DocAnchor) =>
			base.resolveAnchor(anchor) ??
			(active() && anchor.a.i === null && isVirtualId(anchor.b)
				? { blockId: vid, offset: 0 }
				: null),
		onChange: (cb: (change: DocChange) => void) => {
			let shown = active() ? vid : null;
			return base.onChange((change) => {
				const now = active() ? vid : null;
				if (now === shown) return cb(change);
				const added = new Map(change.added);
				const removed = new Set(change.removed);
				const order = new Map(change.order);
				// Written or gone, the virtual cell is replaced: a written one re-enters from `added`.
				if (shown !== null) removed.add(shown);
				if (now !== null) {
					added.set(now, projected());
					order.set(null, [now]);
				}
				shown = now;
				cb({ ...change, added, removed, order });
			});
		}
	});
	return lens;
};
