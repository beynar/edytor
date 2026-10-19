/** @jsxImportSource ../jsx */
/**
 * A view's shared suggestions (`session/suggestions.svelte.ts`, `sugg.*`):
 * its suggesting mode (the dispatcher's plans written as its suggestion,
 * grouped, moves refused), the one list of view-local and shared
 * suggestions, their decisions as one command, and an AI answer written
 * live. A headless peer reads and reviews what the view suggests.
 */
import { describe, expect, it } from 'vitest';
import { Y } from '$lib/crdt/engine.js';
import { createDocument } from '$lib/crdt/index.js';
import type { EdytorDocument } from '$lib/crdt/document.js';
import { createOperationEdytor } from '../test.utils.js';
import { textToBlocks } from '$lib/export/index.js';
import { jsonBlockToSpec, type JSONBlock } from '$lib/utils/json.js';

/** A block without its ids (and its children's) and empty data. */
const stripIds = ({ id: _, children, data, ...rest }: JSONBlock): JSONBlock => ({
	...rest,
	...(data && Object.keys(data).length ? { data } : {}),
	...(children?.length ? { children: children.map(stripIds) } : {})
});

const deliver = (from: { doc: unknown }, to: { doc: unknown }) =>
	Y.applyUpdate(
		to.doc as never,
		Y.encodeStateAsUpdate(from.doc as never, Y.encodeStateVector(to.doc as never)),
		'remote'
	);
const view = () => {
	const { edytor } = createOperationEdytor(
		(
			<root>
				<paragraph>The quick brown fox</paragraph>
				<paragraph>jumps over</paragraph>
				<paragraph>the lazy dog</paragraph>
			</root>
		) as any,
		{ doc: new Y.Doc() }
	);
	const [p1, p2, p3] = edytor.root!.children.map((b) => b.id) as [string, string, string];
	return { edytor, p1, p2, p3 };
};
const peerOf = (from: { doc: unknown }): EdytorDocument => {
	const peer = createDocument({ actor: { id: 'ben' } });
	deliver(from, peer);
	peer.sync();
	return peer;
};
const kinds = (changes: readonly { kind: string; text: string }[]) =>
	changes.map((c) => [c.kind, c.text]);

describe('suggesting mode (sugg.*)', () => {
	it("the view's insertText and deleteText become a suggestion a peer reviews", () => {
		const { edytor, p1 } = view();
		const peer = peerOf(edytor.document);
		edytor.suggestions.suggesting = true;
		edytor.insertText(p1, 4, 'very ');
		// A Backspace-like delete of "brown " (six one-unit deletes from its end).
		for (let at = 20; at >= 15; at--) edytor.deleteText(p1, at, 1);
		edytor.suggestions.suggesting = false;
		expect(edytor.facade.blockText(p1)).toBe('The very quick brown fox');
		// One suggestion: the edits were contiguous.
		expect(edytor.suggestions.list.map((s) => s.shared)).toEqual([true]);
		deliver(edytor.document, peer);
		const changes = peer.facade.suggest.changes();
		expect(kinds(changes)).toEqual([
			['insert', 'very '],
			['delete', 'brown ']
		]);
		// The peer accepts both.
		peer.facade.suggest.run(peer.facade.suggest.decide(changes, true));
		deliver(peer, edytor.document);
		expect(edytor.facade.blockText(p1)).toBe('The very quick fox');
		expect(edytor.suggestions.list).toEqual([]);
	});

	it("the suggester's undo withdraws what it suggested, its redo suggests it again", () => {
		const { edytor, p1 } = view();
		edytor.suggestions.suggesting = true;
		edytor.deleteText(p1, 10, 6);
		edytor.document.history.stopCapturing();
		edytor.insertText(p1, 4, 'very ');
		const { suggest } = edytor.facade;
		expect(suggest.changes().map((c) => c.kind)).toEqual(['insert', 'delete']);
		edytor.historyUndo();
		expect(suggest.changes().map((c) => c.kind)).toEqual(['delete']);
		edytor.historyUndo();
		expect(suggest.changes()).toEqual([]);
		expect(edytor.facade.blockText(p1)).toBe('The quick brown fox');
		edytor.historyRedo();
		edytor.historyRedo();
		expect(kinds(suggest.changes())).toEqual([
			['insert', 'very '],
			['delete', 'brown ']
		]);
	});

	it('one suggestion per contiguous range: a neighbour continues it, a block further away starts another', () => {
		const { edytor, p1, p2, p3 } = view();
		edytor.suggestions.suggesting = true;
		edytor.insertText(p1, 0, 'A');
		edytor.insertText(p2, 0, 'B');
		expect(edytor.suggestions.list).toHaveLength(1);
		// Back in the first block, then two blocks away: a new one.
		edytor.insertText(p1, 0, 'C');
		edytor.insertText(p3, 0, 'D');
		expect(edytor.suggestions.list).toHaveLength(2);
		expect(edytor.suggestions.list.map((s) => s.changes.map((c) => c.text))).toEqual([
			['CA', 'B'],
			['D']
		]);
	});

	it('nothing moves while the view suggests: refused and said (sugg.refused)', () => {
		const { edytor, p2 } = view();
		edytor.suggestions.suggesting = true;
		const block = edytor.idToBlock.get(p2)!;
		expect(edytor.canMove({ blocks: [block], direction: 'up' })).toBe(false);
		expect(edytor.move({ blocks: [block], direction: 'up' })).toEqual([]);
		expect(edytor.dispatcher.last).toMatchObject({ operation: 'moveBlocks', status: 'refused' });
		expect(edytor.announcer.message).toBe('Only text and blocks can be suggested');
		// A move planned by another command (a nest) is refused at its write.
		expect(edytor.moveBlocks([p2], { parent: null, index: 0 }).status).toBe('refused');
		// Nesting (Tab) and outdenting are moves too.
		const [p1] = edytor.root!.children.map((b) => b.id);
		expect(edytor.nestBlock(p2, p1!).status).toBe('refused');
		expect(edytor.root!.children.map((b) => b.id)[1]).toBe(p2);
		expect(edytor.suggestions.list).toEqual([]);
	});

	it('accepting is one command and one undo step, hooks see it; a suggest-only view cannot decide', () => {
		const { edytor, p1 } = view();
		const seen: string[] = [];
		edytor.plugins.push({
			onBeforeOperation: ({ operation }) => void seen.push(operation)
		} as never);
		edytor.suggestions.suggesting = true;
		edytor.insertText(p1, 0, 'Oh, ');
		edytor.suggestions.suggesting = false;
		const [suggestion] = edytor.suggestions.list;
		expect(suggestion!.canDecide).toBe(true);
		edytor.document.access = 'suggest';
		expect(suggestion!.canDecide).toBe(false);
		expect(suggestion!.accept().status).toBe('refused');
		edytor.document.access = 'write';
		seen.length = 0;
		expect(suggestion!.accept().status).toBe('applied');
		expect(seen).toContain('acceptSuggestion');
		expect(edytor.suggestions.list).toEqual([]);
		expect(edytor.facade.blockText(p1)).toBe('Oh, The quick brown fox');
		// Its undo makes it pending again.
		edytor.historyUndo();
		expect(kinds(edytor.facade.suggest.changes())).toEqual([['insert', 'Oh, ']]);
		// Rejected: the text goes, as one step.
		expect(edytor.suggestions.list[0]!.reject().status).toBe('applied');
		expect(edytor.facade.blockText(p1)).toBe('The quick brown fox');
	});

	it('its author rejects it (discard), a suggest-only one too: nothing of it is pending (sugg.withdraw)', () => {
		const { edytor, p1 } = view();
		edytor.suggestions.suggesting = true;
		edytor.insertText(p1, 4, 'very ');
		edytor.deleteText(p1, 15, 6);
		const [suggestion] = edytor.suggestions.list;
		expect(suggestion!.mine).toBe(true);
		edytor.document.access = 'suggest';
		expect(suggestion!.canDecide).toBe(false);
		suggestion!.discard();
		expect(edytor.dispatcher.last).toMatchObject({
			operation: 'rejectSuggestion',
			status: 'applied'
		});
		expect(edytor.facade.blockText(p1)).toBe('The quick brown fox');
		expect(edytor.facade.suggest.changes()).toEqual([]);
		// Its undo brings it back.
		edytor.historyUndo();
		expect(kinds(edytor.facade.suggest.changes())).toEqual([
			['insert', 'very '],
			['delete', 'brown ']
		]);
	});
});

describe('an AI answer, shared live (sugg.ai.live)', () => {
	it('streams into the document as it arrives: a peer reads it so far, the document without it stays as it was', () => {
		const { edytor, p1 } = view();
		const peer = peerOf(edytor.document);
		const suggestion = edytor.suggestions.add({ after: p1 }, undefined, {
			shared: true,
			label: 'AI'
		});
		expect(suggestion.shared).toBe(true);
		expect(suggestion.via).toBe('ai');
		const sizes: number[] = [];
		peer.doc.on('update', (u: Uint8Array) => sizes.push(u.length));
		const seen: string[] = [];
		for (const chunk of ['Next ', 'steps:', ' book the ', 'review.']) {
			suggestion.append(chunk);
			deliver(edytor.document, peer);
			seen.push(
				peer.facade.suggest
					.changes()
					.map((c) => c.text)
					.join('')
			);
		}
		suggestion.done();
		expect(seen).toEqual([
			'Next ',
			'Next steps:',
			'Next steps: book the ',
			'Next steps: book the review.'
		]);
		// The peer sees who asked, and that an AI wrote it.
		const [record] = peer.facade.suggest.records();
		expect(record).toMatchObject({ via: 'ai', label: 'AI' });
		expect(record!.by).toBe(edytor.document.actor.id);
		// Without its pending suggestions, the document is as it was.
		expect(peer.toJSON().children).toHaveLength(3);
		expect(peer.toJSON({ suggestions: true }).children).toHaveLength(4);
		// Each chunk rewrites the answer so far, whole: one update.
		expect(sizes).toHaveLength(4);
		// Accepted by the peer: the answer is the document's.
		peer.facade.suggest.run(peer.facade.suggest.decide(peer.facade.suggest.changes(), true));
		deliver(peer, edytor.document);
		expect(edytor.document.toJSON().children).toHaveLength(4);
		expect(edytor.suggestions.list).toEqual([]);
	});

	it('each chunk replaces what the answer wrote before, whole: one suggestion', () => {
		const { edytor, p1 } = view();
		const suggestion = edytor.suggestions.add({ after: p1 }, undefined, { shared: true });
		suggestion.update([{ type: 'paragraph', content: [{ text: 'One' }] }]);
		suggestion.update([{ type: 'paragraph', content: [{ text: 'One two' }] }]);
		suggestion.update([
			{ type: 'paragraph', content: [{ text: 'One two' }] },
			{ type: 'heading', data: { level: 'h2' }, content: [{ text: 'Three' }] }
		]);
		expect(edytor.facade.suggest.changes().map((c) => [c.kind, c.text])).toEqual([
			['block', 'One two'],
			['block', 'Three']
		]);
		expect(edytor.facade.suggest.records()).toHaveLength(1);
		expect(edytor.document.toJSON({ suggestions: true }).children).toHaveLength(5);
	});

	it("a markdown answer streamed word by word through the export's reader: the peer watches it, the bytes it costs", () => {
		const { edytor, p1 } = view();
		const peer = peerOf(edytor.document);
		const answer = [
			'## Plan for the launch',
			'',
			'The team ships **the editor** on Monday. Before that:',
			'',
			'- Review the open pull requests',
			'- Run the browser lanes on every engine',
			'- Write the changelog',
			'',
			'| Task | Owner |',
			'| --- | --- |',
			'| Docs | Ada |',
			'| Tests | Ben |',
			'',
			'Then we announce it.'
		].join('\n');
		const words = answer.split(/(?<=[ \n])/);
		const suggestion = edytor.suggestions.add({ after: p1 }, undefined, {
			shared: true,
			label: 'AI'
		});
		const synced: number[] = [];
		edytor.document.doc.on('update', (u: Uint8Array) => synced.push(u.length));
		const stored = edytor.document.encode().length;
		const shown = (d: EdytorDocument) =>
			d
				.toJSON({ suggestions: true })
				.children.slice(1, -2)
				.map((b) => stripIds(b));
		let markdown = '';
		for (const word of words) {
			markdown += word;
			const blocks = textToBlocks(markdown, { streaming: true });
			suggestion.update(blocks);
			deliver(edytor.document, peer);
			// The peer reads the answer so far, as the view wrote it.
			expect(shown(peer)).toEqual(blocks.map((b) => stripIds(b)));
		}
		suggestion.update(textToBlocks(markdown));
		suggestion.done();
		deliver(edytor.document, peer);
		const final = textToBlocks(markdown).map((b) => stripIds(b));
		expect(shown(peer)).toEqual(final);
		// One suggestion of the AI's; the document without it is as it was.
		expect(peer.facade.suggest.records()).toHaveLength(1);
		expect(peer.toJSON().children).toHaveLength(3);
		// The same blocks written at once, plainly, for comparison.
		const plain = view();
		const plain0 = plain.edytor.document.encode().length;
		plain.edytor.insertBlocks(
			{ parent: null, index: 1 },
			textToBlocks(markdown).map((b) => jsonBlockToSpec(b, true))
		);
		const report = {
			characters: markdown.length,
			chunks: words.length,
			syncedBytes: synced.reduce((a, b) => a + b, 0),
			storedBytes: edytor.document.encode().length - stored,
			plainBytes: plain.edytor.document.encode().length - plain0
		};
		process.stdout.write(`\nSTREAMED ${JSON.stringify(report)}\n`);
		// Accepted by the peer: the answer is the document's.
		peer.facade.suggest.run(peer.facade.suggest.decide(peer.facade.suggest.changes(), true));
		expect(
			peer
				.toJSON()
				.children.slice(1, -2)
				.map((b) => stripIds(b))
		).toEqual(final);
	});

	it('a readonly view lists pending shared suggestions, which it cannot decide', () => {
		const { edytor, p1 } = view();
		edytor.suggestions.suggesting = true;
		edytor.insertText(p1, 0, 'Hi ');
		const { doc } = peerOf(edytor.document);
		const reader = createOperationEdytor(
			(
				<root>
					<paragraph>x</paragraph>
				</root>
			) as any,
			{ doc, readonly: true }
		).edytor;
		expect(reader.suggestions.list.map((s) => [s.shared, s.canDecide, s.mine])).toEqual([
			[true, false, false]
		]);
		expect(reader.suggestions.list[0]!.accept().status).toBe('refused');
	});
});
