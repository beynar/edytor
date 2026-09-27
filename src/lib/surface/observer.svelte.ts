/**
 * The compare-to-truth observer (R11, R12; plan §2.2 L8, §2.3, §2.4
 * "Divergence set", §4.4 `surface/observer`). At R6 it runs in SHADOW beside
 * today's observer (`events/domTextMutationObserver`), which still acts: this
 * module only classifies, and logs its verdicts to a test-side sink.
 *
 * - The render epoch (`epoch`) is bumped by every cell patch and by
 *   `update()` (extension view state); the passes also re-run when the
 *   selection value, readonly, the composition phase or suggestions change.
 * - The records signal (`records`) is written by the MutationObserver
 *   callback. Records carry no provenance: they only name the elements to
 *   compare (`intake`).
 * - The owned-element registry holds the block, text, mark and atom elements
 *   the core's attachments registered, each with its block, and each
 *   content's last rendered text (with the anchor of a browser edit on it).
 * - The pre pass (root `$effect.pre`, before the flush's DOM writes)
 *   snapshots a content the flush re-renders whose DOM differs from both its
 *   last rendered text and its current cell: an edit the flush may
 *   overwrite, placed through the anchor minted at it when its records were
 *   named, else rebased over the model's change within the block.
 * - The compare pass (root `$effect`, after every DOM write of the flush)
 *   compares each dirty content with its cell: its text (fillers stripped, an
 *   atom one unit), then its partition and mark chain against the render
 *   deltas and its registered elements; the root's children against the
 *   cells; owned attributes against the table; identity clones. A divergence
 *   is classified by location and expectation: text inside a content is
 *   adopted unless a model-owned drift or the composition tail expects its
 *   host, structure is inverted, the live composition host is the IME's, and
 *   read-only text divergence waits for the flip back.
 */
import { untrack } from 'svelte';
import type { DocAnchor, YTransaction } from '../crdt/index.js';
import type { Edytor } from '../edytor.svelte.js';
import type { Text } from '../text/text.svelte.js';
import { diffText } from '../utils/diffText.js';
import { attributeDiverges } from '../events/domTextMutationObserver.js';
import type { Cell, Patched, Replaced } from './cells.js';

export type Verdict = 'equal' | 'adopt' | 'invert' | 'ime' | 'readonly';
/** Where an adopted edit lands: the block and offset its anchor resolves to now. */
export type Place = { block: string; at: number; remove: number; insert: string };
export type Finding = { block: string | null; verdict: Verdict; why: string; place?: Place };
type Kind = 'block' | 'text' | 'mark' | 'atom';
type Entry = { kind: Kind; block: string; name?: string };
/**
 * A content's last rendered text, and the browser edit seen on it while the
 * model still equalled that render (its DOM text, and an anchor minted at it).
 */
type Base = { text: string; edit: { dom: string; anchor: DocAnchor | null } | null };

const ZWSP = /\u200B/g;
const ATOM = '\uFFFC';
const IDENTITY = '[data-edytor-id],[data-edytor-text],[data-edytor-block],[data-edytor-mark]';

/** The text a cell renders: characters, an atom one unit, fillers stripped. */
const textOf = (cell: Cell) =>
	cell.runs
		.map((run) => (run.kind === 'text' ? run.text : ATOM))
		.join('')
		.replace(ZWSP, '');

/** The shadow log (test-side, R6): absent in production, where nothing is kept. */
const log = (edytor: Edytor, entry: object) =>
	(
		globalThis as { __EDYTOR_OBSERVER_SHADOW__?: (entry: object) => void }
	).__EDYTOR_OBSERVER_SHADOW__?.({ view: edytor.presenceKey, edytor, ...entry });

const isAnchor = (node: Node) =>
	node.nodeType === Node.COMMENT_NODE || (node.nodeType === Node.TEXT_NODE && !node.nodeValue);

export class SurfaceObserver {
	/** The render epoch: cell patches and extension view state. */
	epoch = $state(0);
	/** The records signal: the MutationObserver named elements to compare. */
	records = $state(0);
	#registry = new Map<Element, Entry>();
	#contents = new Map<string, Set<Element>>();
	#blocks = new Map<string, Element>();
	/** Contents to compare (`null`: the root's children), and attribute records. */
	#dirty = new Set<string | null>();
	/** Attribute records to compare, kept while their element diverges from the table. */
	#attributes = new Set<MutationRecord>();
	#added = new Set<Node>();
	/** Contents patched since the last pass: their DOM shows an older cell. */
	#patched = new Set<string>();
	#bases = new Map<string, Base>();
	#snapshots = new Map<string, Finding>();
	/** Divergences waiting for a state change: read-only text, the live IME host. */
	#deferred = new Set<string>();
	#host: string | null = null;
	/** Contents the last pass found divergent: the settle check compares them again. */
	#divergent = new Set<string | null>();
	/** Contents whose DOM was ahead of the render and equal to the cell: already adopted. */
	#ahead: string[] = [];

	constructor(private edytor: Edytor) {}

	/** Register an element the core rendered (an attachment); returns its release. */
	register = (node: Element, kind: Kind, block: string, name?: string) => {
		this.#registry.set(node, { kind, block, name });
		if (kind === 'block') this.#blocks.set(block, node);
		else {
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

	/** Extension view state rendered into the host: an epoch bump (`surface.update`). */
	update = () => void this.epoch++;

	/** Cells patched by a commit: the contents the flush re-renders (`before`: what the DOM shows). */
	patched = (ids: Patched, before: Replaced) => {
		for (const id of ids) {
			this.#dirty.add(id);
			if (id !== null) this.#patched.add(id);
		}
		for (const [id, cell] of before)
			if (!this.#bases.has(id)) this.#bases.set(id, { text: textOf(cell), edit: null });
		this.epoch++;
	};

	/** A mutation record names elements to compare (never a verdict). */
	intake = (record: MutationRecord) => {
		const root = this.edytor.node;
		if (!root) return;
		const id = record.target === root ? null : this.#owner(record.target);
		if (id !== undefined) this.#dirty.add(id);
		if (id) this.#seen(id);
		if (record.type === 'attributes') this.#attributes.add(record);
		for (const node of record.addedNodes) this.#added.add(node);
	};

	/** The records signal: the passes run again. */
	signal = () => void this.records++;

	/** Compare every content and the root at the next pass (a settle check, F-O10). */
	check = () => {
		this.#dirty.add(null);
		for (const id of [...this.#contents.keys(), ...this.#divergent]) this.#dirty.add(id);
		this.signal();
	};

	/** Before a transaction: pending records are named while the model still equals the render. */
	before = (transaction: YTransaction) => {
		void transaction;
		this.edytor.observer?.take();
	};

	pre = () => {
		this.#deps();
		untrack(this.#pre);
	};

	post = () => {
		this.#deps();
		untrack(this.#post);
	};

	#deps = () => {
		const { edytor } = this;
		void [this.epoch, this.records, edytor.readonly, edytor.composition.phase];
		void [edytor.selection.value, edytor.selection.suggestions.size];
	};

	/** The block an element belongs to: its closest registered element's. */
	#owner = (node: Node): string | undefined => {
		for (let at: Node | null = node; at && at !== this.edytor.node; at = at.parentNode) {
			const entry = at instanceof Element ? this.#registry.get(at) : undefined;
			if (entry) return entry.block;
		}
		return undefined;
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
		const base = this.#bases.get(id);
		if (base?.text !== text) this.#bases.set(id, { text, edit: null });
		const dom = this.#read(id)?.text;
		const known = this.#bases.get(id)!;
		if (dom === undefined || dom === text || known.edit?.dom === dom) return;
		const at = diffText(text, dom)!.at;
		const anchor = this.edytor.facade.anchorAt(id, at, at < text.length ? 'right' : 'left');
		known.edit = { dom, anchor };
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

	/** A content's DOM: its registered text and atom elements in order; null when not shown. */
	#read = (id: string): { text: string; broken: string | null } | null => {
		const elements = [...(this.#contents.get(id) ?? [])];
		if (!elements.length) return null;
		elements.sort((a, b) =>
			a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
		);
		const host = this.#blocks.get(id);
		let text = '';
		let broken: string | null = null;
		for (const element of elements) {
			if (!element.isConnected) broken ??= 'missing';
			else if (host && !host.contains(element)) broken ??= 'escaped';
			const kind = this.#registry.get(element)?.kind;
			// A mark's text is its text element's: marks are checked for presence only.
			if (kind === 'atom') text += ATOM;
			else if (kind === 'text') text += (element.textContent ?? '').replace(ZWSP, '');
		}
		return { text, broken };
	};

	#pre = () => {
		// Only a content this flush re-renders can lose an edit to its writes.
		for (const id of this.#patched) {
			if (id === this.#host) continue;
			const base = this.#bases.get(id);
			const dom = base && this.#read(id);
			const cell = this.edytor.cells?.get(id);
			if (!dom || !cell || dom.text === base.text) continue;
			if (dom.text === textOf(cell)) {
				this.#ahead.push(id);
				continue;
			}
			// An edit the flush may overwrite: an expectation claims it, or it is
			// snapshotted and placed through the anchor minted at it.
			const claimed = this.#divergence(id);
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

	#post = () => {
		const { edytor } = this;
		const cells = edytor.cells;
		if (!cells || !edytor.node?.isConnected || edytor.destroyed) return;
		const live = edytor.composition.live ? (edytor.composition.host?.parent.id ?? null) : null;
		// The hand-back: the IME host and read-only text return to the compare pass.
		if (this.#host !== live) {
			if (this.#host) this.#dirty.add(this.#host);
			this.#host = live;
		}
		if (!edytor.readonly) for (const id of this.#drain()) this.#dirty.add(id);
		const findings: Finding[] = [];
		const dirty = [...this.#dirty];
		this.#dirty.clear();
		this.#patched.clear();
		for (const id of dirty) {
			const found = id === null ? this.#root() : this.#content(id, cells.get(id));
			if (found) findings.push(found);
		}
		for (const record of this.#attributes) {
			if (!record.target.isConnected || !attributeDiverges(edytor, record)) {
				this.#attributes.delete(record);
				continue;
			}
			const block = this.#owner(record.target) ?? null;
			findings.push({ block, verdict: 'invert', why: `attribute:${record.attributeName}` });
		}
		for (const node of this.#added) {
			if (!(node instanceof Element) || !node.isConnected || !edytor.node.contains(node)) continue;
			const clone = node.matches(IDENTITY) ? node : node.querySelector(IDENTITY);
			if (clone && !this.#registry.has(clone) && !clone.closest('[data-edytor-text-suggestion]'))
				findings.push({ block: this.#owner(node) ?? null, verdict: 'invert', why: 'clone' });
		}
		this.#added.clear();
		const divergent = new Set(findings.map((finding) => finding.block));
		const equal = dirty.filter((id) => !divergent.has(id));
		for (const id of equal) this.#divergent.delete(id);
		for (const id of divergent) this.#divergent.add(id);
		const ahead = this.#ahead.splice(0);
		if (dirty.length || findings.length) log(edytor, { src: 'pass', findings, equal, ahead });
	};

	#drain = () => {
		const out = [...this.#deferred];
		this.#deferred.clear();
		return out;
	};

	/** One content against its cell. */
	#content = (id: string, cell: Cell | undefined): Finding | null => {
		const snapshot = this.#snapshots.get(id);
		this.#snapshots.delete(id);
		if (!cell) {
			this.#bases.delete(id);
			return null;
		}
		if (id === this.#host) return { block: id, verdict: 'ime', why: 'composition' };
		const want = textOf(cell);
		if (snapshot) {
			// Compared again at the next pass, once the edit is resolved.
			this.#dirty.add(id);
			return snapshot;
		}
		const dom = this.#read(id);
		if (!dom) return null;
		// What the flush rendered: the base of the next edit.
		if (this.#bases.get(id)?.text !== want) this.#bases.set(id, { text: want, edit: null });
		if (dom.broken) return { block: id, verdict: 'invert', why: dom.broken };
		if (dom.text !== want) return this.#divergence(id);
		const shape = this.#shape(id);
		return shape ? { block: id, verdict: 'invert', why: shape } : null;
	};

	/**
	 * A text divergence: read-only text waits for the flip back; an
	 * expectation on its host claims it (the composition tail and a
	 * model-owned drift invert, a browser-owned attempt adopts); otherwise the
	 * location default adopts text inside a content.
	 */
	#divergence = (id: string): Finding => {
		const { attempts, composition, readonly } = this.edytor;
		if (readonly) {
			this.#deferred.add(id);
			return { block: id, verdict: 'readonly', why: 'readonly' };
		}
		if (composition.tail()?.parent.id === id) return { block: id, verdict: 'invert', why: 'tail' };
		// A structural key waiting for its `beforeinput` or deadline owns the drift it causes.
		if (attempts.key) return { block: id, verdict: 'invert', why: 'key' };
		for (const text of this.#texts(id)) {
			if (attempts.on(text)) return { block: id, verdict: 'adopt', why: 'attempt' };
			if (attempts.drifting(text)) return { block: id, verdict: 'invert', why: 'drift' };
		}
		return { block: id, verdict: 'adopt', why: 'location' };
	};

	#texts = (id: string): Text[] =>
		[...(this.#contents.get(id) ?? [])].flatMap(
			(element) => this.edytor.nodeToText.get(element) ?? []
		);

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
			const nodes = [...element.childNodes].filter(
				(node) =>
					!isAnchor(node) &&
					!(node instanceof Element && node.hasAttribute('data-edytor-trailing-newline'))
			);
			if (!deltas.length) {
				if (nodes.length > 1 || (nodes[0] && nodes[0].nodeType !== Node.TEXT_NODE)) return 'filler';
				continue;
			}
			if (nodes.length !== deltas.length) return 'partition';
			for (const [i, delta] of deltas.entries()) {
				const node = nodes[i];
				const chain = delta.marks
					.map(([name]) => name)
					.filter((name) => this.edytor.marks.get(name)?.snippet);
				if (!chain.length) {
					if (node.nodeType !== Node.TEXT_NODE) return 'foreign-child';
					continue;
				}
				if (!(node instanceof Element) || !this.#registry.has(node)) return 'foreign-child';
				const marks = [node, ...node.querySelectorAll('[data-edytor-mark]')]
					.map((el) => this.#registry.get(el)?.name)
					.filter(Boolean);
				if (marks.join() !== chain.join()) return 'mark-chain';
			}
		}
		return null;
	};

	/** The root, a strict container: the registered elements of its cells, in order. */
	#root = (): Finding | null => {
		const { node, cells } = this.edytor;
		if (!node || !cells) return null;
		const shown: string[] = [];
		for (const child of node.childNodes) {
			if (isAnchor(child)) continue;
			const entry = child instanceof Element ? this.#registry.get(child) : undefined;
			if (entry?.kind === 'block') shown.push(entry.block);
			else if (!(child instanceof Element && child.hasAttribute('data-edytor-render-anchor')))
				return { block: null, verdict: 'invert', why: 'root-child' };
		}
		return shown.join() === cells.rootIds.join()
			? null
			: { block: null, verdict: 'invert', why: 'root-order' };
	};

	/** Today's observer acted (R6's comparison log; temporary). */
	acted = (at: Node | string | null, action: 'adopt' | 'invert', why: string) => {
		if (!(globalThis as { __EDYTOR_OBSERVER_SHADOW__?: unknown }).__EDYTOR_OBSERVER_SHADOW__)
			return;
		const block = typeof at === 'string' || at === null ? at : (this.#owner(at) ?? null);
		const site = new Error().stack
			?.split('\n')
			.slice(3, 6)
			.map((l) => l.trim().split(' ')[1])
			.join('<');
		const live = this.edytor.composition.live;
		log(this.edytor, { src: 'observer', block, action, why, live, site });
		// Its repairs make no records (it disconnects while it writes): compare again.
		this.#dirty.add(block);
		this.signal();
	};
}
