/** @jsxImportSource ../../jsx */
/**
 * arch-v2 — checkpoint I1 rows (dom lane): one input attempt per user
 * occurrence (R8, L6, O33, O59; §8.4).
 *
 * - F-I1 — `he[ll]o`, Backspace keydown with no `beforeinput` (the fallback
 *   engines need); a peer inserts `XX` at 0 before the deadline → `XXheo`
 *   (reader C3 measured `XXllo`: the fallback replayed a numeric snapshot).
 * - F-I2 — Android non-cancelable `deleteContentBackward` the browser does not
 *   perform, plus a peer edit inside the deadline → exactly one grapheme
 *   deleted, before the anchored caret (reader C5: the keystroke is lost).
 * - F-I4 — a hook throws during a non-cancelable insert → the attempt fails;
 *   the DOM equals the model after settle; the next keystroke works; the error
 *   surfaces (reader C7).
 * - F-I5 — Shift+Enter in a code line, desktop and Android (`insertLineBreak`)
 *   → the same intent (the `shift+enter` binding), the same operations shown
 *   to hooks, the same result (reader C8).
 * - F-I19 — one text: a prevented Backspace plus late drift, then within one
 *   frame a non-cancelable `insertText` → both effects land exactly once (BI-7).
 *
 * Expected values come from the plan rows, never from running the code.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Y } from '$lib/crdt/engine.js';
import { attachDocument } from '$lib/crdt/document.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { Plugin } from '$lib/plugins.js';
import type { HotKey } from '$lib/session/keymap.js';
import { codePlugin } from '$lib/plugins/code/CodePlugin.svelte';
import { mentionPlugin } from '$lib/plugins/mention/MentionPlugin.svelte';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { flushDomUpdates, renderDomEdytor, setNativeSelection } from '../../dom/test.utils.js';

/** Red on the reference; green since I1. */
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

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A browser `beforeinput`, dispatched synchronously (no flush). */
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

/** The browser's `input` after it mutated the DOM itself. */
const input = (target: EventTarget, inputType: string, data: string | null = null) => {
	const event = new Event('input', { bubbles: true }) as InputEvent;
	Object.defineProperties(event, {
		inputType: { value: inputType },
		data: { value: data },
		isComposing: { value: false }
	});
	target.dispatchEvent(event);
};

const keydown = (target: EventTarget, init: KeyboardEventInit & { key: string }) => {
	const event = new KeyboardEvent('keydown', {
		code: init.key,
		...init,
		bubbles: true,
		cancelable: true
	});
	target.dispatchEvent(event);
	return event;
};

/** Replace the DOM text of `element`'s first text node (a native edit) and put the caret at `caret`. */
const nativeEdit = (element: HTMLElement, value: string, caret: number) => {
	const node = [...element.childNodes].find((child) => child.nodeType === Node.TEXT_NODE)!;
	node.textContent = value;
	const range = document.createRange();
	range.setStart(node, caret);
	range.collapse(true);
	window.getSelection()?.removeAllRanges();
	window.getSelection()?.addRange(range);
};

const firstText = (edytor: Edytor) => edytor.root!.children[0]!.firstText!;
const domText = (edytor: Edytor) =>
	(firstText(edytor).node?.textContent ?? '').replace(/\u200B/g, '');

const surfaced = () => {
	const errors: unknown[] = [];
	const onError = (event: ErrorEvent) => {
		errors.push(event.error);
		event.preventDefault();
	};
	window.addEventListener('error', onError);
	const consoleError = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
		errors.push(...args.filter((arg) => arg instanceof Error));
	});
	return {
		errors,
		stop: () => {
			window.removeEventListener('error', onError);
			consoleError.mockRestore();
		}
	};
};

describe('F-I1 — the keydown fallback runs against the anchored target', () => {
	row(
		'`he[ll]o`, Backspace with no beforeinput, a peer inserts XX at 0 first → XXheo',
		async () => {
			const { edytor, editor } = await renderDomEdytor(
				<root>
					<paragraph>he|ll|o</paragraph>
				</root>
			);
			const block = edytor.root!.children[0]!;
			const remote = peer(edytor);
			const down = keydown(firstText(edytor).node ?? editor, { key: 'Backspace' });
			expect(down.defaultPrevented).toBe(false);
			// The peer's insert lands before the missing-beforeinput deadline.
			remote.facade.insertText(block.id, 0, 'XX');
			remote.deliver();
			await flushDomUpdates();
			await wait(60);
			await flushDomUpdates();
			expect(block.firstText?.stringContent).toBe('XXheo');
		}
	);

	pin('without a concurrent edit the fallback deletes the keydown-time range', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>he|ll|o</paragraph>
			</root>
		);
		keydown(firstText(edytor).node ?? editor, { key: 'Backspace' });
		await flushDomUpdates();
		await wait(60);
		await flushDomUpdates();
		expect(firstText(edytor).stringContent).toBe('heo');
	});
});

describe('F-I2 — the Android no-op Backspace deadline is phase-based', () => {
	row.fails(
		'the browser does not delete; a peer edits inside the deadline → one grapheme before the anchored caret',
		async () => {
			const restore = asAndroid();
			try {
				const { edytor, editor } = await renderDomEdytor(
					<root>
						<paragraph>abc|def</paragraph>
					</root>
				);
				const block = edytor.root!.children[0]!;
				const remote = peer(edytor);
				const event = beforeinput(firstText(edytor).node ?? editor, 'deleteContentBackward', {
					cancelable: false
				});
				expect(event.defaultPrevented).toBe(false);
				// The browser performs nothing; a peer edit lands inside the deadline.
				remote.facade.insertText(block.id, 0, 'XX');
				remote.deliver();
				await flushDomUpdates();
				await wait(220);
				await flushDomUpdates();
				expect(block.firstText?.stringContent).toBe('XXabdef');
				expect(domText(edytor)).toBe('XXabdef');
			} finally {
				restore();
			}
		}
	);

	pin(
		'the browser deletes natively → the deadline does nothing (exactly one deletion)',
		async () => {
			const restore = asAndroid();
			try {
				const { edytor, editor } = await renderDomEdytor(
					<root>
						<paragraph>abc|def</paragraph>
					</root>
				);
				const text = firstText(edytor);
				beforeinput(text.node ?? editor, 'deleteContentBackward', { cancelable: false });
				nativeEdit(text.node!, 'abdef', 2);
				input(text.node!, 'deleteContentBackward');
				await flushDomUpdates();
				await wait(220);
				await flushDomUpdates();
				expect(firstText(edytor).stringContent).toBe('abdef');
				expect(domText(edytor)).toBe('abdef');
			} finally {
				restore();
			}
		}
	);
});

describe('F-I4 — a hook that throws fails the attempt', () => {
	const throwingOnce = (): Plugin => {
		let thrown = false;
		return () => ({
			onBeforeInput: () => {
				if (thrown) return;
				thrown = true;
				throw new TypeError('hook failed');
			}
		});
	};

	row.fails(
		'non-cancelable range insert: attempt failed, DOM equals model, next keystroke works, error surfaces',
		async () => {
			const errors = surfaced();
			try {
				const { edytor, editor } = await renderDomEdytor(
					<root>
						<paragraph>he|ll|o</paragraph>
					</root>,
					{ plugins: [throwingOnce(), richTextPlugin, mentionPlugin] }
				);
				const text = firstText(edytor);
				beforeinput(text.node ?? editor, 'insertText', { data: 'x', cancelable: false });
				nativeEdit(text.node!, 'hexo', 3);
				input(text.node!, 'insertText', 'x');
				await flushDomUpdates();
				await wait(200);
				await flushDomUpdates();
				expect(edytor.attempts.last?.phase).toBe('failed');
				expect(domText(edytor)).toBe(firstText(edytor).stringContent);
				expect(errors.errors.length).toBeGreaterThan(0);

				// The next keystroke works.
				const before = firstText(edytor).stringContent;
				const { yStart } = edytor.selection.state;
				beforeinput(firstText(edytor).node ?? editor, 'insertText', { data: 'y' });
				await flushDomUpdates();
				expect(firstText(edytor).stringContent).toBe(
					before.slice(0, yStart) + 'y' + before.slice(yStart)
				);
				expect(domText(edytor)).toBe(firstText(edytor).stringContent);
			} finally {
				errors.stop();
			}
		}
	);
});

describe('F-I5 — Shift+Enter in a code line: one intent on desktop and Android', () => {
	const codeValue = {
		children: [
			{ type: 'code', children: [{ type: 'codeLine', content: [{ text: 'const a = 1;' }] }] },
			{ type: 'paragraph', content: [{ text: 'tail' }] }
		]
	};

	/** Counts `shift+enter` offers (never claims) and records the operations hooks see. */
	const observing = (log: { offers: number; operations: string[] }): Plugin => {
		const binding: HotKey = () => {
			log.offers++;
		};
		return () => ({
			hotkeys: { 'shift+enter': binding },
			onBeforeOperation: ({ operation }) => {
				log.operations.push(operation);
			}
		});
	};

	const run = async (android: boolean) => {
		const log = { offers: 0, operations: [] as string[] };
		const { edytor, editor } = await renderDomEdytor(<root></root>, {
			value: codeValue,
			autoSelectFixture: false,
			plugins: [observing(log), richTextPlugin, mentionPlugin, codePlugin]
		});
		const line = edytor.root!.children[0]!.children[0]!;
		await setNativeSelection(edytor, line.firstText, 'const '.length);
		const target = line.firstText!.node ?? editor;
		if (android) {
			// Android: an `Unidentified` keydown, then a non-cancelable line break.
			keydown(target, { key: 'Unidentified' });
			beforeinput(target, 'insertLineBreak', { cancelable: false });
		} else {
			const down = keydown(target, { key: 'Enter', shiftKey: true });
			if (!down.defaultPrevented) beforeinput(target, 'insertLineBreak');
		}
		await flushDomUpdates();
		await wait(200);
		await flushDomUpdates();
		const lines = edytor.root!.children[0]!.children.map((b) => b.firstText?.stringContent ?? '');
		return { log, lines };
	};

	row('the same binding, the same hooked operations and the same lines', async () => {
		const desktop = await run(false);
		const android = await run(true);
		expect(desktop.lines).toEqual(['const ', 'a = 1;']);
		expect(android.lines).toEqual(desktop.lines);
		expect([desktop.log.offers, android.log.offers]).toEqual([1, 1]);
		expect(android.log.operations).toEqual(desktop.log.operations);
	});
});

describe('F-I19 — attempts queue per host; drift is attributed by expectation', () => {
	row.fails(
		'a prevented word delete with late drift, then a non-cancelable insertText: both land once',
		async () => {
			const { edytor, editor } = await renderDomEdytor(
				<root>
					<paragraph>hello world|</paragraph>
				</root>
			);
			const text = firstText(edytor);
			// Model-owned: a non-cancelable word delete (the model computes the unit).
			beforeinput(text.node ?? editor, 'deleteWordBackward', { cancelable: false });
			await Promise.resolve();
			expect(firstText(edytor).stringContent).toBe('hello ');
			await flushDomUpdates();
			// Late drift: the browser also deleted, differently, and fires no input for it.
			nativeEdit(firstText(edytor).node!, 'hello', 5);
			// Within one frame: a non-cancelable insertText the browser performs itself.
			const host = firstText(edytor).node!;
			await new Promise((resolve) => setTimeout(resolve, 0));
			beforeinput(host, 'insertText', { data: 'X', cancelable: false });
			nativeEdit(host, 'helloX', 6);
			input(host, 'insertText', 'X');
			await flushDomUpdates();
			await wait(200);
			await flushDomUpdates();
			expect(firstText(edytor).stringContent).toBe('hello X');
			expect(domText(edytor)).toBe('hello X');
		}
	);
});
