/**
 * WU-13 (API-07, API-08, API-09): the command surface, on the headless view.
 *
 * - API-07 — `prevent()` records the hook's veto and returns: the hook runs
 *   to its end, a `try/catch` in it can no longer swallow the veto, the
 *   first call decides (its replacement, if any, runs once). A thrown
 *   `PreventionError` (the earlier form) still vetoes; `isPrevention` names
 *   it.
 * - API-08 — `onAfterOperation`'s payload narrows by `operation` (a
 *   distributive `Omit`): checked by `pnpm test:typecheck`.
 * - API-09 — one result channel: `dispatcher.last` is the
 *   `CommandResult { operation, status, value }` of every handle mutator
 *   (`value` is what the mutator returned); the raw path
 *   `edytor.document.facade` takes the `JSONBlock` shape `value` and
 *   `toJSON` speak.
 *
 * Expected values come from the plan rows, never from running the code.
 */
import { describe, expect, expectTypeOf, test } from 'vitest';
import {
	createDocument,
	isPrevention,
	PreventionError,
	type CommandResult,
	type JSONBlock,
	type Plugin,
	type Text
} from '$lib/index.js';
import { Edytor } from '$lib/edytor.svelte.js';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';

const p = (id: string, text: string): JSONBlock => ({ id, type: 'paragraph', content: [{ text }] });

const view = (plugins: Plugin[] = []) => {
	const document = createDocument({ value: { children: [p('a', 'aa'), p('b', 'bb')] } });
	const edytor = new Edytor({ document, plugins: [...plugins, richTextPlugin] });
	return { document, edytor };
};

const texts = (edytor: Edytor) =>
	(edytor.value.children ?? []).map((b) => (b.content ?? []).map((x) => ('text' in x ? x.text : '')).join(''));

const typeAt = (edytor: Edytor, id: string, value: string) =>
	edytor.idToBlock.get(id)!.firstText!.insertText({ value, start: 0, end: 0 });

describe('API-07 · prevent records and returns', () => {
	test('the hook runs to its end; the command is refused', () => {
		const seen: string[] = [];
		const { edytor } = view([
			() => ({
				onBeforeOperation: ({ operation, prevent }) => {
					if (operation !== 'insertText') return;
					prevent();
					seen.push('after prevent');
				}
			})
		]);
		expect(() => typeAt(edytor, 'a', 'x')).not.toThrow();
		expect(seen).toEqual(['after prevent']);
		expect(edytor.dispatcher.last).toMatchObject({ operation: 'insertText', status: 'refused' });
		expect(texts(edytor)).toEqual(['aa', 'bb']);
	});

	test('a try/catch in the hook no longer swallows the veto', () => {
		const { edytor } = view([
			() => ({
				onBeforeOperation: ({ operation, prevent }) => {
					if (operation !== 'insertText') return;
					try {
						prevent();
					} catch {
						// the earlier `prevent` threw: this swallowed the veto
					}
				}
			})
		]);
		typeAt(edytor, 'a', 'x');
		expect(edytor.dispatcher.last?.status).toBe('refused');
		expect(texts(edytor)).toEqual(['aa', 'bb']);
	});

	test('the first prevent decides; its replacement runs once', () => {
		let runs = 0;
		const { edytor } = view([
			() => ({
				onBeforeOperation: ({ operation, prevent }) => {
					if (operation !== 'insertText') return;
					prevent(() => {
						runs++;
						edytor.idToBlock.get('b')!.firstText!.insertText({ value: 'y', start: 0, end: 0 });
					});
					prevent(() => (runs += 10));
				}
			})
		]);
		typeAt(edytor, 'a', 'x');
		expect(runs).toBe(1);
		expect(texts(edytor)).toEqual(['aa', 'ybb']);
	});

	test('a prevent in a key binding claims the key and ends the chain', () => {
		const order: string[] = [];
		const { edytor } = view([
			() => ({
				hotkeys: {
					'mod+j': ({ prevent }) => {
						order.push('first');
						prevent();
						order.push('first, after prevent');
					}
				}
			}),
			() => ({ hotkeys: { 'mod+j': () => void order.push('second') } })
		]);
		let defaultPrevented = false;
		const event = {
			preventDefault: () => void (defaultPrevented = true),
			stopPropagation: () => {}
		} as unknown as KeyboardEvent;
		expect(edytor.keymap.run('mod+j', event)).toBe(true);
		expect(order).toEqual(['first', 'first, after prevent']);
		expect(defaultPrevented).toBe(true);
	});

	test('a thrown PreventionError (the earlier form) still vetoes; isPrevention names it', () => {
		const { edytor } = view([
			() => ({
				onBeforeOperation: ({ operation }) => {
					if (operation === 'insertText') throw new PreventionError();
				}
			})
		]);
		typeAt(edytor, 'a', 'x');
		expect(edytor.dispatcher.last?.status).toBe('refused');
		expect(isPrevention(new PreventionError())).toBe(true);
		expect(isPrevention(new Error('Prevent'))).toBe(false);
	});
});

describe('API-08 · onAfterOperation narrows by operation', () => {
	test('the payload of a text operation is its own (type-level)', () => {
		const plugin: Plugin = () => ({
			onAfterOperation: (change) => {
				expectTypeOf(change).not.toHaveProperty('prevent');
				if (change.operation === 'insertText') {
					expectTypeOf(change.text).toEqualTypeOf<Text>();
					expectTypeOf(change.payload.value).toEqualTypeOf<string>();
				}
				if (change.operation === 'setBlock') {
					expectTypeOf(change).not.toHaveProperty('text');
				}
			}
		});
		const after: string[] = [];
		const { edytor } = view([
			plugin,
			() => ({
				onAfterOperation: (change) => {
					if (change.operation === 'insertText') after.push(change.payload.value);
				}
			})
		]);
		typeAt(edytor, 'a', 'x');
		expect(after).toEqual(['x']);
	});
});

describe('API-09 · one result channel and one raw path', () => {
	test('dispatcher.last is the CommandResult of a handle mutator, its value included', () => {
		const { edytor } = view();
		const block = edytor.idToBlock.get('a')!;
		const inserted = block.insertBlockAfter({ block: { type: 'paragraph' } });
		const last: CommandResult | null = edytor.dispatcher.last;
		expect(inserted?.id).toBeTypeOf('string');
		expect(last).toMatchObject({ operation: 'insertBlockAfter', status: 'applied' });
		expect(last?.value).toBe(inserted);
		edytor.readonly = true;
		expect(block.insertBlockAfter({ block: { type: 'paragraph' } })).toBeUndefined();
		expect(edytor.dispatcher.last).toMatchObject({
			operation: 'insertBlockAfter',
			status: 'refused',
			value: undefined
		});
	});

	test('the raw path, edytor.document.facade, takes JSONBlock', () => {
		const { edytor, document } = view();
		const result = edytor.document.facade.insertBlock(
			{ parent: null, index: 2 },
			{
				type: 'paragraph',
				content: [{ text: 'raw ' }, { text: 'bold', marks: { bold: true } }],
				children: [{ id: 'kid', type: 'paragraph', content: [{ text: 'child' }] }]
			}
		);
		expect(result.status).toBe('applied');
		const [id] = result.ids;
		expect(id).toBeTypeOf('string');
		const json = document.facade.toJSON().children[2]!;
		expect(json).toMatchObject({
			id,
			type: 'paragraph',
			content: [{ text: 'raw ' }, { text: 'bold', marks: { bold: true } }],
			children: [{ id: 'kid', type: 'paragraph', content: [{ text: 'child' }] }]
		});
		// The shape `toJSON` exports goes back in, ids kept.
		const other = createDocument({ value: { children: [p('z', 'zz')] } });
		expect(other.facade.insertBlocks({ parent: null, index: 1 }, [json]).ids).toEqual([id]);
		expect(other.facade.toJSON().children[1]).toEqual(json);
		other.destroy();
	});
});
