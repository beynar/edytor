/**
 * The compare-to-truth observer (the divergence set): the only interpreter of DOM changes. After a
 * flush has written the host, a content whose text differs from its cell, a
 * strict container whose children differ from what the cells render, a
 * registered element that went missing, or an owned attribute that differs
 * from the table is browser or foreign input. Records carry no provenance:
 * they only name what to compare.
 *
 * - The render epoch (`epoch`, the one render epoch the projector also reads):
 *   every cell patch, `update()` (extension view state, re-display requests)
 *   and every pass that wrote the host itself.
 * - The records signal (`records`): the MutationObserver callback, an
 *   attempt closing; the passes run again.
 * - The owned-element registry: the block, text, mark and atom elements (and
 *   the render anchor) the core's attachments registered, each with its block;
 *   each content's last rendered text (with the anchor of a browser edit made
 *   on it while the model still equalled that render).
 * - The pre pass (root `$effect.pre`, before the flush's writes) inverts a
 *   record that removed registered elements (its added nodes go, its removed
 *   nodes return at their recorded siblings, before Svelte reconciles around
 *   them), and one that removed only the render's anchors from a block list
 *   when the editor did not write it (`dom.anchors.foreign`: the records taken
 *   from the pre pass to the end of a compare pass are the editor's own), and
 *   snapshots a content the flush re-renders whose DOM holds an edit the
 *   flush would overwrite.
 * - The compare pass (root `$effect`, after every DOM write of the flush)
 *   removes identity clones, nodes inside a content's run and the root's
 *   foreign children, heals owned attributes (bounded), and compares each
 *   named content with its cell: its text (fillers stripped, an atom one
 *   unit), then its partition and mark chain. A divergence is classified by
 *   location and expectation: text inside a content is adopted through the
 *   dispatcher (a snapshotted edit where its anchor resolves now) unless the
 *   composition tail, a pending structural key or a model-owned drift claims
 *   its host, which restores the cell; while a model-owned window is open,
 *   other divergence waits for it; structure restores the cell; the live
 *   composition host is the IME's; read-only divergence is inverted at the
 *   flip back. A kind's own markup around its slots is the kind's.
 */
import { tick, untrack } from 'svelte';
import type { DocAnchor } from '../crdt/index.js';
import type { Edytor } from '../edytor.svelte.js';
import type { Text } from '../text/text.svelte.js';
import type { InlineBlock } from '../block/inlineBlock.svelte.js';
import { diffText } from '../utils/diffText.js';
import { jsonEquals } from '../utils/json.js';
import { activeMarks, marksForInsertion } from '../session/editing/text.js';
import { INTENTS } from '../session/attempt.js';
import { runOccurrence } from '../events/onBeforeInput.js';
import { getDomSelectionSnapshot } from '../selection/domSelection.js';
import { domOffsetIn } from '../selection/selection.utils.js';
import { diverges, heal, ownText, ownedOf, type Kind, type Owned } from './attributes.js';
import { getTextContentOffsetAtPoint, textLeaves } from '../events/domTextOffset.js';
import { rendersMark, type Cell, type Patched, type Replaced } from './cells.js';

/**
 * What a text divergence asks for: adopted (`attempt`: claimed by the
 * browser-owned attempt on its host), the cell restored, or compared again
 * once a model-owned attempt's window closed.
 */
type Verdict = 'adopt' | 'attempt' | 'invert' | 'defer';
/** Where an adopted edit lands: the block and offset its anchor resolves to now. */
type Place = { block: string; at: number; remove: number; insert: string };
/**
 * A registered element; `owned`: the attributes its render owns (a block's,
 * `Block.svelte`); `handle`: the text or atom it renders (the one node → handle map).
 */
type Entry = {
	kind: Kind;
	block: string;
	name?: string;
	owned?: () => Owned;
	handle?: Text | InlineBlock;
};
/** A content's last rendered text, and the browser edit seen on it while the model equalled it. */
type Base = { text: string; edit: { dom: string; anchor: DocAnchor | null } | null };
/**
 * A record that removed registered elements or the render's anchors: what it
 * removed and added, and where; `foreign`: the editor did not write it (taken
 * outside its own writes, `#own`).
 */
type Removal = {
	parent: Node;
	nodes: Node[];
	added: Node[];
	next: Node | null;
	prev: Node | null;
	foreign: boolean;
};
type Replacement = { nodes: Node[]; value: string; caret: number | undefined };

/** The empty filler (and the trailing newline's marker). */
const ZWSP = '\u200B';
const ATOM = '\uFFFC';
/** Attributes that claim a core element's identity: never on an unregistered element. */
const IDENTITY_ATTRIBUTES = [
	'data-edytor-id',
	'data-edytor-text',
	'data-edytor-block',
	'data-edytor-inline-block',
	'data-edytor-mark'
];
const IDENTITY = IDENTITY_ATTRIBUTES.map((name) => `[${name}]`).join(',');
/** View-only content the core renders in the host: an `end` ghost text, a block suggestion's preview. */
const SUGGESTION = '[data-edytor-text-suggestion], [data-edytor-suggestion]';
/** The rest a live composition merged into its host, rendered after it (`pin.rest`). */
const REST = '[data-edytor-composition-rest]';
/** A foreign writer that re-damages every heal: the heals stop for a window (Quill's bound). */
const BOUND = 100;
const WINDOW_MS = 250;

/** The text a cell renders: characters, an atom one unit, fillers stripped. */
const textOf = (cell: Cell) => ownText(cell.runs, ATOM).replaceAll(ZWSP, '');

/** Svelte's anchors: comments and empty text nodes are never input and never removed. */
const isAnchor = (node: Node) =>
	node.nodeType === Node.COMMENT_NODE || (node.nodeType === Node.TEXT_NODE && !node.nodeValue);

/**
 * What the browser shows for `text`: its element's text nodes in order (WebKit's
 * converted-space wrappers read as plain spaces), the empty filler and the
 * trailing-newline marker stripped.
 */
export const readDomText = (text: Text) => {
	let value = '';
	for (const leaf of text.node ? textLeaves(text.node) : [])
		value += leaf.parentElement?.closest('span.Apple-converted-space')
			? leaf.data.replaceAll('\u00A0', ' ')
			: leaf.data;
	// An empty text's filler shares its node with what the browser typed, on either side.
	if (text.isEmpty) return value.replaceAll(ZWSP, '');
	return text.endsWithNewline && value.endsWith(ZWSP) ? value.slice(0, -1) : value;
};

export const getCollapsedDomTextSelection = (edytor: Edytor) => {
	const selection = getDomSelectionSnapshot(edytor.node);
	const node = selection?.isCollapsed ? selection.anchorNode : null;
	const text = node && edytor.node?.contains(node) ? edytor.selection.getTextOfNode(node) : null;
	// No model rule here: the DOM caret is read BEFORE the reconcile writes
	// the model, so a native insertion legitimately sits past `text.length`
	// (`selectText` clamps the final write).
	return text?.node ? { text, offset: domOffsetIn(text, node!, selection!.anchorOffset) } : null;
};

/** A native line break (a diff inserting only newlines at `at`) runs as the key's occurrence. */
export const lineBreak = async (edytor: Edytor, text: Text, value: string, at: number) => {
	if (!text.isInDocument) return;
	const inputType =
		edytor.attempts.confirm()?.inputType === 'insertLineBreak' || value.includes('\n')
			? 'insertLineBreak'
			: 'insertParagraph';
	text.refreshFromModel();
	edytor.selection.selectText(text, at);
	await runOccurrence(edytor, { inputType, cancelable: false });
};

const settle = (promises: Promise<unknown>[]) => Promise.all(promises).then(() => undefined);

/** The collapsed DOM caret's text offset inside `nodes` (a replacement's), if it is there. */
const caretIn = (nodes: Node[]) => {
	const selection = nodes[0].ownerDocument?.getSelection();
	let offset = 0;
	if (selection?.isCollapsed)
		for (const node of nodes) {
			if (node.contains(selection.anchorNode))
				return (
					offset + getTextContentOffsetAtPoint(node, selection.anchorNode!, selection.anchorOffset)
				);
			offset += node.textContent!.length;
		}
};

export class SurfaceObserver {
	/** The render epoch (one owner): cell patches, view state, re-display requests. */
	epoch = $state(0);
	/** The records signal: the MutationObserver named elements to compare. */
	records = $state(0);
	#mo: MutationObserver | null = null;
	#registry = new Map<Node, Entry>();
	#contents = new Map<string, Set<Element>>();
	#blocks = new Map<string, Element>();
	/** Contents to compare (`null`: the root's children). */
	#dirty = new Set<string | null>();
	/** Attribute records, kept while their element diverges from the table. */
	#attributes = new Set<MutationRecord>();
	#added = new Set<Node>();
	/**
	 * Nodes put into the root since its last check (records whose target is the
	 * root; its children at attach): the strict root checks these, never every
	 * child — a block added or moved costs the same on a long page.
	 */
	#rooted = new Set<Node>();
	#removed: Removal[] = [];
	/** A text element the browser replaced with its own nodes: their text is the edit. */
	#replaced = new Map<Node, Replacement>();
	/** A restored text element's replacement: its text is the element's DOM text until adopted. */
	#replacements = new Map<Node, Replacement>();
	/** Contents patched since the last pass: their DOM shows an older cell. */
	#patched = new Set<string>();
	/** Of those, the ones a commit re-rendered (a remount discards its DOM: never snapshotted). */
	#rerendered = new Set<string>();
	#bases = new Map<string, Base>();
	/** A snapshotted edit: where it lands, or the verdict an expectation gave it. */
	#snapshots = new Map<string, Place | Verdict>();
	/** Divergence a model-owned attempt's drift window may still repair: compared once it closed. */
	#waiting = new Set<string>();
	/** Divergence seen while read-only: inverted at the flip back. */
	#readonly = new Set<string | null>();
	#host: string | null = null;
	#heals = 0;
	/** The pass wrote the host itself: a render (the projector displays after it). */
	#wrote = false;
	/** Records arrived since the last pass (the projector reads what they did: `rendered`). */
	#fresh = false;
	/** The flush writes the host: from the pre pass to the end of its compare pass. */
	#rendering = false;
	/** Passes under way (a pass's own repairs; an adoption's synchronous flush nests one). */
	#passes = 0;
	#window?: ReturnType<typeof setTimeout>;

	constructor(private edytor: Edytor) {}

	/** Observe `root` (the host): records name what to compare. */
	attach = (root: HTMLElement) => {
		const mo = (this.#mo = new MutationObserver((records) => {
			this.#take(records);
			this.signal();
		}));
		for (const child of root.childNodes) this.#rooted.add(child);
		this.#rendering = false;
		mo.observe(root, { attributes: true, characterData: true, childList: true, subtree: true });
		return () => {
			mo.disconnect();
			clearTimeout(this.#window);
		};
	};

	/**
	 * Register an element the core rendered (an attachment); returns its
	 * release. A text element takes the table's attributes now (its id, its
	 * editing host inside a void).
	 */
	register = (
		node: Element,
		kind: Kind,
		block: string,
		name?: string,
		owned?: () => Owned,
		handle?: Text | InlineBlock
	) => {
		const entry = { kind, block, name, owned, handle };
		this.#registry.set(node, entry);
		if (kind === 'text') heal(node as HTMLElement, ownedOf(this.edytor, node, entry)!);
		if (kind === 'block') this.#blocks.set(block, node);
		else if (kind !== 'anchor' && kind !== 'preview') {
			const set = this.#contents.get(block) ?? new Set();
			this.#contents.set(block, set.add(node));
		}
		return () => {
			if (this.#registry.get(node)?.block !== block) return;
			this.#registry.delete(node);
			if (this.#blocks.get(block) === node) this.#blocks.delete(block);
			this.#contents.get(block)?.delete(node);
		};
	};

	/**
	 * A view-only element the core renders in the host, never compared: the
	 * render anchor (`Edytor.svelte`, a registered child of the strict root),
	 * or with its suggestion's `id`, a preview group (`components/Suggestion`).
	 */
	own = (node: HTMLElement, id?: string) => ({
		destroy: this.register(node, id ? 'preview' : 'anchor', id ?? '')
	});

	/** Extension view state rendered into the host, or a re-display request: an epoch bump. */
	update = () => void this.epoch++;

	/** Cells patched by a commit: the contents the flush re-renders (`before`: what the DOM shows). */
	patched = (ids: Patched, before: Replaced) => {
		for (const id of ids) {
			this.#dirty.add(id);
			if (id !== null) this.#patched.add(id);
		}
		for (const [id, cell] of before) {
			this.#rerendered.add(id);
			if (!this.#bases.has(id)) this.#bases.set(id, { text: textOf(cell), edit: null });
		}
		this.epoch++;
	};

	/** The records signal: the passes run again. */
	signal = () => void this.records++;

	/** Records the observer has not compared yet: the DOM may differ from what the cells rendered. */
	pending = () => {
		if (this.#take()) this.signal();
		return this.#dirty.size > 0 || this.#removed.length > 0;
	};

	/**
	 * Compare and act now (an `input` event, a composition's end, a context
	 * menu): the contents the last flush rendered, not those waiting for one.
	 */
	flush = (): Promise<void> => {
		this.#take();
		return settle(this.#pass(false));
	};

	pre = () => {
		this.#deps();
		untrack(() => {
			this.#take();
			if (!this.edytor.readonly) this.#restore();
			this.#snapshot();
			// From here to the end of the compare pass, what the host records is the flush's.
			this.#rendering = true;
		});
	};

	post = () => {
		this.#deps();
		untrack(() => {
			void this.#pass(true);
			this.#rendering = false;
		});
	};

	#deps = () => {
		const { edytor } = this;
		void [this.epoch, this.records, edytor.readonly, edytor.composition.phase];
		void [edytor.selection.value, edytor.suggestions.revision];
	};

	/**
	 * Take `records` (the callback's; else the queue's): each names elements to
	 * compare. The editor writes the host now: the flush (from the pre pass to
	 * the end of its compare pass) or a pass's own repairs. A record taken then
	 * is the render's (`dom.anchors.foreign`); every other one is the browser's,
	 * a page script's or an extension's.
	 */
	#take = (records = this.#mo?.takeRecords() ?? []) => {
		const own = this.#rendering || this.#passes > 0;
		for (const record of records) this.#intake(record, own);
		return records.length > 0;
	};

	/** The closest registered element holding `node` in the host: its entry (`null`: the host). */
	#near = (node: Node | null): Entry | null | undefined => {
		for (let at = node; at; at = at.parentNode) {
			if (at === this.edytor.node) return null;
			const entry = this.#registry.get(at);
			if (entry) return entry;
		}
	};

	/**
	 * The block an element belongs to: its closest registered element's
	 * (`null`: the root; `undefined`: a preview, the view's own render, or
	 * outside the host).
	 */
	#owner = (node: Node): string | null | undefined => {
		const entry = this.#near(node);
		return (
			entry && (entry.kind === 'preview' ? undefined : entry.kind === 'anchor' ? null : entry.block)
		);
	};

	/** The handle a registered element of `kind` renders (`null`: another element). */
	handleOf = <K extends 'text' | 'atom'>(element: Node | null | undefined, kind: K) => {
		const entry = element && this.#registry.get(element);
		return (entry?.kind === kind ? entry.handle : null) as
			| (K extends 'text' ? Text : InlineBlock)
			| null;
	};

	/** The block `node` is in (its closest registered element's), none in a preview or outside the host. */
	blockOf = (node: Node | null) => {
		const id = node && this.#owner(node);
		return id ? (this.edytor.idToBlock.get(id) ?? null) : null;
	};

	/** `node` is, or holds, an element the core still renders. */
	#holds = (node: Node) =>
		this.#registry.has(node) ||
		(node instanceof Element &&
			[...node.querySelectorAll('*')].some((child) => this.#registry.has(child)));

	/** A record names elements to compare (never a verdict); `own`: the editor wrote it. */
	#intake = (record: MutationRecord, own: boolean) => {
		this.#fresh = true;
		const id = this.#owner(record.target);
		if (id === undefined) return;
		this.#dirty.add(id);
		if (id) this.#seen(id);
		const { type, target: parent, nextSibling: next, previousSibling: prev } = record;
		if (type === 'attributes') this.#attributes.add(record);
		if (type !== 'childList') return;
		const added = [...record.addedNodes];
		for (const node of added) {
			this.#added.add(node);
			if (parent === this.edytor.node) this.#rooted.add(node);
		}
		const nodes = [...record.removedNodes];
		if (!nodes.some((node) => isAnchor(node) || this.#holds(node))) return;
		this.#removed.push({ parent, nodes, added, next, prev, foreign: !own });
		// Wrapper replacement: the browser replaced a text element with its own nodes.
		const value = added.map((node) => node.textContent).join('');
		if (
			nodes.length === 1 &&
			this.#registry.get(nodes[0])?.kind === 'text' &&
			value &&
			!added.some((node) => this.#holds(node) || node.nodeName === 'BR')
		)
			this.#replaced.set(nodes[0], { nodes: added, value, caret: caretIn(added) });
	};

	/**
	 * Records name a content while the model still equals its render (no patch
	 * since the last pass): that render is its base, and a browser edit on it
	 * gets an anchor at its position, minted now.
	 */
	#seen = (id: string) => {
		const cell = this.edytor.cells?.get(id);
		if (!cell || this.#patched.has(id)) return;
		const text = textOf(cell);
		let base = this.#bases.get(id);
		if (base?.text !== text) this.#bases.set(id, (base = { text, edit: null }));
		const dom = this.#read(id)?.text;
		if (dom === undefined || dom === text || base.edit?.dom === dom) return;
		const at = diffText(text, dom)!.at;
		base.edit = {
			dom,
			anchor: this.edytor.facade.anchorAt(id, at, at < text.length ? 'right' : 'left')
		};
	};

	/**
	 * A record that removed registered elements is inverted whole (newest
	 * first): the nodes it added go, the nodes it removed return in order at
	 * their recorded siblings — Svelte's anchors with them, also when the
	 * browser removed them one record each (Firefox): an anchor-only record is
	 * inverted in a parent that gets a registered element back, else the
	 * element's recorded siblings are gone and it lands outside Svelte's block.
	 * A foreign range across blocks (`dom.anchors.foreign`: a script's
	 * `Range.deleteContents()`) takes the render's anchors between the blocks
	 * from their list (the root, a block's children) and those after its start
	 * and before its end inside the blocks it enters, and leaves the elements:
	 * Svelte's next removal of either block would start at a detached anchor
	 * and leave its element, a child added to one would find no anchor to
	 * render before. When a foreign record took anchors from a block list,
	 * every foreign anchor-only record of the batch is inverted. The render's
	 * own removals (an item leaving the list) are never undone.
	 */
	#restore = () => {
		const root = this.edytor.node;
		const removals = this.#removed.splice(0).reverse();
		const held = ({ parent, nodes }: Removal) =>
			nodes.some((node) => node.parentNode !== parent && this.#holds(node));
		// A foreign record took only the render's anchors, and they are gone from
		// the page (not moved): they can return beside a recorded sibling still
		// there (never at the parent's end).
		const lost = ({ parent, nodes, next, prev, foreign }: Removal) =>
			foreign &&
			nodes.every((node) => isAnchor(node) && !node.isConnected) &&
			(next?.parentNode === parent || prev?.parentNode === parent);
		const parents = new Set(removals.filter(held).map(({ parent }) => parent));
		// Took anchors from a block list: the root, or a parent of block elements (a block's children).
		const crossed = removals.some(
			(removal) =>
				lost(removal) &&
				(removal.parent === root ||
					[...removal.parent.childNodes].some(
						(child) => this.#registry.get(child)?.kind === 'block'
					))
		);
		for (const removal of removals) {
			const { parent, nodes, added, next, prev } = removal;
			if (!root?.contains(parent)) continue;
			const anchors = parents.has(parent) && nodes.every(isAnchor);
			if (!held(removal) && !anchors && !(crossed && lost(removal))) continue;
			// A browser-owned attempt's host: its change is adopted whatever the
			// browser did to its structure, which the re-render then restores.
			const near = this.#near(parent);
			if (near?.kind === 'text' && this.edytor.attempts.on(near.handle as Text)) continue;
			for (const node of added)
				if (node.parentNode === parent && !this.#holds(node)) parent.removeChild(node);
			const before =
				next?.parentNode === parent ? next : prev?.parentNode === parent ? prev.nextSibling : null;
			for (const node of nodes) {
				if (node.parentNode !== parent) parent.insertBefore(node, before);
				// The replacement's text is the browser's edit: adopted into the element's text.
				const replaced = this.#replaced.get(node);
				if (replaced) this.#replacements.set(node, replaced);
			}
			this.#wrote = true;
		}
		this.#replaced.clear();
	};

	/** Only a content this flush re-renders can lose an edit to its writes: snapshot it. */
	#snapshot = () => {
		const { edytor } = this;
		if (edytor.readonly) return;
		for (const id of this.#rerendered) {
			const base = this.#bases.get(id);
			const read = base && id !== this.#host && this.#read(id);
			const cell = edytor.cells?.get(id);
			if (!read || !cell || read.text === base.text || read.text === textOf(cell)) continue;
			const dom = read.text;
			// An expectation claims the edit, or it is placed through the anchor minted at it.
			const verdict = this.#divergence(id);
			// An edit the window defers is drift: the flush's render restores the cell.
			if (verdict !== 'adopt') {
				this.#snapshots.set(id, verdict === 'defer' ? 'invert' : verdict);
				continue;
			}
			// Where it lands now: through the anchor minted at it (it follows its text
			// through a re-key, split, move or retype), else rebased within the block
			// over the model's own change (three-way prefix/suffix).
			const change = diffText(base.text, dom)!;
			const to =
				base.edit?.dom === dom && base.edit.anchor && edytor.facade.resolveAnchor(base.edit.anchor);
			const model = !to && diffText(base.text, textOf(cell));
			const at = to
				? to.offset
				: change.at +
					(model && model.at + model.remove <= change.at ? model.insert.length - model.remove : 0);
			this.#snapshots.set(id, { ...change, block: to ? to.blockId : id, at });
		}
	};

	/** The live composition host's block. */
	#live = () => {
		const { composition } = this.edytor;
		return composition.live ? (composition.host?.parent.id ?? null) : null;
	};

	/**
	 * One pass: structure, attributes, then each named content against its
	 * cell. `flushed`: the flush rendered every patched content (the root
	 * `$effect`); otherwise contents waiting for a flush are left to it.
	 */
	#pass = (flushed: boolean): Promise<unknown>[] => {
		this.#passes++;
		try {
			return this.#compare(flushed);
		} finally {
			// What the flush and this pass wrote: the render's records, compared
			// at the next pass (as the observer's callback would have them).
			if (this.#take()) queueMicrotask(this.signal);
			this.#passes--;
		}
	};

	#compare = (flushed: boolean): Promise<unknown>[] => {
		const { edytor } = this;
		const cells = edytor.cells;
		const work: Promise<unknown>[] = [];
		if (!cells || !edytor.node?.isConnected || edytor.destroyed) return work;
		const live = this.#live();
		// The hand-back: the IME host returns to the compare pass at the session's end.
		if (this.#host !== live) {
			if (this.#host) this.#dirty.add(this.#host);
			this.#host = live;
		}
		this.#heal();
		if (edytor.readonly) {
			// The root is checked at the flip back (its strict check finds what diverged).
			for (const id of this.#dirty) if (id === null || this.#diverges(id)) this.#readonly.add(id);
			this.#dirty.clear();
		} else {
			// The flip back: what diverged while read-only is compared again; and
			// what waited for a model-owned attempt's drift window, once it closed.
			for (const id of this.#readonly) this.#dirty.add(id);
			if (!edytor.attempts.busy) {
				for (const id of this.#waiting) this.#dirty.add(id);
				this.#waiting.clear();
			}
			this.#restore();
			this.#clones();
			const dirty = [...this.#dirty].filter(
				(id) => flushed || id === null || !this.#patched.has(id)
			);
			for (const id of dirty) this.#dirty.delete(id);
			if (flushed) {
				this.#patched.clear();
				this.#rerendered.clear();
			}
			for (const id of dirty) {
				if (id === null) this.#strictRoot();
				// A content this pass's own adoption re-rendered waits for that flush.
				else if (!this.#patched.has(id)) work.push(...this.#resolve(id, cells.get(id)));
			}
			this.#readonly.clear();
			if (this.#fresh) {
				this.#fresh = false;
				void settle(work).then(edytor.projector.rendered);
			}
		}
		if (this.#wrote) {
			this.#wrote = false;
			this.update();
		}
		return work;
	};

	/** A content differs from its cell (text, structure or a missing element). */
	#diverges = (id: string, dom = id !== this.#host && this.#read(id)) => {
		const cell = this.edytor.cells?.get(id);
		return !!(cell && dom && (dom.broken || dom.text !== textOf(cell) || this.#shape(id)));
	};

	/** One content against its cell, and what that asks for. */
	#resolve = (id: string, cell: Cell | undefined): Promise<unknown>[] => {
		const snapshot = this.#snapshots.get(id);
		this.#snapshots.delete(id);
		if (!cell) this.#bases.delete(id);
		const dom = cell && id !== this.#host && this.#read(id);
		if (!dom) return [];
		// What the DOM shows once this pass acted: the base of the next edit.
		this.#bases.set(id, { text: dom.text, edit: null });
		if (snapshot) {
			// Compared again at the next pass, once the edit is resolved.
			this.#dirty.add(id);
			if (typeof snapshot === 'object') return [this.#adoptAt(snapshot)];
			if (snapshot === 'invert') this.#invert(id);
			return [];
		}
		const replaced = this.#texts(id).some((text) => this.#replacements.has(text.node!));
		// Broken, read-only or equal text: the cell is restored when it differs.
		if (dom.broken || this.#readonly.has(id) || (dom.text === textOf(cell) && !replaced)) {
			if (this.#diverges(id, dom)) this.#invert(id);
			return [];
		}
		const verdict = this.#divergence(id);
		if (verdict === 'defer') this.#waiting.add(id);
		else if (verdict === 'invert') this.#invert(id);
		else return this.#adoptContent(id);
		return [];
	};

	/**
	 * A text divergence: an expectation on its host claims it (the composition
	 * tail, a pending structural key and a model-owned drift invert; a
	 * browser-owned attempt adopts); otherwise text inside a content is adopted.
	 */
	#divergence = (id: string): Verdict => {
		const { attempts, composition } = this.edytor;
		// The composition's tail; a composition with no target writes nothing: what its
		// IME wrote is drift; a structural key waiting for its `beforeinput` or
		// deadline owns the drift it causes.
		if (composition.tail()?.parent.id === id || composition.targetless || attempts.key)
			return 'invert';
		for (const text of this.#texts(id)) {
			if (attempts.on(text)) return 'attempt';
			if (attempts.drifting(text)) return 'invert';
		}
		// A model-owned attempt's window is open: its drift may land around its host (a merge target).
		return attempts.busy ? 'defer' : 'adopt';
	};

	/**
	 * Restore the current cell (never the IME's host): the exact text when the
	 * content's structure is the render's (its elements and the caret's node
	 * survive; the projector displays again), else a remount of its text elements.
	 */
	#invert = (id: string) => {
		if (id === this.#live()) return;
		if (this.#shape(id, true)) this.edytor.cells?.remount(id);
		else this.update();
	};

	/**
	 * Adopt the browser's text of each text element of `id` (one command each,
	 * through the dispatcher); a native line break runs as its occurrence. A
	 * content whose structure the browser also changed is then re-rendered.
	 */
	#adoptContent = (id: string): Promise<unknown>[] => {
		const { edytor } = this;
		let broken = this.#shape(id);
		const caret = getCollapsedDomTextSelection(edytor);
		const work: Promise<unknown>[] = [];
		for (const text of this.#texts(id)) {
			const replaced = this.#replacements.get(text.node!);
			this.#replacements.delete(text.node!);
			const dom = replaced ? replaced.value : readDomText(text);
			if (dom === text.stringContent) continue;
			broken ||= !!replaced;
			const line = diffText(text.stringContent, dom);
			work.push(
				line && !line.remove && /^[\r\n]+$/.test(line.insert)
					? lineBreak(edytor, text, dom, line.at)
					: adopt(
							edytor,
							text,
							dom,
							replaced ? replaced.caret : caret?.text === text ? caret.offset : undefined
						)
			);
		}
		if (broken) this.#invert(id);
		return work;
	};

	/** A snapshotted edit, placed where its anchor resolves now. */
	#adoptAt = ({ block, at, remove, insert }: Place) => {
		const text = this.#texts(block).find(
			(text) => text.segStart <= at && at + remove <= text.segStart + text.length
		);
		if (!text) return Promise.resolve();
		const local = at - text.segStart;
		const now = text.stringContent;
		const value = now.slice(0, local) + insert + now.slice(local + remove);
		return adopt(this.edytor, text, value, undefined, local + insert.length);
	};

	#texts = (id: string): Text[] =>
		[...(this.#contents.get(id) ?? [])].flatMap((element) => this.handleOf(element, 'text') ?? []);

	/** A content's DOM: its registered text and atom elements in order; null when not shown. */
	#read = (id: string): { text: string; broken: boolean } | null => {
		const elements = [...(this.#contents.get(id) ?? [])];
		if (!elements.length) return null;
		elements.sort((a, b) =>
			a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
		);
		const host = this.#blocks.get(id);
		let text = '';
		let broken = !!host && !host.isConnected;
		for (const element of elements) {
			const entry = this.#registry.get(element);
			// A mark is inside its text element: its presence is the shape check's.
			if (entry?.kind === 'mark') continue;
			broken ||= !element.isConnected || (!!host && !host.contains(element));
			if (entry?.kind === 'atom') text += ATOM;
			else if (entry?.kind === 'text')
				text += readDomText(entry.handle as Text).replaceAll(ZWSP, '');
		}
		return { text, broken };
	};

	/**
	 * Equal text, compared structurally: each text element (a strict
	 * container) holds one node per render delta (the empty filler's one) — a
	 * text node, or a registered mark element whose registered marks follow
	 * the delta's chain and that renders one text node. Svelte's anchors and
	 * the newline marker stand for none. Answers whether it differs; `write`:
	 * a content that does not gets each delta's text back in its node.
	 */
	#shape = (id: string, write?: boolean): boolean => {
		const { edytor } = this;
		const writes: [CharacterData, string][] = [];
		for (const text of this.#texts(id)) {
			const element = text.node;
			if (!element) continue;
			const deltas = edytor.deltasOf(text);
			const shown = deltas.length ? deltas : [{ text: ZWSP, marks: [] }];
			const nodes = [...element.childNodes].filter(
				(node) =>
					!isAnchor(node) &&
					!(node instanceof Element && node.hasAttribute('data-edytor-trailing-newline'))
			);
			if (nodes.length !== shown.length) return true;
			for (const [i, delta] of shown.entries()) {
				const node = nodes[i] as Element;
				let leaf = node as unknown as CharacterData;
				const chain = delta.marks
					.map(([name]) => name)
					.filter((name) => rendersMark(edytor.marks, name));
				if (chain.length) {
					if (!this.#registry.has(node)) return true;
					const marks = [node, ...node.querySelectorAll('[data-edytor-mark]')]
						.map((el) => this.#registry.get(el)?.name)
						.filter(Boolean);
					const leaves = textLeaves(node).filter((leaf) => leaf.data);
					// The snippet's markup is its own, but the delta renders one text node.
					if (marks.join() !== chain.join() || leaves.length !== 1) return true;
					leaf = leaves[0];
				} else if (node.nodeType !== Node.TEXT_NODE) return true;
				if (leaf.data !== delta.text) writes.push([leaf, delta.text]);
			}
		}
		if (write) for (const [leaf, value] of writes) leaf.data = value;
		return false;
	};

	/**
	 * The root is a strict container: a child it does not render is removed.
	 * Only a node a record put there can be one (`#rooted`).
	 */
	#strictRoot = () => {
		const node = this.edytor.node!;
		for (const child of this.#rooted)
			if (child.parentNode === node && !isAnchor(child) && !this.#registry.has(child)) {
				node.removeChild(child);
				this.#wrote = true;
			}
		this.#rooted.clear();
	};

	/**
	 * Added nodes the core does not render where it renders: an unregistered
	 * element claiming a core identity (a clone, removed with its added root),
	 * and a node inside a content's run between two of its registered elements
	 * (the run is the core's; the kind's markup around it is the kind's).
	 * A live composition's rest element is the core's own (`pin.rest`).
	 */
	#clones = () => {
		const root = this.edytor.node!;
		for (const node of this.#added) {
			if (!root.contains(node) || isAnchor(node) || this.#holds(node)) continue;
			if (node instanceof Element && node.matches(REST)) continue;
			const clone =
				node instanceof Element &&
				[node, ...node.querySelectorAll(IDENTITY)].some(
					(element) =>
						element.matches(IDENTITY) &&
						!this.#registry.has(element) &&
						!element.closest(SUGGESTION) &&
						this.#claims(element)
				);
			if (!clone && !this.#inRun(node)) continue;
			(node as ChildNode).remove();
			this.#wrote = true;
		}
		this.#added.clear();
	};

	/** `node` sits between two registered text or atom elements of one content. */
	#inRun = (node: Node) => {
		const side = (step: 'previousSibling' | 'nextSibling') => {
			for (let at = node[step]; at; at = at[step]) {
				const entry = this.#registry.get(at);
				if (entry) return entry.kind === 'text' || entry.kind === 'atom' ? entry.block : null;
			}
			return null;
		};
		const before = side('previousSibling');
		return before !== null && before === side('nextSibling');
	};

	/** A `data-edytor-mark` naming no declared mark claims nothing: its element is foreign input. */
	#claims = (element: Element) =>
		element.hasAttribute('data-edytor') ||
		IDENTITY_ATTRIBUTES.some(
			(name) =>
				element.hasAttribute(name) &&
				(name !== 'data-edytor-mark' || this.edytor.marks.has(element.getAttribute(name)!))
		);

	/**
	 * Owned attributes against the table (read-only views included); an
	 * identity attribute on an unregistered element is stripped; damage on a
	 * mark element re-renders its content. Bounded against a foreign writer
	 * that re-damages every heal.
	 */
	#heal = () => {
		const { edytor } = this;
		for (const record of this.#attributes) {
			const element = record.target;
			if (!(element instanceof HTMLElement) || !element.isConnected) {
				this.#attributes.delete(record);
				continue;
			}
			const entry = this.#registry.get(element);
			const owner = this.#owner(element);
			if (owner && owner === this.#host) continue;
			if (this.#heals > BOUND) break;
			this.#attributes.delete(record);
			const name = record.attributeName!;
			const table = ownedOf(edytor, element, entry);
			// A mark element's own attributes are its render: damage there re-renders the content.
			if (entry?.kind === 'mark') {
				if (table && owner && diverges(element, table)) edytor.cells?.remount(owner);
			} else if (table) {
				if (diverges(element, table) && heal(element, table)) {
					this.#counted();
					if (element === edytor.node) this.#refocus();
				}
			} else if (
				IDENTITY_ATTRIBUTES.includes(name) &&
				element.hasAttribute(name) &&
				!element.closest(SUGGESTION)
			) {
				element.removeAttribute(name);
				this.#counted();
			}
		}
	};

	/**
	 * A heal of the root (a foreign `contenteditable` removal blurs it): the
	 * projector displays the current value again, now and — the engine drops
	 * the range a task after the blur — once more on the next task, unless the
	 * last gesture landed outside the editor or any gesture came since (the
	 * selection is the user's: a deferred display checks the gesture serial).
	 */
	#refocus = () => {
		const { edytor } = this;
		const serial = edytor.intentSerial;
		const again = () => {
			if (edytor.lastUserGestureOutsideEditor || edytor.destroyed) return false;
			edytor.selection.display();
			return true;
		};
		if (again())
			setTimeout(() => {
				if (
					edytor.intentSerial === serial &&
					!edytor.node?.ownerDocument.getSelection()?.rangeCount
				)
					again();
			});
	};

	#counted = () => {
		this.#wrote = true;
		if (++this.#heals === 1)
			this.#window = setTimeout(() => {
				this.#heals = 0;
				if (this.#attributes.size) this.signal();
			}, WINDOW_MS);
	};
}

/** The rendered marks (a tag or a snippet) the browser shows at `at` of `text`: the element chain of its node there. */
const shownMarks = (text: Text, at: number) => {
	const element = text.node;
	let offset = 0;
	const node =
		element &&
		textLeaves(element).find((leaf) => (offset += leaf.data.replaceAll(ZWSP, '').length) > at);
	if (!node) return null;
	const names: string[] = [];
	for (let el = node.parentElement; el && el !== element; el = el.parentElement) {
		const name = el.getAttribute('data-edytor-mark');
		if (name) names.push(name);
	}
	return names.sort().join();
};

/** The rendered marks the model gives the character at `at` of `text`. */
const modelMarks = (edytor: Edytor, text: Text, at: number) =>
	Object.keys(activeMarks(text.getMarksAtRange(at, at + 1)[0]?.marks))
		.filter((name) => rendersMark(edytor.marks, name))
		.sort()
		.join();

/**
 * Adopt what the browser made of `text` — the only adopter: one
 * user command through the dispatcher (hooks, undo policy — a change no input
 * occurrence owns is its own undo step —, marks for insertion), placed by the
 * prefix/suffix diff that prefers the owning attempt's target (else `prefer`,
 * else the DOM caret). A browser-owned attempt expecting this host owns the
 * change: its anchored target is the command's selection (history's
 * `before`), and its expected text wins over a model-owned attempt's drift on
 * the host. A vetoed or replaced change re-renders the text from the model.
 * The caret lands where the browser put it (`domCaret`), else, for an
 * attempt, where the change ends — unless a gesture came since.
 */
export const adopt = async (
	edytor: Edytor,
	text: Text,
	dom: string,
	domCaret?: number,
	prefer?: number
) => {
	if (!text.isInDocument) return;
	const { attempts, selection } = edytor;
	const serial = edytor.intentSerial;
	const attempt = attempts.on(text);
	const after = attempt?.expect?.kind === 'change' ? attempt.expect.after : null;
	const drifted = after !== null && dom !== after && attempts.drifting(text);
	const value = drifted ? after : dom;
	const caret = drifted ? undefined : domCaret;
	if (attempt) selection.select(attempt.target);
	const { startText, yStart } = selection.textRange();
	const grow = value.length - text.length;
	const back = attempt?.isCollapsed && INTENTS[attempt.inputType]?.dir === 'back';
	const change = diffText(
		text.stringContent,
		value,
		attempt && startText === text ? yStart + (back ? grow : Math.max(0, grow)) : (prefer ?? caret)
	);
	if (!change) return;
	const { at, remove, insert } = change;
	// The command runs at the change (a hook reads the selection).
	if (startText !== text && (attempt || caret !== undefined))
		selection.select(selection.textValue(text, at));
	const replaced = remove ? text.getMarksAtRange(at, at + remove) : undefined;
	// A deletion of uniformly marked text keeps its marks pending.
	const removed = insert ? [] : replaced!;
	const marks = activeMarks(removed[0]?.marks);
	const same = removed.every((part) => jsonEquals(activeMarks(part.marks), marks));
	const shown = insert && shownMarks(text, at);
	edytor.dispatcher.run(
		attempt ? attempt.inputType || (insert ? 'insertText' : 'deleteContent') : 'foreignChange',
		() => {
			const [id, from] = [text.parent.id, text.segStart + at];
			// A replaced range's common marks; else the view's insertion rule.
			const marks = replaced && marksForInsertion(text, at, { replaced });
			if (remove) edytor.deleteText(id, from, remove);
			if (insert) edytor.insertText(id, from, insert, marks);
		}
	);
	const adopted = text.isInDocument && text.stringContent === value;
	if (attempt) attempt.phase = adopted ? 'applied' : 'failed';
	if (!text.isInDocument) return;
	// The render patches only the runs the command changed: when the one
	// insertion rule (`marksForInsertion`) gave the text other marks than the
	// node the browser wrote, that node keeps its copy — re-render.
	if (!adopted || drifted || (insert && shown !== modelMarks(edytor, text, at)))
		text.refreshFromModel();
	// Deferred past the re-render (selecting in the same turn left the
	// native caret at 0), so it checks the gesture serial: a gesture since the
	// adoption owns the selection, and its caret and pending marks stand
	// (review 2026-09-29).
	await tick();
	if (!adopted || edytor.intentSerial !== serial) return;
	const end = caret ?? (attempt ? at + insert.length : undefined);
	if (end !== undefined) selection.selectText(text, Math.min(end, text.length));
	// A deletion of uniformly marked text keeps its marks pending at the caret.
	if (same && Object.keys(marks).length > 0 && selection.textRange().startText === text)
		selection.stage(marks);
};
