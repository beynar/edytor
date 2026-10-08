/** @jsxImportSource ../../jsx */
/**
 * arch-v2 — checkpoint I3 rows (dom lane): one composition session per IME
 * composition (R7, R8, L7, O34, D32, D48; §5 L35; §8.4).
 *
 * - F-I6 — `Hello|`, a preview, 850 ms without events while a peer edits
 *   another paragraph and the editor writes its own focus attributes → the
 *   session stays live, the preview intact, the host not remounted; the
 *   commit gives `Helloに` (reader C1: the 750 ms idle cancel deleted it).
 * - F-I7 — `alpha|Hello` split, then `n` → `に` at the fresh block start →
 *   `にHello`; `alpha` untouched.
 * - F-I9 — the model equals the IME buffer at every step (previews never reach
 *   hooks: no auto-pair on `(`), and the slash menu opens once, after the
 *   commit, with query `h` (D33).
 * - F-I16 — (a) previews with gaps longer than `captureTimeout`, commit, one
 *   undo, one redo; (b) the same with an equal-text commit; (c) compose over a
 *   selection, undo restores it; (d) cancel after a gap, undo undoes the
 *   previous step and no preview resurrects; (e) an extension refusing a block
 *   deletion refuses a composition over a cross-block selection exactly as it
 *   refuses typing (F3, BI-1, FP-3).
 * - F-I17 — a blur with `compositionend` suppressed keeps the composed text;
 *   a 10 s pause leaves the session live and it commits once (BI-4).
 * - F-I18 — Firefox, WebKit and Android orders commit once; a late trailing
 *   composition change after the commit is resolved by the tail — also when
 *   it arrives after the old 50 ms window (BI-5, BI2-6).
 * - F-I21 — a peer splits inside a replicated preview; the commit deletes the
 *   live preview items in both streams and lands at the region start (BI-11).
 *
 * Expected values come from the plan rows, never from running the code.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Y } from '$lib/crdt/engine.js';
import { attachDocument } from '$lib/crdt/document.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { Plugin } from '$lib/plugins.js';
import { codePlugin } from '$lib/plugins/code/CodePlugin.svelte';
import { mentionPlugin } from '../../atMention.svelte';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { slashMenuPlugin } from '$lib/plugins/slashMenu/slashMenuPlugin.js';
import {
	dispatchComposition,
	dispatchDomBeforeInput,
	dispatchDomInput,
	flushDomUpdates,
	renderDomEdytor,
	setNativeSelection
} from '../../dom/test.utils.js';

/** Red on the reference; green since I3. */
const row = it;
/** Green on the reference: a regression guard. */
const pin = it;

afterEach(() => {
	vi.restoreAllMocks();
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Longer than the engine's 500 ms undo capture window. */
const GAP_MS = 600;

/** A replica of the mounted document; `sync` exchanges both ways. */
const peer = (edytor: Edytor) => {
	const remoteDoc = new Y.Doc();
	Y.applyUpdate(remoteDoc, Y.encodeStateAsUpdate(edytor.doc));
	const remote = attachDocument(remoteDoc);
	return {
		facade: remote.facade,
		sync: () => {
			const local = Y.encodeStateAsUpdate(edytor.doc, Y.encodeStateVector(remoteDoc));
			Y.applyUpdate(edytor.doc, Y.encodeStateAsUpdate(remoteDoc, Y.encodeStateVector(edytor.doc)));
			Y.applyUpdate(remoteDoc, local);
		}
	};
};

const texts = (edytor: Edytor) =>
	edytor.root!.children.map((block) =>
		block.content.map((part) => ('stringContent' in part ? part.stringContent : '@')).join('')
	);
const blockText = (edytor: Edytor, index: number) => texts(edytor)[index];
const hostOf = (edytor: Edytor, index: number) => edytor.root!.children[index]!.firstText!;
const domText = (edytor: Edytor, index: number) =>
	(hostOf(edytor, index).node?.textContent ?? '').replace(/\u200B/g, '');
const textNodes = (element: Node) => {
	const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
	const out: globalThis.Text[] = [];
	while (walker.nextNode()) out.push(walker.currentNode as globalThis.Text);
	return out.filter((node) => node.data.length > 0);
};
const caret = (edytor: Edytor) => {
	const { startText, yStart, isCollapsed } = edytor.selection.state;
	const block = edytor.root!.children.findIndex((b) => b === startText?.parent);
	return { block, offset: yStart, isCollapsed };
};

const start = (editor: HTMLElement) => dispatchComposition(editor, [{ type: 'compositionstart' }]);
const preview = (editor: HTMLElement, data: string) =>
	dispatchComposition(editor, [{ type: 'beforeinput', inputType: 'insertCompositionText', data }]);
const end = (editor: HTMLElement, data: string) =>
	dispatchComposition(editor, [{ type: 'compositionend', data }]);
const undo = (editor: HTMLElement) => dispatchDomBeforeInput(editor, { inputType: 'historyUndo' });
const redo = (editor: HTMLElement) => dispatchDomBeforeInput(editor, { inputType: 'historyRedo' });

describe('F-I6 — an idle composition survives a peer edit and the editor’s own renders', () => {
	row(
		'850 ms without events: live, preview intact, host kept; the commit gives Helloに',
		async () => {
			const { edytor, editor } = await renderDomEdytor(
				<root>
					<paragraph>Hello|</paragraph>
					<paragraph>other</paragraph>
				</root>
			);
			const remote = peer(edytor);
			const host = hostOf(edytor, 0).node!;
			await start(editor);
			await preview(editor, 'に');
			const nodes = textNodes(host);

			// A peer edits the other paragraph; then nothing for 850 ms.
			remote.facade.insertText(edytor.root!.children[1]!.id, 0, 'P');
			remote.sync();
			await flushDomUpdates();
			await wait(850);
			await flushDomUpdates();

			expect(edytor.isComposing).toBe(true);
			expect(blockText(edytor, 0)).toBe('Helloに');
			expect(host.isConnected).toBe(true);
			expect(nodes.every((node) => node.isConnected && host.contains(node))).toBe(true);
			expect(domText(edytor, 0)).toBe('Helloに');

			await end(editor, 'に');
			expect(texts(edytor)).toEqual(['Helloに', 'Pother']);
			expect(caret(edytor)).toEqual({ block: 0, offset: 6, isCollapsed: true });
		}
	);
});

describe('F-I7 — a composition at a split-born block start stays there', () => {
	pin('alpha|Hello, Enter, n → に: にHello, alpha untouched', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>alpha|Hello</paragraph>
			</root>
		);
		await dispatchDomBeforeInput(editor, { inputType: 'insertParagraph' });
		expect(texts(edytor)).toEqual(['alpha', 'Hello']);
		await dispatchComposition(editor, [
			{ type: 'compositionstart' },
			{ type: 'beforeinput', inputType: 'insertCompositionText', data: 'n' },
			{ type: 'beforeinput', inputType: 'insertFromComposition', data: 'に' },
			{ type: 'compositionend', data: 'に' }
		]);
		expect(texts(edytor)).toEqual(['alpha', 'にHello']);
		expect(caret(edytor)).toEqual({ block: 1, offset: 1, isCollapsed: true });
	});
});

describe('F-I9 — previews never reach hooks; the commit is one insertion', () => {
	row('a code line: the model equals the IME buffer at every step (no auto-pair)', async () => {
		const { edytor, editor } = await renderDomEdytor(<root></root>, {
			autoSelectFixture: false,
			value: {
				children: [{ type: 'code', children: [{ type: 'codeLine', content: [{ text: 'x' }] }] }]
			},
			plugins: [richTextPlugin, mentionPlugin, codePlugin]
		});
		const line = edytor.root!.children[0]!.children[0]!;
		await setNativeSelection(edytor, line.firstText, 1);
		const lineText = () => line.firstText!.stringContent;

		await start(editor);
		await preview(editor, '(');
		expect(lineText()).toBe('x(');
		await preview(editor, '(a');
		expect(lineText()).toBe('x(a');
		await end(editor, '(a');
		expect(lineText()).toBe('x(a');
	});

	row('the slash menu opens once, after the commit, with query h', async () => {
		const { editor } = await renderDomEdytor(
			<root>
				<paragraph>|</paragraph>
			</root>,
			{ plugins: [richTextPlugin, mentionPlugin, slashMenuPlugin] }
		);
		const menu = () => document.querySelector('[data-testid="slash-menu"]');
		const opened: boolean[] = [];

		await start(editor);
		await preview(editor, '/');
		opened.push(Boolean(menu()));
		await preview(editor, '/h');
		opened.push(Boolean(menu()));
		await end(editor, '/h');
		opened.push(Boolean(menu()));

		expect(opened).toEqual([false, false, true]);
		expect(document.querySelector('[data-testid="slash-menu-query"]')?.textContent).toBe('/h');
	});
});

describe('F-I16 — a session and its commit are one undo step', () => {
	row('(a) にほん with gaps, commit 日本, one undo, one redo', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>note|</paragraph>
			</root>
		);
		await start(editor);
		for (const step of ['に', 'にほ', 'にほん']) {
			await preview(editor, step);
			await wait(GAP_MS);
		}
		await end(editor, '日本');
		expect(texts(edytor)).toEqual(['note日本']);

		await undo(editor);
		expect(texts(edytor)).toEqual(['note']);
		expect(domText(edytor, 0)).toBe('note');
		expect(caret(edytor)).toEqual({ block: 0, offset: 4, isCollapsed: true });
		await redo(editor);
		expect(texts(edytor)).toEqual(['note日本']);
		expect(domText(edytor, 0)).toBe('note日本');
	});

	row('(b) an equal-text commit: ㅎ, 하, 한 with gaps, commit 한, undo, redo', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>note|</paragraph>
			</root>
		);
		await start(editor);
		for (const step of ['ㅎ', '하', '한']) {
			await preview(editor, step);
			await wait(GAP_MS);
		}
		await end(editor, '한');
		expect(texts(edytor)).toEqual(['note한']);

		await undo(editor);
		expect(texts(edytor)).toEqual(['note']);
		await redo(editor);
		expect(texts(edytor)).toEqual(['note한']);
	});

	pin(
		'(c) compose over a selected word, commit, undo: the word and its selection return',
		async () => {
			const { edytor, editor } = await renderDomEdytor(
				<root>
					<paragraph>say |hello| now</paragraph>
				</root>
			);
			await start(editor);
			await preview(editor, 'に');
			await end(editor, 'に');
			expect(texts(edytor)).toEqual(['say に now']);

			await undo(editor);
			expect(texts(edytor)).toEqual(['say hello now']);
			const { yStart, yEnd } = edytor.selection.state;
			expect([yStart, yEnd]).toEqual([4, 9]);
		}
	);

	row('(d) a canceled preview: undo undoes the previous step, nothing resurrects', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>|</paragraph>
			</root>
		);
		await dispatchDomBeforeInput(editor, { inputType: 'insertText', data: 'a' });
		expect(texts(edytor)).toEqual(['a']);
		await wait(GAP_MS);

		await start(editor);
		await preview(editor, 'に');
		await wait(GAP_MS);
		await end(editor, '');
		expect(texts(edytor)).toEqual(['a']);

		await undo(editor);
		expect(texts(edytor)).toEqual(['']);
		expect(domText(edytor, 0)).toBe('');
		await redo(editor);
		expect(texts(edytor)).toEqual(['a']);
	});

	pin('(e) a refused block deletion refuses a composition over it exactly as typing', async () => {
		const vetoing: Plugin = () => ({
			onBeforeOperation: (change) => {
				if (
					change.operation === 'removeBlock' &&
					(change.block as { content?: { stringContent?: string }[] }).content?.[0]
						?.stringContent === 'bb'
				)
					change.prevent();
			}
		});
		const run = async (input: (editor: HTMLElement) => Promise<unknown>) => {
			const { edytor, editor } = await renderDomEdytor(
				<root>
					<paragraph>a|a</paragraph>
					<paragraph>bb</paragraph>
					<paragraph>c|c</paragraph>
				</root>,
				{ plugins: [richTextPlugin, mentionPlugin, vetoing] }
			);
			await input(editor);
			await flushDomUpdates();
			return { texts: texts(edytor), dom: [0, 1, 2].map((i) => domText(edytor, i)) };
		};
		const typed = await run((editor) =>
			dispatchDomBeforeInput(editor, { inputType: 'insertText', data: 'x' })
		);
		const composed = await run((editor) =>
			dispatchComposition(editor, [
				{ type: 'compositionstart' },
				{ type: 'beforeinput', inputType: 'insertCompositionText', data: 'x' },
				{ type: 'compositionend', data: 'x' }
			])
		);
		expect(typed.texts).toEqual(['aa', 'bb', 'cc']);
		expect(composed).toEqual(typed);
	});
});

describe('F-I17 — time never ends a session; abandonment adopts what the DOM shows', () => {
	pin(
		'a blur with compositionend suppressed keeps the composed text in model and DOM',
		async () => {
			const { edytor, editor } = await renderDomEdytor(
				<root>
					<paragraph>Hello|</paragraph>
				</root>
			);
			const outside = document.createElement('button');
			document.body.append(outside);
			try {
				await start(editor);
				await preview(editor, 'に');
				outside.focus();
				editor.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: outside }));
				await flushDomUpdates();
				await wait(800);
				await flushDomUpdates();
				expect(edytor.isComposing).toBe(false);
				expect(texts(edytor)).toEqual(['Helloに']);
				expect(domText(edytor, 0)).toBe('Helloに');
			} finally {
				outside.remove();
			}
		}
	);

	// Green in jsdom on the reference (no record re-arms the idle timer here);
	// the cdp lane carries the red version.
	pin(
		'a 10 s pause: the session is still live and commits once',
		async () => {
			const { edytor, editor } = await renderDomEdytor(
				<root>
					<paragraph>Hello|</paragraph>
				</root>
			);
			await start(editor);
			await preview(editor, 'に');
			await wait(10_000);
			await flushDomUpdates();
			expect(edytor.isComposing).toBe(true);
			expect(texts(edytor)).toEqual(['Helloに']);

			await end(editor, 'に');
			await end(editor, 'に');
			expect(texts(edytor)).toEqual(['Helloに']);
			expect(domText(edytor, 0)).toBe('Helloに');
		},
		20_000
	);
});

/** The browser rewrote the host's text (a late IME change), then reports it. */
const lateCompositionInput = async (
	edytor: Edytor,
	editor: HTMLElement,
	domValue: string,
	data: string
) => {
	const node = textNodes(hostOf(edytor, 0).node!)[0]!;
	node.data = domValue;
	const range = document.createRange();
	range.setStart(node, domValue.length);
	range.collapse(true);
	window.getSelection()?.removeAllRanges();
	window.getSelection()?.addRange(range);
	await dispatchDomInput(editor, { inputType: 'insertCompositionText', data });
};

describe('F-I18 — one commit whatever the engine order; the tail owns late signals', () => {
	pin('Firefox: compositionend, then the trailing composition input → に once', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>|</paragraph>
			</root>
		);
		await start(editor);
		await preview(editor, 'n');
		await end(editor, 'に');
		await lateCompositionInput(edytor, editor, 'にに', 'に');
		await wait(200);
		await flushDomUpdates();
		expect(texts(edytor)).toEqual(['に']);
		expect(domText(edytor, 0)).toBe('に');
	});

	row(
		'Firefox: the trailing input arrives after the old 50 ms window → still に once',
		async () => {
			const { edytor, editor } = await renderDomEdytor(
				<root>
					<paragraph>|</paragraph>
				</root>
			);
			await start(editor);
			await preview(editor, 'n');
			await end(editor, 'に');
			await wait(120);
			await lateCompositionInput(edytor, editor, 'にに', 'に');
			await wait(200);
			await flushDomUpdates();
			expect(texts(edytor)).toEqual(['に']);
			expect(domText(edytor, 0)).toBe('に');
			expect(caret(edytor)).toEqual({ block: 0, offset: 1, isCollapsed: true });
		}
	);

	pin('WebKit: insertFromComposition before compositionend → に once', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>|</paragraph>
			</root>
		);
		await dispatchComposition(editor, [
			{ type: 'compositionstart' },
			{ type: 'beforeinput', inputType: 'insertCompositionText', data: 'n' },
			{ type: 'beforeinput', inputType: 'insertFromComposition', data: 'に' },
			{ type: 'compositionend', data: 'に' }
		]);
		expect(texts(edytor)).toEqual(['に']);
		expect(caret(edytor)).toEqual({ block: 0, offset: 1, isCollapsed: true });
	});

	pin(
		'Android: a composition mutation without beforeinput, then a duplicate compositionend → に once',
		async () => {
			const { edytor, editor } = await renderDomEdytor(
				<root>
					<paragraph>|</paragraph>
				</root>
			);
			await start(editor);
			const host = hostOf(edytor, 0).node!;
			const node = textNodes(host)[0] ?? host.appendChild(document.createTextNode(''));
			node.data = 'に';
			await dispatchDomInput(editor, {
				inputType: 'insertCompositionText',
				data: 'に',
				isComposing: true
			});
			await end(editor, 'に');
			await end(editor, 'に');
			await wait(200);
			await flushDomUpdates();
			expect(texts(edytor)).toEqual(['に']);
			expect(domText(edytor, 0)).toBe('に');
		}
	);
});

describe('F-I21 — a peer split inside a replicated preview', () => {
	row('the commit deletes the preview in both streams and lands at the region start', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>ab|cd</paragraph>
			</root>
		);
		const remote = peer(edytor);
		const blockId = edytor.root!.children[0]!.id;
		await start(editor);
		await preview(editor, 'にほんご');
		remote.sync();
		// Peer C, seeing the preview, splits inside it: `abにほ | んごcd`.
		expect(remote.facade.splitBlock(blockId, 4, 'peer-split', { type: 'paragraph' }).status).toBe(
			'applied'
		);
		remote.sync();
		await flushDomUpdates();

		await end(editor, '日本語');
		remote.sync();
		await flushDomUpdates();

		expect(texts(edytor)).toEqual(['ab日本語', 'cd']);
		const remoteTexts = remote.facade
			.project()
			.children.map((block: { id: string }) => remote.facade.blockText(block.id));
		expect(remoteTexts).toEqual(['ab日本語', 'cd']);
	});
});
