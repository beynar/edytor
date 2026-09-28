/**
 * The composition session (R7, R8, L7, O34, D32, D48; §4.3 `session/composition`).
 *
 * One IME composition is one session. Its start target (the selection at
 * `compositionstart`) is replaced at its first write through an ordinary
 * command (hooks, veto, tracked), and the marks of the composed text are
 * captured once, at the start. Previews are mechanical tracked writes (no
 * hooks) inside one capture group: the group opens with the session's first
 * write and is held open before each later one (`UndoManager.lastChange`,
 * K15), so the session and its ending are one undo step. Like a typed
 * insertion it cuts nothing: its first write coalesces with the step before
 * it within `captureTimeout`, and the next insertion may coalesce with it. The region the
 * previews occupy is two anchors, written only by the session: its start is
 * bound to the atom before it, its end to the preview's last atom, so a
 * peer's edit outside the region moves it and one inside is absorbed.
 *
 * A session ends exactly once:
 * - `commit(value)` — the final value (`insertFromComposition`, a text
 *   insertion while composing, `compositionend`): one user-origin command that
 *   deletes the live preview items per stream and inserts at the region start,
 *   the insertion shown to hooks;
 * - `cancel()` — an explicit cancel (an empty final value): the preview is
 *   deleted inside the capture group;
 * - `abandon()` — focus loss, a non-composing key, a new `compositionstart`,
 *   a pointer gesture: what the host shows is adopted (the browser committed
 *   it). No timer ever ends a session.
 * - D-20 — a commit that re-places the host's block (deleted, merged away,
 *   retyped, re-parented or moved among its siblings, itself or an ancestor
 *   — each re-creates or moves the IME's node) commits what the IME
 *   shows before the change renders; a preview deleted with its block is
 *   lost with it. The IME, unaware, keeps composing (Chromium drops its
 *   composition with its node and sends the commit as a plain insertion):
 *   its next start, update or commit resumes over the text just committed,
 *   so it commits once — or, after a deletion, writes nothing.
 * Then it keeps a tail (`live → tail → gone`) that owns late composition
 * signals — a trailing `compositionend`, a trailing composition `input` or
 * host mutation (resolved to the committed text), the phantom Enter/Backspace
 * — until the next non-composition occurrence, or `TAIL_MS` compared at use.
 *
 * The facts a display gate reads: `host` (the text whose element a live
 * session owns), `owns(node)`, and `ended(fn)` (the session end, after its
 * writes: where the catch-up display runs).
 */
import type { DocChange } from '$lib/crdt/index.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { TextAnchor } from '$lib/selection/selection.svelte.js';
import type { Text } from '$lib/text/text.svelte.js';
import { insertionMarks } from '$lib/events/beforeInputCommands.js';
import {
	replaceSelectedBlocksWithEmptyBlockTargetSync,
	replaceSelectionWithCollapsedTarget
} from '$lib/selection/replaceSelection.js';
import { attemptOf, intentSnapshot, kindOf, type Attempt } from './attempt.js';
import type { SelectionValue } from './selection.js';

export type Phase = 'live' | 'tail' | 'gone';
type Marks = Record<string, unknown>;

/** How long the tail owns late signals of an engine that sends no next occurrence (compared at use). */
const TAIL_MS = 500;
const now = () => (typeof performance === 'undefined' ? Date.now() : performance.now());

const isAppleWebKit = () =>
	typeof navigator !== 'undefined' &&
	/AppleWebKit/i.test(navigator.userAgent) &&
	!/(Chrome|Chromium|Edg|OPR|SamsungBrowser)/i.test(navigator.userAgent);

export class Composition {
	/** `live` from `compositionstart` to the ending, then `tail` until the next occurrence. */
	phase = $state<Phase>('gone');
	/** The text whose element the live session's IME owns (the render pin's host). */
	host = $state<Text | null>(null);
	/** The IME buffer the model holds. */
	preview = '';
	/** The last update was announced by a `beforeinput`: its `input` changes nothing. */
	#announced = false;
	/** The browser itself shows the preview (its update was not prevented): the host's render stays frozen. */
	native = false;
	/** The marks of the composed text, captured at the start (O29). */
	marks: Marks | undefined;
	/** The selection at `compositionstart`: the start target. */
	#start: SelectionValue | null = null;
	/** The region: its start bound to the atom before it, its end to the preview's last atom. */
	#region: { start: TextAnchor; end: TextAnchor } | null = null;
	/** The start target's replacement was refused: the session writes nothing. */
	#refused = false;
	/** A model command moved the caret during the session: the ending keeps it. */
	#interrupted = false;
	/** The undo stack item the session's first write landed in: its capture group. */
	#item: unknown = null;
	/** The tail: when the session ended, its host and the caret it left. */
	#ended = 0;
	#tail: Text | null = null;
	#caret: { text: Text; offset: number } | null = null;
	#waiting: (() => void)[] = [];
	/** Where the host's block sits (its and its ancestors' ids and types), and their siblings: D-20 compares them. */
	#where = '';
	#order: { id: string; kids: readonly string[] }[] = [];
	/** After a D-20 commit, until the IME ends: the text it committed (resumed over), or `lost` (dropped). */
	#resume: SelectionValue | 'lost' | null = null;
	/** Phantom structural keys the tail swallowed (a test oracle). */
	swallows = 0;

	constructor(private edytor: Edytor) {}

	get live() {
		return this.phase === 'live';
	}

	/** `node` lies inside the element a live session owns (the pinned element). */
	owns = (node: Node | null | undefined) => this.host !== null && this.edytor.pin.owns(node);

	/** Run `fn` once the live session has ended (after its writes), or now when none is live. */
	ended = (fn: () => void) => {
		if (this.live) this.#waiting.push(fn);
		else fn();
	};

	/** `compositionstart`: the start target is the current selection (the caller read the DOM). */
	start = () => {
		if (this.live) this.abandon();
		const { selection } = this.edytor;
		const resume = this.#resume;
		this.#resume = null;
		if (resume && resume !== 'lost') selection.select(resume);
		const { startText, endText, yStart, yEnd } = selection.state;
		this.phase = 'live';
		this.#tail = this.#caret = this.#region = null;
		this.#start = selection.value;
		this.preview = '';
		this.#interrupted = this.native = false;
		// The IME continues a composition whose block was deleted: it writes nothing.
		this.#refused = resume === 'lost';
		this.#item = null;
		this.marks = insertionMarks(this.edytor, intentSnapshot(this.edytor, 'insertCompositionText'));
		const host = selection.selectedBlocks.size ? null : (startText ?? null);
		if (host) this.#pin(host, yStart, endText === host ? yEnd : host.length);
		this.host = host;
		this.#where = this.#place();
		this.#order = this.#siblings();
	};

	/** A composition update: the model holds `value` (mechanical, in the capture group). */
	update = (value: string, attempt?: Attempt) => {
		if (!this.live && this.#resume) this.start();
		if (!this.live || !this.#open(attempt)) return;
		this.#announced = Boolean(attempt);
		this.native = !attempt?.event?.defaultPrevented;
		this.#write(value);
		// The model caret follows the preview; the DOM caret is the IME's.
		const at = this.#at();
		const { selection } = this.edytor;
		if (at) selection.select(selection.textValue(at.text, at.offset + value.length));
	};

	commit = (value: string) => {
		if (!this.live && this.#resume) this.start();
		return this.#end(value);
	};
	cancel = () => this.#end('');
	/** Adopt what the host shows: the browser committed it. */
	abandon = () => this.#end(this.edytor.pin.imeBuffer() ?? this.preview);

	/** `offset` of `text` lies in the live session's region. */
	covers = (text: Text, offset: number) => {
		const region = this.live && this.#region;
		if (!region) return false;
		const { selection } = this.edytor;
		const start = selection.resolveTextAnchor(region.start);
		const end = selection.resolveTextAnchor(region.end);
		return (
			start?.text === text && end?.text === text && start.offset <= offset && offset <= end.offset
		);
	};

	/** A model command ran during the live session: its caret outlives the ending. */
	interrupt = () => {
		if (this.live) this.#interrupted = true;
	};

	/** A non-composition occurrence ends the tail (and a resume, unless it is the IME's plain commit). */
	occurred = (inputType?: string) => {
		if (inputType !== 'insertText') this.#resume = null;
		if (this.phase === 'tail') this.phase = 'gone';
	};

	/**
	 * A commit (D-20): when it re-placed the host's block, commit what the IME
	 * shows now, before the change renders — nothing when the preview went
	 * with a deleted block. The commit's own report follows this one.
	 */
	restructured = (change: DocChange) => {
		if (!this.live || !(change.removed.size || change.moved.size || change.meta.size)) return;
		if (this.#place() === this.#where && !this.#reordered()) return;
		const shown = this.edytor.pin.imeBuffer() ?? this.preview;
		const at = this.#kept();
		const lost = !at && this.preview ? 'lost' : null;
		if (!at) this.#region = null;
		this.#end(at ? shown : '');
		const { selection } = this.edytor;
		const to = at ? at.offset + shown.length : 0;
		this.#resume = at && shown ? selection.textValue(at.text, at.offset, at.text, to) : lost;
	};

	/** The tail's host while it owns late signals (`at`: the signal's time). */
	tail = (at = now()) => (this.phase === 'tail' && at - this.#ended <= TAIL_MS ? this.#tail : null);

	/** An `input`: `live` (the session's; a preview the DOM shows is adopted), `late` (the tail's) or null. */
	input = (event: InputEvent): 'live' | 'late' | null => {
		if (!event.isComposing && kindOf(event.inputType) !== 'composition') {
			this.occurred();
			return null;
		}
		if (this.live) {
			// An update no `beforeinput` announced (Android): the model takes what the IME shows.
			const shown = this.#announced ? null : this.edytor.pin.imeBuffer();
			this.#announced = false;
			if (shown != null && shown !== this.preview) this.update(shown);
			return 'live';
		}
		const caret = this.#caret;
		if (!this.tail() || !caret) return null;
		// A late change: model-owned drift, repaired to the committed text and caret.
		const { attempts } = this.edytor;
		const attempt = attemptOf(this.edytor, { inputType: event.inputType, cancelable: false });
		attempts.drift(attempts.admit(attempt, 'model'), 'restore', 0);
		attempts.caret(caret.text, caret.offset);
		return 'late';
	};

	/** A keydown: true when it belongs to the IME or is the tail's phantom key (swallowed). */
	keydown = (event: KeyboardEvent) => {
		if (event.isComposing) return true;
		if (this.live) {
			// A non-composing key abandons the session, then acts.
			this.abandon();
			return false;
		}
		const tail = this.tail();
		this.occurred();
		const { state, selectedBlocks, selectedInlineBlock } = this.edytor.selection;
		const phantom =
			tail &&
			(event.key === 'Enter' || (event.key === 'Backspace' && isAppleWebKit())) &&
			state.isCollapsed &&
			!selectedBlocks.size &&
			!selectedInlineBlock.size;
		if (!phantom) return false;
		this.swallows++;
		event.preventDefault();
		event.stopPropagation();
		return true;
	};

	/** The view is going away: drop the session without writing. */
	reset = () => {
		this.#release();
		this.phase = 'gone';
	};

	/** The first write: open the capture group and replace the start target (a command). */
	#open(attempt?: Attempt) {
		if (this.#region) return true;
		if (this.#refused) return false;
		const { edytor } = this;
		const { selection, dispatcher } = edytor;
		// A declared target range re-states where the composition starts.
		if (this.#start && !attempt?.declared) selection.select(this.#start);
		const target = this.#tracked(() =>
			dispatcher.scope(
				() =>
					selection.selectedBlocks.size
						? replaceSelectedBlocksWithEmptyBlockTargetSync(edytor)
						: replaceSelectionWithCollapsedTarget(edytor),
				() => (this.#refused = true)
			)
		);
		const start = target && selection.createTextAnchor(target.text, target.offset, 'left');
		if (this.#refused || !start) return !(this.#refused = true);
		this.#region = { start, end: start };
		return true;
	}

	/** The host's block and its ancestors (none once it is not visible). */
	#chain() {
		const { facade } = this.edytor;
		const id = this.host?.parent.id;
		return id && facade.isVisibleBlock(id) ? [id, ...facade.ancestorsOf(id)] : [];
	}

	/** The chain with its types. */
	#place() {
		const { facade } = this.edytor;
		return this.#chain()
			.map((id) => `${id}:${facade.blockTypeOf(id)}`)
			.join('/');
	}

	/** Each chain member with its parent's child ids. */
	#siblings() {
		const { facade } = this.edytor;
		return this.#chain().map((id) => ({ id, kids: facade.childrenIds(facade.parentOf(id)) }));
	}

	/** A chain member moved among the siblings it had and still has (a same-parent move). */
	#reordered() {
		const [before, after] = [this.#order, (this.#order = this.#siblings())];
		const rank = (id: string, kids: readonly string[], other: readonly string[]) => {
			const kept = new Set(other);
			return kids.filter((kid) => kept.has(kid)).indexOf(id);
		};
		return before.some(({ id, kids }, i) => {
			const now = after[i]?.kids ?? [];
			return rank(id, kids, now) !== rank(id, now, kids);
		});
	}

	/** The region start while the preview is live and whole in one visible block (not deleted with it). */
	#kept() {
		const { facade } = this.edytor;
		const [start, end] = [this.#region?.start, this.#region?.end].map(
			(a) => a && facade.resolveAnchor(a)
		);
		const whole = start && end?.blockId === start.blockId && facade.isVisibleBlock(start.blockId);
		return whole && end.offset - start.offset === this.preview.length ? this.#at() : null;
	}

	/** The region start as a text position. */
	#at() {
		return this.#region && this.edytor.selection.resolveTextAnchor(this.#region.start);
	}

	/** Delete the live items between the region's anchors, per stream. */
	#erase() {
		const { facade } = this.edytor;
		const start = this.#region && facade.resolveAnchor(this.#region.start);
		const end = this.#region && facade.resolveAnchor(this.#region.end);
		if (!start || !end) return;
		if (start.blockId === end.blockId) {
			if (end.offset > start.offset)
				facade.deleteText(start.blockId, start.offset, end.offset - start.offset);
			return;
		}
		// A peer split inside the region: its streams keep their own tails.
		const length = facade.displayLength(start.blockId) - start.offset;
		if (length > 0) facade.deleteText(start.blockId, start.offset, length);
		if (end.offset > 0) facade.deleteText(end.blockId, 0, end.offset);
	}

	/** Pin the host's cell and segment: the renderer never rewrites the IME's node (`surface/pin`). */
	#pin(host: Text, from: number, to: number) {
		const { edytor } = this;
		const at = edytor.segmentOf(host);
		if (!at) return;
		const transform = edytor.getBlockDefinition('block', at.cell.type).transformText;
		edytor.pin.acquire(at.cell, at.segment, transform, from, to, host.node ?? null);
	}

	/** A mechanical tracked write: the region holds `value`. */
	#write(value: string) {
		const { edytor } = this;
		this.preview = value;
		edytor.pin.show(value, this.marks, this.native);
		this.#hold();
		const { facade } = edytor;
		this.#tracked(() =>
			edytor.transact(() => {
				this.#erase();
				const start = this.#region && facade.resolveAnchor(this.#region.start);
				if (!start || !this.#region) return;
				if (value) facade.insertText(start.blockId, start.offset, value, this.marks);
				this.#region.end =
					facade.anchorAt(start.blockId, start.offset + value.length, 'left') ?? this.#region.start;
			})
		);
	}

	/** Hold the capture group open for the next write (K15). */
	#hold() {
		const um = this.edytor.undoManager;
		if (um && this.#item && um.undoStack.at(-1) === this.#item) um.lastChange = Date.now();
	}

	/**
	 * Run a write and record the stack item its first tracked transaction
	 * landed in — a new one, or the previous step it coalesced into, as a typed
	 * insertion does (no cut: the session groups like typing, then is held).
	 */
	#tracked<T>(write: () => T): T {
		const um = this.edytor.undoManager;
		if (!um || this.#item) return write();
		const record = ({ stackItem }: { stackItem: unknown }) => (this.#item ??= stackItem);
		um.on('stack-item-added', record);
		um.on('stack-item-updated', record);
		try {
			return write();
		} finally {
			um.off('stack-item-added', record);
			um.off('stack-item-updated', record);
		}
	}

	/** The one ending: `value` replaces the preview (a commit shown to hooks), '' deletes it. */
	#end(value: string) {
		if (!this.live) {
			this.#resume = null;
			return false;
		}
		const { edytor } = this;
		const { dispatcher, selection } = edytor;
		// A command that moved the caret out of the region keeps it there.
		const { startText: moved, yStart: movedAt } = selection.state;
		const keep = this.#interrupted && moved && !this.covers(moved, movedAt);
		this.#tail = this.host;
		this.#ended = now();
		this.phase = 'tail';
		if ((value || this.#region) && dispatcher.permits() && this.#open()) {
			const at = this.#at();
			this.preview = '';
			this.#hold();
			if (at && value) {
				const text = at.text;
				const payload = { value, start: at.offset, end: at.offset, marks: this.marks };
				dispatcher.run('insertFromComposition', () =>
					dispatcher.dispatch('insertText', payload, { block: text.parent, text }, (p) => {
						this.#erase();
						text.insertAt(p.start, p.value, p.marks ?? this.marks);
						if (selection.pending) selection.stage(undefined);
					})
				);
			}
			// A refused commit, or a cancel: the preview goes.
			if (!value || dispatcher.last?.status === 'refused') edytor.transact(() => this.#erase());
			const text = at?.text;
			const typed = dispatcher.last?.status === 'applied' ? value.length : 0;
			if (text) this.#caret = { text, offset: Math.min(at.offset + typed, text.length) };
		}
		const { startText, yStart } = selection.state;
		const caret = keep && startText ? { text: startText, offset: yStart } : this.#caret;
		this.#release();
		if (caret) void edytor.stabilizeCompositionSelection(caret.text, caret.offset);
		void edytor.surface.flush();
		for (const fn of this.#waiting.splice(0)) fn();
		return true;
	}

	#release() {
		this.host = null;
		this.#region = null;
		this.edytor.pin.release();
	}
}
