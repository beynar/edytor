/**
 * The command surface, on the headless view.
 *
 * - API-07 — `prevent()` records the hook's veto and returns: the hook runs
 *   to its end, a `try/catch` in it can no longer swallow the veto, the
 *   first call decides (its replacement, if any, runs once). A thrown
 *   `PreventionError` (the earlier form) still vetoes; `isPrevention` names
 *   it.
 * - API-08 — `onAfterOperation`'s payload narrows by `operation` (a
 *   distributive `Omit`): checked by `pnpm test:typecheck`.
 * - API-09 — one write API: the view's operations (`edytor.insertBlocks`)
 *   answer the document's `OpResult` and record the `CommandResult
 *   { operation, status }` in `dispatcher.last`; the raw path, the
 *   document's same operations, takes the `JSONBlock` shape `value` and
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
import { richTextPlugin } from '../../lib/starter/chrome/plugins.js';

const p = (id: string, text: string): JSONBlock => ({ id, type: 'paragraph', content: [{ text }] });

const view = (plugins: Plugin[] = []) => {
	const document = createDocument({ value: { children: [p('a', 'aa'), p('b', 'bb')] } });
	const edytor = new Edytor({ document, plugins: [...plugins, richTextPlugin] });
	return { document, edytor };
};

const texts = (edytor: Edytor) =>
	(edytor.value.children ?? []).map((b) => (b.content ?? []).map((x) => ('text' in x ? x.text : '')).join(''));

const typeAt = (edytor: Edytor, id: string, value: string) => edytor.insertText(id, 0, value);

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
						edytor.insertText('b', 0, 'y');
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
					expectTypeOf(change.text).toEqualTypeOf<Text | undefined>();
					expectTypeOf(change.payload[2]).toEqualTypeOf<string>();
				}
				if (change.operation === 'setBlock') {
					expectTypeOf(change.payload[0]).toEqualTypeOf<string>();
				}
			}
		});
		const after: string[] = [];
		const { edytor } = view([
			plugin,
			() => ({
				onAfterOperation: (change) => {
					if (change.operation === 'insertText') after.push(change.payload[2]);
				}
			})
		]);
		typeAt(edytor, 'a', 'x');
		expect(after).toEqual(['x']);
	});
});

describe('API-09 · one write API, two entry points', () => {
	test('a view operation answers its OpResult and records its CommandResult', () => {
		const { edytor } = view();
		const at = { parent: null, index: 1 };
		const inserted = edytor.insertBlocks(at, [{ type: 'paragraph' }]);
		const last: CommandResult | null = edytor.dispatcher.last;
		expect(inserted).toMatchObject({ status: 'applied', ids: [expect.any(String)] });
		expect(last).toMatchObject({ operation: 'insertBlocks', status: 'applied' });
		edytor.readonly = true;
		expect(edytor.insertBlocks(at, [{ type: 'paragraph' }])).toMatchObject({
			status: 'refused',
			reason: 'view'
		});
		expect(edytor.dispatcher.last).toMatchObject({ operation: 'insertBlocks', status: 'refused' });
	});

	test('a replacement running the vetoed operation records its own result', () => {
		// The mention plugin's pattern: `prevent(cb)` where `cb` runs the same
		// operation. The vetoed call is refused by the view; the result
		// recorded is the replacement's.
		let replacement: unknown;
		const { edytor } = view([
			() => ({
				onBeforeOperation: ({ operation, payload, prevent }) => {
					if (operation !== 'insertBlocks' || payload[1][0]?.type !== 'paragraph') return;
					prevent(() => {
						replacement = edytor.insertBlocks(payload[0], [{ type: 'heading' }]);
					});
				}
			})
		]);
		const vetoed = edytor.insertBlocks({ parent: null, index: 1 }, [{ type: 'paragraph' }]);
		expect(vetoed).toMatchObject({ status: 'refused', reason: 'view' });
		expect(replacement).toMatchObject({ status: 'applied' });
		expect(edytor.dispatcher.last).toMatchObject({ operation: 'insertBlocks', status: 'applied' });
	});

	test('the raw path, the document’s same operation, takes JSONBlock', () => {
		const { edytor, document } = view();
		const result = edytor.document.insertBlocks({ parent: null, index: 2 }, [{
				type: 'paragraph',
				content: [{ text: 'raw ' }, { text: 'bold', marks: { bold: true } }],
				children: [{ id: 'kid', type: 'paragraph', content: [{ text: 'child' }] }]
			}]);
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
