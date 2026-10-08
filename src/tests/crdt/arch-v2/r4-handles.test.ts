/**
 * arch-v2 — checkpoint R4 rows on the headless view (an `Edytor` over an
 * attached document, no DOM): extensions get id-only handles (plan §2.4
 * "Handles", §4.3 `session/handles.ts`, §5 L17, §9.3 R4, §11.1 K5).
 *
 * - One command, one update: normalization runs inside the command's
 *   transaction (S1: "one transaction → normalization once per touched
 *   parent"); a peer never sees the un-normalized state.
 * - An operation called inside an outer transaction answers the block (or the
 *   text after an atom) that transaction created — a handle over the index,
 *   not `null`.
 * - Handles: getters read the index (mid-transaction reads see the writes);
 *   one handle per live id; the cache is pruned from `removed`; a handle for
 *   a dead id answers through `isInTree`; insertion takes JSON specs
 *   (`new Block({block})` is gone).
 *
 * Expected values come from the plan rows, never from running the code.
 */
// @ts-nocheck -- tests drive the view through untyped fixtures.
import { describe, expect, test } from 'vitest';
import { createDocument } from '../../../lib/crdt/index.js';
import { Y } from '../../../lib/crdt/engine.js';
import { attachDocument } from '../../../lib/crdt/document.js';
import { Edytor } from '../../../lib/edytor.svelte.js';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { mentionPlugin } from '../../atMention.svelte';

/** Red on the reference (`arch-v2/ref-r4`); green since R4. */
const row = test;
/** Green on the reference: a regression guard. */
const pin = test;

const p = (id: string, text: string) => ({ id, type: 'paragraph', content: [{ text }] });

const view = (children = [p('a', 'aa'), p('b', 'bb')], plugins = []) => {
	const document = createDocument({ value: { children } });
	const edytor = new Edytor({ document, plugins: [richTextPlugin, mentionPlugin, ...plugins] });
	const updates: Uint8Array[] = [];
	edytor.doc.on('update', (update: Uint8Array) => updates.push(update));
	return { document, edytor, updates };
};

const texts = (edytor: Edytor) =>
	edytor.facade
		.toJSON()
		.children.map((b) => [b.type, (b.content ?? []).map((x) => x.text ?? '@').join('')]);

/** `x` typed into a `note` becomes `y`: a content normalizer that writes. */
const noteNormalizer = () => ({
	blocks: {
		note: {
			snippet: (() => {}) as never,
			normalizeContent: ({ block }) => {
				const text = block.firstText;
				const at = text?.stringContent.indexOf('x') ?? -1;
				if (at < 0) return;
				return () => {
					text.deleteAt(at, 1);
					text.insertAt(at, 'y');
				};
			}
		}
	}
});

describe('one command, one update — normalization inside the transaction', () => {
	row(
		'the root emptied by a delete stays empty: one update, no block written; the view shows its virtual paragraph',
		() => {
			const { edytor, updates } = view([p('a', 'aa')]);
			const peer = new Y.Doc();
			Y.applyUpdate(peer, Y.encodeStateAsUpdate(edytor.doc));
			updates.length = 0;
			edytor.idToBlock.get('a')!.removeBlock();
			expect(updates.length).toBe(1);
			// Nothing is written for the emptied root (`doc.empty.virtual`): the
			// peer's document is empty too, and each view shows a virtual paragraph.
			const remote = attachDocument(peer);
			Y.applyUpdate(peer, updates[0]!);
			expect(remote.facade.toJSON().children).toEqual([]);
			expect(texts(edytor)).toEqual([]);
			expect(edytor.root!.children.map((b) => [b.id, b.type])).toEqual([
				[edytor.facade.virtual(), 'paragraph']
			]);
		}
	);

	row('a content normalizer that writes: one update, the normalized text', () => {
		const { edytor, updates } = view(
			[{ id: 'n', type: 'note', content: [{ text: 'ab' }] }],
			[noteNormalizer]
		);
		updates.length = 0;
		edytor.idToBlock.get('n')!.setBlock({ value: { content: [{ text: 'axb' }] } });
		expect(texts(edytor)).toEqual([['note', 'ayb']]);
		expect(updates.length).toBe(1);
		expect(edytor.document.history.undoStack.length).toBe(1);
	});

	pin('a normalizer that finds nothing makes no write of its own', () => {
		const { edytor, updates } = view(
			[{ id: 'n', type: 'note', content: [{ text: 'ab' }] }],
			[noteNormalizer]
		);
		updates.length = 0;
		edytor.idToBlock.get('n')!.setBlock({ value: { content: [{ text: 'abc' }] } });
		expect(texts(edytor)).toEqual([['note', 'abc']]);
		expect(updates.length).toBe(1);
	});
});

describe('an operation inside an outer transaction answers what the transaction created', () => {
	row('splitBlock answers the split-born block, readable in the transaction', () => {
		const { edytor } = view();
		const a = edytor.idToBlock.get('a')!;
		let born: unknown;
		let seen: unknown;
		edytor.transact(() => {
			born = a.splitBlock({ index: 1, text: a.firstText });
			seen = born && [born.type, born.firstText?.stringContent];
		});
		expect(born).toBeTruthy();
		expect(seen).toEqual(['paragraph', 'a']);
		expect(edytor.idToBlock.get(born.id)).toBe(born);
		expect(texts(edytor)).toEqual([
			['paragraph', 'a'],
			['paragraph', 'a'],
			['paragraph', 'bb']
		]);
	});

	row('insertBlockAfter / insertBlockBefore answer the inserted blocks', () => {
		const { edytor } = view();
		const a = edytor.idToBlock.get('a')!;
		const [after, before] = edytor.transact(() => [
			a.insertBlockAfter({ block: p('x', 'x') }),
			a.insertBlockBefore({ block: p('y', 'y') })
		]);
		expect(after?.id).toBe('x');
		expect(before?.id).toBe('y');
		expect(texts(edytor).map(([, t]) => t)).toEqual(['y', 'aa', 'x', 'bb']);
	});

	row('mergeBlockBackward answers a surviving block the transaction created', () => {
		const { edytor } = view();
		const a = edytor.idToBlock.get('a')!;
		const b = edytor.idToBlock.get('b')!;
		const into = edytor.transact(() => {
			a.insertBlockAfter({ block: p('x', 'x') });
			return b.mergeBlockBackward();
		});
		expect(into?.id).toBe('x');
		expect(texts(edytor).map(([, t]) => t)).toEqual(['aa', 'xbb']);
	});

	row('addInlineBlock answers the text after the atom', () => {
		const { edytor } = view();
		const a = edytor.idToBlock.get('a')!;
		const after = edytor.transact(() =>
			a.addInlineBlock({ index: 1, text: a.firstText, block: { type: 'mention', data: {} } })
		);
		expect(after?.stringContent).toBe('a');
		expect(texts(edytor)).toEqual([['paragraph', 'a@a'], ...[['paragraph', 'bb']]]);
	});
});

describe('handles read the index', () => {
	row('mid-transaction reads see the writes', () => {
		const { edytor } = view();
		const a = edytor.idToBlock.get('a')!;
		const seen: unknown[] = [];
		edytor.transact(() => {
			a.model!.insertText(2, 'Z');
			seen.push(a.firstText!.stringContent);
			a.insertChildren(0, [p('c', 'child')]);
			seen.push(a.children.map((child) => child.id));
		});
		expect(seen).toEqual(['aaZ', ['c']]);
	});

	/** Green since R4a. */
	test('insertChildren and insertParts take JSON specs', () => {
		const { edytor } = view();
		const root = edytor.root!;
		root.insertChildren(1, [{ id: 'j', type: 'paragraph', content: [{ text: 'json' }] }]);
		const j = edytor.idToBlock.get('j')!;
		j.insertParts(1, [{ type: 'mention', id: 'm', data: {} }, [{ text: '!' }]]);
		expect(texts(edytor)).toEqual([
			['paragraph', 'aa'],
			['paragraph', 'json@!'],
			['paragraph', 'bb']
		]);
	});

	pin('one handle per live id, across commits and after a peer adds a block', () => {
		const { edytor } = view();
		const a = edytor.idToBlock.get('a')!;
		a.firstText!.insertText({ value: 'q', start: 0, end: 0 });
		expect(edytor.idToBlock.get('a')).toBe(a);
		const peer = new Y.Doc();
		Y.applyUpdate(peer, Y.encodeStateAsUpdate(edytor.doc));
		const remote = attachDocument(peer);
		remote.facade.insertBlock({ parent: null, index: 2 }, { id: 'r', type: 'paragraph' });
		Y.applyUpdate(edytor.doc, Y.encodeStateAsUpdate(peer, Y.encodeStateVector(edytor.doc)));
		expect(edytor.idToBlock.get('r')?.id).toBe('r');
		expect(edytor.root!.children.map((c) => c.id)).toEqual(['a', 'b', 'r']);
	});

	pin('a handle for a dead id answers through isInTree; the cache is pruned', () => {
		const { edytor } = view();
		const b = edytor.idToBlock.get('b')!;
		b.removeBlock();
		expect(b.isInTree).toBe(false);
		expect(edytor.idToBlock.get('b')).toBeUndefined();
	});
});
