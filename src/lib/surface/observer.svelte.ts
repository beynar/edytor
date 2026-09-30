/**
 * The compare-to-truth observer (R11, R12; plan §2.2 L8, §2.4 "Divergence
 * set", §4.4 `surface/observer`): the only interpreter of DOM changes. After a
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
 *   them) and snapshots a content the flush re-renders whose DOM holds an edit
 *   the flush would overwrite.
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
 *   flip back. A kind's own markup around its slots is the kind's (D-25).
 */
import { tick, untrack } from 'svelte';
import type { DocAnchor, YTransaction } from '../crdt/index.js';
import type { Edytor } from '../edytor.svelte.js';
import type { Text } from '../text/text.svelte.js';
import { diffText } from '../utils/diffText.js';
import { jsonEquals } from '../utils/json.js';
import { activeMarks } from '../session/editing/text.js';
import { INTENTS } from '../session/attempt.js';
import {
	getCollapsedDomTextSelection,
	handleNativeLineBreakTextValue,
	readDomText
} from '../events/onInput.js';
import { diverges, heal, ownedOf, type Kind } from './attributes.js';
import type { Cell, Patched, Replaced } from './cells.js';

export type Verdict = 'adopt' | 'invert' | 'defer';
/** Where an adopted edit lands: the block and offset its anchor resolves to now. */
export type Place = { block: string; at: number; remove: number; insert: string };
export type Finding = { block: string | null; verdict: Verdict; why: string; place?: Place };
type Entry = { kind: Kind; block: string; name?: string };
/** A content's last rendered text, and the browser edit seen on it while the model equalled it. */
type Base = { text: string; edit: { dom: string; anchor: DocAnchor | null } | null };
/** A record that removed registered elements: what it removed and added, and where. */
type Removal = { parent: Node; nodes: Node[]; added: Node[]; next: Node | null; prev: Node | null };
type Replacement = { nodes: Node[]; value: string; caret: number | undefined };

const ZWSP = /\u200B/g;
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
const SUGGESTION = '[data-edytor-text-suggestion]';
/** The rest a live composition merged into its host, rendered after it (`pin.rest`, GX-04). */
const REST = '[data-edytor-composition-rest]';
/** A foreign writer that re-damages every heal: the heals stop for a window (Quill's bound). */
const BOUND = 100;
const WINDOW_MS = 250;

/** The text a cell renders: characters, an atom one unit, fillers stripped. */
const textOf = (cell: Cell) =>
	cell.runs
		.map((run) => (run.kind === 'text' ? run.text : ATOM))
		.join('')
		.replace(ZWSP, '');

/** Svelte's anchors: comments and empty text nodes are never input and never removed. */
const isAnchor = (node: Node) =>
	node.nodeType === Node.COMMENT_NODE || (node.nodeType === Node.TEXT_NODE && !node.nodeValue);

/** Non-empty text nodes under `node`. */
const leaves = (node: Node) => {
	const walker = (node.ownerDocument ?? document).createTreeWalker(node, NodeFilter.SHOW_TEXT);
	let count = 0;
	while (walker.nextNode()) if ((walker.currentNode as globalThis.Text).data) count++;
	return count;
};

const firstLeaf = (node: Node) => {
	const walker = (node.ownerDocument ?? document).createTreeWalker(node, NodeFilter.SHOW_TEXT);
	while (walker.nextNode())
		if ((walker.currentNode as globalThis.Text).data) return walker.currentNode as globalThis.Text;
	return null;
};

const settle = (promises: Promise<unknown>[]) => Promise.all(promises).then(() => undefined);

/** The collapsed DOM caret's text offset inside `nodes` (a replacement's), if it is there. */
const caretIn = (nodes: Node[]) => {
	const selection = nodes[0]?.ownerDocument?.getSelection();
	const anchor = selection?.isCollapsed ? selection.anchorNode : null;
	if (!anchor) return undefined;
	let offset = 0;
	for (const node of nodes) {
		if (node === anchor || node.contains(anchor)) {
			const range = node.ownerDocument!.createRange();
			range.selectNodeContents(node);
			range.setEnd(anchor, selection!.anchorOffset);
			return offset + range.toString().length;
		}
		offset += node.textContent?.length ?? 0;
	}
	return undefined;
};

export class SurfaceObserver {
	/** The render epoch (one owner, R10/R12): cell patches, view state, re-display requests. */
	epoch = $state(0);
	/** The records signal: the MutationObserver named elements to compare. */
	records = $state(0);
	#mo: MutationObserver | null = null;
	#registry = new Map<Element, Entry>();
	#contents = new Map<string, Set<Element>>();
	#blocks = new Map<string, Element>();
	/** Contents to compare (`null`: the root's children). */
	#dirty = new Set<string | null>();
	/** Attribute records, kept while their element diverges from the table. */
	#attributes = new Set<MutationRecord>();
	#added = new Set<Node>();
	#removed: Removal[] = [];
	/** A text element the browser replaced with its own nodes: their text is the edit. */
	#replaced = new Map<Element, Replacement>();
	/** A restored text element's replacement: its text is the element's DOM text until adopted. */
	#replacements = new Map<Element, Replacement>();
	/** Contents patched since the last pass: their DOM shows an older cell. */
	#patched = new Set<string>();
	/** Of those, the ones a commit re-rendered (a remount discards its DOM: never snapshotted). */
	#rerendered = new Set<string>();
	#bases = new Map<string, Base>();
	#snapshots = new Map<string, Finding>();
	/** Divergence a model-owned attempt's drift window may still repair: compared once it closed. */
	#waiting = new Set<string>();
	/** Divergence seen while read-only: inverted at the flip back. */
	#readonly = new Set<string | null>();
	#host: string | null = null;
	#heals = 0;
	/** The pass wrote the host itself: a render (the projector displays after it, R10). */
	#wrote = false;
	/** Records arrived since the last pass (O55: a display waiting on them gets a pass). */
	#fresh = false;
	#window: ReturnType<typeof setTimeout> | null = null;

	constructor(private edytor: Edytor) {}

	/** Observe `root` (the host): records name what to compare. */
	attach = (root: HTMLElement) => {
		if (typeof MutationObserver === 'undefined') return () => {};
		const mo = (this.#mo = new MutationObserver((records) => {
			records.forEach(this.#intake);
			this.signal();
		}));
		mo.observe(root, {
			attributes: true,
			attributeOldValue: true,
			characterData: true,
			childList: true,
			subtree: true
		});
		return () => {
			mo.disconnect();
			if (this.#mo === mo) this.#mo = null;
			clearTimeout(this.#window ?? undefined);
		};
	};

	/** Register an element the core rendered (an attachment); returns its release. */
	register = (node: Element, kind: Kind, block: string, name?: string) => {
		this.#registry.set(node, { kind, block, name });
		if (kind === 'block') this.#blocks.set(block, node);
		else if (kind !== 'anchor') {
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

	/** The render anchor (`Edytor.svelte`): a registered child of the strict root. */
	anchor = (node: HTMLElement) => {
		const release = this.register(node, 'anchor', '');
		return { destroy: release };
	};

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

	/** Before a transaction: pending records name their contents while the model equals the render. */
	before = (transaction: YTransaction) => {
		void transaction;
		if (this.#take()) this.signal();
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
		});
	};

	post = () => {
		this.#deps();
		untrack(() => void this.#pass(true));
	};

	#deps = () => {
		const { edytor } = this;
		void [this.epoch, this.records, edytor.readonly, edytor.composition.phase];
		void [edytor.selection.value, edytor.selection.suggestions.size];
	};

	#take = () => {
		const records = this.#mo?.takeRecords() ?? [];
		records.forEach(this.#intake);
		return records.length > 0;
	};

	/** The block an element belongs to: its closest registered element's (`null`: the root). */
	#owner = (node: Node): string | null | undefined => {
		for (let at: Node | null = node; at; at = at.parentNode) {
			if (at === this.edytor.node) return null;
			const entry = at instanceof Element ? this.#registry.get(at) : undefined;
			if (entry) return entry.kind === 'anchor' ? null : entry.block;
		}
		return undefined;
	};

	/** The text whose element holds `node`. */
	#textOf = (node: Node): Text | undefined => {
		for (let at: Node | null = node; at && at !== this.edytor.node; at = at.parentNode) {
			const entry = at instanceof Element ? this.#registry.get(at) : undefined;
			if (entry)
				return entry.kind === 'text' ? this.edytor.nodeToText.get(at as Element) : undefined;
		}
		return undefined;
	};

	#registered = (node: Node) => node instanceof Element && this.#registry.has(node);

	/** `node` is, or holds, an element the core still renders. */
	#holds = (node: Node) =>
		this.#registered(node) ||
		(node instanceof Element &&
			[...node.querySelectorAll('*')].some((child) => this.#registry.has(child)));

	/** A record names elements to compare (never a verdict). */
	#intake = (record: MutationRecord) => {
		this.#fresh = true;
		const id = this.#owner(record.target);
		if (id === undefined) return;
		this.#dirty.add(id);
		if (id) this.#seen(id);
		if (record.type === 'attributes') this.#attributes.add(record);
		if (record.type !== 'childList') return;
		for (const node of record.addedNodes) this.#added.add(node);
		const removed = [...record.removedNodes];
		if (!removed.some((node) => isAnchor(node) || this.#holds(node))) return;
		const added = [...record.addedNodes];
		const { target: parent, nextSibling: next, previousSibling: prev } = record;
		this.#removed.push({ parent, nodes: removed, added, next, prev });
		// Wrapper replacement: the browser replaced a text element with its own nodes.
		const [text] = removed;
		if (
			removed.length === 1 &&
			this.#registry.get(text as Element)?.kind === 'text' &&
			added.length &&
			!added.some((node) => this.#holds(node) || node.nodeName === 'BR')
		) {
			const value = added.map((node) => node.textContent ?? '').join('');
			if (value)
				this.#replaced.set(text as Element, { nodes: added, value, caret: caretIn(added) });
		}
	};

	/**
	 * Records name a content while the model still equals its render (no patch
	 * since the last pass): that render is its base, and a browser edit on it
	 * gets an anchor at its position, minted now (R4).
	 */
	#seen = (id: string) => {
		const cell = this.edytor.cells?.get(id);
		if (!cell || this.#patched.has(id)) return;
		const text = textOf(cell);
		if (this.#bases.get(id)?.text !== text) this.#bases.set(id, { text, edit: null });
		const dom = this.#read(id)?.text;
		const known = this.#bases.get(id)!;
		if (dom === undefined || dom === text || known.edit?.dom === dom) return;
		const at = diffText(text, dom)!.at;
		const anchor = this.edytor.facade.anchorAt(id, at, at < text.length ? 'right' : 'left');
		known.edit = { dom, anchor };
	};

	/**
	 * A record that removed registered elements is inverted whole (newest
	 * first): the nodes it added go, the nodes it removed return in order at
	 * their recorded siblings — Svelte's anchors with them, also when the
	 * browser removed them one record each (Firefox): an anchor-only record is
	 * inverted in a parent that gets a registered element back, else the
	 * element's recorded siblings are gone and it lands outside Svelte's block.
	 */
	#restore = () => {
		const root = this.edytor.node;
		const removals = this.#removed.splice(0).reverse();
		const held = ({ parent, nodes }: Removal) =>
			nodes.some((node) => node.parentNode !== parent && this.#holds(node));
		const parents = new Set(removals.filter(held).map(({ parent }) => parent));
		for (const removal of removals) {
			const { parent, nodes, added, next, prev } = removal;
			if (!root?.contains(parent)) continue;
			if (!held(removal) && !(parents.has(parent) && nodes.every(isAnchor))) continue;
			// A browser-owned attempt's host: its change is adopted whatever the
			// browser did to its structure, which the re-render then restores.
			const inside = this.#textOf(parent);
			if (inside && this.edytor.attempts.on(inside)) continue;
			for (const node of added)
				if (node.parentNode === parent && !this.#holds(node)) parent.removeChild(node);
			const before =
				next?.parentNode === parent ? next : prev?.parentNode === parent ? prev.nextSibling : null;
			for (const node of nodes) if (node.parentNode !== parent) parent.insertBefore(node, before);
			this.#wrote = true;
			for (const node of nodes) {
				const replaced = node instanceof Element && this.#replaced.get(node);
				// The replacement's text is the browser's edit: adopted into the element's text.
				if (replaced) this.#replacements.set(node as Element, replaced);
			}
		}
		this.#replaced.clear();
	};

	/**
	 * Where an edit made at `at` of the base lands now: through the anchor
	 * minted at it (it follows its text through a re-key, split, move or
	 * retype), else rebased within the block over the model's own change
	 * (three-way prefix/suffix).
	 */
	#place = (id: string, base: Base, dom: string, at: number, now: string) => {
		const to =
			base.edit?.dom === dom &&
			base.edit.anchor &&
			this.edytor.facade.resolveAnchor(base.edit.anchor);
		if (to) return { block: to.blockId, at: to.offset };
		const model = diffText(base.text, now);
		const before = model && model.at + model.remove <= at;
		return { block: id, at: at + (before ? model.insert.length - model.remove : 0) };
	};

	/** Only a content this flush re-renders can lose an edit to its writes: snapshot it. */
	#snapshot = () => {
		if (this.edytor.readonly) return;
		for (const id of this.#rerendered) {
			if (id === this.#host) continue;
			const base = this.#bases.get(id);
			const dom = base && this.#read(id);
			const cell = this.edytor.cells?.get(id);
			if (!dom || !cell || dom.text === base.text || dom.text === textOf(cell)) continue;
			// An expectation claims the edit, or it is placed through the anchor minted at it.
			const claimed = this.#divergence(id);
			// An edit the window defers is drift: the flush's render restores the cell.
			if (claimed.verdict === 'defer') claimed.verdict = 'invert';
			if (claimed.verdict !== 'adopt' || claimed.why === 'attempt') {
				this.#snapshots.set(id, claimed);
				continue;
			}
			const change = diffText(base.text, dom.text)!;
			this.#snapshots.set(id, {
				block: id,
				verdict: 'adopt',
				why: 'snapshot',
				place: { ...change, ...this.#place(id, base, dom.text, change.at, textOf(cell)) }
			});
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
		const { edytor } = this;
		const cells = edytor.cells;
		if (!cells || !edytor.node?.isConnected || edytor.destroyed) return [];
		const live = this.#live();
		// The hand-back: the IME host returns to the compare pass at the session's end.
		if (this.#host !== live) {
			if (this.#host) this.#dirty.add(this.#host);
			this.#host = live;
		}
		this.#heal();
		if (edytor.readonly) {
			for (const id of this.#dirty) if (this.#diverges(id)) this.#readonly.add(id);
			this.#dirty.clear();
			if (this.#wrote) this.update();
			this.#wrote = false;
			return [];
		}
		// The flip back: what diverged while read-only is compared again; and
		// what waited for a model-owned attempt's drift window, once it closed.
		for (const id of this.#readonly) this.#dirty.add(id);
		if (!edytor.attempts.busy) {
			for (const id of this.#waiting) this.#dirty.add(id);
			this.#waiting.clear();
		}
		this.#restore();
		this.#clones();
		const work: Promise<unknown>[] = [];
		const dirty = [...this.#dirty].filter((id) => flushed || id === null || !this.#patched.has(id));
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
		if (this.#wrote) {
			this.#wrote = false;
			this.update();
		}
		if (this.#fresh) {
			this.#fresh = false;
			void settle(work).then(edytor.projector.recordsChanged);
		}
		return work;
	};

	/** A content differs from its cell (text, structure or a missing element). */
	#diverges = (id: string | null) => {
		if (id === null) return this.#root() !== null;
		const cell = this.edytor.cells?.get(id);
		const dom = cell && id !== this.#host && this.#read(id);
		return Boolean(dom && (dom.broken || dom.text !== textOf(cell!) || this.#shape(id)));
	};

	/** One content against its cell, and what that asks for. */
	#resolve = (id: string, cell: Cell | undefined): Promise<unknown>[] => {
		const snapshot = this.#snapshots.get(id);
		this.#snapshots.delete(id);
		if (!cell) {
			this.#bases.delete(id);
			return [];
		}
		if (id === this.#host) return [];
		const dom = this.#read(id);
		if (!dom) return [];
		// What the DOM shows once this pass acted: the base of the next edit.
		this.#bases.set(id, { text: dom.text, edit: null });
		if (snapshot) {
			// Compared again at the next pass, once the edit is resolved.
			this.#dirty.add(id);
			if (snapshot.verdict === 'adopt' && snapshot.place) return [this.#adoptAt(snapshot.place)];
			if (snapshot.verdict === 'invert') this.#invert(id);
			return [];
		}
		const want = textOf(cell);
		const replaced = this.#texts(id).some((text) => text.node && this.#replacements.has(text.node));
		if (dom.broken || this.#readonly.has(id)) {
			if (dom.broken || dom.text !== want || this.#shape(id)) this.#invert(id);
			return [];
		}
		if (dom.text === want && !replaced) {
			if (this.#shape(id)) this.#invert(id);
			return [];
		}
		const { verdict } = this.#divergence(id);
		if (verdict === 'defer') this.#waiting.add(id);
		if (verdict === 'invert') this.#invert(id);
		if (verdict !== 'adopt') return [];
		return this.#adoptContent(id);
	};

	/**
	 * A text divergence: an expectation on its host claims it (the composition
	 * tail, a pending structural key and a model-owned drift invert; a
	 * browser-owned attempt adopts); otherwise text inside a content is adopted.
	 */
	#divergence = (id: string): Finding => {
		const { attempts, composition } = this.edytor;
		if (composition.tail()?.parent.id === id) return { block: id, verdict: 'invert', why: 'tail' };
		// A structural key waiting for its `beforeinput` or deadline owns the drift it causes.
		if (attempts.key) return { block: id, verdict: 'invert', why: 'key' };
		for (const text of this.#texts(id)) {
			if (attempts.on(text)) return { block: id, verdict: 'adopt', why: 'attempt' };
			if (attempts.drifting(text)) return { block: id, verdict: 'invert', why: 'drift' };
		}
		// A model-owned attempt's window is open: its drift may land around its host (a merge target).
		if (attempts.busy) return { block: id, verdict: 'defer', why: 'window' };
		return { block: id, verdict: 'adopt', why: 'location' };
	};

	/**
	 * Restore the current cell (never the IME's host): the exact text when the
	 * content's structure is the render's (its elements and the caret's node
	 * survive; the projector displays again), else a remount of its text elements.
	 */
	#invert = (id: string) => {
		if (id === this.#live()) return;
		if (this.#shape(id) || !this.#rewrite(id)) this.edytor.cells?.remount(id);
		else this.update();
	};

	/** Write each render delta's text back into its node; false when a node is not there. */
	#rewrite = (id: string) => {
		const writes: [globalThis.Text, string][] = [];
		for (const text of this.#texts(id)) {
			const deltas = this.edytor.deltasOf(text);
			const nodes = this.#nodes(text.node!);
			const shown = deltas.length ? deltas : [{ text: '\u200B' }];
			for (const [i, delta] of shown.entries()) {
				const node = nodes[i];
				const leaf =
					node?.nodeType === Node.TEXT_NODE ? (node as globalThis.Text) : node && firstLeaf(node);
				if (!leaf) return false;
				if (leaf.data !== delta.text) writes.push([leaf, delta.text]);
			}
		}
		for (const [leaf, value] of writes) leaf.data = value;
		return true;
	};

	/** A text element's children that stand for render deltas (Svelte's anchors and the newline marker aside). */
	#nodes = (element: Element) =>
		[...element.childNodes].filter(
			(node) =>
				!isAnchor(node) &&
				!(node instanceof Element && node.hasAttribute('data-edytor-trailing-newline'))
		);

	/**
	 * Adopt the browser's text of each text element of `id` (one command each,
	 * through the dispatcher); a native line break runs as its occurrence. A
	 * content whose structure the browser also changed is then re-rendered.
	 */
	#adoptContent = (id: string): Promise<unknown>[] => {
		const { edytor } = this;
		let broken = Boolean(this.#shape(id));
		const caret = getCollapsedDomTextSelection(edytor);
		const work: Promise<unknown>[] = [];
		for (const text of this.#texts(id)) {
			const replaced = text.node && this.#replacements.get(text.node);
			if (replaced) this.#replacements.delete(text.node!);
			const dom = replaced ? replaced.value : readDomText(text);
			if (dom === text.stringContent) continue;
			broken ||= Boolean(replaced);
			const at = replaced ? replaced.caret : caret?.text === text ? caret.offset : undefined;
			const line = diffText(text.stringContent, dom);
			if (line && !line.remove && /^[\r\n]+$/.test(line.insert)) {
				work.push(handleNativeLineBreakTextValue(edytor, text, dom));
				continue;
			}
			work.push(adopt(edytor, text, dom, at));
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
		[...(this.#contents.get(id) ?? [])].flatMap(
			(element) => this.edytor.nodeToText.get(element) ?? []
		);

	/** A content's DOM: its registered text and atom elements in order; null when not shown. */
	#read = (id: string): { text: string; broken: string | null } | null => {
		const elements = [...(this.#contents.get(id) ?? [])];
		if (!elements.length) return null;
		elements.sort((a, b) =>
			a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
		);
		const host = this.#blocks.get(id);
		let text = '';
		let broken: string | null = host && !host.isConnected ? 'missing' : null;
		for (const element of elements) {
			const kind = this.#registry.get(element)?.kind;
			// A mark is inside its text element: its presence is the shape check's.
			if (kind === 'mark') continue;
			if (!element.isConnected) broken ??= 'missing';
			else if (host && !host.contains(element)) broken ??= 'escaped';
			if (kind === 'atom') text += ATOM;
			else if (kind === 'text') {
				const found = this.edytor.nodeToText.get(element);
				text += (found ? readDomText(found) : (element.textContent ?? '')).replace(ZWSP, '');
			}
		}
		return { text, broken };
	};

	/**
	 * Equal text, compared structurally: each text element (a strict
	 * container) holds one node per render delta — a text node, or a
	 * registered mark element whose registered marks follow the delta's chain.
	 */
	#shape = (id: string): string | null => {
		for (const text of this.#texts(id)) {
			const element = text.node;
			if (!element) continue;
			const deltas = this.edytor.deltasOf(text);
			const nodes = this.#nodes(element);
			if (!deltas.length) {
				if (nodes.length !== 1 || nodes[0].nodeType !== Node.TEXT_NODE) return 'filler';
				continue;
			}
			if (nodes.length !== deltas.length) return 'partition';
			for (const [i, delta] of deltas.entries()) {
				const node = nodes[i];
				const chain = delta.marks
					.map(([name]) => name)
					.filter((name) => {
						const mark = this.edytor.marks.get(name);
						return mark?.snippet || mark?.tag;
					});
				if (!chain.length) {
					if (node.nodeType !== Node.TEXT_NODE) return 'foreign-child';
					continue;
				}
				if (!(node instanceof Element) || !this.#registry.has(node)) return 'foreign-child';
				const marks = [node, ...node.querySelectorAll('[data-edytor-mark]')]
					.map((el) => this.#registry.get(el)?.name)
					.filter(Boolean);
				if (marks.join() !== chain.join()) return 'mark-chain';
				// The snippet's markup is its own, but the delta renders one text node.
				if (leaves(node) !== 1) return 'mark-text';
			}
		}
		return null;
	};

	/** The root's children: registered block elements in cell order, the anchor, Svelte's anchors. */
	#root = (): Finding | null => {
		const { node, cells } = this.edytor;
		if (!node || !cells) return null;
		const shown: string[] = [];
		for (const child of node.childNodes) {
			if (isAnchor(child)) continue;
			const entry = child instanceof Element ? this.#registry.get(child) : undefined;
			if (entry?.kind === 'block') shown.push(entry.block);
			else if (entry?.kind !== 'anchor')
				return { block: null, verdict: 'invert', why: 'root-child' };
		}
		const missing = cells.rootIds.some((id) => this.#blocks.get(id)?.parentNode !== node);
		if (missing) return { block: null, verdict: 'invert', why: 'missing' };
		return shown.join() === cells.rootIds.join()
			? null
			: { block: null, verdict: 'invert', why: 'root-order' };
	};

	/** The root is a strict container: a child it does not render is removed. */
	#strictRoot = () => {
		const node = this.edytor.node;
		if (!node) return;
		for (const child of [...node.childNodes])
			if (!isAnchor(child) && !this.#registered(child)) {
				node.removeChild(child);
				this.#wrote = true;
			}
	};

	/**
	 * Added nodes the core does not render where it renders: an unregistered
	 * element claiming a core identity (a clone, removed with its added root),
	 * and a node inside a content's run between two of its registered elements
	 * (the run is the core's; the kind's markup around it is the kind's, D-25).
	 * A live composition's rest element is the core's own (`pin.rest`).
	 */
	#clones = () => {
		const root = this.edytor.node!;
		for (const node of this.#added) {
			if (!node.isConnected || !root.contains(node) || isAnchor(node) || this.#holds(node))
				continue;
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
			node.parentNode?.removeChild(node);
			this.#wrote = true;
		}
		this.#added.clear();
	};

	/** `node` sits between two registered text or atom elements of one content. */
	#inRun = (node: Node) => {
		const side = (step: (at: Node) => Node | null) => {
			for (let at = step(node); at; at = step(at)) {
				const entry = at instanceof Element ? this.#registry.get(at) : undefined;
				if (entry) return entry.kind === 'text' || entry.kind === 'atom' ? entry.block : null;
			}
			return null;
		};
		const before = side((at) => at.previousSibling);
		return before !== null && before === side((at) => at.nextSibling);
	};

	/** A `data-edytor-mark` naming no declared mark claims nothing: its element is foreign input. */
	#claims = (element: Element) =>
		IDENTITY_ATTRIBUTES.some(
			(name) =>
				element.hasAttribute(name) &&
				(name !== 'data-edytor-mark' ||
					this.edytor.marks.has(element.getAttribute(name) ?? '') ||
					element.hasAttribute('data-edytor'))
		) || element.hasAttribute('data-edytor');

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
			const entry = this.#registry.get(element) ?? null;
			const owner = this.#owner(element);
			if (owner && owner === this.#host) continue;
			if (this.#heals > BOUND) break;
			this.#attributes.delete(record);
			const name = record.attributeName ?? '';
			const table = ownedOf(edytor, element, entry);
			// A mark element's own attributes are its render: damage there re-renders the content.
			if (entry?.kind === 'mark') {
				if (table && owner && diverges(element, table)) edytor.cells?.remount(owner);
				continue;
			}
			if (!table) {
				if (
					IDENTITY_ATTRIBUTES.includes(name) &&
					element.hasAttribute(name) &&
					!element.closest(SUGGESTION)
				) {
					element.removeAttribute(name);
					this.#counted();
				}
				continue;
			}
			if (!diverges(element, table) || !heal(element, table)) continue;
			this.#counted();
			if (element === edytor.node) this.#refocus();
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
				if (edytor.intentSerial !== serial) return;
				if (!edytor.node?.ownerDocument.getSelection()?.rangeCount) again();
			});
	};

	#counted = () => {
		this.#wrote = true;
		if (++this.#heals === 1)
			this.#window = setTimeout(() => {
				this.#heals = 0;
				this.#window = null;
				if (this.#attributes.size) this.signal();
			}, WINDOW_MS);
	};
}

/** The rendered marks (a tag or a snippet) the browser shows at `at` of `text`: the element chain of its node there. */
const shownMarks = (text: Text, at: number) => {
	const element = text.node;
	if (!element) return null;
	const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
	let offset = 0;
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		offset += (node as globalThis.Text).data.replace(ZWSP, '').length;
		if (offset <= at) continue;
		const names: string[] = [];
		for (let el = node.parentElement; el && el !== element; el = el.parentElement) {
			const name = el.getAttribute('data-edytor-mark');
			if (name) names.push(name);
		}
		return names.sort().join();
	}
	return null;
};

/** The rendered marks the model gives the character at `at` of `text`. */
const modelMarks = (edytor: Edytor, text: Text, at: number) =>
	Object.keys(activeMarks(text.getMarksAtRange(at, at + 1)[0]?.marks))
		.filter((name) => edytor.marks.get(name)?.tag || edytor.marks.get(name)?.snippet)
		.sort()
		.join();

/**
 * Adopt what the browser made of `text` (R8, O59) — the only adopter: one
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
	if (!text.isInDocument) return false;
	const serial = edytor.intentSerial;
	const attempt = edytor.attempts.on(text);
	const after = attempt?.expect?.kind === 'change' ? attempt.expect.after : null;
	const drifted = after !== null && dom !== after && edytor.attempts.drifting(text);
	const value = drifted ? after : dom;
	const caret = drifted ? undefined : domCaret;
	if (attempt) edytor.selection.select(attempt.target);
	const { startText, yStart } = edytor.selection.state;
	const grow = value.length - text.length;
	const back = attempt?.isCollapsed && INTENTS[attempt.inputType]?.dir === 'back';
	const change = diffText(
		text.stringContent,
		value,
		attempt && startText === text ? yStart + (back ? grow : Math.max(0, grow)) : (prefer ?? caret)
	);
	if (!change) return false;
	const { at, remove, insert } = change;
	// The command runs at the change (a hook reads the selection).
	if (startText !== text && (attempt || caret !== undefined))
		edytor.selection.select(edytor.selection.textValue(text, at));
	// A deletion of uniformly marked text keeps its marks pending.
	const removed = insert ? [] : text.getMarksAtRange(at, at + remove);
	const marks = activeMarks(removed[0]?.marks);
	const same = removed.every((part) => jsonEquals(activeMarks(part.marks), marks));
	const shown = insert && shownMarks(text, at);
	const kind = attempt ? attempt.inputType || (insert ? 'insertText' : 'deleteContent') : null;
	edytor.dispatcher.run(kind ?? 'foreignChange', () =>
		insert
			? text.insertText({ value: insert, start: at, end: at + remove })
			: text.parent.deleteContentAtRange({
					start: [text.index, at],
					end: [text.index, at + remove]
				})
	);
	const adopted = text.isInDocument && text.stringContent === value;
	if (attempt) attempt.phase = adopted ? 'applied' : 'failed';
	if (!text.isInDocument) return true;
	// The render patches only the runs the command changed: when the one
	// insertion rule (`marksForInsertion`) gave the text other marks than the
	// node the browser wrote, that node keeps its copy — re-render.
	const moved = adopted && insert !== '' && shown !== modelMarks(edytor, text, at);
	if (!adopted || drifted || moved) text.refreshFromModel();
	// Deferred past the re-render (the P2.3 pin: selecting in the turn left the
	// native caret at 0), so it checks the gesture serial: a gesture since the
	// adoption owns the selection, and its caret and pending marks stand
	// (review 2026-09-29).
	await tick();
	if (edytor.intentSerial !== serial) return true;
	const end = caret ?? (attempt ? at + insert.length : undefined);
	if (adopted && end !== undefined)
		edytor.selection.setAtTextOffset(text, Math.min(end, text.length));
	// A deletion of uniformly marked text keeps its marks pending at the caret.
	if (adopted && same && Object.keys(marks).length > 0 && edytor.selection.state.startText === text)
		edytor.selection.stage(marks);
	return true;
};
