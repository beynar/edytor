/** @jsxImportSource ../../jsx */
/**
 * arch-v2 — checkpoint I4 rows (dom lane): the IME pin and one-node text
 * rendering (plan §2.4 "Segments", "Placeholder attribute"; §4.4
 * `surface/pin`, components; §8.4 F-I10, F-I10b, F-I11, F-I12, F-I15; §11.2
 * D-20; §12 BI-6, BI-13, BI-15).
 *
 * - F-I10 — composing in the second segment of `ab@cd`; a peer inserts an
 *   atom before `@` → the composing text node keeps its identity; the commit
 *   lands after `@`.
 * - F-I10b — composing at `ab@cd|`; a peer inserts a mention between `c` and
 *   `d` → the host text is never rendered twice during the session; after the
 *   commit the atom renders once, in place (BI-13).
 * - F-I11 — composing after atom `@` in `ab@cd`; a peer deletes `@` → the
 *   composing node survives until the session ends; the segments merge after
 *   the commit.
 * - F-I12 (D-20, commit first) — a peer deletes, retypes, re-parents or merges
 *   the block holding a live composition → the session commits what the IME
 *   shows before the change renders; text composed into a deleted block is
 *   lost with it; nothing is duplicated; the caret lands per the contract.
 *   (b) the IME keeps composing after that forced commit → the continued
 *   composition opens a new session over what the IME shows and commits once.
 * - F-I15 — composing into an empty paragraph: the host text node before the
 *   first preview is the node after the pin release (filler and text in one
 *   node, BI-15); no placeholder while the session lives (BI-9).
 *
 * Expected values come from the plan rows, never from running the code.
 */
import { describe, expect, it } from 'vitest';
import { Y } from '$lib/crdt/engine.js';
import { attachDocument } from '$lib/crdt/document.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import {
	dispatchComposition,
	dispatchDomBeforeInput,
	flushDomUpdates,
	renderDomEdytor
} from '../../dom/test.utils.js';

/** Red on the reference (`arch-v2/ref-i4`): expected-fail until I4 flips it. */
const row = it;
/** Green on the reference: a regression guard. */
const pin = it;

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
		},
		/** The replica's root blocks as `type:text` (atoms as `@`). */
		read: () =>
			remote.facade
				.project()
				.children.map(
					(block: { type: string; content: readonly { text?: string }[] }) =>
						`${block.type}:${block.content.map((part) => part.text ?? '@').join('')}`
				)
	};
};

/** Root blocks as `type:text`, atoms as `@`, nested children in braces. */
const shape = (edytor: Edytor) => {
	type Node = { type: string; content?: { text?: string }[]; children?: Node[] };
	const walk = (block: Node): string => {
		const text = (block.content ?? []).map((part) => part.text ?? '@').join('');
		const kids = block.children?.length ? `{${block.children.map(walk).join(', ')}}` : '';
		return `${block.type}:${text}${kids}`;
	};
	return ((edytor.value.children ?? []) as Node[]).map(walk);
};
const textNodes = (element: Node) => {
	const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
	const out: globalThis.Text[] = [];
	while (walker.nextNode()) out.push(walker.currentNode as globalThis.Text);
	return out.filter((node) => node.data.replace(/\u200B/g, '').length > 0);
};
/** Every text node, the empty filler included. */
const allTextNodes = (element: Node) => {
	const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
	const out: globalThis.Text[] = [];
	while (walker.nextNode()) out.push(walker.currentNode as globalThis.Text);
	return out;
};
const blockOf = (edytor: Edytor, index: number) => edytor.root!.children[index]!;
const shown = (element: Element) => (element.textContent ?? '').replace(/\u200B/g, '');
const atoms = (element: Element) =>
	element.querySelectorAll('span[data-edytor-inline-block]').length;
const textElements = (element: Element) =>
	Array.from(element.querySelectorAll<HTMLElement>('[data-edytor-text="true"]'));
const placeholders = (editor: HTMLElement) =>
	editor.querySelectorAll('[data-edytor-text-placeholder]').length;
const caret = (edytor: Edytor) => {
	const { startText, yStart, isCollapsed } = edytor.selection.state;
	return { block: startText?.parent.id, offset: yStart, isCollapsed };
};

const start = (editor: HTMLElement) => dispatchComposition(editor, [{ type: 'compositionstart' }]);
const preview = (editor: HTMLElement, data: string) =>
	dispatchComposition(editor, [{ type: 'beforeinput', inputType: 'insertCompositionText', data }]);
const end = (editor: HTMLElement, data: string) =>
	dispatchComposition(editor, [{ type: 'compositionend', data }]);
const undo = (editor: HTMLElement) => dispatchDomBeforeInput(editor, { inputType: 'historyUndo' });

const mention = (id: string) => ({ id, type: 'mention', data: {} });
/** The block's atom ids and texts in order (`@<id>` for an atom). */
const parts = (edytor: Edytor, index: number) =>
	(edytor.value.children?.[index]?.content ?? []).map((part) =>
		'text' in part ? part.text : `@${(part as { id?: string }).id}`
	);

describe('F-I10 — a peer atom before the composing segment keeps the IME node', () => {
	pin('the composing text node keeps its identity; the commit lands after @', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>
					ab
					<mention />
					c|d
				</paragraph>
				<paragraph>other</paragraph>
			</root>
		);
		const remote = peer(edytor);
		const block = blockOf(edytor, 0);
		const atomId = parts(edytor, 0)[1]!.slice(1);
		const host = textElements(block.node!)[1]!;
		expect(shown(host)).toBe('cd');
		await start(editor);
		await preview(editor, 'に');
		const nodes = textNodes(host);

		// A peer inserts an atom before `@` (block offset 2).
		remote.facade.insertInline(block.id, 2, mention('peer-atom'));
		remote.sync();
		await flushDomUpdates();

		expect(edytor.isComposing).toBe(true);
		expect(host.isConnected && block.node!.contains(host)).toBe(true);
		expect(nodes.length).toBeGreaterThan(0);
		expect(nodes.every((node) => node.isConnected && host.contains(node))).toBe(true);

		await end(editor, 'に');
		await flushDomUpdates();
		const after = parts(edytor, 0);
		// The commit lands after the original `@`.
		expect(after.slice(-2)).toEqual([`@${atomId}`, 'cにd']);
		expect(after).toContain('@peer-atom');
		expect(atoms(block.node!)).toBe(2);
		expect(shown(block.node!).split('cにd').length - 1).toBe(1);
	});
});

describe('F-I10b — a peer atom inside the host segment renders nothing twice (BI-13)', () => {
	pin('the host text shows once during the session; the atom renders once after', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>
					ab
					<mention />
					cd|
				</paragraph>
				<paragraph>other</paragraph>
			</root>
		);
		const remote = peer(edytor);
		const block = blockOf(edytor, 0);
		const atomId = parts(edytor, 0)[1]!.slice(1);
		await start(editor);
		await preview(editor, 'に');
		const host = textElements(block.node!)[1]!;
		const nodes = textNodes(host);

		// A peer inserts a mention between `c` and `d` (block offset 4).
		remote.facade.insertInline(block.id, 4, mention('peer-atom'));
		remote.sync();
		await flushDomUpdates();

		expect(edytor.isComposing).toBe(true);
		expect(nodes.every((node) => node.isConnected && host.contains(node))).toBe(true);
		// Never twice: neither `c` nor `d` shows a second time.
		expect(shown(block.node!).split('c').length - 1).toBe(1);
		expect(shown(block.node!).split('d').length - 1).toBe(1);
		expect(atoms(block.node!)).toBe(1);

		await end(editor, 'に');
		await flushDomUpdates();
		expect(parts(edytor, 0)).toEqual(['ab', `@${atomId}`, 'c', '@peer-atom', 'dに']);
		expect(atoms(block.node!)).toBe(2);
		expect(textElements(block.node!).map(shown)).toEqual(['ab', 'c', 'dに']);
	});
});

describe('F-I11 — a peer deletes the atom before the composing segment', () => {
	pin('the composing node survives until the end; the segments merge after', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>
					ab
					<mention />
					|cd
				</paragraph>
				<paragraph>other</paragraph>
			</root>
		);
		const remote = peer(edytor);
		const block = blockOf(edytor, 0);
		const atomId = parts(edytor, 0)[1]!.slice(1);
		const host = textElements(block.node!)[1]!;
		await start(editor);
		await preview(editor, 'に');
		const nodes = textNodes(host);

		remote.facade.removeInline(block.id, atomId);
		remote.sync();
		await flushDomUpdates();

		expect(edytor.isComposing).toBe(true);
		expect(host.isConnected && block.node!.contains(host)).toBe(true);
		expect(nodes.every((node) => node.isConnected && host.contains(node))).toBe(true);

		await end(editor, 'に');
		await flushDomUpdates();
		expect(parts(edytor, 0)).toEqual(['abにcd']);
		expect(atoms(block.node!)).toBe(0);
		expect(textElements(block.node!).map(shown)).toEqual(['abにcd']);
	});
});

/** `prev | abc|` with a live preview `に` in the second block, seen by the peer. */
const composing = async () => {
	const rendered = await renderDomEdytor(
		<root>
			<paragraph>prev</paragraph>
			<paragraph>abc|</paragraph>
		</root>
	);
	const { edytor, editor } = rendered;
	const remote = peer(edytor);
	const [prev, host] = [blockOf(edytor, 0).id, blockOf(edytor, 1).id];
	await start(editor);
	await preview(editor, 'に');
	remote.sync();
	return { ...rendered, remote, prev, host };
};

/** `prev | abc| | next` with a live preview `に` in the middle block, seen by the peer. */
const composingBetween = async () => {
	const rendered = await renderDomEdytor(
		<root>
			<paragraph>prev</paragraph>
			<paragraph>abc|</paragraph>
			<paragraph>next</paragraph>
		</root>
	);
	const { edytor, editor } = rendered;
	const remote = peer(edytor);
	const host = blockOf(edytor, 1).id;
	await start(editor);
	await preview(editor, 'に');
	remote.sync();
	return { ...rendered, remote, host };
};

describe('F-I12 (a) — D-20: a same-parent reorder moves the IME’s node too', () => {
	row(
		'a peer moves the composing block after its next sibling: committed first, once',
		async () => {
			const { edytor, editor, remote, host } = await composingBetween();
			expect(remote.facade.moveBlock(host, { parent: null, index: 3 }).status).toBe('applied');
			remote.sync();
			expect(edytor.isComposing).toBe(false);
			await flushDomUpdates();
			expect(shape(edytor)).toEqual(['paragraph:prev', 'paragraph:next', 'paragraph:abcに']);
			expect(caret(edytor)).toEqual({ block: host, offset: 4, isCollapsed: true });

			// The IME continues: its next update resumes over the committed text.
			await preview(editor, 'にほ');
			await end(editor, '日本');
			await flushDomUpdates();
			remote.sync();
			expect(shape(edytor)).toEqual(['paragraph:prev', 'paragraph:next', 'paragraph:abc日本']);
			expect(remote.read()).toEqual(['paragraph:prev', 'paragraph:next', 'paragraph:abc日本']);
		}
	);

	pin('a peer inserting a sibling above only shifts the index: the session lives', async () => {
		const { edytor, editor, remote } = await composingBetween();
		remote.facade.insertBlock(
			{ parent: null, index: 0 },
			{ id: 'peer-top', type: 'paragraph', content: [{ kind: 'text', text: 'top' }] }
		);
		remote.sync();
		await flushDomUpdates();
		expect(edytor.isComposing).toBe(true);
		await end(editor, 'に');
		await flushDomUpdates();
		expect(shape(edytor)).toEqual([
			'paragraph:top',
			'paragraph:prev',
			'paragraph:abcに',
			'paragraph:next'
		]);
	});
});

describe('F-I12 (a) — D-20: a peer’s structural change commits the session first', () => {
	row('delete: the composed text is lost with the block; nothing lands elsewhere', async () => {
		const { edytor, editor, remote, prev, host } = await composing();
		expect(remote.facade.deleteBlock(host).status).toBe('applied');
		remote.sync();
		// Committed before the change renders: the session ended within the sync.
		expect(edytor.isComposing).toBe(false);
		await flushDomUpdates();
		expect(shape(edytor)).toEqual(['paragraph:prev']);

		// The IME's own commit arrives later: nothing is written anywhere.
		await end(editor, 'に');
		await flushDomUpdates();
		remote.sync();
		expect(shape(edytor)).toEqual(['paragraph:prev']);
		expect(remote.read()).toEqual(['paragraph:prev']);
		expect(caret(edytor).block).toBe(prev);
	});

	row('retype: committed first, then the retype renders; one undo removes it', async () => {
		const { edytor, editor, remote, host } = await composing();
		expect(remote.facade.setBlockType(host, 'quote').status).toBe('applied');
		remote.sync();
		expect(edytor.isComposing).toBe(false);
		await flushDomUpdates();
		expect(shape(edytor)).toEqual(['paragraph:prev', 'quote:abcに']);
		expect(caret(edytor)).toEqual({ block: host, offset: 4, isCollapsed: true });
		expect(shown(blockOf(edytor, 1).firstText!.node!)).toBe('abcに');

		await end(editor, 'に');
		await flushDomUpdates();
		remote.sync();
		expect(shape(edytor)).toEqual(['paragraph:prev', 'quote:abcに']);
		expect(remote.read()).toEqual(['paragraph:prev', 'quote:abcに']);

		// The session and its forced commit are one undo step.
		await undo(editor);
		await flushDomUpdates();
		expect(shape(edytor)).toEqual(['paragraph:prev', 'quote:abc']);
	});

	row('re-parent (Tab): committed first; the text moves with its block', async () => {
		const { edytor, editor, remote, prev, host } = await composing();
		expect(remote.facade.nestBlock(host, prev).status).toBe('applied');
		remote.sync();
		expect(edytor.isComposing).toBe(false);
		await flushDomUpdates();
		expect(shape(edytor)).toEqual(['paragraph:prev{paragraph:abcに}']);
		expect(caret(edytor)).toEqual({ block: host, offset: 4, isCollapsed: true });

		await end(editor, 'に');
		await flushDomUpdates();
		remote.sync();
		expect(shape(edytor)).toEqual(['paragraph:prev{paragraph:abcに}']);
	});

	row('merge: committed first; the text lands once in the merged block', async () => {
		const { edytor, editor, remote, prev, host } = await composing();
		expect(remote.facade.mergeBackward(host).status).toBe('applied');
		remote.sync();
		expect(edytor.isComposing).toBe(false);
		await flushDomUpdates();
		expect(shape(edytor)).toEqual(['paragraph:prevabcに']);
		expect(caret(edytor)).toEqual({ block: prev, offset: 8, isCollapsed: true });

		await end(editor, 'に');
		await flushDomUpdates();
		remote.sync();
		expect(shape(edytor)).toEqual(['paragraph:prevabcに']);
		expect(remote.read()).toEqual(['paragraph:prevabcに']);
	});

	pin(
		'a peer split inside the block is not structural for the host: the session lives',
		async () => {
			const { edytor, editor, remote, host } = await composing();
			expect(remote.facade.splitBlock(host, 1, 'peer-split', { type: 'paragraph' }).status).toBe(
				'applied'
			);
			remote.sync();
			await flushDomUpdates();
			expect(edytor.isComposing).toBe(true);
			await end(editor, 'にほ');
			await flushDomUpdates();
			expect(shape(edytor)).toEqual(['paragraph:prev', 'paragraph:a', 'paragraph:bcにほ']);
		}
	);
});

describe('F-I12 (b) — the IME keeps composing after the forced commit', () => {
	row('the continued composition opens a new session over what the IME shows', async () => {
		const { edytor, editor, remote, host } = await composing();
		remote.facade.setBlockType(host, 'quote');
		remote.sync();
		await flushDomUpdates();
		expect(edytor.isComposing).toBe(false);

		// The IME never saw an end: its next update extends what it shows.
		await preview(editor, 'にほ');
		expect(edytor.isComposing).toBe(true);
		expect(shape(edytor)).toEqual(['paragraph:prev', 'quote:abcにほ']);
		await end(editor, '日本');
		await flushDomUpdates();
		remote.sync();
		expect(shape(edytor)).toEqual(['paragraph:prev', 'quote:abc日本']);
		expect(remote.read()).toEqual(['paragraph:prev', 'quote:abc日本']);
		expect(caret(edytor)).toEqual({ block: host, offset: 5, isCollapsed: true });
	});
});

describe('F-I12 (b) — Chromium’s shape: the dropped composition commits as a plain insertion', () => {
	// Green on the reference in jsdom too (its session was never ended); cdp holds the red shape.
	pin('after a retype, the plain commit replaces the forced commit: once', async () => {
		const { edytor, editor, remote, host } = await composing();
		remote.facade.setBlockType(host, 'quote');
		remote.sync();
		await flushDomUpdates();
		await dispatchDomBeforeInput(editor, { inputType: 'insertText', data: 'に' });
		await flushDomUpdates();
		expect(shape(edytor)).toEqual(['paragraph:prev', 'quote:abcに']);
		expect(caret(edytor)).toEqual({ block: host, offset: 4, isCollapsed: true });
	});

	pin('after a deletion, the plain commit writes nothing', async () => {
		const { edytor, editor, remote, host } = await composing();
		remote.facade.deleteBlock(host);
		remote.sync();
		await flushDomUpdates();
		await dispatchDomBeforeInput(editor, { inputType: 'insertText', data: 'に' });
		await flushDomUpdates();
		expect(shape(edytor)).toEqual(['paragraph:prev']);
	});

	pin('a real key after the forced commit types normally', async () => {
		const { edytor, editor, remote, host } = await composing();
		remote.facade.setBlockType(host, 'quote');
		remote.sync();
		await flushDomUpdates();
		editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true }));
		await dispatchDomBeforeInput(editor, { inputType: 'insertText', data: 'x' });
		await flushDomUpdates();
		expect(shape(edytor)).toEqual(['paragraph:prev', 'quote:abcにx']);
	});
});

describe('F-I15 — filler and text in one node (BI-15, BI-9)', () => {
	row(
		'the empty block’s text node before the first preview is the node after release',
		async () => {
			const { edytor, editor } = await renderDomEdytor(
				<root>
					<paragraph>|</paragraph>
					<paragraph>tail</paragraph>
				</root>,
				{ placeholder: 'Start writing' }
			);
			const element = blockOf(edytor, 0).firstText!.node!;
			const [filler] = allTextNodes(element);
			expect(filler?.data).toBe('\u200B');
			expect(placeholders(editor)).toBe(1);

			await start(editor);
			await flushDomUpdates();
			expect(placeholders(editor)).toBe(0);
			await preview(editor, 's');
			await preview(editor, 'す');
			expect(placeholders(editor)).toBe(0);
			await end(editor, 'す');
			await flushDomUpdates();

			expect(shape(edytor)).toEqual(['paragraph:す', 'paragraph:tail']);
			expect(blockOf(edytor, 0).firstText!.node).toBe(element);
			expect(filler!.isConnected && element.contains(filler!)).toBe(true);
			expect(filler!.data).toBe('す');
			expect(placeholders(editor)).toBe(0);
		}
	);

	row(
		'typing the first character keeps the filler node; deleting it back keeps it too',
		async () => {
			const { edytor, editor } = await renderDomEdytor(
				<root>
					<paragraph>|</paragraph>
				</root>
			);
			const element = blockOf(edytor, 0).firstText!.node!;
			const [filler] = allTextNodes(element);
			await dispatchDomBeforeInput(editor, { inputType: 'insertText', data: 'a' });
			await flushDomUpdates();
			expect(filler!.isConnected && filler!.data === 'a').toBe(true);
			await dispatchDomBeforeInput(editor, { inputType: 'deleteContentBackward' });
			await flushDomUpdates();
			expect(shape(edytor)).toEqual(['paragraph:']);
			expect(filler!.isConnected && filler!.data === '\u200B').toBe(true);
		}
	);

	pin('a canceled composition in an empty block brings the placeholder back', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>|</paragraph>
				<paragraph>tail</paragraph>
			</root>,
			{ placeholder: 'Start writing' }
		);
		await start(editor);
		await preview(editor, 'す');
		expect(placeholders(editor)).toBe(0);
		await end(editor, '');
		await flushDomUpdates();
		expect(shape(edytor)).toEqual(['paragraph:', 'paragraph:tail']);
		expect(placeholders(editor)).toBe(1);
	});
});
