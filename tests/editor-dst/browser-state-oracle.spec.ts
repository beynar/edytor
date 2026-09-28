import { expect, test } from '@playwright/test';

import {
	assertActionEffect,
	assertBrowserSnapshot,
	isStickyOutsideEscape,
	assertSemanticPreservation,
	assertTrustedAction,
	flattenTextSegments,
	type DstBrowserSnapshot,
	type DstEvent,
	type DstHarnessFailure,
	type DstTextSelection
} from './browserState.js';
import { inputClassOf, type DstAction, type DstForeignMutation } from './generator.js';
import { contractWordEndOffset, contractWordStartOffset, describeDelete } from './deleteOracle.js';
import { assertDeleteIntent } from './runner.js';
import {
	acceptableEndpointSpots,
	acceptableSelectionShapes,
	passiveSelectionInvariantViolation,
	selectionMoved,
	type EndpointSpot,
	type PassiveEndpoint
} from './selectionOracle.js';
import {
	assertDumpSelectionSane,
	assertPassiveSelectionExact,
	CollabRunError,
	type DocumentDump
} from './collab-runner.js';

const snapshot = (): DstBrowserSnapshot => ({
	value: {
		children: [
			{
				type: 'paragraph',
				id: 'block-1',
				content: [{ text: 'ab', marks: { bold: true } }, { text: 'cd' }]
			}
		]
	},
	history: { undoDepth: 0, redoDepth: 0, canUndo: false, canRedo: false },
	model: {
		blocks: [
			{
				id: 'block-1',
				type: 'paragraph',
				data: {},
				contentKinds: ['text'],
				parts: [
					{
						kind: 'text',
						id: 'text-1',
						runs: [
							{ text: 'ab', marks: { bold: true } },
							{ text: 'cd', marks: null }
						]
					}
				],
				path: [0],
				void: false,
				island: false,
				renderedTextCount: 1
			}
		],
		defaultType: 'paragraph',
		rootDefaultType: 'paragraph',
		texts: ['abcd'],
		textIds: ['text-1'],
		renderedTexts: ['abcd'],
		renderedTextIds: ['text-1'],
		inlineIds: []
	},
	dom: {
		blockCount: 1,
		inlineIds: [],
		texts: ['abcd'],
		textIds: ['text-1'],
		textBindings: [
			{
				dataId: 'text-1',
				nodeMapId: 'text-1',
				idMapId: 'text-1',
				idMapNodeMatches: true
			}
		],
		emptyAttributes: [false],
		placeholderBlockIndexes: [],
		blockTypeAttrs: ['paragraph'],
		markAttrs: ['bold'],
		foreignResidual: { nodes: [], attrs: [] }
	},
	selection: null,
	nativeSelection: null,
	events: []
});

test.describe('DST browser snapshot oracle', () => {
	test('reconstructs omitted editable empties and skips void block content', () => {
		expect(
			flattenTextSegments(
				{
					children: [
						{ type: 'paragraph', id: 'empty' },
						{ type: 'divider', id: 'void' },
						{
							type: 'paragraph',
							id: 'inlines',
							content: [
								{ type: 'mention', id: 'mention-1' },
								{ text: 'middle' },
								{ type: 'mention', id: 'mention-2' }
							]
						}
					]
				},
				[
					{
						id: 'empty',
						type: 'paragraph',
						data: {},
						contentKinds: ['text'],
						parts: [],
						path: [0],
						void: false,
						island: false,
						renderedTextCount: 1
					},
					{
						id: 'void',
						type: 'divider',
						data: {},
						contentKinds: [],
						parts: [],
						path: [1],
						void: true,
						island: false,
						renderedTextCount: 0
					},
					{
						id: 'inlines',
						type: 'paragraph',
						data: {},
						contentKinds: ['text', 'inline', 'text', 'inline', 'text'],
						parts: [],
						path: [2],
						void: false,
						island: false,
						renderedTextCount: 3
					}
				]
			)
		).toEqual(['', '', 'middle', '']);
	});

	test('compares serialized and live logical text without requiring mark-run parity', () => {
		const consistent = snapshot();
		expect(() => assertBrowserSnapshot('chromium', consistent)).not.toThrow();

		const staleSerialization = snapshot();
		staleSerialization.value.children[0].content![1] = { text: 'ce' };

		let failure: DstHarnessFailure | undefined;
		try {
			assertBrowserSnapshot('chromium', staleSerialization);
		} catch (error) {
			failure = error as DstHarnessFailure;
		}
		expect(failure).toMatchObject({
			code: 'model-serialization-text-projection',
			engine: 'chromium'
		});
	});

	test('compares serialized block and inline identities with the live model', () => {
		const staleBlock = snapshot();
		staleBlock.value.children[0].type = 'quote';
		expect(() => assertBrowserSnapshot('firefox', staleBlock)).toThrow(
			/model-serialization-block-projection/
		);

		const staleInline = snapshot();
		staleInline.value.children[0].content = [
			{ text: 'ab' },
			{ type: 'mention', id: 'serialized-inline' },
			{ text: 'cd' }
		];
		staleInline.model.blocks[0].contentKinds = ['text', 'inline', 'text'];
		staleInline.model.texts = ['ab', 'cd'];
		staleInline.model.textIds = ['text-1', 'text-2'];
		staleInline.model.renderedTexts = ['ab', 'cd'];
		staleInline.model.renderedTextIds = ['text-1', 'text-2'];
		staleInline.model.inlineIds = ['live-inline'];
		staleInline.dom.texts = ['ab', 'cd'];
		staleInline.dom.textIds = ['text-1', 'text-2'];
		staleInline.dom.inlineIds = ['live-inline'];
		staleInline.dom.textBindings = [
			{
				dataId: 'text-1',
				nodeMapId: 'text-1',
				idMapId: 'text-1',
				idMapNodeMatches: true
			},
			{
				dataId: 'text-2',
				nodeMapId: 'text-2',
				idMapId: 'text-2',
				idMapNodeMatches: true
			}
		];
		staleInline.dom.emptyAttributes = [false, false];

		expect(() => assertBrowserSnapshot('webkit', staleInline)).toThrow(
			/model-serialization-inline-projection/
		);
	});

	test('classifies the new actions into trusted vs synthetic input classes', () => {
		for (const action of [
			{ kind: 'move', key: 'ArrowUp', extend: false },
			{ kind: 'move', key: 'Alt+ArrowLeft', extend: true },
			{ kind: 'wordDelete', direction: 'backward' },
			{ kind: 'lineDelete', direction: 'backward' },
			{ kind: 'tab' },
			{ kind: 'shiftTab' },
			{ kind: 'pointerClick', target: 'blockText', index: 0, edge: 'center' },
			{ kind: 'pointerDrag', startBlock: 0, endBlock: 1 },
			{ kind: 'shiftClick', target: 'inline', index: 0, edge: 'center' }
		] satisfies DstAction[]) {
			expect(inputClassOf(action), action.kind).toBe('trusted');
		}
		for (const action of [
			{ kind: 'composition', updates: ['e'], commit: 'é', commitViaBeforeinput: true },
			{ kind: 'paste', text: 'x', html: '' },
			{ kind: 'cut' },
			{ kind: 'copy' },
			{ kind: 'drop', index: 0, text: 'x' },
			{
				kind: 'foreignMutation',
				mutation: { kind: 'foreignAttribute', target: 'text', index: 0, attribute: 0 }
			}
		] satisfies DstAction[]) {
			expect(inputClassOf(action), action.kind).toBe('synthetic');
		}
	});

	test('forbids foreignMutation from emitting input events', () => {
		const action: DstAction = {
			kind: 'foreignMutation',
			mutation: { kind: 'managedAttribute', target: 'text', index: 0, attribute: 0 }
		};
		// Scripted DOM writes dispatch no events at all — an empty record is
		// a pass, not a missing-delivery failure.
		expect(() => assertTrustedAction('chromium', action, [])).not.toThrow();
		expect(() =>
			assertTrustedAction('chromium', action, [
				{ type: 'selectionchange', isTrusted: true, cancelable: false }
			])
		).not.toThrow();
		expect(() =>
			assertTrustedAction('chromium', action, [
				{
					type: 'beforeinput',
					isTrusted: false,
					cancelable: true,
					inputType: 'insertText',
					data: 'x'
				}
			])
		).toThrow(/foreign-mutation-emitted-input/);
	});

	test('requires the full synthetic composition sequence to arrive', () => {
		const action: DstAction = {
			kind: 'composition',
			updates: ['e', 'é'],
			commit: 'é',
			commitViaBeforeinput: true
		};
		const sequence: DstEvent[] = [
			{ type: 'compositionstart', isTrusted: false, cancelable: true },
			{ type: 'compositionupdate', isTrusted: false, cancelable: true },
			{
				type: 'beforeinput',
				isTrusted: false,
				cancelable: true,
				inputType: 'insertCompositionText',
				data: 'e'
			},
			{ type: 'compositionupdate', isTrusted: false, cancelable: true },
			{
				type: 'beforeinput',
				isTrusted: false,
				cancelable: true,
				inputType: 'insertCompositionText',
				data: 'é'
			},
			{
				type: 'beforeinput',
				isTrusted: false,
				cancelable: true,
				inputType: 'insertFromComposition',
				data: 'é'
			},
			{ type: 'compositionend', isTrusted: false, cancelable: true }
		];
		expect(() => assertTrustedAction('chromium', action, sequence)).not.toThrow();
		expect(() => assertTrustedAction('chromium', action, sequence.slice(0, -1))).toThrow(
			/synthetic-input-not-delivered/
		);
	});

	test('requires trusted input for new trusted actions and synthetic delivery for paste/cut', () => {
		const trustedKeydown: DstEvent[] = [
			{ type: 'keydown', isTrusted: true, cancelable: true, key: 'Backspace' }
		];
		expect(() =>
			assertTrustedAction('firefox', { kind: 'wordDelete', direction: 'backward' }, trustedKeydown)
		).not.toThrow();
		expect(() =>
			assertTrustedAction('firefox', { kind: 'wordDelete', direction: 'backward' }, [
				{ type: 'keydown', isTrusted: false, cancelable: true, key: 'Backspace' }
			])
		).toThrow(/untrusted-input-path/);
		expect(() =>
			assertTrustedAction(
				'webkit',
				{ kind: 'pointerClick', target: 'blockText', index: 0, edge: 'left' },
				[
					{ type: 'pointerdown', isTrusted: true, cancelable: true, button: 0 },
					{ type: 'mousedown', isTrusted: true, cancelable: true, button: 0 }
				]
			)
		).not.toThrow();
		expect(() =>
			assertTrustedAction('chromium', { kind: 'paste', text: 'x', html: '' }, [
				{ type: 'paste', isTrusted: false, cancelable: true }
			])
		).not.toThrow();
	});
});

const twoBlockSnapshot = (selection: Partial<DstTextSelection> | null): DstBrowserSnapshot => ({
	value: {
		children: [
			{ type: 'paragraph', id: 'b0', content: [{ text: 'hello' }] },
			{ type: 'paragraph', id: 'b1', content: [{ text: 'world' }] }
		]
	},
	history: { undoDepth: 0, redoDepth: 0, canUndo: false, canRedo: false },
	model: {
		blocks: [
			{
				id: 'b0',
				type: 'paragraph',
				data: {},
				contentKinds: ['text'],
				parts: [{ kind: 'text', id: 't0', runs: [{ text: 'hello', marks: null }] }],
				path: [0],
				void: false,
				island: false,
				renderedTextCount: 1
			},
			{
				id: 'b1',
				type: 'paragraph',
				data: {},
				contentKinds: ['text'],
				parts: [{ kind: 'text', id: 't1', runs: [{ text: 'world', marks: null }] }],
				path: [1],
				void: false,
				island: false,
				renderedTextCount: 1
			}
		],
		defaultType: 'paragraph',
		rootDefaultType: 'paragraph',
		texts: ['hello', 'world'],
		textIds: ['t0', 't1'],
		renderedTexts: ['hello', 'world'],
		renderedTextIds: ['t0', 't1'],
		inlineIds: []
	},
	dom: {
		blockCount: 2,
		inlineIds: [],
		texts: ['hello', 'world'],
		textIds: ['t0', 't1'],
		textBindings: [
			{ dataId: 't0', nodeMapId: 't0', idMapId: 't0', idMapNodeMatches: true },
			{ dataId: 't1', nodeMapId: 't1', idMapId: 't1', idMapNodeMatches: true }
		],
		emptyAttributes: [false, false],
		placeholderBlockIndexes: [],
		blockTypeAttrs: ['paragraph', 'paragraph'],
		markAttrs: [],
		foreignResidual: { nodes: [], attrs: [] }
	},
	selection: selection
		? {
				kind: 'text',
				startTextIndex: 0,
				endTextIndex: 0,
				yStart: 0,
				yEnd: 0,
				isCollapsed: true,
				isReversed: false,
				...selection
			}
		: null,
	nativeSelection: null,
	events: []
});

const movedSelection = (snapshot: DstBrowserSnapshot): DstBrowserSnapshot => ({
	...snapshot,
	selection:
		snapshot.selection?.kind === 'text'
			? {
					...snapshot.selection,
					yStart: snapshot.selection.yStart + 1,
					yEnd: snapshot.selection.yStart + 1
				}
			: snapshot.selection
});

test.describe('DST v3 effect oracle', () => {
	test('allows vertical-move edge no-ops but requires provable moves', () => {
		const arrowUp: DstAction = { kind: 'move', key: 'ArrowUp', extend: false };
		// Caret in the first block: ArrowUp has nowhere to go — a legal no-op.
		const firstBlock = twoBlockSnapshot({ startTextIndex: 0, endTextIndex: 0, yStart: 2, yEnd: 2 });
		expect(() => assertActionEffect('chromium', arrowUp, firstBlock, firstBlock)).not.toThrow();
		// Caret in the second block: an earlier rendered block exists, so the
		// selection must move.
		const secondBlock = twoBlockSnapshot({
			startTextIndex: 1,
			endTextIndex: 1,
			yStart: 2,
			yEnd: 2
		});
		expect(() => assertActionEffect('chromium', arrowUp, secondBlock, secondBlock)).toThrow(
			/move-produced-no-effect/
		);
		expect(() =>
			assertActionEffect('chromium', arrowUp, secondBlock, movedSelection(secondBlock))
		).not.toThrow();
		// ArrowDown in the last block: legal no-op.
		const lastBlock = twoBlockSnapshot({ startTextIndex: 1, endTextIndex: 1, yStart: 2, yEnd: 2 });
		const arrowDown: DstAction = { kind: 'move', key: 'ArrowDown', extend: false };
		expect(() => assertActionEffect('firefox', arrowDown, lastBlock, lastBlock)).not.toThrow();
	});

	test('reasons about Home/End line boundaries without pixel metrics', () => {
		const home: DstAction = { kind: 'move', key: 'Home', extend: false };
		// Already at the line start — no-op is legal.
		const atStart = twoBlockSnapshot({ yStart: 0, yEnd: 0 });
		expect(() => assertActionEffect('chromium', home, atStart, atStart)).not.toThrow();
		// Mid-text — must move.
		const mid = twoBlockSnapshot({ yStart: 3, yEnd: 3 });
		expect(() => assertActionEffect('chromium', home, mid, mid)).toThrow(/move-produced-no-effect/);
	});

	test('requires wordDelete to mutate only when a word is deletable', () => {
		const backward: DstAction = { kind: 'wordDelete', direction: 'backward' };
		const midCaret = twoBlockSnapshot({ yStart: 3, yEnd: 3 });
		expect(() => assertActionEffect('webkit', backward, midCaret, midCaret)).toThrow(
			/action-produced-no-effect/
		);
		const atStart = twoBlockSnapshot({ yStart: 0, yEnd: 0 });
		expect(() => assertActionEffect('webkit', backward, atStart, atStart)).not.toThrow();
	});

	test('delete intent pins the delivered inputType to the action family', () => {
		const wordBackward: DstAction = { kind: 'wordDelete', direction: 'backward' };
		const wordForward: DstAction = { kind: 'wordDelete', direction: 'forward' };
		const lineBackward: DstAction = { kind: 'lineDelete', direction: 'backward' };
		const caret = twoBlockSnapshot({ yStart: 3, yEnd: 3 });
		const after = (inputType?: string, mutate = false): DstBrowserSnapshot => {
			const snap = twoBlockSnapshot({ yStart: 3, yEnd: 3 });
			snap.events = [
				{ type: 'keydown', isTrusted: true, cancelable: true, key: 'Backspace' },
				...(inputType === undefined
					? []
					: [{ type: 'beforeinput', isTrusted: true, cancelable: true, inputType }])
			];
			if (mutate) snap.value.children[0].content = [{ text: 'mutated' }];
			return snap;
		};
		// The v4 defect: a `wordDelete` whose chord delivered a line delete
		// must fail loudly — it cannot count as a successful word test.
		expect(() =>
			assertDeleteIntent('chromium', wordBackward, caret, after('deleteSoftLineBackward'))
		).toThrow(/delete-intent-mismatch/);
		// Absent delivery mismatches on engines that always deliver…
		expect(() => assertDeleteIntent('chromium', wordBackward, caret, after())).toThrow(
			/delete-intent-mismatch/
		);
		// …but WebKit suppresses beforeinput for a no-op command — honest
		// only while the document is provably unchanged (a mutation with no
		// delivered unit still fails).
		expect(() => assertDeleteIntent('webkit', wordBackward, caret, after())).not.toThrow();
		expect(() => assertDeleteIntent('webkit', wordBackward, caret, after(undefined, true))).toThrow(
			/delete-intent-mismatch/
		);
		expect(() =>
			assertDeleteIntent('chromium', wordBackward, caret, after('deleteContentBackward'))
		).toThrow(/delete-intent-mismatch/);
		// The honest word-delete deliveries pass on all engines.
		expect(() =>
			assertDeleteIntent('chromium', wordBackward, caret, after('deleteWordBackward'))
		).not.toThrow();
		expect(() =>
			assertDeleteIntent('firefox', wordForward, caret, after('deleteWordForward'))
		).not.toThrow();
		expect(() =>
			assertDeleteIntent('firefox', wordForward, caret, after('deleteWordBackward'))
		).toThrow(/delete-intent-mismatch/);
		// lineDelete accepts the whole backward line-delete family…
		for (const inputType of [
			'deleteSoftLineBackward',
			'deleteHardLineBackward',
			'deleteEntireSoftLine'
		]) {
			expect(
				() => assertDeleteIntent('webkit', lineBackward, caret, after(inputType)),
				inputType
			).not.toThrow();
		}
		// …but not a word unit.
		expect(() =>
			assertDeleteIntent('chromium', lineBackward, caret, after('deleteWordBackward'))
		).toThrow(/delete-intent-mismatch/);
		// The other legal absent delivery: a node selection takes the
		// keydown hotkey path, which dispatches no beforeinput — the
		// oracle's `unchanged` expectation tolerates that no-op, so must
		// the intent check.
		const nodeSelected = twoBlockSnapshot(null);
		nodeSelected.selection = { kind: 'block', ids: ['b0'] };
		const nodeAfter = twoBlockSnapshot(null);
		nodeAfter.selection = { kind: 'block', ids: ['b0'] };
		expect(() =>
			assertDeleteIntent('chromium', wordBackward, nodeSelected, nodeAfter)
		).not.toThrow();
		expect(() => assertDeleteIntent('webkit', lineBackward, nodeSelected, nodeAfter)).not.toThrow();
	});

	test('lineDelete expectation follows the delivered line-delete inputType', () => {
		// 'hel|lo world' — the darwin ⌘⌫ chord delivers
		// `deleteSoftLineBackward`; the oracle reads the DELIVERED type, so
		// the line intent produces the line-scope splice, not a word one.
		const caret = twoBlockSnapshot({ yStart: 3, yEnd: 3 });
		caret.value.children[0].content = [{ text: 'hello world' }];
		caret.model.blocks[0].parts = [
			{ kind: 'text', id: 't0', runs: [{ text: 'hello world', marks: null }] }
		];
		caret.model.texts = ['hello world', 'world'];
		caret.model.renderedTexts = ['hello world', 'world'];
		const events: DstEvent[] = [
			{
				type: 'beforeinput',
				isTrusted: true,
				cancelable: true,
				inputType: 'deleteSoftLineBackward'
			}
		];
		expect(describeDelete(caret, { kind: 'lineDelete', direction: 'backward' }, events)).toEqual({
			kind: 'tree',
			description: 'line backward delete',
			children: [
				{ type: 'paragraph', id: 'b0', data: {}, content: [{ text: 'lo world' }] },
				{ type: 'paragraph', id: 'b1', data: {}, content: [{ text: 'world' }] }
			]
		});
		// A node selection has no model path — a legal no-op expectation.
		const nodeSelected = twoBlockSnapshot(null);
		nodeSelected.selection = { kind: 'block', ids: ['b0'] };
		expect(describeDelete(nodeSelected, { kind: 'lineDelete', direction: 'backward' }, [])).toEqual(
			{
				kind: 'unchanged',
				reason: expect.stringContaining('node selection')
			}
		);
	});

	test('the oracle word-boundary scan pins the contract on marked/CJK text', () => {
		// The contract: a word is a maximal run of `[\p{L}\p{N}_]` code
		// points; every other character is a boundary. CJK letters are word
		// characters; a surrogate pair is one character two UTF-16 units wide.
		expect(contractWordStartOffset('한글 한', 4)).toBe(3);
		expect(contractWordStartOffset('한글 한', 2)).toBe(0);
		expect(contractWordStartOffset('a🚀b', 4)).toBe(3);
		expect(contractWordStartOffset('a🚀b', 3)).toBe(0);
		expect(contractWordEndOffset('한글 한', 0)).toBe(2);
		expect(contractWordEndOffset('한글 한', 2)).toBe(4);
		expect(contractWordEndOffset('a🚀b', 1)).toBe(4);
		// No word in that direction → the boundary run itself is the unit:
		// its far edge is the boundary (a caret before/after only
		// punctuation/space still consumes the run to the text edge).
		expect(contractWordStartOffset('  ', 2)).toBe(0);
		expect(contractWordEndOffset('  ', 0)).toBe(2);

		// A mark seam inside a word run is not a boundary: 'ab'(bold)+'cd'
		// is one word, so wordDelete backward from the end erases all of
		// it — not just the unmarked tail.
		const marked = snapshot();
		marked.selection = {
			kind: 'text',
			startTextIndex: 0,
			endTextIndex: 0,
			yStart: 4,
			yEnd: 4,
			isCollapsed: true,
			isReversed: false
		};
		const events: DstEvent[] = [
			{
				type: 'beforeinput',
				isTrusted: true,
				cancelable: true,
				inputType: 'deleteWordBackward'
			}
		];
		expect(describeDelete(marked, { kind: 'wordDelete', direction: 'backward' }, events)).toEqual({
			kind: 'tree',
			description: 'word backward delete',
			children: [{ type: 'paragraph', id: 'block-1', data: {} }]
		});
	});

	test('undo stack advancement counts dead-item consumption, not just transfers', () => {
		const undo: DstAction = { kind: 'undo' };
		const withUndo = (depths: { undo: number; redo: number }, text = 'hello') => {
			const snap = twoBlockSnapshot({ yStart: 1, yEnd: 1 });
			snap.history = {
				undoDepth: depths.undo,
				redoDepth: depths.redo,
				canUndo: depths.undo > 0,
				canRedo: depths.redo > 0
			};
			snap.value.children[0].content = [{ text }];
			return snap;
		};
		// Dead pop: the item was consumed (undoDepth 1→0) but superseded, so
		// nothing transferred to redo and the doc didn't change — a legal
		// no-effect pop, NOT a stack-advance failure.
		expect(() =>
			assertActionEffect(
				'chromium',
				undo,
				withUndo({ undo: 1, redo: 0 }),
				withUndo({ undo: 0, redo: 0 })
			)
		).toThrow(/history-produced-no-effect/);
		// Truly ignored: both depths untouched → the command never ran.
		expect(() =>
			assertActionEffect(
				'chromium',
				undo,
				withUndo({ undo: 1, redo: 0 }),
				withUndo({ undo: 1, redo: 0 })
			)
		).toThrow(/history-stack-did-not-advance/);
		// Effective pop: consumed one, pushed to redo, doc changed.
		expect(() =>
			assertActionEffect(
				'chromium',
				undo,
				withUndo({ undo: 2, redo: 0 }),
				withUndo({ undo: 1, redo: 1 }, 'hell')
			)
		).not.toThrow();
	});

	test('pointer escapes tolerate a sticky caret only when the model kept it', () => {
		const shiftClick: DstAction = {
			kind: 'shiftClick',
			target: 'blockText',
			index: 0,
			edge: 'right'
		};
		const outsideNative = (snap: DstBrowserSnapshot): DstBrowserSnapshot => ({
			...snap,
			nativeSelection: {
				anchor: { kind: 'outside' },
				focus: { kind: 'outside' },
				start: { kind: 'outside' },
				end: { kind: 'outside' },
				isCollapsed: true,
				isReversed: false,
				selectedNode: null,
				debug: { anchor: 'outside', focus: 'outside' }
			}
		});
		const caret = twoBlockSnapshot({ yStart: 1, yEnd: 1 });
		const after = outsideNative(caret);
		// Pointer action + fully-outside native + unchanged model → legal.
		expect(isStickyOutsideEscape(shiftClick, caret, after)).toBe(true);
		expect(() =>
			assertBrowserSnapshot('webkit', after, {
				requireSelection: true,
				allowOutsideNative: isStickyOutsideEscape(shiftClick, caret, after)
			})
		).not.toThrow();
		// Same escape under a keyboard action → still a parity failure.
		const backspace: DstAction = { kind: 'backspace' };
		expect(isStickyOutsideEscape(backspace, caret, after)).toBe(false);
		expect(() => assertBrowserSnapshot('webkit', after, { requireSelection: true })).toThrow(
			/selection-model-dom-mismatch/
		);
		// Model moved while native escaped → not a sticky caret → fails.
		const moved = twoBlockSnapshot({ yStart: 2, yEnd: 2 });
		expect(isStickyOutsideEscape(shiftClick, caret, outsideNative(moved))).toBe(false);
		// Half-outside range → fails even under a pointer action.
		const half = { ...after, nativeSelection: { ...after.nativeSelection! } };
		half.nativeSelection.end = { kind: 'text', textIndex: 0, offset: 1 };
		expect(isStickyOutsideEscape(shiftClick, caret, half)).toBe(false);
	});

	test('delete oracle asserts the exact post-state, not just some change', () => {
		const backspace: DstAction = { kind: 'backspace' };
		// Caret at 'hel|lo' — grapheme delete removes 'e'.
		const caret = twoBlockSnapshot({ yStart: 2, yEnd: 2 });
		const unchanged = twoBlockSnapshot({ yStart: 2, yEnd: 2 });
		expect(() => assertActionEffect('chromium', backspace, caret, unchanged)).toThrow(
			/action-produced-no-effect/
		);
		const wrongChar = twoBlockSnapshot({ yStart: 1, yEnd: 1 });
		wrongChar.value.children[0].content = [{ text: 'ello' }]; // deleted 'h' instead
		expect(() => assertActionEffect('chromium', backspace, caret, wrongChar)).toThrow(
			/delete-result-mismatch/
		);
		const right = twoBlockSnapshot({ yStart: 1, yEnd: 1 });
		right.value.children[0].content = [{ text: 'hllo' }];
		expect(() => assertActionEffect('chromium', backspace, caret, right)).not.toThrow();
	});

	test('delete oracle asserts exact forward-delete and range splices', () => {
		const forward: DstAction = { kind: 'delete' };
		const caret = twoBlockSnapshot({ yStart: 2, yEnd: 2 });
		const wrong = twoBlockSnapshot({ yStart: 2, yEnd: 2 });
		wrong.value.children[0].content = [{ text: 'helo' }];
		expect(() => assertActionEffect('chromium', forward, caret, wrong)).not.toThrow();
		wrong.value.children[0].content = [{ text: 'heo' }]; // deleted two chars
		expect(() => assertActionEffect('chromium', forward, caret, wrong)).toThrow(
			/delete-result-mismatch/
		);
		// Range delete 'ell' from 'hello' → 'ho'.
		const range = twoBlockSnapshot({ yStart: 1, yEnd: 4, isCollapsed: false });
		const rangeAfter = twoBlockSnapshot({ yStart: 1, yEnd: 1 });
		rangeAfter.value.children[0].content = [{ text: 'ho' }];
		expect(() => assertActionEffect('chromium', forward, range, rangeAfter)).not.toThrow();
		rangeAfter.value.children[0].content = [{ text: 'hlo' }];
		expect(() => assertActionEffect('chromium', forward, range, rangeAfter)).toThrow(
			/delete-result-mismatch/
		);
	});

	test('delete oracle asserts the cross-block merge result', () => {
		const backspace: DstAction = { kind: 'backspace' };
		// Caret at the very start of 'world' — backspace merges b1 into b0.
		const caret = twoBlockSnapshot({ startTextIndex: 1, endTextIndex: 1, yStart: 0, yEnd: 0 });
		const merged = twoBlockSnapshot({ yStart: 5, yEnd: 5 });
		merged.value.children = [{ type: 'paragraph', id: 'b0', content: [{ text: 'helloworld' }] }];
		expect(() => assertActionEffect('chromium', backspace, caret, merged)).not.toThrow();
		// Merge kept the doomed block alive — wrong.
		const leaked = twoBlockSnapshot({ startTextIndex: 1, endTextIndex: 1, yStart: 0, yEnd: 0 });
		leaked.value.children = [
			{ type: 'paragraph', id: 'b0', content: [{ text: 'helloworld' }] },
			{ type: 'paragraph', id: 'b1', content: [] }
		];
		expect(() => assertActionEffect('chromium', backspace, caret, leaked)).toThrow(
			/delete-result-mismatch/
		);
		// Merged into the wrong text — wrong.
		const corrupted = twoBlockSnapshot({ yStart: 5, yEnd: 5 });
		corrupted.value.children = [{ type: 'paragraph', id: 'b0', content: [{ text: 'helloorld' }] }];
		expect(() => assertActionEffect('chromium', backspace, caret, corrupted)).toThrow(
			/delete-result-mismatch/
		);
	});

	test('a whole-document range delete keeps the head, emptied (del.range.whole-doc)', () => {
		const all = twoBlockSnapshot({
			startTextIndex: 0,
			endTextIndex: 1,
			yStart: 0,
			yEnd: 5,
			isCollapsed: false
		});
		for (const action of [{ kind: 'backspace' }, { kind: 'delete' }] as DstAction[]) {
			const kept = twoBlockSnapshot({ yStart: 0, yEnd: 0 });
			kept.value.children = [{ type: 'paragraph', id: 'b0', content: [] }];
			expect(() => assertActionEffect('chromium', action, all, kept)).not.toThrow();
			// A written survivor (the answer before 2026-09-28) duplicates across peers: wrong.
			const written = twoBlockSnapshot({ yStart: 0, yEnd: 0 });
			written.value.children = [{ type: 'paragraph', id: 'b_fresh', content: [] }];
			expect(() => assertActionEffect('chromium', action, all, written)).toThrow(
				/delete-result-mismatch/
			);
			// The tail kept instead of the head: wrong.
			const tail = twoBlockSnapshot({ yStart: 0, yEnd: 0 });
			tail.value.children = [{ type: 'paragraph', id: 'b1', content: [] }];
			expect(() => assertActionEffect('chromium', action, all, tail)).toThrow(
				/delete-result-mismatch/
			);
		}
	});

	test('delete oracle asserts inline-atom boundary deletes', () => {
		// 'a' | [mention] | 'b' — caret at the start of 'b' (the part after
		// the inline) → backspace removes the atom, 'ab' remains.
		const inlineSnapshot = (children: unknown[]): DstBrowserSnapshot => {
			const base = twoBlockSnapshot({ startTextIndex: 1, endTextIndex: 1, yStart: 0, yEnd: 0 });
			base.value.children = [
				{
					type: 'paragraph',
					id: 'b0',
					content: [{ text: 'a' }, { type: 'mention', id: 'm1' }, { text: 'b' }]
				}
			];
			base.model.blocks = [
				{
					id: 'b0',
					type: 'paragraph',
					data: {},
					contentKinds: ['text', 'inline', 'text'],
					parts: [
						{ kind: 'text', id: 't0', runs: [{ text: 'a', marks: null }] },
						{ kind: 'inline', id: 'm1', type: 'mention', data: {} },
						{ kind: 'text', id: 't1', runs: [{ text: 'b', marks: null }] }
					],
					path: [0],
					void: false,
					island: false,
					renderedTextCount: 2
				}
			];
			base.model.texts = ['a', 'b'];
			base.model.textIds = ['t0', 't1'];
			base.model.renderedTexts = ['a', 'b'];
			base.model.renderedTextIds = ['t0', 't1'];
			base.model.inlineIds = ['m1'];
			if (children) base.value.children = children as never;
			return base;
		};
		const backspace: DstAction = { kind: 'backspace' };
		const before = inlineSnapshot([]);
		const removed = inlineSnapshot([{ type: 'paragraph', id: 'b0', content: [{ text: 'ab' }] }]);
		expect(() => assertActionEffect('chromium', backspace, before, removed)).not.toThrow();
		// Atom survived — wrong.
		const kept = inlineSnapshot([
			{ type: 'paragraph', id: 'b0', content: [{ text: 'a' }, { type: 'mention', id: 'm1' }] }
		]);
		expect(() => assertActionEffect('chromium', backspace, before, kept)).toThrow(
			/delete-result-mismatch|action-produced-no-effect/
		);
	});

	test('wordDelete forward asserts the word boundary', () => {
		const wordForward: DstAction = { kind: 'wordDelete', direction: 'forward' };
		const caret = twoBlockSnapshot({ yStart: 0, yEnd: 0 });
		// 'hello world' — forward word delete removes 'hello'.
		caret.value.children[0].content = [{ text: 'hello world' }];
		caret.model.blocks[0].parts = [
			{ kind: 'text', id: 't0', runs: [{ text: 'hello world', marks: null }] }
		];
		caret.model.texts = ['hello world'];
		caret.model.renderedTexts = ['hello world'];
		const deleted = twoBlockSnapshot({ yStart: 0, yEnd: 0 });
		deleted.value.children[0].content = [{ text: ' world' }];
		expect(() => assertActionEffect('chromium', wordForward, caret, deleted)).not.toThrow();
		// Ate the whole text — wrong.
		const over = twoBlockSnapshot({ yStart: 0, yEnd: 0 });
		over.value.children[0].content = [{ text: '' }];
		expect(() => assertActionEffect('chromium', wordForward, caret, over)).toThrow(
			/delete-result-mismatch/
		);
	});

	test('a delivered word-delete targetRange collapses to the caret edge, bounded by plausibility', () => {
		const wordBackward: DstAction = { kind: 'wordDelete', direction: 'backward' };
		const alphaBravo = (): DstBrowserSnapshot => {
			const snap = twoBlockSnapshot({ yStart: 11, yEnd: 11 });
			snap.value.children[0].content = [{ text: 'alpha bravo' }];
			snap.model.blocks[0].parts = [
				{ kind: 'text', id: 't0', runs: [{ text: 'alpha bravo', marks: null }] }
			];
			snap.model.texts = ['alpha bravo'];
			snap.model.renderedTexts = ['alpha bravo'];
			return snap;
		};
		const rangeEvent = (s: number, e: number): DstEvent[] => [
			{
				type: 'beforeinput',
				isTrusted: true,
				cancelable: true,
				inputType: 'deleteWordBackward',
				targetRange: {
					collapsed: false,
					startOffset: s,
					endOffset: e,
					startTextIndex: 0,
					endTextIndex: 0,
					yStart: s,
					yEnd: e
				}
			}
		];
		// Production collapses the delivered range to its caret edge and
		// the model's word-boundary command owns the extent — here the
		// contract boundary equals the delivered span, so 'bravo' goes.
		const caret = alphaBravo();
		const deleted = alphaBravo();
		deleted.value.children[0].content = [{ text: 'alpha ' }];
		deleted.events = rangeEvent(6, 11);
		expect(() => assertActionEffect('chromium', wordBackward, caret, deleted)).not.toThrow();
		// Oversized: '[alpha bravo]' covers TWO contract word-runs — that
		// is a delivered defect, not a word unit.
		const oversized = alphaBravo();
		oversized.events = rangeEvent(0, 11);
		expect(() => assertActionEffect('chromium', wordBackward, alphaBravo(), oversized)).toThrow(
			/delete-range-implausible/
		);
		// Unanchored: a word delete's unit must touch the caret.
		const unanchored = alphaBravo();
		unanchored.events = rangeEvent(0, 5);
		expect(() => assertActionEffect('chromium', wordBackward, alphaBravo(), unanchored)).toThrow(
			/delete-range-implausible/
		);
		// A collapsed delivered range leaves the contract boundary in charge.
		const contractDeleted = alphaBravo();
		contractDeleted.value.children[0].content = [{ text: 'alpha ' }];
		contractDeleted.events = [
			{
				type: 'beforeinput',
				isTrusted: true,
				cancelable: true,
				inputType: 'deleteWordBackward',
				targetRange: {
					collapsed: true,
					startOffset: 11,
					endOffset: 11,
					startTextIndex: 0,
					endTextIndex: 0,
					yStart: 11,
					yEnd: 11
				}
			}
		];
		expect(() =>
			assertActionEffect('chromium', wordBackward, alphaBravo(), contractDeleted)
		).not.toThrow();
		// Phantom span: WebKit delivers the ZWSP placeholder of an EMPTY
		// text part as a forward word unit — [0,1) has no model chars, so
		// strict unit matching cannot apply; plausibility accepts and the
		// collapsed word-forward command finds nothing of its own text
		// ahead: the unit is the neighbour (`del.unit.neighbour`) — the
		// next block merges in, and a no-op is a missed delete.
		const empty = twoBlockSnapshot({ yStart: 0, yEnd: 0 });
		empty.value.children[0].content = [{ text: '' }];
		empty.model.blocks[0].parts = [{ kind: 'text', id: 't0', runs: [] }];
		empty.model.texts = [''];
		empty.model.renderedTexts = [''];
		const phantom = twoBlockSnapshot({ yStart: 0, yEnd: 0 });
		phantom.value.children[0].content = [{ text: '' }];
		phantom.model.blocks[0].parts = [{ kind: 'text', id: 't0', runs: [] }];
		phantom.model.texts = [''];
		phantom.model.renderedTexts = [''];
		phantom.events = [
			{
				type: 'beforeinput',
				isTrusted: true,
				cancelable: true,
				inputType: 'deleteWordForward',
				targetRange: {
					collapsed: false,
					startOffset: 0,
					endOffset: 1,
					startTextIndex: 0,
					endTextIndex: 0,
					yStart: 0,
					yEnd: 1
				}
			}
		];
		const wordForward: DstAction = { kind: 'wordDelete', direction: 'forward' };
		expect(() => assertActionEffect('webkit', wordForward, empty, phantom)).toThrow(
			/action-produced-no-effect/
		);
		const merged = structuredClone(phantom);
		merged.value.children = [{ type: 'paragraph', id: 'b0', content: [{ text: 'world' }] }];
		expect(() => assertActionEffect('webkit', wordForward, empty, merged)).not.toThrow();
	});

	test('a word delete may not truncate a run or span two blocks — ASCII gets independent expectations', () => {
		const wordBackward: DstAction = { kind: 'wordDelete', direction: 'backward' };
		const alphaBravo = (): DstBrowserSnapshot => {
			const snap = twoBlockSnapshot({ yStart: 11, yEnd: 11 });
			snap.value.children[0].content = [{ text: 'alpha bravo' }];
			snap.model.blocks[0].parts = [
				{ kind: 'text', id: 't0', runs: [{ text: 'alpha bravo', marks: null }] }
			];
			snap.model.texts = ['alpha bravo'];
			snap.model.renderedTexts = ['alpha bravo'];
			return snap;
		};
		const rangeEvent = (
			inputType: string,
			s: number,
			e: number,
			startTextIndex = 0,
			endTextIndex = 0
		): DstEvent[] => [
			{
				type: 'beforeinput',
				isTrusted: true,
				cancelable: true,
				inputType,
				targetRange: {
					collapsed: false,
					startOffset: s,
					endOffset: e,
					startTextIndex,
					endTextIndex,
					yStart: s,
					yEnd: e
				}
			}
		];
		// Truncated run: 'alpha brav' — deleting 'o' splits 'bravo'. On
		// ASCII text the only legal backward unit is the contract span
		// [6,11); a one-char span is no word unit.
		const truncated = alphaBravo();
		truncated.value.children[0].content = [{ text: 'alpha brav' }];
		truncated.events = rangeEvent('deleteWordBackward', 10, 11);
		expect(() => assertActionEffect('chromium', wordBackward, alphaBravo(), truncated)).toThrow(
			/delete-range-implausible/
		);
		// Two whole paragraphs as one "word" — 'hello' and 'world' are two
		// runs across a block boundary, never one unit.
		const twoBlockCaret = twoBlockSnapshot({
			startTextIndex: 1,
			endTextIndex: 1,
			yStart: 5,
			yEnd: 5
		});
		const crossBlock = twoBlockSnapshot({ startTextIndex: 0, endTextIndex: 0, yStart: 0, yEnd: 0 });
		crossBlock.value.children = [
			{ type: 'paragraph', id: 'b0', content: [{ text: 'hello' }] },
			{ type: 'paragraph', id: 'b1', content: [{ text: 'world' }] }
		];
		crossBlock.events = rangeEvent('deleteWordBackward', 0, 5, 0, 1);
		expect(() => assertActionEffect('chromium', wordBackward, twoBlockCaret, crossBlock)).toThrow(
			/delete-range-implausible/
		);
		// Boundary-run allowance: caret after 'bravo ' — a platform may
		// deliver just the trailing space [11,12] or the full contract unit
		// [6,12]; both deliveries are legal, but the delete extent is
		// contract-owned — production collapses to the caret edge and runs
		// `deleteCollapsedWordBackward`, so 'bravo ' goes either way.
		const trailingSpace = (): DstBrowserSnapshot => {
			const snap = twoBlockSnapshot({ yStart: 12, yEnd: 12 });
			snap.value.children[0].content = [{ text: 'alpha bravo ' }];
			snap.model.blocks[0].parts = [
				{ kind: 'text', id: 't0', runs: [{ text: 'alpha bravo ', marks: null }] }
			];
			snap.model.texts = ['alpha bravo '];
			snap.model.renderedTexts = ['alpha bravo '];
			return snap;
		};
		const spaceOnly = trailingSpace();
		spaceOnly.value.children[0].content = [{ text: 'alpha ' }];
		spaceOnly.events = rangeEvent('deleteWordBackward', 11, 12);
		expect(() =>
			assertActionEffect('chromium', wordBackward, trailingSpace(), spaceOnly)
		).not.toThrow();
		const contractUnit = trailingSpace();
		contractUnit.value.children[0].content = [{ text: 'alpha ' }];
		contractUnit.events = rangeEvent('deleteWordBackward', 6, 12);
		expect(() =>
			assertActionEffect('chromium', wordBackward, trailingSpace(), contractUnit)
		).not.toThrow();
	});

	test('out-of-model spans are rejected — the phantom allowance is exactly the empty-part ZWSP case', () => {
		const wordForward: DstAction = { kind: 'wordDelete', direction: 'forward' };
		const hello = (): DstBrowserSnapshot => {
			const snap = twoBlockSnapshot({ yStart: 0, yEnd: 0 });
			snap.value.children[0].content = [{ text: 'hello' }];
			snap.model.blocks[0].parts = [
				{ kind: 'text', id: 't0', runs: [{ text: 'hello', marks: null }] }
			];
			snap.model.texts = ['hello'];
			snap.model.renderedTexts = ['hello'];
			return snap;
		};
		// [0,999) reaches 994 chars past the part — not a phantom ZWSP,
		// just an out-of-model span. The phantom exception must NOT cover
		// it (an oversized-delivered-range probe passed before).
		const oversized = hello();
		oversized.value.children[0].content = [];
		oversized.events = [
			{
				type: 'beforeinput',
				isTrusted: true,
				cancelable: true,
				inputType: 'deleteWordForward',
				targetRange: {
					collapsed: false,
					startOffset: 0,
					endOffset: 999,
					startTextIndex: 0,
					endTextIndex: 0,
					yStart: 0,
					yEnd: 999
				}
			}
		];
		expect(() => assertActionEffect('webkit', wordForward, hello(), oversized)).toThrow(
			/delete-range-implausible/
		);
	});

	test('a word unit ending inside the next empty block’s filler is judged filler-free (seed 39, WebKit)', () => {
		const wordForward: DstAction = { kind: 'wordDelete', direction: 'forward' };
		/** Caret in an empty first block; the second holds `second` (empty: its filler only). */
		const emptyThen = (second: string): DstBrowserSnapshot => {
			const snap = twoBlockSnapshot({ yStart: 0, yEnd: 0 });
			snap.value.children[0].content = [];
			snap.model.blocks[0].parts = [{ kind: 'text', id: 't0', runs: [] }];
			snap.value.children[1].content = second ? [{ text: second }] : [];
			snap.model.blocks[1].parts = [
				{ kind: 'text', id: 't1', runs: second ? [{ text: second, marks: null }] : [] }
			];
			snap.model.texts = ['', second];
			snap.model.renderedTexts = ['', second];
			return snap;
		};
		const delivered = (endOffset: number, yEnd: number): DstEvent[] => [
			{
				type: 'beforeinput',
				isTrusted: true,
				cancelable: true,
				inputType: 'deleteWordForward',
				targetRange: {
					collapsed: false,
					startOffset: 0,
					endOffset,
					startTextIndex: 0,
					endTextIndex: 1,
					yStart: 0,
					yEnd
				}
			}
		];
		// WebKit's delivery: [0@0, 1@1) — the end of the empty next block's
		// ZWSP. Filler-free it is [0@0, 0@1): no model character. The unit
		// is the neighbour (`del.unit.neighbour`): the next block merges in.
		const merged = emptyThen('');
		merged.value.children = [{ type: 'paragraph', id: 'b0', content: [] }];
		merged.events = delivered(1, 1);
		expect(() => assertActionEffect('webkit', wordForward, emptyThen(''), merged)).not.toThrow();
		// Sensitivity: two units past an empty part is no filler — out of model.
		const past = structuredClone(merged);
		past.events = delivered(2, 2);
		expect(() => assertActionEffect('webkit', wordForward, emptyThen(''), past)).toThrow(
			/delete-range-implausible/
		);
		// Sensitivity: offset 1 of a NON-empty part is a model character, not a
		// filler — ending there truncates the word `world`.
		const truncated = emptyThen('world');
		truncated.value.children = [{ type: 'paragraph', id: 'b0', content: [{ text: 'world' }] }];
		truncated.events = delivered(1, 1);
		expect(() => assertActionEffect('webkit', wordForward, emptyThen('world'), truncated)).toThrow(
			/delete-range-implausible/
		);
	});

	test('a run never crosses a block boundary OR an inline atom — both directions of the bound', () => {
		const wordBackward: DstAction = { kind: 'wordDelete', direction: 'backward' };
		const rangeEvent = (
			inputType: string,
			s: number,
			e: number,
			startTextIndex = 0,
			endTextIndex = 0
		): DstEvent[] => [
			{
				type: 'beforeinput',
				isTrusted: true,
				cancelable: true,
				inputType,
				targetRange: {
					collapsed: false,
					startOffset: s,
					endOffset: e,
					startTextIndex,
					endTextIndex,
					yStart: s,
					yEnd: e
				}
			}
		];
		// 'café' deleted WHOLESALE from b1 after a paragraph ending in a
		// letter: the truncation lookback must not cross the block
		// boundary — 'o' before the range start lives in b0, not in the
		// deleted run. Non-ASCII content takes the plausibility path.
		const cafeCaret = twoBlockSnapshot({
			startTextIndex: 1,
			endTextIndex: 1,
			yStart: 4,
			yEnd: 4
		});
		cafeCaret.value.children[0].content = [{ text: 'cello' }];
		cafeCaret.model.blocks[0].parts = [
			{ kind: 'text', id: 't0', runs: [{ text: 'cello', marks: null }] }
		];
		cafeCaret.model.texts = ['cello', 'world'];
		cafeCaret.model.renderedTexts = ['cello', 'world'];
		cafeCaret.value.children[1].content = [{ text: 'café' }];
		cafeCaret.model.blocks[1].parts = [
			{ kind: 'text', id: 't1', runs: [{ text: 'café', marks: null }] }
		];
		const cafeDeleted = twoBlockSnapshot({
			startTextIndex: 1,
			endTextIndex: 1,
			yStart: 0,
			yEnd: 0
		});
		cafeDeleted.value.children = [
			{ type: 'paragraph', id: 'b0', content: [{ text: 'cello' }] },
			{ type: 'paragraph', id: 'b1', content: [{ text: '' }] }
		];
		cafeDeleted.model.blocks[1].parts = [{ kind: 'text', id: 't1', runs: [] }];
		cafeDeleted.model.texts = ['cello', ''];
		cafeDeleted.model.renderedTexts = ['cello', ''];
		cafeDeleted.events = rangeEvent('deleteWordBackward', 0, 4, 1, 1);
		expect(() => assertActionEffect('webkit', wordBackward, cafeCaret, cafeDeleted)).not.toThrow();
		// 'hello' + INLINE ATOM + 'world' can never be one word — the atom
		// is a structural run boundary even inside a single block.
		const atomBlock = (): DstBrowserSnapshot => {
			const snap = twoBlockSnapshot({ startTextIndex: 1, endTextIndex: 1, yStart: 5, yEnd: 5 });
			snap.value.children[0].content = [
				{ text: 'hello' },
				{ type: 'mention', id: 'm1', data: {} },
				{ text: 'world' }
			];
			snap.model.blocks[0].parts = [
				{ kind: 'text', id: 't0', runs: [{ text: 'hello', marks: null }] },
				{ kind: 'inline', id: 'm1', type: 'mention', data: {} },
				{ kind: 'text', id: 't1', runs: [{ text: 'world', marks: null }] }
			];
			snap.model.renderedTexts = ['hello', 'world'];
			snap.model.renderedTextIds = ['t0', 't1'];
			snap.model.texts = ['hello', 'world'];
			snap.model.textIds = ['t0', 't1'];
			snap.model.blocks[0].renderedTextCount = 2;
			snap.model.inlineIds = ['m1'];
			return snap;
		};
		const wiped = atomBlock();
		wiped.value.children[0].content = [{ text: '' }];
		wiped.model.blocks[0].parts = [{ kind: 'text', id: 't0', runs: [] }];
		wiped.events = rangeEvent('deleteWordBackward', 0, 5, 0, 1);
		expect(() => assertActionEffect('chromium', wordBackward, atomBlock(), wiped)).toThrow(
			/delete-range-implausible/
		);
	});

	test('a non-collapsed selection accepts deleteContent* from a word/line chord', () => {
		const wordBackward: DstAction = { kind: 'wordDelete', direction: 'backward' };
		const range = twoBlockSnapshot({ yStart: 0, yEnd: 4, isCollapsed: false });
		const after: DstBrowserSnapshot = twoBlockSnapshot({
			yStart: 0,
			yEnd: 0,
			isCollapsed: true
		});
		after.events = [
			{ type: 'keydown', isTrusted: true, cancelable: true, key: 'Backspace' },
			{ type: 'beforeinput', isTrusted: true, cancelable: true, inputType: 'deleteContentBackward' }
		];
		// With a live selection the delete unit IS the selection — the
		// browser correctly reports deleteContent*, not the word family.
		expect(() => assertDeleteIntent('chromium', wordBackward, range, after)).not.toThrow();
	});

	test('requires tab to nest only when a previous sibling admits it', () => {
		const tab: DstAction = { kind: 'tab' };
		// Caret in the second top-level block — the first is a plain paragraph
		// sibling, so nesting is provable.
		const nestable = twoBlockSnapshot({ startTextIndex: 1, endTextIndex: 1, yStart: 1, yEnd: 1 });
		expect(() => assertActionEffect('chromium', tab, nestable, nestable)).toThrow(
			/action-produced-no-effect/
		);
		// Caret in the first block — no previous sibling, so tab may no-op.
		const first = twoBlockSnapshot({ startTextIndex: 0, endTextIndex: 0, yStart: 1, yEnd: 1 });
		expect(() => assertActionEffect('chromium', tab, first, first)).not.toThrow();
	});

	test('composition commits must land on editable selections', () => {
		const composition: DstAction = {
			kind: 'composition',
			updates: ['e'],
			commit: 'é',
			commitViaBeforeinput: false
		};
		const caret = twoBlockSnapshot({ yStart: 2, yEnd: 2 });
		expect(() => assertActionEffect('firefox', composition, caret, caret)).toThrow(
			/action-produced-no-effect/
		);
		const changed = twoBlockSnapshot({ yStart: 2, yEnd: 2 });
		changed.value.children[0].content![0] = { text: 'heéllo' };
		expect(() => assertActionEffect('firefox', composition, caret, changed)).not.toThrow();
	});

	test('keeps copy and drop non-mutating; cut must remove a range', () => {
		const range = twoBlockSnapshot({ yStart: 0, yEnd: 4, isCollapsed: false });
		const copy: DstAction = { kind: 'copy' };
		expect(() => assertSemanticPreservation('chromium', copy, range, range)).not.toThrow();
		const mutated = twoBlockSnapshot({ yStart: 0, yEnd: 4, isCollapsed: false });
		mutated.value.children[0].content![0] = { text: 'mutated' };
		expect(() => assertSemanticPreservation('chromium', copy, range, mutated)).toThrow(
			/non-text-action-mutated-structure/
		);
		expect(() => assertActionEffect('chromium', { kind: 'cut' }, range, range)).toThrow(
			/action-produced-no-effect/
		);
		// A collapsed caret has nothing to cut — legal no-op.
		const caret = twoBlockSnapshot({ yStart: 1, yEnd: 1 });
		expect(() => assertActionEffect('chromium', { kind: 'cut' }, caret, caret)).not.toThrow();
	});
});

test.describe('DST v4 foreign-mutation oracle', () => {
	test('non-adopting foreign mutations must preserve the model', () => {
		const before = twoBlockSnapshot({ yStart: 1, yEnd: 1 });
		const healed = twoBlockSnapshot({ yStart: 1, yEnd: 1 });
		for (const mutation of [
			{ kind: 'foreignAttribute', target: 'text', index: 0, attribute: 0 },
			{ kind: 'foreignAttribute', target: 'root', index: 0, attribute: 1 },
			{ kind: 'managedAttribute', target: 'block', index: 0, attribute: 2 },
			{ kind: 'typeOver', index: 0, data: null },
			{ kind: 'removeElement', target: 'text', index: 0 },
			{ kind: 'removeElement', target: 'mark', index: 0 },
			{ kind: 'insertForeignElement', where: 'block', index: 0, text: 'x' },
			{ kind: 'insertForeignElement', where: 'root', index: 0, text: 'x' }
		] satisfies DstForeignMutation[]) {
			const action: DstAction = { kind: 'foreignMutation', mutation };
			expect(() => assertActionEffect('chromium', action, before, healed)).not.toThrow();
			expect(() => assertSemanticPreservation('chromium', action, before, healed)).not.toThrow();

			// Semantic damage from a non-adopting payload means foreign DOM
			// corrupted the model — both oracles must reject it.
			const corrupted = twoBlockSnapshot({ yStart: 1, yEnd: 1 });
			corrupted.value.children[0].content![0] = { text: 'corrupted' };
			expect(() => assertActionEffect('chromium', action, before, corrupted)).toThrow(
				/foreign-mutation-mutated-model/
			);
			expect(() => assertSemanticPreservation('chromium', action, before, corrupted)).toThrow(
				/non-text-action-mutated-structure/
			);
		}
	});

	test('adoption-capable mutations may change the model but never keep the foreign element', () => {
		const before = twoBlockSnapshot({ yStart: 1, yEnd: 1 });
		const adopted = twoBlockSnapshot({ yStart: 1, yEnd: 1 });
		adopted.value.children[0].content![0] = { text: 'hellozz' };

		for (const mutation of [
			{ kind: 'insertForeignElement', where: 'text', index: 0, text: 'zz' },
			{ kind: 'typeOver', index: 0, data: 'zz' }
		] satisfies DstForeignMutation[]) {
			const action: DstAction = { kind: 'foreignMutation', mutation };
			// Adoption lands the foreign text in the model like browser-owned
			// input — allowed by both oracles. Not adopting (revert) is legal
			// too: the engines must simply agree, which the cross-engine
			// compare checks.
			expect(() => assertActionEffect('chromium', action, before, adopted)).not.toThrow();
			expect(() => assertSemanticPreservation('chromium', action, before, adopted)).not.toThrow();
			expect(() => assertActionEffect('chromium', action, before, before)).not.toThrow();
			expect(() => assertSemanticPreservation('chromium', action, before, before)).not.toThrow();
		}

		// An unsettled foreign element is a hard failure for every payload.
		const unsettled = twoBlockSnapshot({ yStart: 1, yEnd: 1 });
		unsettled.dom.foreignResidual.nodes = ['span@text:0'];
		const action: DstAction = {
			kind: 'foreignMutation',
			mutation: { kind: 'insertForeignElement', where: 'text', index: 0, text: 'zz' }
		};
		expect(() => assertActionEffect('chromium', action, before, unsettled)).toThrow(
			/foreign-element-survived/
		);
	});

	test('D-25: a foreign element in a block element’s own markup may stay; the model may not change', () => {
		const before = twoBlockSnapshot({ yStart: 1, yEnd: 1 });
		const kept = twoBlockSnapshot({ yStart: 1, yEnd: 1 });
		kept.dom.foreignResidual.nodes = ['span@block:0'];
		const action: DstAction = {
			kind: 'foreignMutation',
			mutation: { kind: 'insertForeignElement', where: 'block', index: 0, text: 'zz' }
		};
		expect(() => assertActionEffect('chromium', action, before, kept)).not.toThrow();
		const adopted = twoBlockSnapshot({ yStart: 1, yEnd: 1 });
		adopted.dom.foreignResidual.nodes = ['span@block:0'];
		adopted.value.children[0].content![0] = { text: 'hellozz' };
		expect(() => assertActionEffect('chromium', action, before, adopted)).toThrow(
			/foreign-mutation-mutated-model/
		);
	});
});

test.describe('passive selection oracle', () => {
	const ep = (over: Partial<PassiveEndpoint>): PassiveEndpoint => ({
		end: 'start',
		pre: { blockId: 'b0', textId: 't0', offset: 4 },
		anchorOk: true,
		resolvedAnchor: null,
		blockDied: false,
		textIdAlive: true,
		seam: null,
		rootFallback: null,
		...over
	});

	test('a remote insert into the endpoint text must move the caret — the pre position is not acceptable', () => {
		// 'abcd|ef' + remote 'XX' at 0: the caret's own text was edited,
		// so keeping offset 4 is a defect — only the anchor resolution (6)
		// is acceptable.
		const spots = acceptableEndpointSpots(
			ep({ resolvedAnchor: { blockId: 'b0', textId: 't0', offset: 6 } })
		);
		expect(spots).toEqual([{ blockId: 'b0', textId: 't0', offset: 6 }]);
		expect(spots.some((s) => s.offset === 4)).toBe(false);
	});

	test('atom identity, not string equality — a rewritten-identical text still moves the anchor', () => {
		// 'aa|aa' @2: remote delete of the first 'a' + append 'a' leaves
		// 'aaaa' — the string is identical but the anchor resolves to 1.
		// Only the resolved spot is acceptable; pre @2 is stale.
		const spots = acceptableEndpointSpots(
			ep({ resolvedAnchor: { blockId: 'b0', textId: 't0', offset: 1 } })
		);
		expect(spots).toEqual([{ blockId: 'b0', textId: 't0', offset: 1 }]);
		expect(spots.some((s) => s.offset === 2 && s !== spots[0])).toBe(false);
		// Dead anchor + surviving text → the live wrapper keeps the
		// absolute position (production's early return). Dead anchor +
		// dead text → the seam/root fallback owns the landing.
		expect(acceptableEndpointSpots(ep({}))).toEqual([{ blockId: 'b0', textId: 't0', offset: 4 }]);
		expect(
			acceptableEndpointSpots(ep({ textIdAlive: false, seam: null, rootFallback: null }))
		).toEqual([]);
	});

	test('dead endpoint offers the seam only when the anchor is dead — a resolved anchor stands alone', () => {
		const seam = { blockId: 'b1', textId: 't9', offset: 0 };
		const resolved = { blockId: 'b2', textId: 't8', offset: 3 };
		// Anchor dead: seam is the contract landing.
		expect(acceptableEndpointSpots(ep({ blockDied: true, seam, textIdAlive: false }))).toEqual([
			seam
		]);
		// Anchor alive: ONLY its resolution is acceptable — a fallback
		// seam alongside a valid anchor must not be admitted.
		expect(
			acceptableEndpointSpots(ep({ blockDied: true, seam, resolvedAnchor: resolved }))
		).toEqual([resolved]);
		// Dead anchor + dead block + no seam → the root fallback owns it.
		const root = { blockId: 'b9', textId: 't99', offset: 0 };
		expect(
			acceptableEndpointSpots(
				ep({ blockDied: true, seam: null, textIdAlive: false, rootFallback: root })
			)
		).toEqual([root]);
	});

	test('structural invariants: vanished selection and collapsed→range are failures', () => {
		const textPre = { kind: 'text', isCollapsed: true };
		expect(passiveSelectionInvariantViolation({ pre: textPre, post: null })).toMatch(/vanished/);
		expect(passiveSelectionInvariantViolation({ pre: textPre, post: { kind: 'block' } })).toMatch(
			/vanished/
		);
		expect(
			passiveSelectionInvariantViolation({
				pre: textPre,
				post: { kind: 'text', isCollapsed: false }
			})
		).toMatch(/became a range/);
		expect(
			passiveSelectionInvariantViolation({
				pre: textPre,
				post: { kind: 'text', isCollapsed: true }
			})
		).toBeNull();
		// A pre-range staying a range is fine; no pre-selection → nothing to check.
		expect(
			passiveSelectionInvariantViolation({
				pre: { kind: 'text', isCollapsed: false },
				post: { kind: 'text', isCollapsed: false }
			})
		).toBeNull();
		expect(passiveSelectionInvariantViolation({ pre: null, post: null })).toBeNull();
	});

	test('joint range expectation — a dead start with a resolved end collapses to the survivor', () => {
		// The reported defect: B selects `alpha@1 → beta@3`; A removes
		// `alpha`. Production collapses to `beta@3` — the per-endpoint
		// oracle rejected it because the dead start independently
		// "expected" the `beta@0` seam. The joint shape must accept the
		// survivor collapse and NOT offer the seam.
		const alpha1: EndpointSpot = { blockId: 'alpha', textId: 'tA', offset: 1 };
		const beta3: EndpointSpot = { blockId: 'beta', textId: 'tB', offset: 3 };
		const seamBeta0: EndpointSpot = { blockId: 'beta', textId: 'tB', offset: 0 };
		const shapes = acceptableSelectionShapes({
			isCollapsed: false,
			preStart: alpha1,
			preEnd: beta3,
			resolvedStart: null, // alpha's atoms hard-deleted
			resolvedEnd: beta3,
			startDead: true,
			endDead: false,
			seam: seamBeta0,
			rootFallback: { blockId: 'root-b', textId: 'tR', offset: 0 }
		});
		expect(shapes).toEqual([{ start: beta3, end: beta3, isCollapsed: true }]);
	});

	test('joint range expectation — both anchors resolving keeps the range', () => {
		const s: EndpointSpot = { blockId: 'b0', textId: 't0', offset: 2 };
		const e: EndpointSpot = { blockId: 'b1', textId: 't1', offset: 5 };
		const shapes = acceptableSelectionShapes({
			isCollapsed: false,
			preStart: { blockId: 'b0', textId: 't0', offset: 0 },
			preEnd: { blockId: 'b1', textId: 't1', offset: 9 },
			resolvedStart: s,
			resolvedEnd: e,
			startDead: false,
			endDead: false,
			seam: null,
			rootFallback: null
		});
		expect(shapes).toEqual([{ start: s, end: e, isCollapsed: false }]);
		// Both anchors resolving to the SAME spot collapses — production's
		// setAtRange on equal endpoints writes a caret.
		const same = acceptableSelectionShapes({
			isCollapsed: false,
			preStart: s,
			preEnd: e,
			resolvedStart: s,
			resolvedEnd: s,
			startDead: false,
			endDead: false,
			seam: null,
			rootFallback: null
		});
		expect(same).toEqual([{ start: s, end: s, isCollapsed: true }]);
	});

	test('joint range expectation — dead anchors collapse to the start-block seam, else root', () => {
		const seam: EndpointSpot = { blockId: 'b2', textId: 't2', offset: 0 };
		const root: EndpointSpot = { blockId: 'b9', textId: 't9', offset: 0 };
		const base = {
			isCollapsed: false,
			preStart: { blockId: 'deadS', textId: 'tS', offset: 1 },
			preEnd: { blockId: 'deadE', textId: 'tE', offset: 3 },
			resolvedStart: null,
			resolvedEnd: null,
			startDead: true,
			endDead: true
		};
		expect(acceptableSelectionShapes({ ...base, seam, rootFallback: root })).toEqual([
			{ start: seam, end: seam, isCollapsed: true }
		]);
		expect(acceptableSelectionShapes({ ...base, seam: null, rootFallback: root })).toEqual([
			{ start: root, end: root, isCollapsed: true }
		]);
		// No landing anywhere → empty set = defect, never a silent pass.
		expect(acceptableSelectionShapes({ ...base, seam: null, rootFallback: null })).toEqual([]);
		// Nothing dead and no anchors → the pre shape stands untouched.
		expect(
			acceptableSelectionShapes({
				...base,
				startDead: false,
				endDead: false,
				preEnd: { blockId: 'b1', textId: 't1', offset: 3 },
				seam: null,
				rootFallback: null
			})
		).toEqual([
			{
				start: { blockId: 'deadS', textId: 'tS', offset: 1 },
				end: { blockId: 'b1', textId: 't1', offset: 3 },
				isCollapsed: false
			}
		]);
	});

	test('selectionMoved covers every endpoint field', () => {
		const pre = {
			startBlockId: 'b0',
			endBlockId: 'b0',
			startTextId: 't0',
			endTextId: 't0',
			yStart: 4,
			yEnd: 4
		};
		expect(selectionMoved(pre, { ...pre })).toBe(false);
		expect(selectionMoved(pre, { ...pre, yStart: 5 })).toBe(true);
		expect(selectionMoved(pre, { ...pre, startTextId: 't9' })).toBe(true);
		expect(selectionMoved(pre, { ...pre, endBlockId: 'b9' })).toBe(true);
	});
});

test.describe('collab sanity gate canaries', () => {
	// Synchronous-dump sanity (`assertDumpSelectionSane`) and the
	// passive-peer contract (`assertPassiveSelectionExact`) exercised
	// with synthetic dumps — each corruption must fail at ITS intended
	// gate with the diagnostic code, and the valid case must pass.
	const liveDump = (selection: DocumentDump['selection'], over: Partial<DocumentDump> = {}) =>
		({
			value: {
				children: [
					{
						type: 'paragraph',
						id: 'b0',
						content: [{ text: 'ab' }]
					},
					{
						type: 'list',
						id: 'b1',
						content: [{ text: '' }],
						children: [{ type: 'paragraph', id: 'c1', content: [{ text: 'cc' }] }]
					},
					{ type: 'paragraph', id: 'b2', content: [{ text: 'zz' }] }
				]
			},
			blocks: {},
			lineage: {},
			blockTexts: {
				b0: { firstId: 't0', firstOwner: 'b0', lastId: 't0', lastOwner: 'b0', lastLen: 2 },
				b1: { firstId: 'tc', firstOwner: 'c1', lastId: 'tc', lastOwner: 'c1', lastLen: 2 },
				c1: { firstId: 'tc', firstOwner: 'c1', lastId: 'tc', lastOwner: 'c1', lastLen: 2 },
				b2: { firstId: 't2', firstOwner: 'b2', lastId: 't2', lastOwner: 'b2', lastLen: 2 }
			},
			textContents: { t0: 'ab', tp: '', tc: 'cc', t2: 'zz' },
			textOwners: { t0: 'b0', tp: 'b1', tc: 'c1', t2: 'b2' },
			textClaims: { t0: 'b0', tp: 'b1', tc: 'c1', t2: 'b2' },
			textMounted: { t0: true, tp: false, tc: true, t2: true },
			actor: 'peer-1',
			selection,
			...over
		}) as DocumentDump;

	const caret = (over: Record<string, unknown> = {}) =>
		({
			kind: 'text',
			startBlockId: 'b0',
			endBlockId: 'b0',
			startTextId: 't0',
			endTextId: 't0',
			startAnchor: null,
			endAnchor: null,
			startAnchorOk: true,
			endAnchorOk: true,
			yStart: 1,
			yEnd: 1,
			startTextLen: 2,
			endTextLen: 2,
			isCollapsed: true,
			selectedBlockIds: [],
			...over
		}) as NonNullable<DocumentDump['selection']>;

	const codeOf = (fn: () => void): string => {
		try {
			fn();
		} catch (error) {
			if (error instanceof CollabRunError) return error.code;
			throw error;
		}
		return 'NO-THROW';
	};

	test('valid dump passes the sanity gate', () => {
		expect(() => assertDumpSelectionSane('peer-1', liveDump(caret()))).not.toThrow();
	});

	test('dead textId fails as remote-selection-dead-block', () => {
		const dump = liveDump(caret({ startTextId: 'gone', endTextId: 'gone' }));
		expect(codeOf(() => assertDumpSelectionSane('peer-1', dump))).toBe(
			'remote-selection-dead-block'
		);
	});

	test('stale reported length fails against the live inventory', () => {
		// Live text is 'ab' (2) but the endpoint claims length 6 @5 — the
		// wrapper's self-report must not bound the offset check.
		const dump = liveDump(caret({ startTextLen: 6, endTextLen: 6, yStart: 5, yEnd: 5 }));
		expect(codeOf(() => assertDumpSelectionSane('peer-1', dump))).toBe('dump-inventory-mismatch');
	});

	test('mismatched parent claim fails against containment', () => {
		// t0 sits in b0's content but claims parent b1 — inventory and
		// selection must not agree with the corrupted pointer.
		const dump = liveDump(caret(), { textClaims: { t0: 'b1', tp: 'b1', tc: 'c1', t2: 'b2' } });
		expect(codeOf(() => assertDumpSelectionSane('peer-1', dump))).toBe('dump-inventory-mismatch');
	});

	test('hidden phantom target fails as remote-selection-uneditable', () => {
		// Endpoint on the list container's own content part — live in the
		// inventory but never mounted (phantom slot).
		const dump = liveDump(
			caret({
				startBlockId: 'b1',
				endBlockId: 'b1',
				startTextId: 'tp',
				endTextId: 'tp',
				yStart: 0,
				yEnd: 0,
				startTextLen: 0,
				endTextLen: 0
			})
		);
		expect(codeOf(() => assertDumpSelectionSane('peer-1', dump))).toBe(
			'remote-selection-uneditable'
		);
	});

	test('inconsistent collapsed endpoints fail', () => {
		const dump = liveDump(caret({ yEnd: 2 }));
		expect(codeOf(() => assertDumpSelectionSane('peer-1', dump))).toBe(
			'remote-selection-out-of-bounds'
		);
	});

	// `assertPassiveSelectionExact` needs a PeerRuntime — the stub page
	// answers `captureUpdate`'s evaluate (string arg) with the scripted
	// provider-update count and `resolvePeerAnchor`'s evaluate (anchor
	// object arg) with the canned resolution.
	const stubPeer = (providerUpdates: number, resolution: unknown = null) =>
		({
			index: 1,
			actorId: 'peer-1',
			connected: true,
			sv: new Uint8Array(),
			ownClock: 0,
			page: {
				evaluate: async (_fn: unknown, arg: unknown) =>
					typeof arg === 'string'
						? { updateB64: '', svB64: '', ownClock: 0, providerUpdates }
						: resolution
			}
		}) as never;

	const codeOfAsync = async (fn: () => Promise<void>): Promise<string> => {
		try {
			await fn();
		} catch (error) {
			if (error instanceof CollabRunError) return error.code;
			throw error;
		}
		return 'NO-THROW';
	};

	test('lost selection after delivery fails as remote-selection-lost (release gate)', () => {
		const pre = liveDump(caret());
		const post = liveDump(null);
		// providerUpdates advanced — a frame delivered — and the selection
		// vanished. This is the held-release/canary class that previously
		// slipped through `selection: null` at the barrier.
		return codeOfAsync(() => assertPassiveSelectionExact('peer-1', stubPeer(6), pre, 5, post)).then(
			(code) => expect(code).toBe('remote-selection-lost')
		);
	});

	test('a valid one-survivor range collapse passes', async () => {
		// Range b0/t0@1 → b1-area t9@3 where the end's text died: the
		// surviving start endpoint's anchor resolves to b0/t0@1, so the
		// joint expectation includes collapse-to-survivor.
		const pre = liveDump(
			caret({
				isCollapsed: false,
				startTextId: 't0',
				endBlockId: 'b1',
				endTextId: 't9',
				yStart: 1,
				yEnd: 3,
				startAnchor: { b: 'tb', a: { i: { c: 1, k: 1 }, a: 0 } },
				endAnchor: { b: 'tb', a: { i: { c: 1, k: 2 }, a: -1 } }
			})
		);
		// Post: collapsed at the resolved survivor spot; t9 absent from
		// the inventory (dead).
		const post = liveDump(caret({ startTextId: 't0', endTextId: 't0', yStart: 1, yEnd: 1 }), {
			textContents: { t0: 'ab', tp: '', tc: 'cc', t2: 'zz' }
		});
		await assertPassiveSelectionExact(
			'peer-1',
			stubPeer(6, { blockId: 'b0', textId: 't0', offset: 1 }),
			pre,
			5,
			post
		);
	});

	test('a caret landing on the wrong LIVE block fails as remote-selection-misplaced', async () => {
		// The resolver still resolves (anchor machinery agrees the update
		// applied) but the caret sits somewhere no contract shape allows —
		// the "wrong-but-converged" class.
		const pre = liveDump(caret());
		const post = liveDump(
			caret({ startBlockId: 'b2', endBlockId: 'b2', startTextId: 't2', endTextId: 't2' })
		);
		await expect(
			codeOfAsync(() =>
				assertPassiveSelectionExact(
					'peer-1',
					stubPeer(6, { blockId: 'b0', textId: 't0', offset: 1 }),
					pre,
					5,
					post
				)
			)
		).resolves.toBe('remote-selection-misplaced');
	});

	test('no delivery ⇒ no movement: an unchanged selection passes, a moved one fails', async () => {
		const pre = liveDump(caret());
		await assertPassiveSelectionExact('peer-1', stubPeer(5), pre, 5, liveDump(caret()));
		// Same frame count but the caret moved one offset — impossible
		// without a remote apply, so it must fail.
		await expect(
			codeOfAsync(() =>
				assertPassiveSelectionExact(
					'peer-1',
					stubPeer(5),
					pre,
					5,
					liveDump(caret({ yStart: 2, yEnd: 2 }))
				)
			)
		).resolves.toBe('remote-selection-misplaced');
	});
});
