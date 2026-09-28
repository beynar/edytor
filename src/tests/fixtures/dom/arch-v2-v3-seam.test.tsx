/** @jsxImportSource ../../jsx */
/**
 * arch-v2 — checkpoint V3 rows, dom lane: commands author their result
 * selection; the replicated-slot seam applies only to endpoints this view did
 * not author; a seam never lands in content the view hides (R9, §2.4
 * "Seam of a vanished endpoint" and "Displayable", L21, L25, FP-7).
 *
 * - F-S13 — `['First block', 'Marked middle', 'lead @ tail']`: select block
 *   `[1]`, then Backspace, Delete or cut: the caret lands at the end of
 *   `[0]`'s first editable text; with `[0]` selected, at the end of the next
 *   block's (FP-7: the command's own previous-then-next rule,
 *   `hotkeys.spec:955-993`, CLIP-07). The command authors that result: it is
 *   the selection in the same turn, and it is the only selection change the
 *   command makes (the seam never runs for this view's own endpoints).
 * - F-S14 — a collapsed toggle: the seam of a peer's delete never lands in
 *   the toggle's hidden children; a kind declared `rendersContent: true`
 *   whose snippet renders no `content()` is skipped (its dev check is D3's).
 * - `sel.seam.*` through the view (foreign changes): next sibling, last block,
 *   nested subtree, several adjacent dead siblings, a local operation that
 *   declared no result.
 * - A write whose target dies while it waits for the DOM lands where the
 *   anchors minted at call time resolve (L21 `writeCollapsed…`).
 * - V1 shadow class 5 (a local delete's caret lagging its turn): the value of
 *   a collapsed delete is its caret in the same turn.
 *
 * Expected values come from the plan rows and the delete contract, never from
 * running the code.
 */
import { describe, expect, it } from 'vitest';

import { Y } from '$lib/crdt/engine.js';
import { attachDocument } from '$lib/crdt/document.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import { mentionPlugin } from '$lib/plugins/mention/MentionPlugin.svelte';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { d3KindsPlugin } from '../../dom/D3KindsPlugin.svelte';
import {
	dispatchCut,
	flushDomUpdates,
	renderDomEdytor,
	setNativeSelection
} from '../../dom/test.utils.js';

/** Red on the reference; green since V3. */
const row = it;
/** Green on the reference: a regression guard. */
const pin = it;

/** A remote peer on a replica of the mounted document; `push` delivers its writes as a remote apply. */
const peer = (edytor: Edytor) => {
	const remoteDoc = new Y.Doc();
	Y.applyUpdate(remoteDoc, Y.encodeStateAsUpdate(edytor.doc));
	const remote = attachDocument(remoteDoc);
	const deliver = () =>
		Y.applyUpdate(edytor.doc, Y.encodeStateAsUpdate(remoteDoc, Y.encodeStateVector(edytor.doc)));
	return {
		facade: remote.facade,
		deliver,
		push: async () => {
			deliver();
			await flushDomUpdates();
		}
	};
};

/** The selection's start as (block id, display offset), and whether it is a caret. */
const caret = (edytor: Edytor) => {
	const { start, isCollapsed, kind } = edytor.selection.projection;
	return { kind, block: start?.block ?? null, offset: start?.offset ?? null, isCollapsed };
};

/** Every `onSelectionChange`, as the caret it reported. */
const recorder = () => {
	const calls: ReturnType<typeof caret>[] = [];
	let edytor: Edytor | null = null;
	return {
		calls,
		bind: (e: Edytor) => (edytor = e),
		onSelectionChange: () => {
			if (edytor) calls.push(caret(edytor));
		}
	};
};

const texts = (edytor: Edytor) =>
	(edytor.value.children ?? []).map((block) =>
		(block.content ?? []).map((part) => ('text' in part ? part.text : '@')).join('')
	);

/** F-S13's fixture (the `selection` scenario of the dom test route). */
const selectionScenario = () => (
	<root>
		<paragraph>First block</paragraph>
		<paragraph>
			<bold>Marked </bold>
			<italic>middle</italic>
		</paragraph>
		<paragraph>
			lead <mention /> tail
		</paragraph>
	</root>
);

/** Dispatch `event` on the editor and read the caret in the same turn. */
const fire = (editor: HTMLElement, event: Event) => {
	editor.dispatchEvent(event);
};
const keydown = (key: string) =>
	new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true });
const cutEvent = () => {
	const event = new Event('cut', { bubbles: true, cancelable: true }) as ClipboardEvent;
	const data = new Map<string, string>();
	Object.defineProperty(event, 'clipboardData', {
		value: {
			getData: (type: string) => data.get(type) ?? '',
			setData: (type: string, value: string) => data.set(type, value)
		}
	});
	return event;
};

const causes = {
	Backspace: () => keydown('Backspace'),
	Delete: () => keydown('Delete'),
	cut: cutEvent
} as const;

describe('F-S13 — a block-set delete authors its result selection (FP-7)', () => {
	for (const [cause, event] of Object.entries(causes)) {
		for (const selected of [1, 0] as const) {
			row(`${cause} over block [${selected}]: the command's caret, once, in its turn`, async () => {
				const record = recorder();
				const { edytor, editor } = await renderDomEdytor(selectionScenario(), {
					plugins: [richTextPlugin, mentionPlugin],
					autoSelectFixture: false,
					onSelectionChange: record.onSelectionChange
				});
				record.bind(edytor);
				const [first, middle] = edytor.root!.children;
				await setNativeSelection(edytor, first!.firstText!, 2);
				edytor.selection.selectBlocks(edytor.root!.children[selected]!);
				await flushDomUpdates();
				// FP-7: the end of the previous block's first editable text; with
				// the first block selected, the end of the next block's.
				const target = selected === 1 ? first! : middle!;
				const expected = {
					kind: 'text',
					block: target.id,
					offset: target.firstEditableText!.length,
					isCollapsed: true
				};
				const before = record.calls.length;

				fire(editor, event());

				expect(caret(edytor)).toEqual(expected);
				expect(record.calls.slice(before)).toEqual([expected]);
				await flushDomUpdates();
				expect(texts(edytor)).toEqual(
					selected === 1 ? ['First block', 'lead @ tail'] : ['Marked middle', 'lead @ tail']
				);
				expect(caret(edytor)).toEqual(expected);
				expect(record.calls.slice(before)).toEqual([expected]);
				expect(edytor.selection.selectedBlocks.size).toBe(0);
				expect(edytor.dispatcher.last?.selection).toEqual(edytor.selection.value);
			});
		}
	}

	pin('a vetoed block-set delete leaves the block selection', async () => {
		const { edytor, editor } = await renderDomEdytor(selectionScenario(), {
			plugins: [
				richTextPlugin,
				mentionPlugin,
				() => ({
					onBeforeOperation: ({ operation, prevent }) =>
						void (operation === 'deleteBlocks' && prevent())
				})
			],
			autoSelectFixture: false
		});
		const middle = edytor.root!.children[1]!;
		await setNativeSelection(edytor, middle.firstText!, 2);
		edytor.selection.selectBlocks(middle);
		await flushDomUpdates();
		fire(editor, keydown('Backspace'));
		await flushDomUpdates();
		expect(texts(edytor)).toEqual(['First block', 'Marked middle', 'lead @ tail']);
		expect(edytor.selection.value).toEqual({ kind: 'blocks', ids: [middle.id] });
	});

	pin(
		'cut through the harness: clipboard written, block removed, caret at the end of [0]',
		async () => {
			const { edytor, editor } = await renderDomEdytor(selectionScenario(), {
				plugins: [richTextPlugin, mentionPlugin],
				autoSelectFixture: false
			});
			const [first, middle] = edytor.root!.children;
			await setNativeSelection(edytor, middle!.firstText!, 2);
			edytor.selection.selectBlocks(middle!);
			await flushDomUpdates();
			const cut = await dispatchCut(editor);
			expect(cut.defaultPrevented).toBe(true);
			expect(texts(edytor)).toEqual(['First block', 'lead @ tail']);
			expect(caret(edytor)).toEqual({
				kind: 'text',
				block: first!.id,
				offset: 'First block'.length,
				isCollapsed: true
			});
		}
	);
});

const toggleValue = (withAfter = true) => ({
	children: [
		{
			type: 'toggle',
			content: [{ text: 'sum' }],
			children: [
				{ type: 'paragraph', content: [{ text: 'one' }] },
				{ type: 'paragraph', content: [{ text: 'two' }] }
			]
		},
		...(withAfter ? [{ type: 'paragraph', content: [{ text: 'after' }] }] : [])
	]
});

describe('F-S14 — a seam lands only on displayable content', () => {
	row(
		'a peer deletes the caret block inside a collapsed toggle: never a hidden sibling',
		async () => {
			const { edytor } = await renderDomEdytor(<root></root>, {
				value: toggleValue(),
				autoSelectFixture: false
			});
			const [toggle, after] = edytor.root!.children;
			const [one, two] = toggle!.children;
			const details = toggle!.node as HTMLDetailsElement;
			details.open = true;
			await setNativeSelection(edytor, two!.firstText!, 1);
			details.open = false;
			await flushDomUpdates();

			const remote = peer(edytor);
			remote.facade.deleteBlock(two!.id);
			await remote.push();

			expect(caret(edytor)).toMatchObject({ block: after!.id, offset: 0, isCollapsed: true });
			expect(caret(edytor).block).not.toBe(one!.id);
		}
	);

	row('…and with nothing after the toggle, its own summary end', async () => {
		const { edytor } = await renderDomEdytor(<root></root>, {
			value: toggleValue(false),
			autoSelectFixture: false
		});
		const [toggle] = edytor.root!.children;
		const [, two] = toggle!.children;
		const details = toggle!.node as HTMLDetailsElement;
		details.open = true;
		await setNativeSelection(edytor, two!.firstText!, 1);
		details.open = false;
		await flushDomUpdates();

		const remote = peer(edytor);
		remote.facade.deleteBlock(two!.id);
		await remote.push();

		expect(caret(edytor)).toMatchObject({ block: toggle!.id, offset: 3, isCollapsed: true });
	});

	pin('a collapsed toggle follows the caret block: its summary start', async () => {
		const { edytor } = await renderDomEdytor(<root></root>, {
			value: {
				children: [
					{ type: 'paragraph', content: [{ text: 'gone' }] },
					...toggleValue(false).children
				]
			},
			autoSelectFixture: false
		});
		const [gone, toggle] = edytor.root!.children;
		await setNativeSelection(edytor, gone!.firstText!, 2);
		const remote = peer(edytor);
		remote.facade.deleteBlock(gone!.id);
		await remote.push();
		expect(caret(edytor)).toMatchObject({ block: toggle!.id, offset: 0, isCollapsed: true });
	});

	pin(
		'a collapsed toggle before the caret block (last): its summary end, not a hidden child',
		async () => {
			const { edytor } = await renderDomEdytor(<root></root>, {
				value: {
					children: [
						...toggleValue(false).children,
						{ type: 'paragraph', content: [{ text: 'gone' }] }
					]
				},
				autoSelectFixture: false
			});
			const [toggle, gone] = edytor.root!.children;
			await setNativeSelection(edytor, gone!.firstText!, 2);
			const remote = peer(edytor);
			remote.facade.deleteBlock(gone!.id);
			await remote.push();
			expect(caret(edytor)).toMatchObject({ block: toggle!.id, offset: 3, isCollapsed: true });
		}
	);

	for (const side of ['before', 'after'] as const)
		pin(
			`an undeclared phantom content slot is skipped (panel ${side} the dead block)`,
			async () => {
				const { edytor } = await renderDomEdytor(
					side === 'after' ? (
						<root>
							<paragraph>gone</paragraph>
							<panel>
								<paragraph>inside</paragraph>
							</panel>
						</root>
					) : (
						<root>
							<panel>
								<paragraph>inside</paragraph>
							</panel>
							<paragraph>gone</paragraph>
						</root>
					),
					{ plugins: [richTextPlugin, d3KindsPlugin], autoSelectFixture: false }
				);
				const gone = edytor.root!.children.find((block) => block.type === 'paragraph')!;
				const panel = edytor.root!.children.find((block) => block.type === 'panel')!;
				const inside = panel.children[0]!;
				await setNativeSelection(edytor, gone.firstText!, 2);
				const remote = peer(edytor);
				remote.facade.deleteBlock(gone.id);
				await remote.push();
				expect(caret(edytor)).toMatchObject({
					block: inside.id,
					offset: side === 'after' ? 0 : 'inside'.length
				});
			}
		);
});

describe('sel.seam.* through the view: endpoints this view did not author', () => {
	pin(
		'next sibling; last block → previous end; nested subtree; adjacent dead siblings',
		async () => {
			const { edytor } = await renderDomEdytor(
				<root>
					<paragraph>alpha</paragraph>
					<ordered-list>
						<list-item>beta</list-item>
					</ordered-list>
					<paragraph>bb</paragraph>
					<paragraph>cc</paragraph>
					<paragraph>omega</paragraph>
				</root>,
				{ autoSelectFixture: false }
			);
			const [alpha, list, bb, cc, omega] = edytor.root!.children;
			// nested subtree: the dead chain climbs to the list's slot.
			await setNativeSelection(edytor, list!.children[0]!.firstText!, 2);
			let remote = peer(edytor);
			remote.facade.deleteBlock(list!.id, { keepChildren: false });
			await remote.push();
			expect(caret(edytor)).toMatchObject({ block: bb!.id, offset: 0 });
			// adjacent dead siblings: the slot is the replicated rank.
			await setNativeSelection(edytor, bb!.firstText!, 1);
			remote = peer(edytor);
			remote.facade.deleteBlock(bb!.id);
			remote.facade.deleteBlock(cc!.id);
			await remote.push();
			expect(caret(edytor)).toMatchObject({ block: omega!.id, offset: 0 });
			// last block: the previous sibling's end.
			await setNativeSelection(edytor, omega!.firstText!, 3);
			remote = peer(edytor);
			remote.facade.deleteBlock(omega!.id);
			await remote.push();
			expect(caret(edytor)).toMatchObject({ block: alpha!.id, offset: 5 });
		}
	);

	pin(
		'a local operation that declares no result: the seam still repairs its endpoint',
		async () => {
			const { edytor } = await renderDomEdytor(
				<root>
					<paragraph>aa</paragraph>
					<paragraph>bb</paragraph>
					<paragraph>cc</paragraph>
				</root>,
				{ autoSelectFixture: false }
			);
			const [, bb, cc] = edytor.root!.children;
			await setNativeSelection(edytor, bb!.firstText!, 1);
			bb!.removeBlock();
			await flushDomUpdates();
			expect(caret(edytor)).toMatchObject({ block: cc!.id, offset: 0, isCollapsed: true });
		}
	);
});

describe('writes capture anchors at call time (L21 writeCollapsed…)', () => {
	row(
		'a caret write whose text merges away while it waits lands where its anchor follows',
		async () => {
			const { edytor } = await renderDomEdytor(
				<root>
					<paragraph>aa</paragraph>
					<paragraph>bb</paragraph>
				</root>,
				{ autoSelectFixture: false }
			);
			const [aa, bb] = edytor.root!.children;
			await setNativeSelection(edytor, aa!.firstText!, 0);
			const remote = peer(edytor);
			remote.facade.mergeBackward(bb!.id);
			const write = edytor.selection.setAtTextOffset(bb!.firstText!, 1);
			remote.deliver();
			await write;
			await flushDomUpdates();
			expect(texts(edytor)).toEqual(['aabb']);
			expect(caret(edytor)).toMatchObject({ block: aa!.id, offset: 3, isCollapsed: true });
		}
	);

	it('V3 fix: a caret write aimed at a text that already died to a merge follows its atoms, not the seam', async () => {
		const { edytor } = await renderDomEdytor(
			<root>
				<paragraph>alpha</paragraph>
				<paragraph>beta</paragraph>
				<paragraph>gamma</paragraph>
			</root>,
			{ autoSelectFixture: false }
		);
		const [alpha, beta] = edytor.root!.children;
		const dead = beta!.firstText!;
		await setNativeSelection(edytor, dead, 2);
		const remote = peer(edytor);
		remote.facade.mergeBackward(beta!.id);
		await remote.push();
		expect(dead.isInDocument).toBe(false);
		await edytor.selection.setAtTextOffset(dead, 2);
		await flushDomUpdates();
		expect(texts(edytor)).toEqual(['alphabeta', 'gamma']);
		// The merged-into block (anchor contract: a dead text's atoms are
		// followed through its record), never the seam's next sibling `gamma`.
		expect(caret(edytor)).toMatchObject({ block: alpha!.id, isCollapsed: true });
		expect(edytor.selection.state.startText?.isInDocument).toBe(true);
	});

	pin('a range write whose blocks die while it waits lands at the seam', async () => {
		const { edytor } = await renderDomEdytor(
			<root>
				<paragraph>aa</paragraph>
				<paragraph>bb</paragraph>
				<paragraph>cc</paragraph>
			</root>,
			{ autoSelectFixture: false }
		);
		const [, bb, cc] = edytor.root!.children;
		await setNativeSelection(edytor, cc!.firstText!, 0);
		const remote = peer(edytor);
		remote.facade.deleteBlock(bb!.id);
		const write = edytor.selection.setAtRange(bb!.firstText!, 0, bb!.firstText!, 2);
		remote.deliver();
		await write;
		await flushDomUpdates();
		expect(caret(edytor)).toMatchObject({ block: cc!.id, offset: 0, isCollapsed: true });
	});
});

describe('V1 shadow class 5: a local delete leaves its caret in its own turn', () => {
	pin('Backspace inside a text: the value is the post-delete caret before any flush', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>hello</paragraph>
			</root>,
			{ autoSelectFixture: false }
		);
		const block = edytor.root!.children[0]!;
		await setNativeSelection(edytor, block.firstText!, 5);
		const event = new InputEvent('beforeinput', {
			inputType: 'deleteContentBackward',
			bubbles: true,
			cancelable: true
		});
		fire(editor, event);
		expect(caret(edytor)).toMatchObject({ block: block.id, offset: 4, isCollapsed: true });
		await flushDomUpdates();
		expect(texts(edytor)).toEqual(['hell']);
		expect(caret(edytor)).toMatchObject({ block: block.id, offset: 4, isCollapsed: true });
	});
});
