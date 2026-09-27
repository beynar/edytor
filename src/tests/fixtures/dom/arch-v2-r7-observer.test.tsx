/** @jsxImportSource ../../jsx */
/**
 * arch-v2 — checkpoint R7 rows (dom lane): the observer compares with truth
 * and acts on the passes alone (plan §1.2 R11, R12; §2.4 "Divergence set";
 * §4.4 `surface/observer`; §8.7 F-O2, F-O8, F-O10, F-O13; §8.5 F-P17, F-P20;
 * §9.3 R7; the orchestrator's answers to R6's questions (a)–(f)).
 *
 * R6's rows read the shadow's verdict log; these assert the real outcome —
 * the document, the host DOM and the truth invariant (`truthOf`,
 * `src/tests/oracles/truth.ts`: every content equals its cell, strict
 * containers hold only what the cells render). Expected values come from the
 * plan rows and the answers, never from running the code.
 *
 * - F-O2 — view state renders (selection attributes, a readonly flip,
 *   suggestions, extension view state) leave the host equal to its cells and
 *   re-create no text element; during a composition the preview is the IME's
 *   (never inverted or adopted), the session commits once, and a late change
 *   in the tail is inverted to the committed text.
 * - F-O8 — writes made while handling or flushing leave no divergence; the
 *   next browser keystroke is adopted once (one undo step removes it).
 * - F-O13 (a), (b), (e) — an autocorrect plus a same-task model change: the
 *   correction is adopted once, where it was typed (through the anchor minted
 *   at the edit, answer (a)), and the concurrent change stands; (c) an
 *   extension's unowned attribute on a block element and a style on a mark
 *   element are never inverted; (d) Android drift plus a same-task change
 *   ends at the cell's current text.
 * - F-O10 — after a command program the host equals its cells; a removed
 *   text element is re-inserted and a foreign root child removed.
 * - Answers: (b) D-25, a foreign node beside a text element (the kind's own
 *   markup) stays and never reaches the model; (c) a foreign element with text
 *   inside a text element: its text is adopted and the element removed; (d)
 *   WebKit's converted space is adopted once as a space, and no leftover
 *   node is adopted again; (e) a registered code-line element a foreign script
 *   removed is re-inserted (the vanishing code line; the browser row is in
 *   `tests/editor-dom/arch-v2-r7-observer.spec.ts`); (f) one render epoch,
 *   owned by the surface.
 * - F-P17 (b), (c) — a read-only rewrite stays until the flip back, then is
 *   inverted; an extension's `id` on a block element stays. F-P20 — in a
 *   read-only view a foreign annotation wrapper stays and a damaged identity
 *   attribute is healed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Y } from '$lib/crdt/engine.js';
import { attachDocument } from '$lib/crdt/document.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { Plugin } from '$lib/plugins.js';
import { mentionPlugin } from '$lib/plugins/mention/MentionPlugin.svelte';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { codePlugin } from '$lib/plugins/code/CodePlugin.svelte';
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
import { fold, foldPlugin } from '../../dom/R6FoldKind.svelte';
import { effectDispatcher } from '../../dom/r6Effects.svelte.js';
import { truthOf } from '../../oracles/truth.js';

/** Rows; those red on the reference (`arch-v2/ref-r7`) were `it.fails` in the tests-first commit. */
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

const mount = (value: JSONDoc, options: { plugins?: Plugin[]; readonly?: boolean } = {}) =>
	renderDomEdytor(<root></root>, {
		plugins: options.plugins ?? plugins,
		readonly: options.readonly,
		value
	});

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
const textOfId = (edytor: Edytor, id: string) => edytor.facade.blockText(id) ?? '';

/** The browser rewrites a text node of block `index` (an autocorrect, an IME, a drift). */
const browserEdit = (edytor: Edytor, index: number, value: string, node = 0) => {
	textNodes(hostOf(edytor, index).node!)[node]!.data = value;
};

const paragraph = (text: string, id?: string) => ({
	type: 'paragraph',
	...(id && { id }),
	content: [{ text }]
});

/** The host after a settle: no divergence from the cells (F-O10). */
const settled = async (edytor: Edytor) => {
	await flushDomUpdates();
	await wait(20);
	await flushDomUpdates();
	return truthOf(edytor);
};

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
			const first = blockId(edytor, 0);
			const element = () => edytor.idToBlock.block(first).node!;
			const texts = () => edytor.root!.children.map((block) => block.firstText!.node);
			const before = texts();

			edytor.selection.select({ kind: 'blocks', ids: [first] });
			await flushDomUpdates();
			expect(element().getAttribute('data-edytor-selected')).toBe('true');
			edytor.selection.select(edytor.selection.textValue(hostOf(edytor, 0), 5));
			await flushDomUpdates();
			expect(element().hasAttribute('data-edytor-selected')).toBe(false);

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

			expect(await settled(edytor)).toEqual([]);
			// No render of view state is read as damage: no text element was re-created.
			expect(texts()).toEqual(before);
			expect(edytor.root!.children.map((_, i) => modelText(edytor, i))).toEqual([
				'Hello',
				'Folded',
				'Tail'
			]);
		}
	);

	row(
		'during a live composition: the preview is the IME’s, one commit, the tail inverts a late change',
		async () => {
			const { edytor, editor } = await mount({
				children: [
					paragraph('Hello|'),
					{ type: 'fold', content: [{ text: 'Folded' }] },
					paragraph('other')
				]
			});
			const remote = peer(edytor);
			const other = blockId(edytor, 2);
			const hostElement = hostOf(edytor, 0).node!;

			await dispatchComposition(editor, [{ type: 'compositionstart' }]);
			await dispatchComposition(editor, [
				{ type: 'beforeinput', inputType: 'insertCompositionText', data: 'n' }
			]);
			// The IME redraws its buffer itself (no beforeinput).
			browserEdit(edytor, 0, 'Helloに');
			const preview = textNodes(hostElement)[0];
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

			// The preview is the IME's: neither inverted nor adopted, its node kept.
			expect(edytor.composition.live).toBe(true);
			expect(hostOf(edytor, 0).node).toBe(hostElement);
			expect(textNodes(hostElement)[0]).toBe(preview);
			expect(domText(edytor, 0)).toBe('Helloに');
			expect(modelText(edytor, 2)).toBe('Rother');
			expect(truthOf(edytor).filter((line) => !line.startsWith(blockId(edytor, 0)))).toEqual([]);

			await dispatchComposition(editor, [{ type: 'compositionend', data: 'に' }]);
			await flushDomUpdates();
			expect(modelText(edytor, 0)).toBe('Helloに');
			expect(domText(edytor, 0)).toBe('Helloに');

			// A late composition change in the tail: resolved to the committed text.
			browserEdit(edytor, 0, 'Helloにに');
			await dispatchDomInput(editor, { inputType: 'insertCompositionText', data: 'に' });
			await wait(120);
			expect(modelText(edytor, 0)).toBe('Helloに');
			expect(await settled(edytor)).toEqual([]);
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

			const onKey = () => {
				remote.facade.insertText(second, 0, 'K');
				remote.deliver();
			};
			editor.addEventListener('keydown', onKey, { capture: true });
			await dispatchDomKeyDown(editor, { key: 'Shift' });
			editor.removeEventListener('keydown', onKey, { capture: true });
			await flushDomUpdates();

			const effect = effectDispatcher(() =>
				edytor.transact(() => edytor.facade.insertText(second, 1, 'E'))
			);
			effect.fire();
			await flushDomUpdates();
			effect.stop();

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
			expect(await settled(edytor)).toEqual([]);

			// The next keystroke, made by the browser, is adopted once: one undo step removes it.
			const node = textNodes(hostOf(edytor, 0).node!)[0]!;
			node.data = 'PHellox';
			await setNativeSelection(edytor, hostOf(edytor, 0), 7);
			await dispatchDomInput(editor, { inputType: 'insertText', data: 'x' });
			await flushDomUpdates();
			expect(modelText(edytor, 0)).toBe('PHellox');
			expect(await settled(edytor)).toEqual([]);
			edytor.historyUndo();
			await flushDomUpdates();
			expect(modelText(edytor, 0)).toBe('PHello');
			expect(domText(edytor, 0)).toBe('PHello');
		}
	);
});

// ── F-O13: a browser edit and a same-task model change ────────────────────

describe('F-O13 — the correction is adopted once, where it was typed; the concurrent change stands', () => {
	/** Autocorrect `teh` → `the` in block `index`, then `change` in the same task. */
	const autocorrectThen = async (
		edytor: Edytor,
		change: () => void,
		{ index = 0, segment = 0 } = {}
	) => {
		const element = edytor.textAt(blockId(edytor, index), segment).node!;
		const current = textNodes(element)[0]!;
		current.data = current.data.replace('teh', 'the');
		change();
		return settled(edytor);
	};

	row('(b) the autocorrect, then a remote insert in its task', async () => {
		const { edytor } = await mount({ children: [paragraph('teh cat|')] });
		const remote = peer(edytor);
		const id = blockId(edytor, 0);
		const truth = await autocorrectThen(edytor, () => {
			remote.facade.insertText(id, 7, '!');
			remote.deliver();
		});
		expect(textOfId(edytor, id)).toBe('the cat!');
		expect(truth).toEqual([]);
	});

	row('(b) the other order: a remote insert, then the autocorrect in the same task', async () => {
		const { edytor } = await mount({ children: [paragraph('teh cat|')] });
		const remote = peer(edytor);
		const id = blockId(edytor, 0);
		remote.facade.insertText(id, 0, 'X');
		remote.deliver();
		browserEdit(edytor, 0, 'the cat');
		expect(await settled(edytor)).toEqual([]);
		expect(textOfId(edytor, id)).toBe('Xthe cat');
	});

	row('(e) a remote format of the autocorrected run', async () => {
		const { edytor } = await mount({ children: [paragraph('teh cat|')] });
		const remote = peer(edytor);
		const id = blockId(edytor, 0);
		const truth = await autocorrectThen(edytor, () => {
			remote.facade.formatRange(id, 0, 3, { bold: true });
			remote.deliver();
		});
		expect(textOfId(edytor, id)).toBe('the cat');
		expect(truth).toEqual([]);
		// The concurrent format stands on the characters the correction kept.
		expect(edytor.root!.children[0]!.value.content?.[0]).toMatchObject({
			marks: { bold: true }
		});
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
		const truth = await autocorrectThen(edytor, () => {
			remote.facade.formatRange(id, 0, 7, { italic: true });
			remote.deliver();
		});
		expect(textOfId(edytor, id)).toBe('the cat');
		expect(truth).toEqual([]);
		expect(
			edytor.root!.children[0]!.value.content?.every(
				(part) => 'marks' in part && part.marks?.italic
			)
		).toBe(true);
	});

	row('(e) a retype of its block', async () => {
		const { edytor } = await mount({ children: [paragraph('teh cat|')] });
		const remote = peer(edytor);
		const id = blockId(edytor, 0);
		const truth = await autocorrectThen(edytor, () => {
			remote.facade.setBlockType(id, 'heading');
			remote.deliver();
		});
		expect(edytor.root!.children[0]!.type).toBe('heading');
		expect(textOfId(edytor, id)).toBe('the cat');
		expect(truth).toEqual([]);
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
		const truth = await autocorrectThen(
			edytor,
			() => {
				remote.facade.deleteText(id, 1, 1);
				remote.deliver();
			},
			{ segment: 1 }
		);
		expect(textOfId(edytor, id)).toBe('athe cat');
		expect(truth).toEqual([]);
	});

	row('(e) a move of its block', async () => {
		const { edytor } = await mount({ children: [paragraph('first'), paragraph('teh cat')] });
		const remote = peer(edytor);
		const id = blockId(edytor, 1);
		const truth = await autocorrectThen(
			edytor,
			() => {
				remote.facade.moveBlock(id, { parent: null, index: 0 });
				remote.deliver();
			},
			{ index: 1 }
		);
		expect(blockId(edytor, 0)).toBe(id);
		expect(textOfId(edytor, id)).toBe('the cat');
		expect(truth).toEqual([]);
	});

	row('(e) a split before it: the correction follows its text into the new block', async () => {
		const { edytor } = await mount({ children: [paragraph('xx teh cat')] });
		const remote = peer(edytor);
		const id = blockId(edytor, 0);
		const truth = await autocorrectThen(edytor, () => {
			remote.facade.splitBlock(id, 3, 'peer-split', { type: 'paragraph' });
			remote.deliver();
		});
		expect(textOfId(edytor, id)).toBe('xx ');
		expect(textOfId(edytor, 'peer-split')).toBe('the cat');
		expect(truth).toEqual([]);
	});

	row(
		'(c) an extension’s unowned attribute on a block element and a style on a mark element stay',
		async () => {
			const { edytor } = await mount({
				children: [{ type: 'paragraph', content: [{ text: 'bold', marks: { bold: true } }] }]
			});
			const block = edytor.root!.children[0]!.node!;
			const mark = block.querySelector<HTMLElement>('[data-edytor-mark="bold"]')!;
			block.setAttribute('data-extension-state', 'open');
			mark.style.backgroundColor = 'yellow';
			expect(await settled(edytor)).toEqual([]);
			expect(block.getAttribute('data-extension-state')).toBe('open');
			expect(block.querySelector('[data-edytor-mark="bold"]')).toBe(mark);
			expect(mark.style.backgroundColor).toBe('yellow');
		}
	);

	row(
		'(d) Android drift of an applied prevented Backspace plus a same-task change: the cell’s current text',
		async () => {
			const restore = asAndroid();
			try {
				const { edytor } = await mount({ children: [paragraph('hel|lo')] });
				const remote = peer(edytor);
				const id = blockId(edytor, 0);
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
				expect(modelText(edytor, 0)).toBe('Xhelo');
				expect(await settled(edytor)).toEqual([]);
				expect(domText(edytor, 0)).toBe('Xhelo');
			} finally {
				restore();
			}
		}
	);
});

// ── F-O10 ────────────────────────────────────────────────────────────────

describe('F-O10 — after a settle every content equals its cell (the truth invariant)', () => {
	row('typing, Enter, Backspace, bold, undo and a remote edit', async () => {
		const { edytor, editor } = await mount({ children: [paragraph('Hello|'), paragraph('world')] });
		const remote = peer(edytor);
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
		expect(await settled(edytor)).toEqual([]);
	});

	row(
		'a text element a foreign script removed is re-inserted; the model is unchanged',
		async () => {
			const { edytor } = await mount({ children: [paragraph('Hello'), paragraph('world')] });
			const second = hostOf(edytor, 1).node!;
			second.remove();
			expect(await settled(edytor)).toEqual([]);
			expect(second.isConnected).toBe(true);
			expect(modelText(edytor, 1)).toBe('world');
		}
	);

	row('a foreign root child is removed; the model is unchanged', async () => {
		const { edytor } = await mount({ children: [paragraph('Hello'), paragraph('world')] });
		const intruder = document.createElement('div');
		intruder.textContent = 'foreign';
		edytor.node!.insertBefore(intruder, edytor.node!.firstChild);
		expect(await settled(edytor)).toEqual([]);
		expect(intruder.isConnected).toBe(false);
		expect(edytor.root!.children.map((_, i) => modelText(edytor, i))).toEqual(['Hello', 'world']);
	});
});

// ── The orchestrator's answers to R6's questions ──────────────────────────

describe('answers (b)–(f): what the observer does with each divergence', () => {
	row(
		'(b) D-25: a foreign node beside a text element stays and never reaches the model',
		async () => {
			const { edytor } = await mount({ children: [paragraph('Hello')] });
			const markup = edytor.root!.children[0]!.node!.querySelector('p')!;
			const beside = document.createElement('span');
			beside.textContent = ' injected';
			markup.append(beside);
			expect(await settled(edytor)).toEqual([]);
			expect(beside.isConnected).toBe(true);
			expect(modelText(edytor, 0)).toBe('Hello');
		}
	);

	row(
		'(c) a foreign element with text inside a text element: its text is adopted, the element removed',
		async () => {
			const { edytor } = await mount({ children: [paragraph('Hello')] });
			const spoof = document.createElement('span');
			spoof.setAttribute('data-edytor-mark', 'evil-mark');
			spoof.textContent = 'x';
			hostOf(edytor, 0).node!.append(spoof);
			expect(await settled(edytor)).toEqual([]);
			expect(modelText(edytor, 0)).toBe('Hellox');
			expect(domText(edytor, 0)).toBe('Hellox');
			expect(spoof.isConnected).toBe(false);
		}
	);

	row(
		'(d) WebKit’s converted space is adopted once as a space; no leftover node is adopted again',
		async () => {
			const { edytor } = await mount({ children: [paragraph('lead|')] });
			const converted = document.createElement('span');
			converted.className = 'Apple-converted-space';
			converted.textContent = '\u00A0';
			hostOf(edytor, 0).node!.append(converted);
			expect(await settled(edytor)).toEqual([]);
			await wait(50);
			expect(modelText(edytor, 0)).toBe('lead ');
			expect(domText(edytor, 0)).toBe('lead ');
			expect(hostOf(edytor, 0).node!.querySelector('.Apple-converted-space')).toBeNull();
			expect(textNodes(hostOf(edytor, 0).node!)).toHaveLength(1);
		}
	);

	row('(e) a code line a foreign script removed is re-inserted', async () => {
		const { edytor } = await mount(
			{
				children: [
					{
						type: 'code',
						children: [
							{ type: 'codeLine', content: [{ text: 'const a = 1;' }] },
							{ type: 'codeLine', content: [{ text: 'return a;' }] }
						]
					}
				]
			},
			{ plugins: [richTextPlugin, mentionPlugin, codePlugin] }
		);
		const code = edytor.root!.children[0]!;
		const line = code.children[0]!.node!;
		line.remove();
		expect(await settled(edytor)).toEqual([]);
		expect(line.isConnected).toBe(true);
		expect(code.children.map((child) => edytor.facade.blockText(child.id))).toEqual([
			'const a = 1;',
			'return a;'
		]);
	});

	row(
		'(f) one render epoch: a remote commit bumps the surface’s epoch the projector reads',
		async () => {
			const { edytor } = await mount({ children: [paragraph('Hello|')] });
			const remote = peer(edytor);
			expect((edytor.projector as unknown as { render?: number }).render).toBeUndefined();
			const epoch = edytor.surface.epoch;
			remote.facade.insertText(blockId(edytor, 0), 0, 'R');
			remote.deliver();
			await flushDomUpdates();
			expect(edytor.surface.epoch).toBeGreaterThan(epoch);
			expect(edytor.selection.state.yStart).toBe(6);
		}
	);
});

// ── F-P17 (b), (c), F-P20 ────────────────────────────────────────────────

describe('F-P17 / F-P20 — read-only views and extension attributes', () => {
	row('F-P17 (b) a read-only rewrite stays until the flip back, then is inverted', async () => {
		const { edytor } = await mount({ children: [paragraph('Hello'), paragraph('world')] });
		edytor.readonly = true;
		await flushDomUpdates();
		browserEdit(edytor, 0, 'Hacked');
		await flushDomUpdates();
		await wait(20);
		expect(domText(edytor, 0)).toBe('Hacked');
		expect(modelText(edytor, 0)).toBe('Hello');
		edytor.readonly = false;
		expect(await settled(edytor)).toEqual([]);
		expect(domText(edytor, 0)).toBe('Hello');
		expect(modelText(edytor, 0)).toBe('Hello');
	});

	row('F-P17 (c) an extension’s id on a block element at attach stays', async () => {
		const deepLinks: Plugin = () => ({
			onBlockAttached: ({ node, block }) => {
				node.setAttribute('id', `anchor-${block.id}`);
			}
		});
		const { edytor } = await mount(
			{ children: [paragraph('Hello', 'b1')] },
			{ plugins: [richTextPlugin, mentionPlugin, deepLinks] }
		);
		const element = edytor.root!.children[0]!.node!;
		expect(await settled(edytor)).toEqual([]);
		expect(element.getAttribute('id')).toBe('anchor-b1');
	});

	row(
		'F-P20 a read-only view keeps a foreign annotation wrapper and heals an identity attribute',
		async () => {
			const { edytor } = await mount({ children: [paragraph('Hello world')] }, { readonly: true });
			edytor.readonly = true;
			await flushDomUpdates();
			const host = hostOf(edytor, 0).node!;
			const leaf = textNodes(host)[0]!;
			const wrapper = document.createElement('mark');
			wrapper.className = 'annotation';
			leaf.replaceWith(wrapper);
			wrapper.append(leaf);
			host.removeAttribute('data-edytor-id');
			await flushDomUpdates();
			await wait(20);
			await flushDomUpdates();
			expect(wrapper.isConnected).toBe(true);
			expect(host.getAttribute('data-edytor-id')).toBe(hostOf(edytor, 0).id);
			expect(modelText(edytor, 0)).toBe('Hello world');
		}
	);
});

// ── F-I22 ────────────────────────────────────────────────────────────────

describe('F-I22 — Android types natively into an empty block', () => {
	/** A non-cancelable `insertText` the browser performs in the text's first text node. */
	const typeNatively = async (edytor: Edytor, value: string, caret: number, data: string) => {
		const element = hostOf(edytor, 0).node!;
		const event = new Event('beforeinput', { bubbles: true, cancelable: false }) as InputEvent;
		Object.defineProperties(event, {
			inputType: { value: 'insertText' },
			data: { value: data },
			dataTransfer: { value: null }
		});
		element.dispatchEvent(event);
		const leaf = textNodes(element)[0]!;
		leaf.data = value;
		const range = document.createRange();
		range.setStart(leaf, caret);
		range.collapse(true);
		window.getSelection()!.removeAllRanges();
		window.getSelection()!.addRange(range);
		const input = new Event('input', { bubbles: true }) as InputEvent;
		Object.defineProperties(input, {
			inputType: { value: 'insertText' },
			data: { value: data },
			isComposing: { value: false }
		});
		element.dispatchEvent(input);
		await flushDomUpdates();
	};

	row('each character is adopted once; the filler never reaches the model', async () => {
		const restore = asAndroid();
		try {
			const { edytor } = await mount({ children: [paragraph('|')] });
			// The first character lands in the filler's node, beside the filler.
			await typeNatively(edytor, '\u200Ba', 2, 'a');
			expect(modelText(edytor, 0)).toBe('a');
			await typeNatively(edytor, 'ab', 2, 'b');
			expect(modelText(edytor, 0)).toBe('ab');
			expect(await settled(edytor)).toEqual([]);
			expect(domText(edytor, 0)).toBe('ab');
			expect(edytor.selection.state.yStart).toBe(2);
		} finally {
			restore();
		}
	});
});
