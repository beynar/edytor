/** @jsxImportSource ../../jsx */
/**
 * The shared suggestions plugin's app API (`sugg.ai.live`), each row from
 * its documented contract (site `editor/suggestions`, the `sugg.*` rows of
 * `docs/editor-delete-contract.md`), never from a run:
 *
 * 1. Each `update` keeps the equal blocks, extends the last block's text
 *    when the new one extends it, and replaces the rest. The document as
 *    shown holds the answer so far, as the view wrote it: a code block
 *    growing across updates is that code block, its lines its own.
 * 2. The controller's `add(at, content, options)`: "with content it starts
 *    `ready`", "written live into the document". A suggestion added with
 *    content is listed and holds its changes.
 * 3. `SharedSuggestion.via` (`string | undefined`): "the agent that wrote it
 *    for its author ('ai')"; a record's `via` is set "when one did". A
 *    suggestion a member typed in suggesting mode has no agent.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { JSONBlock } from '$lib/utils/json.js';
import {
	defaultPlugins,
	dispatchDomBeforeInput,
	flushDomUpdates,
	renderDomEdytor
} from '../../dom/test.utils.js';
import { suggestionsOf } from '$lib/crdt/doc/suggest.js';
import { createCodePlugin } from '$lib/plugins/code/CodePlugin.svelte';
import {
	createSharedSuggestionsPlugin,
	sharedSuggestionsController
} from '$lib/plugins/suggestions/shared.svelte.js';

const options = () => ({
	plugins: [...defaultPlugins, createCodePlugin(), createSharedSuggestionsPlugin()]
});
const shared = (edytor: Edytor) => sharedSuggestionsController(edytor)!;

afterEach(() => {
	document.body.innerHTML = '';
});

/** A block as the answer gave it: no ids, no empty data, content or children. */
const plain = ({ type, data, content, children }: JSONBlock): JSONBlock => ({
	type,
	...(data && Object.keys(data).length ? { data } : {}),
	...(content?.length ? { content } : {}),
	...(children?.length ? { children: children.map(plain) } : {})
});
/** The document as shown (pending suggestions in), its blocks after the first. */
const shownAfterFirst = (edytor: Edytor) =>
	edytor.facade.toJSON({ suggestions: true }).children.slice(1).map(plain);

const paragraph = (text: string): JSONBlock => ({ type: 'paragraph', content: [{ text }] });
const code = (...lines: string[]): JSONBlock => ({
	type: 'code',
	children: lines.map((text) => ({ type: 'codeLine', content: [{ text }] }))
});

describe('sugg.ai.live — the shared suggestions app API', () => {
	it('1. sugg.ai.live: a code block growing across updates stays one code block, its lines its own', async () => {
		const { edytor } = await renderDomEdytor(
			<root>
				<paragraph>Anchor|</paragraph>
			</root>,
			options()
		);
		const anchor = edytor.root!.children[0]!.id;
		const suggestion = shared(edytor).add({ after: anchor }, undefined, { label: 'AI' });
		const updates: JSONBlock[][] = [
			[paragraph('Intro')],
			[paragraph('Intro'), code('const a = 1;')],
			[paragraph('Intro'), code('const a = 1;', 'const b = 2;')],
			[paragraph('Intro'), code('const a = 1;', 'const b = 2;', 'a + b;')],
			[paragraph('Intro'), code('const a = 1;', 'const b = 2;', 'a + b;'), paragraph('Done.')]
		];
		const seen: JSONBlock[][] = [];
		for (const blocks of updates) {
			suggestion.update(blocks);
			await flushDomUpdates();
			seen.push(shownAfterFirst(edytor));
		}
		suggestion.done();
		// After each update the document shows the answer so far, as written.
		expect(seen).toEqual(updates.map((blocks) => blocks.map(plain)));
		// One suggestion of the AI's.
		expect(suggestionsOf(edytor.facade).records()).toHaveLength(1);
	});

	it('1b. sugg.ai.live: a growing code block grows in place, its lines kept, the last one extended', async () => {
		const { edytor } = await renderDomEdytor(
			<root>
				<paragraph>Anchor|</paragraph>
			</root>,
			options()
		);
		const anchor = edytor.root!.children[0]!.id;
		const suggestion = shared(edytor).add({ after: anchor }, undefined, { label: 'AI' });
		/** The shown code block's id and its lines' ids and texts. */
		const ids = () => {
			const block = edytor.facade.toJSON({ suggestions: true }).children[1]!;
			return {
				id: block.id,
				lines: (block.children ?? []).map((line) => [line.id, plain(line).content])
			};
		};
		suggestion.update([code('const a')]);
		await flushDomUpdates();
		const first = ids();
		suggestion.update([code('const a = 1;')]);
		await flushDomUpdates();
		const extended = ids();
		suggestion.update([code('const a = 1;', 'const b')]);
		await flushDomUpdates();
		const added = ids();
		suggestion.done();
		// The block and its first line are the ones first written: extended, never replaced.
		expect(extended.id).toBe(first.id);
		expect(extended.lines).toEqual([[first.lines[0]![0], [{ text: 'const a = 1;' }]]]);
		expect(added.id).toBe(first.id);
		expect(added.lines[0]).toEqual(extended.lines[0]);
		expect(added.lines[1]![1]).toEqual([{ text: 'const b' }]);
		expect(shownAfterFirst(edytor)).toEqual([code('const a = 1;', 'const b')]);
	});

	it('2. add(at, content): a suggestion added with its content is written, listed and reviewable', async () => {
		const { edytor } = await renderDomEdytor(
			<root>
				<paragraph>Anchor|</paragraph>
			</root>,
			options()
		);
		const anchor = edytor.root!.children[0]!.id;
		const suggestion = shared(edytor).add({ after: anchor }, [paragraph('Hello')], {
			label: 'AI'
		});
		await flushDomUpdates();
		// "with content it starts ready", and it is listed (live) and written.
		expect(suggestion.status).toBe('ready');
		expect(suggestion.live).toBe(true);
		expect(edytor.suggestions.get(suggestion.id)).toBe(suggestion);
		expect(edytor.suggestions.list.filter((s) => s.shared)).toHaveLength(1);
		expect(suggestion.shared && suggestion.changes.map((c) => [c.kind, c.text])).toEqual([
			['block', 'Hello']
		]);
		expect(shownAfterFirst(edytor)).toEqual([paragraph('Hello')]);
	});

	it("3. via: a suggestion a member typed in suggesting mode has no agent (not 'ai')", async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>Hello|</paragraph>
			</root>,
			options()
		);
		shared(edytor).suggesting = true;
		await dispatchDomBeforeInput(editor, { inputType: 'insertText', data: '!' });
		await flushDomUpdates();
		const [record] = suggestionsOf(edytor.facade).records();
		// The document holds no agent for it…
		expect(record?.via).toBeUndefined();
		const list = edytor.suggestions.list.filter((s) => s.shared);
		expect(list).toHaveLength(1);
		// …and the list reads what the document holds.
		expect(list[0]!.shared && list[0]!.via).toBeUndefined();
		expect(list[0]!.shared && list[0]!.by).toBe(edytor.document.actor.id);
	});
});
