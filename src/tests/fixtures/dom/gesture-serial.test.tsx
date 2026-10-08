/** @jsxImportSource ../../jsx */
/**
 * Independent review of 2026-09-29 (dom lane). The first two rows are the
 * reviewer's reproductions, red on 5e21dad; the rest are variants added with
 * the fixes. Expected values come from the contracts, never from running the code:
 *
 * - A composition replaces only its own preview (`session/composition`): a
 *   peer's text that landed inside the preview is foreign and stays; the
 *   replacement takes the place of the preview's first live unit (range
 *   replacement), so foreign text before that unit stays before the committed
 *   text and foreign text after it follows it; the caret lands after the
 *   committed text. Replicas converge.
 * - Every deferred selection write checks the gesture serial on every exit
 *   (`docs/editor-delete-contract.md`, "Selection ownership and lifecycle"):
 *   an adoption's caret after its render tick, the observer's next-task
 *   redisplay after a root heal and the drift repair's caret after its
 *   discard wait all yield to a newer gesture — keyboard or pointer.
 */
import { describe, expect, it } from 'vitest';
import { Y } from '$lib/crdt/engine.js';
import { attachDocument } from '$lib/crdt/document.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import { adopt } from '$lib/surface/observer.svelte.js';
import {
	dispatchComposition,
	flushDomUpdates,
	renderDomEdytor,
	textNodeOf
} from '../../dom/test.utils.js';

/** A replica of the mounted document; `sync` exchanges both ways. */
const peer = (edytor: Edytor) => {
	const remoteDoc = new Y.Doc();
	Y.applyUpdate(remoteDoc, Y.encodeStateAsUpdate(edytor.doc));
	const remote = attachDocument(remoteDoc);
	return {
		facade: remote.facade,
		doc: remoteDoc,
		sync: () => {
			const local = Y.encodeStateAsUpdate(edytor.doc, Y.encodeStateVector(remoteDoc));
			Y.applyUpdate(edytor.doc, Y.encodeStateAsUpdate(remoteDoc, Y.encodeStateVector(edytor.doc)));
			Y.applyUpdate(remoteDoc, local);
		}
	};
};

const compose = (editor: HTMLElement, data: string) =>
	dispatchComposition(editor, [{ type: 'beforeinput', inputType: 'insertCompositionText', data }]);

describe('independent current-branch review', () => {
	it('composition completion preserves a foreign insertion inside the preview', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>ab|cd</paragraph>
			</root>
		);
		const remoteDoc = new Y.Doc();
		Y.applyUpdate(remoteDoc, Y.encodeStateAsUpdate(edytor.doc));
		const remote = attachDocument(remoteDoc);
		const sync = () => {
			const local = Y.encodeStateAsUpdate(edytor.doc, Y.encodeStateVector(remoteDoc));
			Y.applyUpdate(edytor.doc, Y.encodeStateAsUpdate(remoteDoc, Y.encodeStateVector(edytor.doc)));
			Y.applyUpdate(remoteDoc, local);
		};
		const id = edytor.root!.children[0]!.id;
		try {
			await dispatchComposition(editor, [{ type: 'compositionstart' }]);
			await dispatchComposition(editor, [
				{ type: 'beforeinput', inputType: 'insertCompositionText', data: 'にほん' }
			]);
			sync();
			expect(remote.facade.blockText(id)).toBe('abにほんcd');
			expect(remote.facade.insertText(id, 3, 'X').status).toBe('applied');
			sync();
			await flushDomUpdates();
			expect(edytor.facade.blockText(id)).toBe('abにXほんcd');
			await dispatchComposition(editor, [{ type: 'compositionend', data: '日本' }]);
			sync();
			expect(
				edytor.facade.blockText(id),
				'X is a peer contribution, not an IME preview atom'
			).toContain('X');
			expect(remote.facade.blockText(id)).toBe(edytor.facade.blockText(id));
		} finally {
			remoteDoc.destroy();
		}
	});

	it('an adoption continuation must not overwrite a newer gesture selection', async () => {
		const { edytor } = await renderDomEdytor(
			<root>
				<paragraph>abc|</paragraph>
				<paragraph>next</paragraph>
			</root>
		);
		const first = edytor.root!.children[0]!.firstText!;
		const second = edytor.root!.children[1]!.firstText!;
		const pending = adopt(edytor, first, 'abcd', 4);
		edytor.markUserGesture();
		edytor.selection.select(edytor.selection.textValue(second, 1));
		expect(edytor.selection.state.startText).toBe(second);
		await pending;
		expect(
			edytor.selection.state.startText,
			'newer selection intent must survive the older async adoption'
		).toBe(second);
		expect(edytor.selection.state.yStart).toBe(1);
	});
});

describe('a composition replaces only its own preview (variants)', () => {
	/**
	 * `ab|cd`, preview `にほん`, synced; the peer's `edit` lands; `compositionend`
	 * commits `commit`. Returns the local and remote texts and the local caret.
	 */
	const scenario = async (
		edit: (facade: ReturnType<typeof peer>['facade'], id: string) => void,
		options: { seen: string; commit: string; update?: string }
	) => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>ab|cd</paragraph>
			</root>
		);
		const remote = peer(edytor);
		const id = edytor.root!.children[0]!.id;
		try {
			await dispatchComposition(editor, [{ type: 'compositionstart' }]);
			await compose(editor, 'にほん');
			remote.sync();
			edit(remote.facade, id);
			remote.sync();
			await flushDomUpdates();
			expect(edytor.facade.blockText(id)).toBe(options.seen);
			if (options.update) {
				await compose(editor, options.update);
				remote.sync();
			}
			await dispatchComposition(editor, [{ type: 'compositionend', data: options.commit }]);
			remote.sync();
			await flushDomUpdates();
			const { startText, yStart, isCollapsed } = edytor.selection.state;
			return {
				edytor,
				local: edytor.facade.blockText(id),
				remote: remote.facade.blockText(id),
				caret: isCollapsed && startText?.parent.id === id ? yStart : null
			};
		} finally {
			remote.doc.destroy();
		}
	};

	it('a peer insert inside the preview follows the committed text', async () => {
		const result = await scenario((facade, id) => facade.insertText(id, 3, 'X'), {
			seen: 'abにXほんcd',
			commit: '日本'
		});
		expect(result.local).toBe('ab日本Xcd');
		expect(result.remote).toBe('ab日本Xcd');
		expect(result.caret).toBe(4);
	});

	it('a peer insert at the preview start stays before the committed text', async () => {
		const result = await scenario((facade, id) => facade.insertText(id, 2, 'X'), {
			seen: 'abXにほんcd',
			commit: '日本'
		});
		expect(result.local).toBe('abX日本cd');
		expect(result.remote).toBe('abX日本cd');
		expect(result.caret).toBe(5);
	});

	it('a peer insert at the preview end stays after the committed text', async () => {
		const result = await scenario((facade, id) => facade.insertText(id, 5, 'X'), {
			seen: 'abにほんXcd',
			commit: '日本'
		});
		expect(result.local).toBe('ab日本Xcd');
		expect(result.remote).toBe('ab日本Xcd');
		expect(result.caret).toBe(4);
	});

	it('a peer delete inside the preview: the commit replaces what is left of it', async () => {
		const result = await scenario((facade, id) => facade.deleteText(id, 3, 1), {
			seen: 'abにんcd',
			commit: '日本'
		});
		expect(result.local).toBe('ab日本cd');
		expect(result.remote).toBe('ab日本cd');
		expect(result.caret).toBe(4);
	});

	it('a later preview update also keeps the foreign text, in the preview’s place', async () => {
		const result = await scenario((facade, id) => facade.insertText(id, 3, 'X'), {
			seen: 'abにXほんcd',
			update: 'にほんご',
			commit: '日本語'
		});
		expect(result.local).toBe('ab日本語Xcd');
		expect(result.remote).toBe('ab日本語Xcd');
		expect(result.caret).toBe(5);
	});

	it('a cancel deletes only the preview', async () => {
		const result = await scenario((facade, id) => facade.insertText(id, 3, 'X'), {
			seen: 'abにXほんcd',
			commit: ''
		});
		expect(result.local).toBe('abXcd');
		expect(result.remote).toBe('abXcd');
	});

	it('one undo after the commit removes the composition and keeps the peer’s text', async () => {
		const result = await scenario((facade, id) => facade.insertText(id, 3, 'X'), {
			seen: 'abにXほんcd',
			commit: '日本'
		});
		result.edytor.historyUndo();
		await flushDomUpdates();
		expect(result.edytor.facade.blockText(result.edytor.root!.children[0]!.id)).toBe('abXcd');
	});
});

describe('an adoption never overwrites a newer gesture (variants)', () => {
	it('a keyboard gesture (select-all) after the adoption keeps its range', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>abc|</paragraph>
				<paragraph>next</paragraph>
			</root>
		);
		const first = edytor.root!.children[0]!.firstText!;
		const pending = adopt(edytor, first, 'abcd', 4);
		// Synchronous: the key lands before any continuation of the adoption could run.
		editor.dispatchEvent(
			new KeyboardEvent('keydown', {
				key: 'a',
				code: 'KeyA',
				metaKey: true,
				bubbles: true,
				cancelable: true
			})
		);
		await pending;
		await flushDomUpdates();
		expect(edytor.facade.blockText(first.parent.id)).toBe('abcd');
		const { startText, yStart, endText, yEnd, isCollapsed } = edytor.selection.state;
		expect(isCollapsed, 'select-all ran after the adoption: its range stands').toBe(false);
		expect([startText?.parent.id, yStart, endText?.parent.id, yEnd]).toEqual([
			first.parent.id,
			0,
			first.parent.id,
			4
		]);
	});

	it('a pointer gesture after the adoption keeps its caret', async () => {
		const { edytor } = await renderDomEdytor(
			<root>
				<paragraph>abc|</paragraph>
				<paragraph>next</paragraph>
			</root>
		);
		const first = edytor.root!.children[0]!.firstText!;
		const second = edytor.root!.children[1]!.firstText!;
		const node = await textNodeOf(second);
		const pending = adopt(edytor, first, 'abcd', 4);
		// Synchronous: pointerdown, the browser's caret in `next` at 1, pointerup.
		node.dispatchEvent(new Event('pointerdown', { bubbles: true }));
		const range = document.createRange();
		range.setStart(document.createTreeWalker(node, NodeFilter.SHOW_TEXT).nextNode()!, 1);
		range.collapse(true);
		window.getSelection()!.removeAllRanges();
		window.getSelection()!.addRange(range);
		document.dispatchEvent(new Event('selectionchange'));
		node.dispatchEvent(new Event('pointerup', { bubbles: true }));
		await pending;
		await flushDomUpdates();
		expect(edytor.facade.blockText(first.parent.id)).toBe('abcd');
		expect(edytor.selection.state.startText?.parent.id).toBe(second.parent.id);
		expect(edytor.selection.state.yStart).toBe(1);
		expect(edytor.selection.state.isCollapsed).toBe(true);
	});
});

describe('the observer’s deferred redisplay checks the gesture serial', () => {
	it('a gesture between a root heal and its next-task redisplay owns the selection', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		);
		editor.dispatchEvent(new FocusEvent('focusout', { relatedTarget: null }));
		window.getSelection()!.removeAllRanges();
		// A foreign write blurs the root; the observer heals it and displays at once…
		editor.removeAttribute('contenteditable');
		for (let i = 0; i < 20 && editor.getAttribute('contenteditable') === null; i++)
			await Promise.resolve();
		expect(editor.getAttribute('contenteditable')).not.toBeNull();
		// …then the user acts (a gesture that leaves no range) before the next task.
		edytor.markUserGesture();
		window.getSelection()!.removeAllRanges();
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(window.getSelection()!.rangeCount, 'the next-task redisplay is stale').toBe(0);
	});
});

describe('the drift repair’s deferred caret checks the gesture serial', () => {
	it('a gesture during the discard wait owns the selection', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>ab|cd</paragraph>
				<paragraph>next</paragraph>
			</root>
		);
		const event = (type: string) => {
			const input = new Event(type, { bubbles: true, cancelable: false }) as InputEvent;
			Object.defineProperties(input, {
				inputType: { value: 'insertParagraph' },
				data: { value: null },
				isComposing: { value: false }
			});
			return input;
		};
		// A non-cancelable line break: the model performs it and owns the browser's drift.
		editor.dispatchEvent(event('beforeinput'));
		await flushDomUpdates();
		expect(edytor.root!.children.map((block) => block.firstText?.stringContent)).toEqual([
			'ab',
			'cd',
			'next'
		]);
		// The browser's `input`: the repair waits, then puts the model caret back…
		editor.dispatchEvent(event('input'));
		// …but the user selects `n|ext` meanwhile.
		const next = edytor.root!.children[2]!.firstText!;
		edytor.markUserGesture();
		edytor.selection.select(edytor.selection.textValue(next, 1));
		await new Promise((resolve) => setTimeout(resolve, 60));
		await flushDomUpdates();
		expect(edytor.selection.state.startText?.parent.id).toBe(next.parent.id);
		expect(edytor.selection.state.yStart).toBe(1);
	});
});
