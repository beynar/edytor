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

	/** A view with one anchor paragraph, and its shared suggestions' controller. */
	const mounted = async () => {
		const { edytor } = await renderDomEdytor(
			<root>
				<paragraph>Anchor|</paragraph>
			</root>,
			options()
		);
		return { edytor, anchor: edytor.root!.children[0]!.id };
	};
	const listed = (edytor: Edytor) => edytor.suggestions.list.filter((s) => s.shared);

	it('add(at, []) waits for its content: listed, then an update writes it', async () => {
		const { edytor, anchor } = await mounted();
		const suggestion = shared(edytor).add({ after: anchor }, []);
		await flushDomUpdates();
		expect(suggestion.live).toBe(true);
		suggestion.update([paragraph('Later')]);
		await flushDomUpdates();
		expect(listed(edytor)).toEqual([suggestion]);
		expect(shownAfterFirst(edytor)).toEqual([paragraph('Later')]);
	});

	it("add(at, undefined, { status: 'ready' }) then update writes and lists it", async () => {
		const { edytor, anchor } = await mounted();
		const suggestion = shared(edytor).add({ after: anchor }, undefined, { status: 'ready' });
		suggestion.update([paragraph('Hello')]);
		await flushDomUpdates();
		expect(suggestion.status).toBe('ready');
		expect(listed(edytor)).toEqual([suggestion]);
		expect(shownAfterFirst(edytor)).toEqual([paragraph('Hello')]);
	});

	it('added again under its id, it replaces what the earlier one wrote', async () => {
		const { edytor, anchor } = await mounted();
		shared(edytor).add({ after: anchor }, [paragraph('First'), paragraph('Draft')], { id: 'ans' });
		await flushDomUpdates();
		const again = shared(edytor).add({ after: anchor }, [paragraph('First'), paragraph('Final')], {
			id: 'ans'
		});
		await flushDomUpdates();
		expect(shownAfterFirst(edytor)).toEqual([paragraph('First'), paragraph('Final')]);
		expect(listed(edytor)).toEqual([again]);
		expect(suggestionsOf(edytor.facade).records()).toHaveLength(1);
	});

	it('a decided suggestion leaves the list', async () => {
		const { edytor, anchor } = await mounted();
		const suggestion = shared(edytor).add({ after: anchor }, [paragraph('Kept')]);
		await flushDomUpdates();
		expect(suggestion.accept().status).toBe('applied');
		await flushDomUpdates();
		expect(listed(edytor)).toEqual([]);
		expect(edytor.facade.toJSON().children.slice(1).map(plain)).toEqual([paragraph('Kept')]);
	});

	it('a container whose children grow grows in place, and accepting gives the answer', async () => {
		const { edytor, anchor } = await mounted();
		const toggle = (...children: string[]): JSONBlock => ({
			type: 'toggle',
			content: [{ text: 'Steps' }],
			children: children.map(paragraph)
		});
		const suggestion = shared(edytor).add({ after: anchor }, undefined);
		const shownToggle = () => edytor.facade.toJSON({ suggestions: true }).children[1]!;
		suggestion.update([toggle('One')]);
		await flushDomUpdates();
		const first = shownToggle();
		suggestion.update([toggle('One', 'Tw')]);
		await flushDomUpdates();
		suggestion.update([toggle('One', 'Two')]);
		await flushDomUpdates();
		const last = shownToggle();
		suggestion.done();
		// The toggle and its first child are the ones first written; the second child grew.
		expect(last.id).toBe(first.id);
		expect(last.children![0]!.id).toBe(first.children![0]!.id);
		expect(shownAfterFirst(edytor)).toEqual([toggle('One', 'Two')]);
		expect(suggestion.accept().status).toBe('applied');
		expect(edytor.facade.toJSON().children.slice(1).map(plain)).toEqual([toggle('One', 'Two')]);
	});

	it('a code block shrinking to no lines is replaced, never left with stray lines', async () => {
		const { edytor, anchor } = await mounted();
		const suggestion = shared(edytor).add({ after: anchor }, undefined);
		suggestion.update([code('const a')]);
		await flushDomUpdates();
		suggestion.update([code()]);
		await flushDomUpdates();
		suggestion.update([code('const a = 1;')]);
		await flushDomUpdates();
		suggestion.done();
		expect(shownAfterFirst(edytor)).toEqual([code('const a = 1;')]);
	});
});
