/** @jsxImportSource ../../jsx */
/**
 * arch-v2 — checkpoint I2 rows (dom lane): browser-made text is adopted once,
 * through the dispatcher, by a prefix/suffix diff that prefers the owning
 * attempt's target (R8, O59, D57; §5 L31, L32; §8.4).
 *
 * - F-I14 — a foreign script rewrites the middle 700 characters of an
 *   1,100-character paragraph → adoption = retain 200 / delete 700 / insert
 *   700: the suffix keeps its marks, anchors in the prefix and suffix keep
 *   their atoms, a remote caret and a concurrent insert in the prefix survive
 *   (reader C4 measured delete-all + insert-all with the marks at offset 0).
 * - F-I20 — Android browser-owned Backspace at `hel|lo` → exactly one `l`
 *   deleted and the deadline does nothing; the deleted `l` is the one before
 *   the caret (doubled letters, BI-8); a word-delete of the first of two
 *   identical words with different marks → the surviving word keeps its own
 *   marks and a remote caret inside it stays.
 * - Adoption runs through the dispatcher: hooks see one `insertText` per
 *   adopted insertion, and a hook's veto re-renders the text (reader: "adopted
 *   insertions go through the same interceptable insertion op as typed ones").
 *
 * Expected values come from the plan rows, never from running the code.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Y } from '$lib/crdt/engine.js';
import { attachDocument } from '$lib/crdt/document.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { Plugin } from '$lib/plugins.js';
import { mentionPlugin } from '../../atMention.svelte';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { flushDomUpdates, renderDomEdytor } from '../../dom/test.utils.js';

/** Red on the reference (flipped to `it` by I2). */
const row = it;
/** Green on the reference: a regression guard. */
const pin = it;

afterEach(() => {
	vi.restoreAllMocks();
});

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

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const beforeinput = (
	target: EventTarget,
	inputType: string,
	{ data = null, cancelable = true }: { data?: string | null; cancelable?: boolean } = {}
) => {
	const event = new Event('beforeinput', { bubbles: true, cancelable }) as InputEvent;
	Object.defineProperties(event, {
		inputType: { value: inputType },
		data: { value: data },
		dataTransfer: { value: null }
	});
	target.dispatchEvent(event);
	return event;
};

const input = (target: EventTarget, inputType: string, data: string | null = null) => {
	const event = new Event('input', { bubbles: true }) as InputEvent;
	Object.defineProperties(event, {
		inputType: { value: inputType },
		data: { value: data },
		isComposing: { value: false }
	});
	target.dispatchEvent(event);
};

const textNodes = (element: Node) => {
	const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
	const out: globalThis.Text[] = [];
	while (walker.nextNode()) out.push(walker.currentNode as globalThis.Text);
	// The renderer's empty text anchors are not the browser's text.
	return out.filter((node) => node.data.length > 0);
};

const caretAt = (node: Node, offset: number) => {
	const range = document.createRange();
	range.setStart(node, offset);
	range.collapse(true);
	window.getSelection()?.removeAllRanges();
	window.getSelection()?.addRange(range);
};

const firstBlock = (edytor: Edytor) => edytor.root!.children[0]!;
const firstText = (edytor: Edytor) => firstBlock(edytor).firstText!;
const domText = (edytor: Edytor) =>
	(firstText(edytor).node?.textContent ?? '').replace(/\u200B/g, '');
const content = (edytor: Edytor) => firstBlock(edytor).value.content;

/** `n` characters of `word ` repeated: no shared edge with a different word. */
const fill = (word: string, n: number) =>
	`${word} `.repeat(Math.ceil(n / (word.length + 1))).slice(0, n);

describe('F-I14 — a heavily rewritten text is adopted by its common prefix and suffix', () => {
	const prefix = fill('lorem', 200);
	const middle = fill('alpha', 700);
	const rewritten = fill('omega', 700);
	const suffix = fill('dolor', 200);

	row(
		'retain 200 / delete 700 / insert 700: marks, local anchors, a remote caret and a concurrent insert survive',
		async () => {
			const { edytor } = await renderDomEdytor(<root></root>, {
				autoSelectFixture: false,
				value: {
					children: [
						{
							type: 'paragraph',
							content: [{ text: prefix + middle }, { text: suffix, marks: { bold: true } }]
						}
					]
				}
			});
			const block = firstBlock(edytor);
			const remote = peer(edytor);
			// Atom identity: anchors in the untouched prefix and suffix.
			const inPrefix = edytor.facade.anchorAt(block.id, 150)!;
			const inSuffix = edytor.facade.anchorAt(block.id, 1000)!;
			// A peer, not yet synced: a caret at 150 and an insert at 100, both in the prefix.
			const remoteCaret = remote.facade.anchorAt(block.id, 150)!;
			remote.facade.insertText(block.id, 100, 'Z');

			// The foreign script rewrites the middle; no input event.
			const [plain] = textNodes(firstText(edytor).node!);
			plain!.data = prefix + rewritten;
			await flushDomUpdates();

			expect(content(edytor)).toEqual([
				{ text: prefix + rewritten },
				{ text: suffix, marks: { bold: true } }
			]);
			expect(edytor.facade.resolveAnchor(inPrefix)?.offset).toBe(150);
			expect(edytor.facade.resolveAnchor(inSuffix)?.offset).toBe(1000);

			remote.sync();
			await flushDomUpdates();
			const merged = prefix.slice(0, 100) + 'Z' + prefix.slice(100) + rewritten + suffix;
			expect(firstText(edytor).stringContent).toBe(merged);
			expect(domText(edytor)).toBe(merged);
			expect(remote.facade.resolveAnchor(remoteCaret)?.offset).toBe(151);
		}
	);
});

describe('F-I20 — the adoption diff prefers the attempt target (BI-8)', () => {
	pin(
		'Android browser-owned Backspace at hel|lo → exactly one l; the deadline does nothing',
		async () => {
			const restore = asAndroid();
			try {
				const { edytor, editor } = await renderDomEdytor(
					<root>
						<paragraph>hel|lo</paragraph>
					</root>
				);
				const host = firstText(edytor).node!;
				beforeinput(host ?? editor, 'deleteContentBackward', { cancelable: false });
				const [node] = textNodes(host);
				node!.data = 'helo';
				caretAt(node!, 2);
				input(host, 'deleteContentBackward');
				await flushDomUpdates();
				await wait(220);
				await flushDomUpdates();
				expect(firstText(edytor).stringContent).toBe('helo');
				expect(domText(edytor)).toBe('helo');
			} finally {
				restore();
			}
		}
	);

	row(
		'doubled letters: the deleted l is the one before the caret (its marks go with it)',
		async () => {
			const restore = asAndroid();
			try {
				const { edytor } = await renderDomEdytor(
					<root>
						<paragraph>
							he<bold>l</bold>|lo
						</paragraph>
					</root>
				);
				const block = firstBlock(edytor);
				expect(edytor.selection.state.yStart).toBe(3);
				const remote = peer(edytor);
				// A remote caret right after the bold l: it follows that atom.
				const remoteCaret = remote.facade.anchorAt(block.id, 3)!;
				const host = firstText(edytor).node!;
				beforeinput(host, 'deleteContentBackward', { cancelable: false });
				// The browser deletes the bold l natively.
				const [he, bold] = textNodes(host);
				bold!.data = '';
				caretAt(he!, 2);
				input(host, 'deleteContentBackward');
				await flushDomUpdates();
				await wait(220);
				await flushDomUpdates();
				expect(content(edytor)).toEqual([{ text: 'helo' }]);
				expect(domText(edytor)).toBe('helo');
				remote.sync();
				expect(remote.facade.resolveAnchor(remoteCaret)?.offset).toBe(2);
			} finally {
				restore();
			}
		}
	);

	row(
		'a word-delete of the first of two identical words: the survivor keeps its marks and a remote caret',
		async () => {
			const restore = asAndroid();
			try {
				const { edytor } = await renderDomEdytor(
					<root>
						<paragraph>
							<bold>|foo</bold> |<italic>foo</italic>
						</paragraph>
					</root>
				);
				const block = firstBlock(edytor);
				expect([edytor.selection.state.yStart, edytor.selection.state.yEnd]).toEqual([0, 4]);
				const remote = peer(edytor);
				// A remote caret inside the second word: `foo f|oo`.
				const remoteCaret = remote.facade.anchorAt(block.id, 5)!;
				const host = firstText(edytor).node!;
				beforeinput(host, 'deleteContentBackward', { cancelable: false });
				// The browser deletes the selected `foo ` natively.
				const [bold, space, italic] = textNodes(host);
				bold!.data = '';
				space!.data = '';
				caretAt(italic!, 0);
				input(host, 'deleteContentBackward');
				await flushDomUpdates();
				await wait(220);
				await flushDomUpdates();
				expect(content(edytor)).toEqual([{ text: 'foo', marks: { italic: true } }]);
				expect(domText(edytor)).toBe('foo');
				remote.sync();
				expect(remote.facade.resolveAnchor(remoteCaret)?.offset).toBe(1);
			} finally {
				restore();
			}
		}
	);
});

describe('adoption runs through the dispatcher', () => {
	const hooked = (log: string[], veto = false): Plugin => {
		return () => ({
			onBeforeOperation: ({ operation, payload, prevent }) => {
				if (operation !== 'insertText') return;
				const { value, start, end } = payload as { value: string; start: number; end: number };
				log.push(`${value}@${start}-${end}`);
				if (veto) prevent();
			}
		});
	};

	const typeNatively = async (edytor: Edytor) => {
		const host = firstText(edytor).node!;
		beforeinput(host, 'insertText', { data: 'x', cancelable: false });
		const [node] = textNodes(host);
		node!.data = 'hexllo';
		caretAt(node!, 3);
		input(host, 'insertText', 'x');
		await flushDomUpdates();
	};

	row('a browser-owned insertion is one insertText hooks see', async () => {
		const log: string[] = [];
		const { edytor } = await renderDomEdytor(
			<root>
				<paragraph>he|llo</paragraph>
			</root>,
			{ plugins: [hooked(log), richTextPlugin, mentionPlugin] }
		);
		await typeNatively(edytor);
		expect(firstText(edytor).stringContent).toBe('hexllo');
		expect(log).toEqual(['x@2-2']);
	});

	row('a hook vetoes the adoption: the text re-renders from the model', async () => {
		const log: string[] = [];
		const { edytor } = await renderDomEdytor(
			<root>
				<paragraph>he|llo</paragraph>
			</root>,
			{ plugins: [hooked(log, true), richTextPlugin, mentionPlugin] }
		);
		await typeNatively(edytor);
		expect(log).toEqual(['x@2-2']);
		expect(firstText(edytor).stringContent).toBe('hello');
		expect(domText(edytor)).toBe('hello');
	});

	pin('a natively typed @ with no beforeinput becomes the mention atom', async () => {
		const { edytor } = await renderDomEdytor(
			<root>
				<paragraph>he|llo</paragraph>
			</root>
		);
		const host = firstText(edytor).node!;
		const [node] = textNodes(host);
		node!.data = 'he@llo';
		caretAt(node!, 3);
		input(host, 'insertText', '@');
		await flushDomUpdates();
		expect(firstBlock(edytor).value.content).toEqual([
			{ text: 'he' },
			{ type: 'mention', id: expect.any(String), data: {} },
			{ text: 'llo' }
		]);
	});
});
