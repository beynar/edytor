/** @jsxImportSource ../../jsx */
/**
 * arch-v2 — checkpoint S7 rows, dom lane: history (R7's named exception, R9,
 * L2, O32, D-23, F4). Every row runs on the three history channels: the
 * Mod+Z / Mod+Shift+Z bindings, `beforeinput` `historyUndo`/`historyRedo`,
 * and `edytor.historyUndo()`/`historyRedo()`.
 *
 * - F-U1 — `Hello world`, caret @5, type `abc` (@8); a peer inserts `XYZ` at
 *   0; undo → the caret sits @8 of `XYZHello world` (the recorded `before`,
 *   resolved causally).
 * - F-U2 — type `!` at the end of `hello world`; a peer inserts a mention at
 *   3; undo → the caret sits after `world`, not before the mention.
 * - F-U6 — select the first child of a list, delete, undo, redo → undo
 *   restores the block set; redo lands on the recorded `after` (the
 *   selection the delete left), the same answer on every channel (H3).
 * - F-U7 — views V1 and V2 on one document; V1 types, then undoes → V1
 *   restores its `before`; V2's caret rides the change (H1).
 * - F-U9 (dom half) — undo then redo; a normalizer armed before the undo →
 *   the undo is one update, the normalizer does not fire, redo stays
 *   available and redoes (D-23, F4).
 * - S7-after (coordinator row, L2/F-U6 intent) — type `abc` (caret @3), click
 *   the caret to @0, undo, redo → the caret is @3 again: `after` is the
 *   selection the step's last transaction left, not the one at undo time.
 *
 * Expected values come from the plan rows, never from running the code.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { Y } from '$lib/crdt/engine.js';
import { attachDocument, createDocument } from '$lib/crdt/document.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { Plugin } from '$lib/plugins.js';
import { mentionPlugin } from '$lib/plugins/mention/MentionPlugin.svelte';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import {
	dispatchDomBeforeInput,
	dispatchDomKeyDown,
	flushDomUpdates,
	renderDomEdytor,
	setNativeSelection
} from '../../dom/test.utils.js';

/**
 * Rows still red (expected-fail). Red on the reference (arch-v2/ref-s7): F-U1
 * and F-U2 on hotkey and beforeinput, F-U6 on every channel, F-U9 on api —
 * all green since S7.
 */
const RED = new Set<string>([]);
/** A plan row on one channel: `it.fails` while red, else `it`. */
const row = (id: string, channel: Channel) => (RED.has(`${id} ${channel}`) ? it.fails : it);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Channel = 'hotkey' | 'beforeinput' | 'api';
const channels: Channel[] = ['hotkey', 'beforeinput', 'api'];

/** Run one history command through `channel`, then let every deferred write land. */
const history = async (
	channel: Channel,
	edytor: Edytor,
	editor: HTMLElement,
	command: 'undo' | 'redo'
) => {
	if (channel === 'hotkey')
		await dispatchDomKeyDown(editor, {
			key: 'z',
			code: 'KeyZ',
			metaKey: true,
			shiftKey: command === 'redo'
		});
	else if (channel === 'beforeinput')
		await dispatchDomBeforeInput(editor, {
			inputType: command === 'undo' ? 'historyUndo' : 'historyRedo'
		});
	else if (command === 'undo') edytor.historyUndo();
	else edytor.historyRedo();
	await flushDomUpdates();
	await sleep(60);
	await flushDomUpdates();
};

/** A remote peer on a replica of the mounted document; `push` delivers its writes as a remote apply. */
const peer = (edytor: Edytor) => {
	const remoteDoc = new Y.Doc();
	Y.applyUpdate(remoteDoc, Y.encodeStateAsUpdate(edytor.doc));
	const remote = attachDocument(remoteDoc);
	return {
		facade: remote.facade,
		push: async () => {
			Y.applyUpdate(edytor.doc, Y.encodeStateAsUpdate(remoteDoc, Y.encodeStateVector(edytor.doc)));
			await flushDomUpdates();
		}
	};
};

/** The caret as (block id, display offset): the plan's coordinates. */
const caret = (edytor: Edytor) => {
	const { startText, yStart, isCollapsed } = edytor.selection.state;
	return {
		block: startText?.parent.id ?? null,
		offset: startText ? startText.segStart + yStart : null,
		isCollapsed
	};
};

const plainText = (edytor: Edytor, index = 0) =>
	(edytor.value.children[index]?.content ?? [])
		.map((part) => ('text' in part ? part.text : '@'))
		.join('');

afterEach(() => {
	document.body.innerHTML = '';
});

describe('S7 — history restores the issuing view’s recorded selection', () => {
	for (const channel of channels) {
		row('F-U1', channel)(
			`F-U1 (${channel}): undo after a peer insert restores the caret @8`,
			async () => {
				const { edytor, editor } = await renderDomEdytor(
					<root>
						<paragraph>Hello| world</paragraph>
					</root>
				);
				const block = edytor.root!.children[0]!;
				edytor.undoManager.stopCapturing();
				await dispatchDomBeforeInput(editor, { inputType: 'insertText', data: 'abc' });
				expect(plainText(edytor)).toBe('Helloabc world');
				expect(caret(edytor)).toEqual({ block: block.id, offset: 8, isCollapsed: true });

				const remote = peer(edytor);
				remote.facade.insertText(block.id, 0, 'XYZ');
				await remote.push();
				expect(plainText(edytor)).toBe('XYZHelloabc world');
				expect(caret(edytor).offset).toBe(11);

				await history(channel, edytor, editor, 'undo');
				expect(plainText(edytor)).toBe('XYZHello world');
				expect(caret(edytor)).toEqual({ block: block.id, offset: 8, isCollapsed: true });
			}
		);

		row('F-U2', channel)(
			`F-U2 (${channel}): undo after a peer mention restores the caret after \`world\``,
			async () => {
				const { edytor, editor } = await renderDomEdytor(
					<root>
						<paragraph>hello world|</paragraph>
					</root>,
					{ plugins: [richTextPlugin, mentionPlugin] }
				);
				const block = edytor.root!.children[0]!;
				edytor.undoManager.stopCapturing();
				await dispatchDomBeforeInput(editor, { inputType: 'insertText', data: '!' });
				expect(plainText(edytor)).toBe('hello world!');

				const remote = peer(edytor);
				remote.facade.insertInline(block.id, 3, { id: 'm1', type: 'mention', data: {} });
				await remote.push();
				expect(plainText(edytor)).toBe('hel@lo world!');

				await history(channel, edytor, editor, 'undo');
				expect(plainText(edytor)).toBe('hel@lo world');
				// After `world`: display offset 12 (the mention counts one).
				expect(caret(edytor)).toEqual({ block: block.id, offset: 12, isCollapsed: true });
			}
		);

		row('F-U6', channel)(
			`F-U6 (${channel}): delete the first list child, undo restores it selected, redo lands on the recorded after`,
			async () => {
				const { edytor, editor } = await renderDomEdytor(
					<root>
						<paragraph>Intro</paragraph>
						<ordered-list>
							<list-item>One</list-item>
							<list-item>Two</list-item>
						</ordered-list>
					</root>,
					{ autoSelectFixture: false }
				);
				const list = edytor.root!.children[1]!;
				const first = list.children[0]!;
				editor.focus();
				await setNativeSelection(edytor, first.firstText, 1);
				edytor.selection.selectBlocks(first);
				await flushDomUpdates();
				edytor.undoManager.stopCapturing();
				await dispatchDomKeyDown(editor, { key: 'Backspace', code: 'Backspace' });
				await sleep(60);
				await flushDomUpdates();
				expect(list.children.map((child) => child.id)).not.toContain(first.id);
				const after = caret(edytor);
				expect(after.block).not.toBeNull();

				await history(channel, edytor, editor, 'undo');
				expect(edytor.root!.children[1]!.children[0]!.id).toBe(first.id);
				expect([...edytor.selection.selectedBlocks].map((block) => block.id)).toEqual([first.id]);
				expect(edytor.undoManager.canRedo()).toBe(true);

				await history(channel, edytor, editor, 'redo');
				expect(edytor.root!.children[1]!.children.map((child) => child.id)).not.toContain(first.id);
				expect(edytor.selection.selectedBlocks.size).toBe(0);
				expect(caret(edytor)).toEqual(after);
			}
		);

		row('F-U7', channel)(
			`F-U7 (${channel}): V1 undoes its typing — V1 restores its before, V2's caret rides`,
			async () => {
				const value = { children: [{ type: 'paragraph', content: [{ text: 'Hello world' }] }] };
				const shared = createDocument({ value: structuredClone(value) });
				const v1 = await renderDomEdytor(<root></root>, {
					value,
					document: shared,
					autoSelectFixture: false
				});
				const v2 = await renderDomEdytor(<root></root>, {
					value,
					document: shared,
					autoSelectFixture: false
				});
				const block1 = v1.edytor.root!.children[0]!;
				const block2 = v2.edytor.root!.children[0]!;
				v2.edytor.selection.setCollapsedStateAtTextOffset(block2.firstText, 11);
				await setNativeSelection(v1.edytor, block1.firstText, 5);
				v1.edytor.undoManager.stopCapturing();
				await dispatchDomBeforeInput(v1.editor, { inputType: 'insertText', data: 'abc' });
				expect(plainText(v1.edytor)).toBe('Helloabc world');
				expect(caret(v2.edytor).offset).toBe(14);

				await history(channel, v1.edytor, v1.editor, 'undo');
				expect(plainText(v1.edytor)).toBe('Hello world');
				expect(caret(v1.edytor)).toEqual({ block: block1.id, offset: 5, isCollapsed: true });
				expect(caret(v2.edytor)).toEqual({ block: block2.id, offset: 11, isCollapsed: true });
			}
		);

		row('F-U9', channel)(
			`F-U9 (${channel}): no normalization after undo; one update; redo stays available`,
			async () => {
				let armed = false;
				let firedWhileArmed = 0;
				// The paragraph kind with a normalizer that records whether it ran.
				const normalizer: Plugin = (host) => {
					const definitions = richTextPlugin(host);
					const paragraph = definitions.blocks!.paragraph!;
					return {
						...definitions,
						blocks: {
							...definitions.blocks,
							paragraph: {
								...paragraph,
								normalizeContent: (payload) => {
									if (armed) firedWhileArmed++;
									return paragraph.normalizeContent?.(payload);
								}
							}
						}
					};
				};
				const { edytor, editor } = await renderDomEdytor(
					<root>
						<paragraph>Hello|</paragraph>
					</root>,
					{ plugins: [normalizer] }
				);
				edytor.undoManager.stopCapturing();
				await dispatchDomBeforeInput(editor, { inputType: 'insertText', data: '!' });
				expect(plainText(edytor)).toBe('Hello!');

				let updates = 0;
				const count = () => updates++;
				edytor.doc.on('update', count);
				armed = true;
				await history(channel, edytor, editor, 'undo');
				armed = false;
				expect(plainText(edytor)).toBe('Hello');
				expect(updates).toBe(1);
				expect(firedWhileArmed).toBe(0);
				expect(edytor.undoManager.canRedo()).toBe(true);

				await history(channel, edytor, editor, 'redo');
				edytor.doc.off('update', count);
				expect(plainText(edytor)).toBe('Hello!');
				expect(updates).toBe(2);
				expect(caret(edytor).offset).toBe(6);
			}
		);

		row('S7-after', channel)(
			`S7-after (${channel}): redo returns the caret to where the command left it`,
			async () => {
				const { edytor, editor } = await renderDomEdytor(
					<root>
						<paragraph>|</paragraph>
					</root>
				);
				const block = edytor.root!.children[0]!;
				edytor.undoManager.stopCapturing();
				await dispatchDomBeforeInput(editor, { inputType: 'insertText', data: 'abc' });
				expect(plainText(edytor)).toBe('abc');
				expect(caret(edytor)).toEqual({ block: block.id, offset: 3, isCollapsed: true });

				// A click moves the caret to the start.
				editor.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
				await setNativeSelection(edytor, block.firstText, 0);
				await flushDomUpdates();
				expect(caret(edytor).offset).toBe(0);

				await history(channel, edytor, editor, 'undo');
				expect(plainText(edytor)).toBe('');
				await history(channel, edytor, editor, 'redo');
				expect(plainText(edytor)).toBe('abc');
				expect(caret(edytor)).toEqual({ block: block.id, offset: 3, isCollapsed: true });
			}
		);
	}
});
