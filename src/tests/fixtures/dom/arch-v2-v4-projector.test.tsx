/** @jsxImportSource ../../jsx */
/**
 * arch-v2 — checkpoint V4 rows, dom lane: the display projector is the only
 * writer of the DOM selection (R10, O49–O57, L21 rest, L22, L26 core, L52).
 *
 * - F-S1 — two writes requested in one turn: the later request wins, in both
 *   orders (W1).
 * - F-S4 — host code moves the DOM selection with no gesture and no render:
 *   the model adopts it (a foreign write is not drift).
 * - F-S5 — `ab` + bold `cd` + `ef`: the point `(textElement, i)` reads the
 *   text before child `i` (0, 2, 4, 6).
 * - F-S6 — a forward native selection whose focus is `(textElement,
 *   childCount)` reads forward, 1 → end, with the model slice as content
 *   (green on the reference since V2's projection: a pin here, a row on
 *   firefox in the browser spec).
 * - F-S9 — (a) our own render detaches the focused node: the caret is
 *   displayed again; (b) the user focused an outside `<input>`; (c) the user
 *   selected text outside the editor: a remote apply updates the model only,
 *   the user's focus and selection are kept (BI-14).
 * - F-S11 (d) — an unobserved native move before a remote apply is admitted
 *   after the apply commits (BI-3); an `onSelectionChange` hook that
 *   dispatches a command then runs outside the apply's (and an undo's)
 *   transaction, as its own local, broadcast transaction (LH2-5).
 * - F-P2 — the toolbar holds the selection as a value: a link applied after a
 *   peer insert covers the word that was selected.
 * - F-P3 — the slash menu holds its range as anchors: a peer insert before it
 *   keeps the menu open on `quo`, and Enter runs on `/quo`.
 * - F-O1 (timer half) — after a command program settles, no timer scheduled
 *   by the selection display (selection, surface, bindings) is left pending.
 *
 * Expected values come from the plan rows, never from running the code.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { Y } from '$lib/crdt/engine.js';
import { attachDocument } from '$lib/crdt/document.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import { mentionPlugin } from '$lib/plugins/mention/MentionPlugin.svelte';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { slashMenuPlugin } from '$lib/plugins/slashMenu/slashMenuPlugin.js';
import { toolbarPlugin } from '$lib/plugins/toolbar/toolbarPlugin.js';
import {
	dispatchDomBeforeInput,
	dispatchDomKeyDown,
	flushDomUpdates,
	renderDomEdytor,
	setNativeSelection
} from '../../dom/test.utils.js';

/** Red on the reference; green since V4. */
const row = it;
/** Green on the reference: a regression guard. */
const pin = it;

afterEach(() => {
	document.body.innerHTML = '';
});

/** A remote peer on a replica of the mounted document; `push` delivers its writes as a remote apply. */
const peer = (edytor: Edytor) => {
	const remoteDoc = new Y.Doc();
	Y.applyUpdate(remoteDoc, Y.encodeStateAsUpdate(edytor.doc));
	const remote = attachDocument(remoteDoc);
	return {
		facade: remote.facade,
		deliver: () =>
			Y.applyUpdate(
				edytor.doc,
				Y.encodeStateAsUpdate(remoteDoc, Y.encodeStateVector(edytor.doc)),
				'peer'
			),
		push: async () => {
			Y.applyUpdate(
				edytor.doc,
				Y.encodeStateAsUpdate(remoteDoc, Y.encodeStateVector(edytor.doc)),
				'peer'
			);
			await flushDomUpdates();
		}
	};
};

/** The selection as (block, display offsets): the plan's coordinates. */
const range = (edytor: Edytor) => {
	const { start, end, isCollapsed, isReversed, kind } = edytor.selection.projection;
	return {
		kind,
		block: start?.block ?? null,
		start: start?.offset ?? null,
		end: end?.offset ?? null,
		isCollapsed,
		isReversed
	};
};

/** The first text node inside a text element. */
const leaf = (element: Element) => {
	const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
	return walker.nextNode() as globalThis.Text;
};

/** The live DOM selection as offsets inside the (single) text node of `element`, or null. */
const domRange = (element: Element) => {
	const selection = window.getSelection();
	if (!selection?.anchorNode || !selection.focusNode) return null;
	if (!element.contains(selection.anchorNode) || !element.contains(selection.focusNode))
		return null;
	return {
		anchor: selection.anchorOffset,
		focus: selection.focusOffset,
		anchorIsText: selection.anchorNode.nodeType === Node.TEXT_NODE
	};
};

/** Every call to a `Selection` mutator while armed. */
const selectionWriteSpy = () => {
	const writes: string[] = [];
	const names = [
		'addRange',
		'removeAllRanges',
		'setBaseAndExtent',
		'collapse',
		'extend',
		'empty',
		'selectAllChildren',
		'collapseToStart',
		'collapseToEnd'
	] as const;
	const originals = new Map<string, unknown>();
	const proto = Selection.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
	for (const name of names) {
		const original = proto[name];
		if (typeof original !== 'function') continue;
		originals.set(name, original);
		proto[name] = function (this: Selection, ...args: unknown[]) {
			writes.push(name);
			return original.apply(this, args);
		};
	}
	return {
		writes,
		restore: () => {
			for (const [name, original] of originals) proto[name] = original as never;
		}
	};
};

describe('F-S1 — the later of two requested writes wins (W1)', () => {
	row('a caret then a range, no await between: the range', async () => {
		const { edytor } = await renderDomEdytor(
			<root>
				<paragraph>a|bcdefgh</paragraph>
			</root>
		);
		const text = edytor.root!.children[0]!.firstText!;
		void edytor.selection.setAtTextOffset(text, 4);
		void edytor.selection.setAtRange(text, 2, text, 6);
		await flushDomUpdates();
		expect(range(edytor)).toMatchObject({ start: 2, end: 6, isCollapsed: false });
		expect(domRange(text.node!)).toEqual({ anchor: 2, focus: 6, anchorIsText: true });
	});

	pin('a range then a caret, no await between: the caret', async () => {
		const { edytor } = await renderDomEdytor(
			<root>
				<paragraph>a|bcdefgh</paragraph>
			</root>
		);
		const text = edytor.root!.children[0]!.firstText!;
		void edytor.selection.setAtRange(text, 2, text, 6);
		void edytor.selection.setAtTextOffset(text, 4);
		await flushDomUpdates();
		expect(range(edytor)).toMatchObject({ start: 4, end: 4, isCollapsed: true });
		expect(domRange(text.node!)).toEqual({ anchor: 4, focus: 4, anchorIsText: true });
	});
});

describe('F-S4 — a programmatic DOM selection with no gesture is adopted', () => {
	row('after a render elsewhere, host code selects 1 → end: the model adopts it', async () => {
		const { edytor } = await renderDomEdytor(
			<root>
				<paragraph>|hello world</paragraph>
				<paragraph>second</paragraph>
			</root>
		);
		const [first, second] = edytor.root!.children;
		// A render after the last gesture (a peer edit in another block).
		const remote = peer(edytor);
		remote.facade.insertText(second!.id, 0, 'X');
		await remote.push();
		expect(range(edytor)).toMatchObject({ block: first!.id, start: 0, isCollapsed: true });

		const node = leaf(first!.firstText!.node!);
		window.getSelection()!.setBaseAndExtent(node, 1, node, 11);
		document.dispatchEvent(new Event('selectionchange'));
		await flushDomUpdates();
		expect(range(edytor)).toEqual({
			kind: 'text',
			block: first!.id,
			start: 1,
			end: 11,
			isCollapsed: false,
			isReversed: false
		});
		expect(domRange(first!.firstText!.node!)).toEqual({
			anchor: 1,
			focus: 11,
			anchorIsText: true
		});
	});

	pin('with no render since the gesture: the model adopts it', async () => {
		const { edytor } = await renderDomEdytor(
			<root>
				<paragraph>|hello world</paragraph>
			</root>
		);
		const text = edytor.root!.children[0]!.firstText!;
		const node = leaf(text.node!);
		window.getSelection()!.setBaseAndExtent(node, 1, node, 11);
		document.dispatchEvent(new Event('selectionchange'));
		await flushDomUpdates();
		expect(range(edytor)).toMatchObject({ start: 1, end: 11, isCollapsed: false });
	});
});

describe('F-S5 — an element-boundary point inside a text element', () => {
	row('(textElement, i) reads the text before child i: 0, 2, 4, 6', async () => {
		const { edytor } = await renderDomEdytor(
			<root>
				<paragraph>
					ab<bold>cd</bold>ef
				</paragraph>
			</root>,
			{ autoSelectFixture: false }
		);
		const text = edytor.root!.children[0]!.firstText!;
		const element = text.node!;
		const children = Array.from(element.childNodes);
		const before = (i: number) =>
			children
				.slice(0, i)
				.reduce(
					(n, child) => n + (child.textContent ?? '').replace(/[\u200B\uFEFF]/g, '').length,
					0
				);
		const expected = children.map((_, i) => before(i)).concat(before(children.length));
		// The fixture renders as the row describes: boundaries at 0, 2, 4 and 6.
		expect([...new Set(expected)]).toEqual([0, 2, 4, 6]);
		const read: number[] = [];
		for (let i = 0; i <= children.length; i++) {
			edytor.markUserGesture();
			window.getSelection()!.setBaseAndExtent(element, i, element, i);
			document.dispatchEvent(new Event('selectionchange'));
			await flushDomUpdates();
			read.push(range(edytor).start ?? -1);
		}
		expect(read).toEqual(expected);
	});
});

describe('F-S6 — a node-bound focus keeps the native direction', () => {
	pin('anchor text@1, focus (textElement, childCount): forward 1 → end', async () => {
		const { edytor } = await renderDomEdytor(
			<root>
				<paragraph>hello world</paragraph>
			</root>,
			{ autoSelectFixture: false }
		);
		const text = edytor.root!.children[0]!.firstText!;
		const element = text.node!;
		edytor.markUserGesture();
		window.getSelection()!.setBaseAndExtent(leaf(element), 1, element, element.childNodes.length);
		document.dispatchEvent(new Event('selectionchange'));
		await flushDomUpdates();
		expect(range(edytor)).toMatchObject({ start: 1, end: 11, isReversed: false });
		expect(edytor.selection.state.content).toBe('ello world');
	});
});

describe('F-S9 — the focus verdict (BI-14)', () => {
	// R7 rewrite (L39): our render re-creates the caret's text element (no
	// whole-editor remount exists); the caret is displayed in the new one.
	row('(a) our render detaches the caret’s node: the caret is displayed', async () => {
		const { edytor } = await renderDomEdytor(
			<root>
				<paragraph>hel|lo</paragraph>
			</root>
		);
		// jsdom does not focus a contenteditable: a tabindex lets the host hold focus.
		edytor.node!.tabIndex = -1;
		edytor.node!.focus();
		const before = edytor.root!.children[0]!.firstText!.node!;
		edytor.cells!.remount(edytor.root!.children[0]!.id);
		await flushDomUpdates();
		const text = edytor.root!.children[0]!.firstText!;
		expect(text.node).not.toBe(before);
		expect(before.isConnected).toBe(false);
		expect(range(edytor)).toMatchObject({ start: 3, isCollapsed: true });
		expect(domRange(text.node!)).toEqual({ anchor: 3, focus: 3, anchorIsText: true });
	});

	pin(
		'(b) the user focuses an outside <input>: a remote apply updates the model only',
		async () => {
			const { edytor } = await renderDomEdytor(
				<root>
					<paragraph>hel|lo</paragraph>
				</root>
			);
			const block = edytor.root!.children[0]!;
			const input = document.createElement('input');
			document.body.append(input);
			input.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
			input.focus();
			const spy = selectionWriteSpy();
			try {
				const remote = peer(edytor);
				remote.facade.insertText(block.id, 0, 'ZZ');
				await remote.push();
			} finally {
				spy.restore();
			}
			expect(range(edytor)).toMatchObject({ block: block.id, start: 5, isCollapsed: true });
			expect(document.activeElement).toBe(input);
			expect(spy.writes).toEqual([]);
		}
	);

	pin(
		'(c) the user selects text outside the editor: a remote apply updates the model only',
		async () => {
			const { edytor } = await renderDomEdytor(
				<root>
					<paragraph>hel|lo</paragraph>
				</root>
			);
			const block = edytor.root!.children[0]!;
			const outside = document.createElement('p');
			outside.textContent = 'outside text';
			document.body.append(outside);
			outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
			(document.activeElement as HTMLElement | null)?.blur();
			window.getSelection()!.setBaseAndExtent(outside.firstChild!, 0, outside.firstChild!, 7);
			document.dispatchEvent(new Event('selectionchange'));
			await flushDomUpdates();
			const spy = selectionWriteSpy();
			try {
				const remote = peer(edytor);
				remote.facade.insertText(block.id, 0, 'ZZ');
				await remote.push();
			} finally {
				spy.restore();
			}
			expect(range(edytor)).toMatchObject({ block: block.id, start: 5, isCollapsed: true });
			expect(spy.writes).toEqual([]);
			expect(window.getSelection()!.anchorNode).toBe(outside.firstChild);
			expect(window.getSelection()!.toString()).toBe('outside');
		}
	);
});

describe('F-S11 (d) — an unobserved native move is admitted after the apply commits (BI-3, LH2-5)', () => {
	row(
		'the move survives the remote apply; the hook’s command is its own local transaction',
		async () => {
			const hook: { open: boolean; offset: number | null }[] = [];
			let edytor!: Edytor;
			let armed = false;
			const origins: unknown[] = [];
			const rendered = await renderDomEdytor(
				<root>
					<paragraph>|hello world</paragraph>
					<paragraph>log</paragraph>
				</root>,
				{
					onSelectionChange: () => {
						if (!armed || !edytor) return;
						const doc = edytor.doc as unknown as { _transaction: unknown };
						hook.push({ open: doc._transaction !== null, offset: range(edytor).start });
						armed = false;
						const log = edytor.root!.children[1]!.firstText!;
						edytor.dispatcher.run('insertText', () =>
							log.insertText({ value: '!', start: log.length, end: log.length })
						);
					}
				}
			);
			edytor = rendered.edytor;
			const [first] = edytor.root!.children;
			edytor.doc.on('update', (_update: Uint8Array, origin: unknown) => origins.push(origin));
			// The user moves the caret natively to 6; its selectionchange has not arrived.
			const node = leaf(first!.firstText!.node!);
			window.getSelection()!.setBaseAndExtent(node, 6, node, 6);
			const remote = peer(edytor);
			remote.facade.insertText(first!.id, 0, 'ZZ');
			armed = true;
			remote.deliver();
			await flushDomUpdates();
			expect(range(edytor)).toMatchObject({ block: first!.id, start: 8, isCollapsed: true });
			expect(hook).toEqual([{ open: false, offset: 8 }]);
			expect(origins).toEqual(['peer', edytor.transaction]);
			expect(edytor.value.children![1]!.content).toEqual([{ text: 'log!' }]);
		}
	);

	pin('an undo that restores a selection runs the hook outside its transaction', async () => {
		const hook: boolean[] = [];
		let edytor!: Edytor;
		let armed = false;
		const origins: unknown[] = [];
		const rendered = await renderDomEdytor(
			<root>
				<paragraph>hello|</paragraph>
				<paragraph>log</paragraph>
			</root>,
			{
				onSelectionChange: () => {
					if (!armed || !edytor) return;
					armed = false;
					hook.push((edytor.doc as unknown as { _transaction: unknown })._transaction !== null);
					const log = edytor.root!.children[1]!.firstText!;
					edytor.dispatcher.run('insertText', () =>
						log.insertText({ value: '!', start: log.length, end: log.length })
					);
				}
			}
		);
		edytor = rendered.edytor;
		edytor.undoManager.stopCapturing();
		await dispatchDomBeforeInput(rendered.editor, { inputType: 'insertText', data: 'X' });
		edytor.doc.on('update', (_update: Uint8Array, origin: unknown) => origins.push(origin));
		armed = true;
		edytor.historyUndo();
		await flushDomUpdates();
		expect(hook).toEqual([false]);
		expect(origins).toEqual([edytor.undoManager, edytor.transaction]);
	});
});

describe('F-P2 — the toolbar holds the selection as a value (L52)', () => {
	row('a link applied after a peer insert covers the selected word', async () => {
		const rendered = await renderDomEdytor(
			<root>
				<paragraph>hello world</paragraph>
			</root>,
			{ plugins: [richTextPlugin, mentionPlugin, toolbarPlugin], autoSelectFixture: false }
		);
		const { edytor } = rendered;
		const block = edytor.root!.children[0]!;
		const text = block.firstText!;
		await setNativeSelection(edytor, text, 6, text, 11);
		const input = rendered.getByTestId('toolbar-link-input') as HTMLInputElement;
		input.focus();
		input.value = 'https://example.com';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		await flushDomUpdates();

		const remote = peer(edytor);
		remote.facade.insertText(block.id, 0, 'ZZZ');
		await remote.push();

		const apply = rendered.getByTestId('toolbar-link-apply');
		apply.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
		apply.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
		await flushDomUpdates();
		expect(edytor.value.children![0]!.content).toEqual([
			{ text: 'ZZZhello ' },
			{ text: 'world', marks: { link: { href: 'https://example.com' } } }
		]);
	});
});

describe('F-P3 — the slash menu holds its range as anchors (L52)', () => {
	row('a peer insert before the query keeps the menu open on quo; Enter runs on /quo', async () => {
		const rendered = await renderDomEdytor(
			<root>
				<paragraph>ab|</paragraph>
			</root>,
			{ plugins: [richTextPlugin, mentionPlugin, slashMenuPlugin] }
		);
		const { edytor, editor } = rendered;
		for (const character of '/quo') {
			await dispatchDomBeforeInput(editor, { inputType: 'insertText', data: character });
		}
		expect(rendered.getByTestId('slash-menu-query').textContent).toBe('/quo');

		const block = edytor.root!.children[0]!;
		const remote = peer(edytor);
		remote.facade.insertText(block.id, 0, 'ZZ');
		await remote.push();
		expect(rendered.queryByTestId('slash-menu-query')?.textContent).toBe('/quo');

		await dispatchDomKeyDown(document, { key: 'Enter', code: 'Enter' });
		await flushDomUpdates();
		expect(edytor.value.children!.map((child) => [child.type, child.content])).toEqual([
			['quote', [{ text: 'ZZab' }]]
		]);
	});
});

describe('F-O1 (timer half) — no selection-display timer is left once a program settles', () => {
	/** Pending timers scheduled by the selection display (selection, surface, bindings). */
	const timerSpy = () => {
		const pending = new Map<unknown, string>();
		const setTimeoutOriginal = window.setTimeout;
		const clearTimeoutOriginal = window.clearTimeout;
		const displayOwned = /src\/lib\/(selection|surface)\/|src\/lib\/session\/bindings\.ts/;
		window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
			const stack = new Error().stack ?? '';
			let id: unknown;
			const run = (...runArgs: unknown[]) => {
				pending.delete(id);
				if (typeof handler === 'function') handler(...runArgs);
			};
			id = setTimeoutOriginal(run as TimerHandler, timeout, ...args);
			// The scheduling frame: the first library frame on the stack.
			const frame = stack.split('\n').find((line) => line.includes('/src/lib/')) ?? '';
			if (displayOwned.test(frame)) pending.set(id, frame.trim());
			return id;
		}) as typeof window.setTimeout;
		window.clearTimeout = ((id?: number) => {
			pending.delete(id);
			return clearTimeoutOriginal(id);
		}) as typeof window.clearTimeout;
		return {
			pending: () => [...pending.values()],
			restore: () => {
				window.setTimeout = setTimeoutOriginal;
				window.clearTimeout = clearTimeoutOriginal;
			}
		};
	};

	const programs: [string, (edytor: Edytor, editor: HTMLElement) => Promise<unknown>][] = [
		[
			'a caret write',
			(edytor) => edytor.selection.setAtTextOffset(edytor.root!.children[1]!.firstText!, 2)
		],
		[
			'typing',
			(_, editor) => dispatchDomBeforeInput(editor, { inputType: 'insertText', data: 'x' })
		],
		['Enter', (_, editor) => dispatchDomBeforeInput(editor, { inputType: 'insertParagraph' })],
		['Tab (nest)', (_, editor) => dispatchDomKeyDown(editor, { key: 'Tab', code: 'Tab' })],
		[
			'a block-set delete',
			async (edytor, editor) => {
				edytor.selection.selectBlocks(edytor.root!.children[1]!);
				await flushDomUpdates();
				return dispatchDomKeyDown(editor, { key: 'Backspace', code: 'Backspace' });
			}
		],
		[
			'a remote apply under the caret',
			async (edytor) => {
				const remote = peer(edytor);
				remote.facade.insertText(edytor.root!.children[0]!.id, 0, 'Z');
				return remote.push();
			}
		],
		[
			'an undo',
			async (edytor, editor) => {
				await dispatchDomBeforeInput(editor, { inputType: 'insertText', data: 'x' });
				edytor.historyUndo();
			}
		]
	];

	for (const [name, program] of programs) {
		row(`${name}: no display timer pending at settle`, async () => {
			const { edytor, editor } = await renderDomEdytor(
				<root>
					<paragraph>fir|st</paragraph>
					<paragraph>second</paragraph>
				</root>
			);
			const spy = timerSpy();
			try {
				await program(edytor, editor);
				await flushDomUpdates();
				expect(spy.pending()).toEqual([]);
			} finally {
				spy.restore();
			}
		});
	}
});
