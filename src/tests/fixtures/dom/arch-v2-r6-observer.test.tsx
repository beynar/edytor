/** @jsxImportSource ../../jsx */
/**
 * arch-v2 — checkpoint R6 rows (dom lane): the compare-to-truth observer, in
 * shadow beside today's observer (plan §2.4 "Divergence set", §4.4
 * `surface/observer`, R11, R12; §8.7 F-O2, F-O8, F-O10, F-O13; §12.5 BI2-1…6).
 * The rows read the shadow's verdict log (`pass` entries: findings per
 * content; `observer` entries: what today's observer did) and its snapshot
 * log (the pre pass's `snapshot` findings and where they place the edit).
 *
 * - F-O2 — selection-driven attribute writes, a readonly flip, suggestions
 *   and extension view state, rendered outside a composition and during one:
 *   after each flush the compare pass finds no divergence; the IME preview
 *   diverges for the session's lifetime and is never inverted or adopted;
 *   the session commits once; a late change in the tail is inverted to the
 *   committed text.
 * - F-O8 — a remote update applied synchronously inside a keydown handler, an
 *   extension `$effect` that dispatches a command, an update applied inside
 *   another transaction's observer: after the flush the compare pass finds no
 *   divergence; the next keystroke is adopted once.
 * - F-O13 (b), (d), (e) on the snapshot log — an autocorrect and a same-task
 *   model change (both task orders; a remote format, a mark-nesting change, a
 *   retype, the deletion of the atom before it, a move, a split before it):
 *   the snapshot places the correction where it was typed and the concurrent
 *   change stands; (d) Android drift of an applied prevented Backspace plus a
 *   same-task change: the drift is inverted and the DOM ends at the cell's
 *   current text, never at the text last rendered.
 * - F-O10 (the truth invariant, R7's gate, checked here on the shadow) —
 *   after a settle every content equals its cell and the root holds its
 *   cells' elements; nothing the renderer wrote is a divergence.
 *
 * Expected values come from the plan rows, never from running the code.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Y } from '$lib/crdt/engine.js';
import { attachDocument } from '$lib/crdt/document.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import { mentionPlugin } from '$lib/plugins/mention/MentionPlugin.svelte';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import type { JSONDoc } from '$lib/utils/json.js';
import {
	dispatchComposition,
	dispatchDomBeforeInput,
	dispatchDomInput,
	dispatchDomKeyDown,
	flushDomUpdates,
	renderDomEdytor,
	setNativeSelection
} from '../../dom/test.utils.js';
import { shadowEntries } from '../../dom/observerShadow.js';
import { fold, foldPlugin } from '../../dom/R6FoldKind.svelte';
import { effectDispatcher } from '../../dom/r6Effects.svelte.js';
import type { Finding, ShadowEntry } from '../../oracles/observer-shadow.js';

/** Red on the reference (`arch-v2/ref-r6`: no surface observer); flipped to `it` by R6. */
const row = it;

afterEach(() => {
	vi.restoreAllMocks();
	fold.open = true;
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const ANDROID_CHROME_UA =
	'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
const asAndroid = () => {
	Object.defineProperty(window.navigator, 'userAgent', {
		get: () => ANDROID_CHROME_UA,
		configurable: true
	});
	return () => {
		delete (window.navigator as { userAgent?: string }).userAgent;
	};
};

/** A remote peer on a replica of the mounted document; `deliver` applies its writes here. */
const peer = (edytor: Edytor) => {
	const remoteDoc = new Y.Doc();
	Y.applyUpdate(remoteDoc, Y.encodeStateAsUpdate(edytor.doc));
	const remote = attachDocument(remoteDoc);
	return {
		facade: remote.facade,
		deliver: () =>
			Y.applyUpdate(edytor.doc, Y.encodeStateAsUpdate(remoteDoc, Y.encodeStateVector(edytor.doc)))
	};
};

const plugins = [richTextPlugin, mentionPlugin, foldPlugin];

const mount = (value: JSONDoc, caret = true) =>
	renderDomEdytor(<root></root>, { plugins, value, autoSelectFixture: caret });

// ── the shadow's logs ────────────────────────────────────────────────────

/** A log position: entries logged after it are the step's. */
const mark = () => shadowEntries().length;
const since = (edytor: Edytor, from: number) =>
	shadowEntries()
		.slice(from)
		.filter((entry) => entry.view === edytor.presenceKey);
const passes = (edytor: Edytor, from: number) =>
	since(edytor, from).filter(
		(entry): entry is Extract<ShadowEntry, { src: 'pass' }> => entry.src === 'pass'
	);
const findings = (edytor: Edytor, from: number): Finding[] =>
	passes(edytor, from).flatMap((pass) => pass.findings);
/** Findings that call for an action (adopt or invert). */
const divergences = (edytor: Edytor, from: number) =>
	findings(edytor, from).filter((f) => f.verdict === 'adopt' || f.verdict === 'invert');
const actions = (edytor: Edytor, from: number) =>
	since(edytor, from).filter(
		(entry): entry is Extract<ShadowEntry, { src: 'observer' }> => entry.src === 'observer'
	);

/** The settle check: every content and the root compared once more (F-O10). */
const settle = async (edytor: Edytor) => {
	const from = mark();
	edytor.surface.check();
	await flushDomUpdates();
	return passes(edytor, from);
};

const blockId = (edytor: Edytor, index: number) => edytor.root!.children[index]!.id;
const hostOf = (edytor: Edytor, index: number) => edytor.root!.children[index]!.firstText!;
const textNodes = (element: Node) => {
	const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
	const out: globalThis.Text[] = [];
	while (walker.nextNode()) out.push(walker.currentNode as globalThis.Text);
	return out.filter((node) => node.data.length > 0);
};
const domText = (edytor: Edytor, index: number) =>
	(hostOf(edytor, index).node?.textContent ?? '').replace(/\u200B/g, '');
const modelText = (edytor: Edytor, index: number) =>
	edytor.facade.blockText(blockId(edytor, index)) ?? '';

/** The browser rewrites a text node of block `index` (an autocorrect, an IME, a drift). */
const browserEdit = (edytor: Edytor, index: number, value: string, node = 0) => {
	textNodes(hostOf(edytor, index).node!)[node]!.data = value;
};

/** Apply a snapshot's placement to a text: what adopting it gives. */
const applied = (text: string, place: { at: number; remove: number; insert: string }) =>
	text.slice(0, place.at) + place.insert + text.slice(place.at + place.remove);

const snapshots = (edytor: Edytor, from: number) =>
	findings(edytor, from).filter((f) => f.why === 'snapshot');

const paragraph = (text: string, id?: string) => ({
	type: 'paragraph',
	...(id && { id }),
	content: [{ text }]
});

// ── F-O2 ─────────────────────────────────────────────────────────────────

describe('F-O2 — view state renders into the host without divergence', () => {
	row(
		'outside a composition: selection attributes, a readonly flip, suggestions and extension view state',
		async () => {
			const { edytor } = await mount({
				children: [
					paragraph('Hello'),
					{ type: 'fold', content: [{ text: 'Folded' }] },
					paragraph('Tail')
				]
			});
			const from = mark();
			const first = blockId(edytor, 0);
			const element = () => edytor.idToBlock.block(first).node!;

			edytor.selection.select({ kind: 'blocks', ids: [first] });
			await flushDomUpdates();
			// The selection-driven attributes are rendered (R11): drawn by the renderer.
			expect(element().getAttribute('data-edytor-selected')).toBe('true');
			edytor.selection.select(edytor.selection.textValue(hostOf(edytor, 0), 5));
			await flushDomUpdates();
			expect(element().hasAttribute('data-edytor-selected')).toBe(false);
			expect(element().getAttribute('data-edytor-focused')).toBe('true');

			edytor.readonly = true;
			await flushDomUpdates();
			edytor.readonly = false;
			await flushDomUpdates();

			edytor.idToBlock.block(first).suggestions = [[{ text: ' world' }]];
			await flushDomUpdates();
			edytor.idToBlock.block(first).suggestions = null;
			await flushDomUpdates();

			fold.open = false;
			edytor.surface.update();
			await flushDomUpdates();
			fold.open = true;
			edytor.surface.update();
			await flushDomUpdates();

			expect(passes(edytor, from).length).toBeGreaterThan(0);
			expect(divergences(edytor, from)).toEqual([]);
			const check = await settle(edytor);
			expect(check.flatMap((pass) => pass.findings)).toEqual([]);
			expect(check.flatMap((pass) => pass.equal)).toContain(first);
		}
	);

	row(
		'during a live composition: renders find no divergence, the preview is the IME’s, one commit, the tail inverts a late change',
		async () => {
			const { edytor, editor } = await mount({
				children: [
					paragraph('Hello|'),
					{ type: 'fold', content: [{ text: 'Folded' }] },
					paragraph('other')
				]
			});
			const remote = peer(edytor);
			const host = blockId(edytor, 0);
			const other = blockId(edytor, 2);

			await dispatchComposition(editor, [{ type: 'compositionstart' }]);
			await dispatchComposition(editor, [
				{ type: 'beforeinput', inputType: 'insertCompositionText', data: 'n' }
			]);
			const from = mark();
			// The IME redraws its buffer itself (no beforeinput): the host diverges from its cell.
			browserEdit(edytor, 0, 'Helloに');
			await flushDomUpdates();

			edytor.idToBlock.block(other).suggestions = [[{ text: ' ghost' }]];
			await flushDomUpdates();
			fold.open = false;
			edytor.surface.update();
			await flushDomUpdates();
			remote.facade.insertText(other, 0, 'R');
			remote.deliver();
			await flushDomUpdates();
			edytor.idToBlock.block(other).suggestions = null;
			fold.open = true;
			edytor.surface.update();
			await flushDomUpdates();

			expect(edytor.composition.live).toBe(true);
			const during = findings(edytor, from);
			expect(during.some((f) => f.block === host && f.verdict === 'ime')).toBe(true);
			// Only the IME host diverges, and it is never classified for action.
			expect(during.filter((f) => f.verdict !== 'ime')).toEqual([]);
			expect(actions(edytor, from).filter((a) => a.live)).toEqual([]);

			await dispatchComposition(editor, [{ type: 'compositionend', data: 'に' }]);
			await flushDomUpdates();
			expect(modelText(edytor, 0)).toBe('Helloに');
			expect(domText(edytor, 0)).toBe('Helloに');

			// A late composition change in the tail: resolved to the committed text.
			const late = mark();
			browserEdit(edytor, 0, 'Helloにに');
			await dispatchDomInput(editor, { inputType: 'insertCompositionText', data: 'に' });
			await wait(120);
			await flushDomUpdates();
			expect(findings(edytor, late)).toContainEqual({
				block: host,
				verdict: 'invert',
				why: 'tail'
			});
			expect(modelText(edytor, 0)).toBe('Helloに');
			expect(domText(edytor, 0)).toBe('Helloに');
		}
	);
});

// ── F-O8 ─────────────────────────────────────────────────────────────────

describe('F-O8 — writes made while handling or flushing leave no divergence', () => {
	row(
		'a remote update in a keydown handler, an extension $effect dispatching a command, an update inside another transaction’s observer; the next keystroke is adopted once',
		async () => {
			const { edytor, editor } = await mount({
				children: [paragraph('Hello|'), paragraph('world')]
			});
			const remote = peer(edytor);
			const first = blockId(edytor, 0);
			const second = blockId(edytor, 1);
			const from = mark();

			const onKey = () => {
				remote.facade.insertText(second, 0, 'K');
				remote.deliver();
			};
			editor.addEventListener('keydown', onKey, { capture: true });
			await dispatchDomKeyDown(editor, { key: 'Shift' });
			editor.removeEventListener('keydown', onKey, { capture: true });
			await flushDomUpdates();
			expect(modelText(edytor, 1)).toBe('Kworld');

			const effect = effectDispatcher(() =>
				edytor.transact(() => edytor.facade.insertText(second, 1, 'E'))
			);
			effect.fire();
			await flushDomUpdates();
			effect.stop();
			expect(modelText(edytor, 1)).toBe('KEworld');

			let nested = true;
			const off = edytor.facade.onChange(() => {
				if (!nested) return;
				nested = false;
				remote.facade.insertText(second, 0, 'N');
				remote.deliver();
			});
			remote.facade.insertText(first, 0, 'P');
			remote.deliver();
			await flushDomUpdates();
			off();
			expect(modelText(edytor, 0)).toBe('PHello');
			expect(modelText(edytor, 1)).toBe('NKEworld');

			expect(divergences(edytor, from)).toEqual([]);
			expect(domText(edytor, 0)).toBe('PHello');
			expect(domText(edytor, 1)).toBe('NKEworld');

			// The next keystroke, made by the browser, is adopted once.
			const typed = mark();
			const node = textNodes(hostOf(edytor, 0).node!)[0]!;
			node.data = 'PHellox';
			await setNativeSelection(edytor, hostOf(edytor, 0), 7);
			await dispatchDomInput(editor, { inputType: 'insertText', data: 'x' });
			await flushDomUpdates();
			expect(modelText(edytor, 0)).toBe('PHellox');
			expect(actions(edytor, typed).filter((a) => a.action === 'adopt')).toHaveLength(1);
			expect(divergences(edytor, typed).filter((f) => f.verdict === 'invert')).toEqual([]);
			const check = await settle(edytor);
			expect(check.flatMap((pass) => pass.findings)).toEqual([]);
		}
	);
});

// ── F-O13 (b), (d), (e): the snapshot log ────────────────────────────────

describe('F-O13 — a browser edit and a same-task model change: the snapshot places the edit', () => {
	/** Autocorrect `teh` → `the` in block `index`, then `change` in the same task; the snapshot. */
	const autocorrectThen = async (
		edytor: Edytor,
		change: () => void,
		{ index = 0, from: text = 'teh', to = 'the', segment = 0 } = {}
	) => {
		const start = mark();
		const element = edytor.textAt(blockId(edytor, index), segment).node!;
		const current = textNodes(element)[0]!;
		current.data = current.data.replace(text, to);
		change();
		await flushDomUpdates();
		return snapshots(edytor, start);
	};

	row(
		'(b) the autocorrect, then a remote insert in its task: placed where it was typed',
		async () => {
			const { edytor } = await mount({ children: [paragraph('teh cat|')] });
			const remote = peer(edytor);
			const id = blockId(edytor, 0);
			const [snapshot] = await autocorrectThen(edytor, () => {
				remote.facade.insertText(id, 7, '!');
				remote.deliver();
			});
			expect(snapshot?.place).toEqual({ block: id, at: 1, remove: 2, insert: 'he' });
			expect(applied('teh cat!', snapshot!.place as never)).toBe('the cat!');
		}
	);

	row('(b) the other order: a remote insert, then the autocorrect in the same task', async () => {
		const { edytor } = await mount({ children: [paragraph('teh cat|')] });
		const remote = peer(edytor);
		const id = blockId(edytor, 0);
		const start = mark();
		remote.facade.insertText(id, 0, 'X');
		remote.deliver();
		browserEdit(edytor, 0, 'the cat');
		await flushDomUpdates();
		const [snapshot] = snapshots(edytor, start);
		expect(snapshot?.place).toEqual({ block: id, at: 2, remove: 2, insert: 'he' });
		expect(applied('Xteh cat', snapshot!.place as never)).toBe('Xthe cat');
	});

	row('(e) a remote format of the autocorrected run', async () => {
		const { edytor } = await mount({ children: [paragraph('teh cat|')] });
		const remote = peer(edytor);
		const id = blockId(edytor, 0);
		const [snapshot] = await autocorrectThen(edytor, () => {
			remote.facade.formatRange(id, 0, 3, { bold: true });
			remote.deliver();
		});
		expect(snapshot?.place).toEqual({ block: id, at: 1, remove: 2, insert: 'he' });
	});

	row('(e) a mark-nesting change over the run', async () => {
		const { edytor } = await mount({
			children: [
				{
					type: 'paragraph',
					content: [{ text: 'teh ', marks: { bold: true } }, { text: 'cat' }]
				}
			]
		});
		const remote = peer(edytor);
		const id = blockId(edytor, 0);
		const [snapshot] = await autocorrectThen(edytor, () => {
			remote.facade.formatRange(id, 0, 7, { italic: true });
			remote.deliver();
		});
		expect(snapshot?.place).toEqual({ block: id, at: 1, remove: 2, insert: 'he' });
	});

	row('(e) a retype of its block', async () => {
		const { edytor } = await mount({ children: [paragraph('teh cat|')] });
		const remote = peer(edytor);
		const id = blockId(edytor, 0);
		const [snapshot] = await autocorrectThen(edytor, () => {
			remote.facade.setBlockType(id, 'heading');
			remote.deliver();
		});
		expect(snapshot?.place).toEqual({ block: id, at: 1, remove: 2, insert: 'he' });
	});

	row('(e) the deletion of the atom before it', async () => {
		const { edytor } = await mount({
			children: [
				{
					type: 'paragraph',
					content: [
						{ text: 'a' },
						{ type: 'mention', id: 'm1', data: { name: 'x' } },
						{ text: 'teh cat' }
					]
				}
			]
		});
		const remote = peer(edytor);
		const id = blockId(edytor, 0);
		const [snapshot] = await autocorrectThen(
			edytor,
			() => {
				remote.facade.deleteText(id, 1, 1);
				remote.deliver();
			},
			{ segment: 1 }
		);
		// Base `a@teh cat` (the atom one unit): the correction at 3 lands at 2 once the atom is gone.
		expect(snapshot?.place).toEqual({ block: id, at: 2, remove: 2, insert: 'he' });
		expect(applied('ateh cat', snapshot!.place as never)).toBe('athe cat');
	});

	row('(e) a move of its block: its element moves, the edit is still there to adopt', async () => {
		const { edytor } = await mount({ children: [paragraph('first'), paragraph('teh cat')] });
		const remote = peer(edytor);
		const id = blockId(edytor, 1);
		const start = mark();
		const moved = await autocorrectThen(
			edytor,
			() => {
				remote.facade.moveBlock(id, { parent: null, index: 0 });
				remote.deliver();
			},
			{ index: 1 }
		);
		// A keyed move keeps the element and its text: nothing to snapshot; the
		// compare pass finds the correction and adopts it where it was typed.
		expect(moved).toEqual([]);
		expect(findings(edytor, start)).toContainEqual({
			block: id,
			verdict: 'adopt',
			why: 'location'
		});
		expect(domText(edytor, 0)).toBe('the cat');
	});

	row('(e) a split before it: the correction follows its text into the new block', async () => {
		const { edytor } = await mount({ children: [paragraph('xx teh cat')] });
		const remote = peer(edytor);
		const id = blockId(edytor, 0);
		const [snapshot] = await autocorrectThen(edytor, () => {
			remote.facade.splitBlock(id, 3, 'peer-split', { type: 'paragraph' });
			remote.deliver();
		});
		expect(snapshot?.place).toEqual({ block: 'peer-split', at: 1, remove: 2, insert: 'he' });
		expect(applied('teh cat', snapshot!.place as never)).toBe('the cat');
	});

	row(
		'(d) Android drift of an applied prevented Backspace plus a same-task change: inverted to the current cell',
		async () => {
			const restore = asAndroid();
			try {
				const { edytor, editor } = await mount({ children: [paragraph('hel|lo')] });
				const remote = peer(edytor);
				const id = blockId(edytor, 0);
				const start = mark();
				const event = new Event('beforeinput', { bubbles: true, cancelable: true }) as InputEvent;
				Object.defineProperties(event, {
					inputType: { value: 'deleteContentBackward' },
					data: { value: null },
					dataTransfer: { value: null }
				});
				hostOf(edytor, 0).node!.dispatchEvent(event);
				expect(event.defaultPrevented).toBe(true);
				// Android deletes anyway, then a same-task change lands on the run.
				browserEdit(edytor, 0, 'helo');
				remote.facade.insertText(id, 0, 'X');
				remote.deliver();
				await flushDomUpdates();
				await wait(150);
				await flushDomUpdates();
				expect(modelText(edytor, 0)).toBe('Xhelo');
				expect(findings(edytor, start)).toContainEqual({
					block: id,
					verdict: 'invert',
					why: 'drift'
				});
				expect(snapshots(edytor, start)).toEqual([]);
				expect(domText(edytor, 0)).toBe('Xhelo');
				void editor;
			} finally {
				restore();
			}
		}
	);
});

// ── F-O10 on the shadow ──────────────────────────────────────────────────

describe('F-O10 — after a settle every content equals its cell (the truth invariant)', () => {
	row(
		'typing, Enter, Backspace, bold, undo and a remote edit: no divergence the renderer wrote',
		async () => {
			const { edytor, editor } = await mount({
				children: [paragraph('Hello|'), paragraph('world')]
			});
			const remote = peer(edytor);
			const from = mark();
			await dispatchDomBeforeInput(editor, { inputType: 'insertText', data: 'x' });
			await dispatchDomBeforeInput(editor, { inputType: 'insertParagraph' });
			await dispatchDomBeforeInput(editor, { inputType: 'insertText', data: 'y' });
			await dispatchDomBeforeInput(editor, { inputType: 'deleteContentBackward' });
			await dispatchDomBeforeInput(editor, { inputType: 'deleteContentBackward' });
			await setNativeSelection(edytor, hostOf(edytor, 0), 0, hostOf(edytor, 0), 3);
			await dispatchDomBeforeInput(editor, { inputType: 'formatBold' });
			await dispatchDomBeforeInput(editor, { inputType: 'historyUndo' });
			remote.facade.insertText(blockId(edytor, 1), 0, 'R');
			remote.deliver();
			await flushDomUpdates();
			expect(divergences(edytor, from)).toEqual([]);
			const check = await settle(edytor);
			expect(check.flatMap((pass) => pass.findings)).toEqual([]);
			const compared = check.flatMap((pass) => pass.equal);
			for (const block of edytor.root!.children) expect(compared).toContain(block.id);
			expect(compared).toContain(null);
		}
	);

	row('foreign damage is a divergence: a removed text element, a foreign root child', async () => {
		const { edytor } = await mount({ children: [paragraph('Hello'), paragraph('world')] });
		const from = mark();
		const second = hostOf(edytor, 1).node!;
		second.remove();
		await flushDomUpdates();
		const intruder = document.createElement('div');
		intruder.textContent = 'foreign';
		edytor.node!.insertBefore(intruder, edytor.node!.firstChild);
		await flushDomUpdates();
		const seen = findings(edytor, from);
		expect(seen).toContainEqual({ block: blockId(edytor, 1), verdict: 'invert', why: 'missing' });
		expect(seen).toContainEqual({ block: null, verdict: 'invert', why: 'root-child' });
	});
});
