import { assertTruth } from '../truthCheck';
import {
	chromium,
	firefox,
	webkit,
	type Browser,
	type BrowserContext,
	type BrowserType,
	type Page
} from '@playwright/test';
import { createHash } from 'node:crypto';

import {
	setReverseSelectionByTextIndex,
	setSelectionByTextIndex,
	waitForEditorReady
} from '../editor-dom/helpers.js';
import {
	DstHarnessFailure,
	assertActionEffect,
	assertBrowserSnapshot,
	assertSemanticPreservation,
	assertTrustedAction,
	captureBrowserSnapshot,
	canonicalDocumentValue,
	domRepairSignature,
	installEventRecorder,
	isPersistedStickyEscape,
	isStickyOutsideEscape,
	selectionSignature,
	semanticSignature,
	settleEditor,
	type DstBrowserSnapshot,
	type DstEvent,
	type DstSelection
} from './browserState.js';
import { deliveredDeleteInputType, describeDelete, diffDeleteExpectation } from './deleteOracle.js';
import type {
	DstAction,
	DstForeignMutation,
	DstForeignMutationTarget,
	DstSchedule,
	DstSelectionSelector,
	DstStep
} from './generator.js';

export type DstEngineName = 'chromium' | 'firefox' | 'webkit';

export type EngineSession = {
	name: DstEngineName;
	browser: Browser;
	version: string;
};

export type ActivePage = {
	engine: EngineSession;
	context: BrowserContext;
	page: Page;
	pageErrors: string[];
	consoleErrors: string[];
};

export type ResolvedSelection =
	| {
			kind: 'text';
			startTextIndex: number;
			startOffset: number;
			endTextIndex: number;
			endOffset: number;
			reversed: boolean;
	  }
	| { kind: 'preserve' }
	| { kind: 'node'; target: 'inline' | 'block'; index: number; reversed: boolean }
	| { kind: 'block'; index: number; reversed: boolean }
	| { kind: 'root'; startBlockIndex: number; endBlockIndex: number; reversed: boolean }
	| { kind: 'document'; reversed: boolean };

export type DstHistorySummary = {
	stepIndex: number;
	action: DstAction;
	selection: ResolvedSelection;
	status: 'captured' | 'passed';
	before: Record<
		DstEngineName,
		{
			semantic: string;
			selection: string | null;
			undoDepth: number;
			redoDepth: number;
		}
	>;
	after: Record<
		DstEngineName,
		{
			semantic: string;
			selection: string | null;
			undoDepth: number;
			redoDepth: number;
			events: string[];
			domRepair?: string;
		}
	>;
};

export type DstRunFailure = {
	code: string;
	engine: string;
	message: string;
	details?: unknown;
	fingerprint: string;
	stepIndex: number;
	step: DstStep | null;
	resolvedSelection: ResolvedSelection | null;
	beforeSnapshots: Partial<Record<DstEngineName, DstBrowserSnapshot>>;
	snapshots: Partial<Record<DstEngineName, DstBrowserSnapshot>>;
	history: DstHistorySummary[];
};

export type DstRunResult =
	| {
			ok: true;
			finalSnapshots: Record<DstEngineName, DstBrowserSnapshot>;
	  }
	| {
			ok: false;
			failure: DstRunFailure;
	  };

const ENGINE_TYPES: Record<DstEngineName, BrowserType> = {
	chromium,
	firefox,
	webkit
};

const mod = (value: number, divisor: number): number =>
	divisor === 0 ? 0 : (value >>> 0) % divisor;

const comparePoint = (left: [number, number], right: [number, number]): number =>
	left[0] === right[0] ? left[1] - right[1] : left[0] - right[0];

const graphemeBoundaries = (value: string): number[] => {
	type Segment = { index: number; segment: string };
	type SegmenterApi = { segment(value: string): Iterable<Segment> };
	type SegmenterConstructor = new (
		locale?: string | string[],
		options?: { granularity: 'grapheme' }
	) => SegmenterApi;
	const SegmenterCtor = (Intl as typeof Intl & { Segmenter?: SegmenterConstructor }).Segmenter;
	if (SegmenterCtor) {
		return [
			0,
			...Array.from(
				new SegmenterCtor(undefined, { granularity: 'grapheme' }).segment(value),
				({ index, segment }) => index + segment.length
			)
		];
	}

	let offset = 0;
	return [
		0,
		...Array.from(value, (codePoint) => {
			offset += codePoint.length;
			return offset;
		})
	];
};

const resolveTextOffset = (entropy: number, value: string): number => {
	const boundaries = graphemeBoundaries(value);
	return boundaries[mod(entropy, boundaries.length)];
};

export const resolveSelection = (
	selector: DstSelectionSelector,
	snapshot: DstBrowserSnapshot
): ResolvedSelection => {
	if (selector.kind === 'preserve') return { kind: 'preserve' };
	if (selector.kind === 'node') {
		const target = snapshot.model.inlineIds.length > 0 ? 'inline' : 'block';
		const count =
			target === 'inline' ? snapshot.model.inlineIds.length : snapshot.model.blocks.length;
		if (count === 0) {
			throw new DstHarnessFailure('no-live-node', 'all', 'document has no selectable node');
		}
		return { kind: 'node', target, index: mod(selector.index, count), reversed: selector.reversed };
	}
	if (selector.kind === 'block') {
		if (snapshot.model.blocks.length === 0) {
			throw new DstHarnessFailure('no-live-block', 'all', 'document has no selectable block');
		}
		return {
			kind: 'block',
			index: mod(selector.index, snapshot.model.blocks.length),
			reversed: selector.reversed
		};
	}
	if (selector.kind === 'root') {
		if (snapshot.model.blocks.length === 0) {
			throw new DstHarnessFailure('no-live-block', 'all', 'document has no selectable root range');
		}
		const first = mod(selector.startBlock, snapshot.model.blocks.length);
		const second = mod(selector.endBlock, snapshot.model.blocks.length);
		return {
			kind: 'root',
			startBlockIndex: Math.min(first, second),
			endBlockIndex: Math.max(first, second),
			reversed: selector.reversed && first !== second
		};
	}
	if (selector.kind === 'document') {
		return { kind: 'document', reversed: selector.reversed };
	}

	const segments = snapshot.model.renderedTexts;
	if (segments.length === 0) {
		throw new DstHarnessFailure('no-live-text', 'all', 'document has no selectable text segment');
	}

	const startIndex = mod(selector.startText, segments.length);
	if (selector.mode === 'collapsed') {
		const offset = resolveTextOffset(selector.startOffset, segments[startIndex]);
		return {
			kind: 'text',
			startTextIndex: startIndex,
			startOffset: offset,
			endTextIndex: startIndex,
			endOffset: offset,
			reversed: false
		};
	}

	let endIndex =
		selector.mode === 'within-text' ? startIndex : mod(selector.endText, segments.length);
	if (selector.mode === 'cross-text' && segments.length > 1 && endIndex === startIndex) {
		endIndex = (startIndex + 1 + mod(selector.endText, segments.length - 1)) % segments.length;
	}
	const startOffset = resolveTextOffset(selector.startOffset, segments[startIndex]);
	const endOffset = resolveTextOffset(selector.endOffset, segments[endIndex]);
	const rawStart: [number, number] = [startIndex, startOffset];
	const rawEnd: [number, number] = [endIndex, endOffset];
	const [start, end] =
		comparePoint(rawStart, rawEnd) <= 0 ? [rawStart, rawEnd] : [rawEnd, rawStart];

	return {
		kind: 'text',
		startTextIndex: start[0],
		startOffset: start[1],
		endTextIndex: end[0],
		endOffset: end[1],
		reversed: selector.reversed && comparePoint(start, end) !== 0
	};
};

export const setSelection = (page: Page, selection: ResolvedSelection) => {
	if (selection.kind === 'preserve') return Promise.resolve();
	if (selection.kind !== 'text') {
		return page.evaluate((resolved) => {
			const editor = document.querySelector<HTMLElement>('[data-edytor]');
			if (!editor) throw new Error('Missing [data-edytor] root');
			const blocks = Array.from(editor.querySelectorAll<HTMLElement>('[data-edytor-block="true"]'));
			const inlineById = new Map<string, HTMLElement>();
			for (const inline of editor.querySelectorAll<HTMLElement>('[data-edytor-inline-block]')) {
				const id = inline.dataset.edytorId;
				if (id && !inlineById.has(id)) inlineById.set(id, inline);
			}
			const inlines = [...inlineById.values()];
			const range = document.createRange();
			if (resolved.kind === 'node') {
				const target =
					resolved.target === 'inline' ? inlines[resolved.index] : blocks[resolved.index];
				if (!target) throw new Error(`Missing ${resolved.target} node at index ${resolved.index}`);
				range.selectNode(target);
			} else if (resolved.kind === 'block') {
				const block = blocks[resolved.index];
				if (!block) throw new Error(`Missing block at index ${resolved.index}`);
				range.selectNodeContents(block);
			} else if (resolved.kind === 'root') {
				const start = blocks[resolved.startBlockIndex];
				const end = blocks[resolved.endBlockIndex];
				if (!start || !end) throw new Error('Missing root range block');
				range.setStartBefore(start);
				range.setEndAfter(end);
			} else {
				range.selectNodeContents(editor);
			}

			editor.focus({ preventScroll: true });
			// A DOM-first placement is a user decision — mark the gesture so
			// the drift guard doesn't revert this echo as render churn.
			(window as { __EDYTOR__?: { markUserGesture?: () => void } }).__EDYTOR__?.markUserGesture?.();
			const domSelection = window.getSelection();
			if (!domSelection) throw new Error('Missing window selection');
			domSelection.removeAllRanges();
			if (resolved.reversed && typeof domSelection.setBaseAndExtent === 'function') {
				domSelection.setBaseAndExtent(
					range.endContainer,
					range.endOffset,
					range.startContainer,
					range.startOffset
				);
			} else if (resolved.reversed && typeof domSelection.extend === 'function') {
				domSelection.collapse(range.endContainer, range.endOffset);
				domSelection.extend(range.startContainer, range.startOffset);
			} else {
				domSelection.addRange(range);
			}
			document.dispatchEvent(new Event('selectionchange'));
		}, selection);
	}
	const args = [
		page,
		selection.startTextIndex,
		selection.startOffset,
		selection.endTextIndex,
		selection.endOffset
	] as const;
	return selection.reversed
		? setReverseSelectionByTextIndex(...args)
		: setSelectionByTextIndex(...args);
};

const formatKey = (mark: Extract<DstAction, { kind: 'format' }>['mark']): string => {
	const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
	const key =
		mark === 'bold'
			? 'b'
			: mark === 'italic'
				? 'i'
				: mark === 'underline'
					? 'u'
					: mark === 'code'
						? 'e'
						: 'Shift+x';
	return `${modifier}+${key}`;
};

/**
 * The platform word-delete chord. On every OS the backward word delete is
 * Alt+Backspace — ⌥⌫ delivers `deleteWordBackward` on darwin too. (⌘⌫,
 * the darwin LINE delete, is the separate `lineDelete` action — schema v5
 * split the units after v4 mislabeled the line chord as a word delete.)
 * Forward is Alt+Delete everywhere.
 */
const wordDeleteKey = (direction: 'backward' | 'forward'): string =>
	direction === 'backward' ? 'Alt+Backspace' : 'Alt+Delete';

/**
 * Build the Playwright chord for a move action. `Alt+Arrow*` is the macOS
 * word-jump chord — on other platforms Alt+Arrow navigates browser history,
 * so the same semantic intent is pressed as Control+Arrow.
 */
const moveChord = (key: string, extend: boolean): string => {
	const parts = key.split('+');
	const modifiers = parts
		.slice(0, -1)
		.map((modifier) =>
			modifier === 'Alt' && process.platform !== 'darwin' ? 'Control' : modifier
		);
	if (extend) modifiers.push('Shift');
	return [...modifiers, parts.at(-1)].join('+');
};

type NormalizedPointerTarget =
	| { kind: 'inline'; index: number }
	| { kind: 'blockText'; index: number; edge: 'left' | 'center' | 'right' }
	| { kind: 'padding'; index: number };

/**
 * Resolve a pointer action's element-granularity target against the
 * pre-action snapshot. Snapshot counts are already asserted identical
 * across engines, so the *choice* of target is deterministic; only the
 * geometry is resolved per-engine at click time. Falls back along a fixed
 * chain (inline → blockText → padding) when a target class is absent.
 */
const normalizePointerTarget = (
	target: 'inline' | 'blockText' | 'padding',
	index: number,
	edge: 'left' | 'center' | 'right',
	snapshot: DstBrowserSnapshot
): NormalizedPointerTarget => {
	if (target === 'inline' && snapshot.model.inlineIds.length > 0) {
		return { kind: 'inline', index: mod(index, snapshot.model.inlineIds.length) };
	}
	if ((target === 'inline' || target === 'blockText') && snapshot.model.renderedTexts.length > 0) {
		return {
			kind: 'blockText',
			index: mod(index, snapshot.model.renderedTexts.length),
			edge
		};
	}
	return { kind: 'padding', index };
};

type PointerPoint = { x: number; y: number };

const pointerPoint = (page: Page, target: NormalizedPointerTarget): Promise<PointerPoint> =>
	page.evaluate((resolved) => {
		const editor = document.querySelector<HTMLElement>('[data-edytor]');
		if (!editor) throw new Error('Missing [data-edytor] root');
		const modOf = (value: number, count: number) => (count === 0 ? 0 : value % count);
		const center = (rect: DOMRect): PointerPoint => ({
			x: rect.left + rect.width / 2,
			y: rect.top + rect.height / 2
		});
		if (resolved.kind === 'inline') {
			const elements = Array.from(
				editor.querySelectorAll<HTMLElement>('[data-edytor-inline-block]')
			);
			const element = elements[modOf(resolved.index, elements.length)];
			if (!element) throw new Error('Missing inline element for pointer target');
			return center(element.getBoundingClientRect());
		}
		if (resolved.kind === 'blockText') {
			const texts = Array.from(editor.querySelectorAll<HTMLElement>('[data-edytor-text="true"]'));
			const element = texts[modOf(resolved.index, texts.length)];
			if (!element) throw new Error('Missing text element for pointer target');
			const rect = element.getBoundingClientRect();
			// Edge pixels must stay ON the element's box: `right - 1` on a
			// zero-width (empty) text escapes a pixel to its left, where the
			// hit resolves onto chrome — WebKit then extends a shift-click
			// anchor to the nearest preceding DOM text (outside the editor)
			// and model/native parity breaks.
			const x =
				resolved.edge === 'left'
					? rect.left + 1
					: resolved.edge === 'right'
						? rect.right - 1
						: rect.left + rect.width / 2;
			return {
				x: Math.min(Math.max(x, rect.left), Math.max(rect.left, rect.right - 1)),
				y: rect.top + rect.height / 2
			};
		}
		// Editor padding between adjacent top-level blocks: block index picks
		// the gap pair, midpoint lands inside the editor chrome. Falls back
		// to just below the last top-level block, then inside the editor's
		// own top-left corner.
		const topLevel = Array.from(
			editor.querySelectorAll<HTMLElement>('[data-edytor-block="true"]')
		).filter((block) => !block.parentElement?.closest('[data-edytor-block="true"]'));
		const editorRect = editor.getBoundingClientRect();
		const pairCount = Math.max(topLevel.length - 1, 0);
		if (pairCount > 0) {
			const pairIndex = modOf(resolved.index, pairCount);
			const upper = topLevel[pairIndex].getBoundingClientRect();
			const lower = topLevel[pairIndex + 1].getBoundingClientRect();
			return {
				x: editorRect.left + Math.min(8, Math.max(editorRect.width / 4, 1)),
				y: Math.min((upper.bottom + lower.top) / 2, editorRect.bottom - 1)
			};
		}
		const last = topLevel.at(-1)?.getBoundingClientRect();
		if (last) {
			return {
				x: editorRect.left + Math.min(8, Math.max(editorRect.width / 4, 1)),
				y: Math.min(last.bottom + 4, editorRect.bottom - 1)
			};
		}
		return { x: editorRect.left + 2, y: editorRect.top + 2 };
	}, target);

const pointerDragPoints = (
	page: Page,
	startBlock: number,
	endBlock: number,
	blockCount: number
): Promise<{ from: PointerPoint; to: PointerPoint }> =>
	page.evaluate(
		({ startBlock, endBlock, blockCount }) => {
			const editor = document.querySelector<HTMLElement>('[data-edytor]');
			if (!editor) throw new Error('Missing [data-edytor] root');
			const blocks = Array.from(editor.querySelectorAll<HTMLElement>('[data-edytor-block="true"]'));
			const modOf = (value: number, count: number) => (count === 0 ? 0 : value % count);
			const edgePoint = (blockIndex: number, edge: 'first' | 'last'): { x: number; y: number } => {
				const block = blocks[modOf(blockIndex, blockCount)];
				if (!block) throw new Error(`Missing block ${blockIndex} for drag`);
				const texts = Array.from(block.querySelectorAll<HTMLElement>('[data-edytor-text="true"]'));
				const element = edge === 'first' ? texts[0] : texts.at(-1);
				const rect = (element ?? block).getBoundingClientRect();
				return {
					x: edge === 'first' ? rect.left + 1 : rect.right - 1,
					y: rect.top + rect.height / 2
				};
			};
			return { from: edgePoint(startBlock, 'first'), to: edgePoint(endBlock, 'last') };
		},
		{ startBlock, endBlock, blockCount }
	);

/**
 * Synthetic IME composition. Dispatches the same honest sequence on all
 * three engines — compositionstart → (compositionupdate + beforeinput
 * insertCompositionText)× → optionally beforeinput insertFromComposition →
 * compositionend. Consistency of the pipeline's response across engines is
 * the test; events are isTrusted:false and the oracle asserts the sequence
 * arrived instead of faking trust.
 */
const dispatchSyntheticComposition = (
	page: Page,
	action: Extract<DstAction, { kind: 'composition' }>
) =>
	page.evaluate((a) => {
		const target = document.querySelector<HTMLElement>('[data-edytor]');
		if (!target) throw new Error('Missing [data-edytor] root');
		const fireComposition = (type: string, data: string) => {
			const event =
				typeof CompositionEvent === 'function'
					? new CompositionEvent(type, { bubbles: true, cancelable: true, data })
					: (new Event(type, { bubbles: true, cancelable: true }) as CompositionEvent);
			if (typeof CompositionEvent !== 'function' || event.data !== data) {
				Object.defineProperty(event, 'data', { value: data, configurable: true });
			}
			target.dispatchEvent(event);
		};
		const fireBeforeInput = (inputType: string, data: string) => {
			const event =
				typeof InputEvent === 'function'
					? new InputEvent('beforeinput', {
							bubbles: true,
							cancelable: true,
							inputType,
							data
						})
					: (new Event('beforeinput', {
							bubbles: true,
							cancelable: true
						}) as InputEvent);
			if (typeof InputEvent !== 'function' || event.inputType !== inputType) {
				Object.defineProperties(event, {
					inputType: { value: inputType, configurable: true },
					data: { value: data, configurable: true }
				});
			}
			target.dispatchEvent(event);
		};
		fireComposition('compositionstart', '');
		for (const update of a.updates) {
			fireComposition('compositionupdate', update);
			fireBeforeInput('insertCompositionText', update);
		}
		if (a.commitViaBeforeinput) fireBeforeInput('insertFromComposition', a.commit);
		fireComposition('compositionend', a.commit);
	}, action);

const dispatchSyntheticClipboard = (
	page: Page,
	type: 'paste' | 'cut' | 'copy',
	payload: Record<string, string>
) =>
	page.evaluate(
		({ type, payload }) => {
			const target = document.querySelector<HTMLElement>('[data-edytor]');
			if (!target) throw new Error('Missing [data-edytor] root');
			const clipboardData = (() => {
				if (typeof DataTransfer === 'function') {
					try {
						const transfer = new DataTransfer();
						for (const [mime, value] of Object.entries(payload)) {
							try {
								transfer.setData(mime, value);
							} catch {
								// unknown MIME — ignored
							}
						}
						return transfer as DataTransfer;
					} catch {
						// fall through
					}
				}
				const store = { ...payload };
				return {
					types: Object.keys(store),
					getData: (mime: string) => store[mime] ?? '',
					setData: (mime: string, value: string) => {
						store[mime] = value;
						return true;
					}
				} as unknown as DataTransfer;
			})();
			const event =
				typeof ClipboardEvent === 'function'
					? new ClipboardEvent(type, {
							bubbles: true,
							cancelable: true,
							clipboardData
						})
					: (new Event(type, { bubbles: true, cancelable: true }) as ClipboardEvent);
			if (event.clipboardData !== clipboardData) {
				Object.defineProperty(event, 'clipboardData', {
					value: clipboardData,
					configurable: true
				});
			}
			target.dispatchEvent(event);
		},
		{ type, payload }
	);

const dispatchSyntheticDrop = (page: Page, index: number, text: string, blockCount: number) =>
	page.evaluate(
		({ index, text, blockCount }) => {
			const editor = document.querySelector<HTMLElement>('[data-edytor]');
			if (!editor) throw new Error('Missing [data-edytor] root');
			const blocks = Array.from(editor.querySelectorAll<HTMLElement>('[data-edytor-block="true"]'));
			const target = blocks[blockCount === 0 ? 0 : index % blockCount] ?? editor;
			const dataTransfer: DataTransfer =
				typeof DataTransfer === 'function'
					? (() => {
							const transfer = new DataTransfer();
							try {
								transfer.setData('text/plain', text);
							} catch {
								// ignore
							}
							return transfer;
						})()
					: ({
							types: ['text/plain'],
							getData: (mime: string) => (mime === 'text/plain' ? text : ''),
							setData: () => false
						} as unknown as DataTransfer);
			for (const type of ['dragover', 'drop']) {
				const event =
					typeof DragEvent === 'function'
						? new DragEvent(type, {
								bubbles: true,
								cancelable: true,
								dataTransfer
							})
						: (new Event(type, { bubbles: true, cancelable: true }) as DragEvent);
				if (event.dataTransfer !== dataTransfer) {
					Object.defineProperty(event, 'dataTransfer', {
						value: dataTransfer,
						configurable: true
					});
				}
				target.dispatchEvent(event);
			}
		},
		{ index, text, blockCount }
	);

const EDYTOR_FRAGMENT_MIME = 'application/x-edytor-fragment';

/**
 * Foreign attribute payloads. `attribute` indexes these tables mod-length
 * so schedules stay compact and deterministic. Foreign writes use only
 * marker attributes the snapshot's `foreignResidual` accounting can
 * detect; managed removals list the editor-owned attributes each surface
 * must heal back (`style` on text = the owned `white-space` declaration).
 */
const FOREIGN_ATTRIBUTE_WRITES = [
	{ name: 'data-dst-foreign', value: '1' },
	{ name: 'data-gramm', value: 'true' },
	{ name: 'title', value: 'dst-foreign' }
] as const;

const MANAGED_ATTRIBUTE_NAMES: Record<DstForeignMutationTarget, readonly string[]> = {
	text: [
		'data-edytor-id',
		'data-edytor-text',
		'data-edytor-text-empty',
		'contenteditable',
		'style'
	],
	mark: ['data-edytor-mark', 'data-edytor-mark-void', 'contenteditable'],
	block: [
		'data-edytor-id',
		'data-edytor-block',
		'data-edytor-type',
		'data-edytor-selected',
		'contenteditable'
	],
	inlineBlock: ['data-edytor-id', 'data-edytor-inline-block', 'contenteditable'],
	root: ['data-edytor', 'contenteditable']
};

/**
 * Schema v4 foreign DOM damage. Mutates managed DOM directly — no input
 * events are dispatched: the mutation observer's heal/restore/settle
 * paths are the system under test. Target resolution is engine-local but
 * deterministic: snapshot DOM counts are asserted identical across
 * engines before the action, so `index % count` picks the same element
 * everywhere. Absent targets (e.g. no marks in the document) are uniform
 * no-ops.
 */
const performForeignMutation = (page: Page, mutation: DstForeignMutation) =>
	page.evaluate(
		({ mutation, foreignAttributes, managedAttributes }) => {
			const editor = document.querySelector<HTMLElement>('[data-edytor]');
			if (!editor) throw new Error('Missing [data-edytor] root');
			const modOf = (value: number, count: number) => (count === 0 ? -1 : value % count);
			const targets = (target: DstForeignMutationTarget): HTMLElement[] => {
				switch (target) {
					case 'text':
						return Array.from(editor.querySelectorAll<HTMLElement>('[data-edytor-text="true"]'));
					case 'mark':
						return Array.from(editor.querySelectorAll<HTMLElement>('[data-edytor-mark]'));
					case 'block':
						return Array.from(editor.querySelectorAll<HTMLElement>('[data-edytor-block="true"]'));
					case 'inlineBlock':
						return Array.from(editor.querySelectorAll<HTMLElement>('[data-edytor-inline-block]'));
					case 'root':
						return [editor];
				}
			};
			const resolve = (target: DstForeignMutationTarget, index: number) => {
				const elements = targets(target);
				const resolved = modOf(index, elements.length);
				return resolved < 0 ? null : elements[resolved];
			};

			switch (mutation.kind) {
				case 'foreignAttribute': {
					const element = resolve(mutation.target, mutation.index);
					if (!element) return;
					const write = foreignAttributes[modOf(mutation.attribute, foreignAttributes.length)];
					element.setAttribute(write.name, write.value);
					return;
				}
				case 'managedAttribute': {
					const element = resolve(mutation.target, mutation.index);
					if (!element) return;
					const names = managedAttributes[mutation.target];
					const name = names[modOf(mutation.attribute, names.length)];
					if (!name || !element.hasAttribute(name)) return;
					element.removeAttribute(name);
					return;
				}
				case 'typeOver': {
					const element = resolve('text', mutation.index);
					if (!element) return;
					const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
					const leaf = walker.nextNode() as Text | null;
					if (!leaf) return;
					const current = leaf.data;
					// data === null is the identical-value write — a mobile
					// type-over record the observer must classify via
					// characterDataOldValue rather than skip as "unchanged".
					leaf.data = mutation.data === null ? current : `${current}${mutation.data}`;
					return;
				}
				case 'removeElement': {
					const element = resolve(mutation.target, mutation.index);
					element?.remove();
					return;
				}
				case 'insertForeignElement': {
					const host =
						mutation.where === 'text'
							? resolve('text', mutation.index)
							: mutation.where === 'block'
								? resolve('block', mutation.index)
								: editor;
					if (!host) return;
					const foreign = document.createElement('span');
					foreign.setAttribute('data-dst-foreign-node', '1');
					foreign.textContent = mutation.text;
					host.appendChild(foreign);
					return;
				}
			}
		},
		{
			mutation,
			foreignAttributes: FOREIGN_ATTRIBUTE_WRITES,
			managedAttributes: MANAGED_ATTRIBUTE_NAMES
		}
	);

export const performAction = async (
	page: Page,
	action: DstAction,
	before: DstBrowserSnapshot
): Promise<void> => {
	switch (action.kind) {
		case 'type':
			await page.keyboard.type(action.text);
			return;
		case 'insertText':
			await page.keyboard.insertText(action.text);
			return;
		case 'backspace':
			await page.keyboard.press('Backspace');
			return;
		case 'delete':
			await page.keyboard.press('Delete');
			return;
		case 'enter':
			await page.keyboard.press('Enter');
			return;
		case 'softBreak':
			await page.keyboard.press('Shift+Enter');
			return;
		case 'format':
			await page.keyboard.press(formatKey(action.mark));
			return;
		case 'move':
			await page.keyboard.press(moveChord(action.key, action.extend));
			return;
		case 'wordDelete':
			await page.keyboard.press(wordDeleteKey(action.direction));
			return;
		case 'lineDelete':
			// `forward` is declared for schema stability but no forward
			// line chord is defined — never press the backward chord and
			// count a different delivered unit as a pass.
			if (action.direction !== 'backward') {
				throw new DstHarnessFailure(
					'unsupported-action',
					'all',
					`lineDelete ${action.direction} has no native chord — only backward is defined`,
					{ action }
				);
			}
			// ⌘⌫ is a macOS-only native chord — replaying a darwin artifact
			// off-platform must fail loudly, not silently swap chords and
			// count a different delivered unit as a pass.
			if (process.platform !== 'darwin') {
				throw new DstHarnessFailure(
					'unsupported-action',
					'all',
					'lineDelete has no native chord off darwin — the artifact requires a macOS host',
					{ action }
				);
			}
			await page.keyboard.press('Meta+Backspace');
			return;
		case 'tab':
			await page.keyboard.press('Tab');
			return;
		case 'shiftTab':
			await page.keyboard.press('Shift+Tab');
			return;
		case 'undo':
			await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+z`);
			return;
		case 'redo':
			await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+Shift+z`);
			return;
		case 'pointerClick': {
			const point = await pointerPoint(
				page,
				normalizePointerTarget(action.target, action.index, action.edge, before)
			);
			await page.mouse.click(point.x, point.y);
			return;
		}
		case 'shiftClick': {
			const point = await pointerPoint(
				page,
				normalizePointerTarget(action.target, action.index, action.edge, before)
			);
			await page.keyboard.down('Shift');
			try {
				await page.mouse.click(point.x, point.y);
			} finally {
				await page.keyboard.up('Shift');
			}
			return;
		}
		case 'pointerDoubleClick': {
			const target: NormalizedPointerTarget =
				before.model.renderedTexts.length > 0
					? {
							kind: 'blockText',
							index: mod(action.index, before.model.renderedTexts.length),
							edge: 'center'
						}
					: { kind: 'padding', index: action.index };
			const point = await pointerPoint(page, target);
			await page.mouse.click(point.x, point.y, { clickCount: 2 });
			return;
		}
		case 'pointerDrag': {
			const { from, to } = await pointerDragPoints(
				page,
				action.startBlock,
				action.endBlock,
				before.model.blocks.length
			);
			await page.mouse.move(from.x, from.y);
			await page.mouse.down();
			await page.mouse.move(to.x, to.y, { steps: 8 });
			await page.mouse.up();
			return;
		}
		case 'composition':
			await dispatchSyntheticComposition(page, action);
			return;
		case 'paste': {
			const payload: Record<string, string> = {};
			if (action.text) payload['text/plain'] = action.text;
			if (action.html) payload['text/html'] = action.html;
			if (action.fragment != null) {
				// Same encoding as serializeClipboardFragment.ts's
				// encodeClipboardJson: btoa(encodeURIComponent(json)).
				payload[EDYTOR_FRAGMENT_MIME] = btoa(encodeURIComponent(JSON.stringify(action.fragment)));
			}
			await dispatchSyntheticClipboard(page, 'paste', payload);
			return;
		}
		case 'cut':
			await dispatchSyntheticClipboard(page, 'cut', {});
			return;
		case 'copy':
			await dispatchSyntheticClipboard(page, 'copy', {});
			return;
		case 'drop':
			await dispatchSyntheticDrop(page, action.index, action.text, before.model.blocks.length);
			return;
		case 'foreignMutation':
			await performForeignMutation(page, action.mutation);
			return;
	}
};

const pageRoute = (schedule: DstSchedule): string => {
	const query = new URLSearchParams({
		scenario: 'dst',
		dst: JSON.stringify(schedule.document),
		spellcheck: 'false',
		autocorrect: 'off',
		autocomplete: 'off',
		autocapitalize: 'none'
	});
	return `/test/dom?${query}`;
};

const createActivePage = async (
	engine: EngineSession,
	baseURL: string,
	schedule: DstSchedule
): Promise<ActivePage> => {
	const context = await engine.browser.newContext({ baseURL });
	const page = await context.newPage();
	const pageErrors: string[] = [];
	const consoleErrors: string[] = [];
	page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));
	page.on('console', (message) => {
		if (message.type() === 'error') consoleErrors.push(message.text());
	});
	await installEventRecorder(page);
	await page.goto(pageRoute(schedule), { waitUntil: 'domcontentloaded' });
	await waitForEditorReady(page, { requireRuntime: true });
	await settleEditor(page);
	return { engine, context, page, pageErrors, consoleErrors };
};

export const assertNoPageIssues = (active: ActivePage) => {
	if (active.pageErrors.length > 0 || active.consoleErrors.length > 0) {
		throw new DstHarnessFailure(
			'browser-error',
			active.engine.name,
			'browser emitted an uncaught error',
			{
				pageErrors: active.pageErrors,
				consoleErrors: active.consoleErrors
			}
		);
	}
};

const captureAll = async (
	activePages: ActivePage[]
): Promise<Record<DstEngineName, DstBrowserSnapshot>> => {
	const entries = await Promise.all(
		activePages.map(async (active) => {
			assertNoPageIssues(active);
			const snapshot = await captureBrowserSnapshot(active.page);
			return [active.engine.name, snapshot] as const;
		})
	);
	return Object.fromEntries(entries) as Record<DstEngineName, DstBrowserSnapshot>;
};

const assertAllSnapshots = (
	snapshots: Record<DstEngineName, DstBrowserSnapshot>,
	options: { requireSelection?: boolean } = {}
) => {
	for (const engine of ['chromium', 'firefox', 'webkit'] as const) {
		assertBrowserSnapshot(engine, snapshots[engine], options);
	}
};

const historyState = ({ history }: Pick<DstBrowserSnapshot, 'history'>) => ({
	undoDepth: history.undoDepth,
	redoDepth: history.redoDepth,
	canUndo: history.canUndo,
	canRedo: history.canRedo
});

export const assertHistoryEquivalence = (
	snapshots: Record<DstEngineName, Pick<DstBrowserSnapshot, 'history'>>,
	action: DstAction | null
) => {
	const reference = historyState(snapshots.chromium);
	for (const engine of ['firefox', 'webkit'] as const) {
		const current = historyState(snapshots[engine]);
		if (JSON.stringify(current) !== JSON.stringify(reference)) {
			throw new DstHarnessFailure(
				'cross-browser-history-divergence',
				`${engine}/chromium`,
				'undo and redo state diverged after the same trusted input',
				{
					chromium: reference,
					[engine]: current,
					action
				}
			);
		}
	}
};

/**
 * Intent assertion: the chord a delete action pressed must deliver a
 * `delete*` beforeinput of the same unit family — a `wordDelete` that
 * arrives as `deleteSoftLineBackward` means the platform chord map lied
 * about the unit (the v4 defect this split fixes). Absent delivery is a
 * mismatch too — a chord counted as a pass without doing the named
 * delete — except for the two honest no-delivery cases documented in
 * the body. Either way the step cannot silently succeed.
 */
export const assertDeleteIntent = (
	engine: string,
	action: DstAction,
	before: DstBrowserSnapshot,
	after: DstBrowserSnapshot
) => {
	// With a live (non-collapsed) selection the delete unit IS the
	// selection — the word/line family no longer applies and engines
	// correctly deliver `deleteContent*` instead. Asserting the word unit
	// here would fail correct browser behavior.
	const overSelection = before.selection?.kind === 'text' && !before.selection.isCollapsed;
	const expected: readonly string[] | null = overSelection
		? action.kind === 'wordDelete' || action.kind === 'lineDelete'
			? action.direction === 'backward'
				? ['deleteContentBackward', 'deleteContent']
				: ['deleteContentForward', 'deleteContent']
			: null
		: action.kind === 'wordDelete'
			? action.direction === 'backward'
				? ['deleteWordBackward']
				: ['deleteWordForward']
			: action.kind === 'lineDelete'
				? action.direction === 'backward'
					? ['deleteSoftLineBackward', 'deleteHardLineBackward', 'deleteEntireSoftLine']
					: ['deleteSoftLineForward', 'deleteHardLineForward', 'deleteEntireSoftLine']
				: null;
	if (expected === null) return;
	const delivered = deliveredDeleteInputType(after.events);
	if (delivered === null) {
		// Absent delivery is honest in exactly three cases:
		// - a non-text selection, where the keydown hotkey path runs and no
		//   beforeinput is dispatched at all;
		// - WebKit's no-op suppression — it emits no beforeinput for an
		//   editing command that can delete nothing (caret at a deletion
		//   boundary). The document must then be provably unchanged; the
		//   effect oracle still fails the step if a delete was owed, so an
		//   unsupported chord cannot hide here;
		// - the same suppression at the document's first (last) text, where
		//   the model still owes a delete (an empty first list item lifts
		//   out): the editor's keydown fallback deletes the neighbour at the
		//   block's edge like a character (SW10-crdt-1), and the effect
		//   oracle holds the result to that.
		if (before.selection?.kind !== 'text') return;
		if (engine === 'webkit' && semanticSignature(before) === semanticSignature(after)) return;
		const { startTextIndex, yStart, isCollapsed } = before.selection;
		const texts = before.model.renderedTexts;
		const documentEdge =
			'direction' in action && action.direction === 'backward'
				? startTextIndex === 0 && yStart === 0
				: startTextIndex === texts.length - 1 && yStart === texts.at(-1)?.length;
		if (engine === 'webkit' && isCollapsed && documentEdge) return;
	} else if (expected.includes(delivered)) {
		return;
	}
	throw new DstHarnessFailure(
		'delete-intent-mismatch',
		engine,
		`${action.kind} delivered ${delivered ?? 'no delete beforeinput'} — expected ${expected.join(' | ')}`,
		{ action, delivered, expected, selection: before.selection }
	);
};

/**
 * `assertActionEffect`'s delete-oracle gate does not name `lineDelete`
 * (the gate lives in browserState.ts) — run the same `describeDelete`
 * oracle for it here so the new intent still gets exact-result coverage.
 * Verdict codes match the gate's, so nothing disagrees if it adopts
 * `lineDelete` later.
 */
const assertLineDeleteExpectation = (
	engine: string,
	action: Extract<DstAction, { kind: 'lineDelete' }>,
	before: DstBrowserSnapshot,
	after: DstBrowserSnapshot
) => {
	const beforeSemantic = semanticSignature(before);
	const afterSemantic = semanticSignature(after);
	const expectation = describeDelete(before, action, after.events);
	if (expectation.kind === 'invalid') {
		throw new DstHarnessFailure(
			'delete-range-implausible',
			engine,
			`${action.kind}: ${expectation.reason}`,
			{ action, reason: expectation.reason }
		);
	}
	if (expectation.kind === 'unchanged' || expectation.kind === 'selectOnly') {
		if (beforeSemantic !== afterSemantic) {
			throw new DstHarnessFailure(
				'delete-noop-mutated-document',
				engine,
				`${action.kind} mutated the document but ${expectation.reason}`,
				{ action, reason: expectation.reason }
			);
		}
		if (expectation.kind === 'selectOnly') {
			const landed = after.selection;
			if (
				landed?.kind !== 'block' ||
				landed.ids.length !== 1 ||
				landed.ids[0] !== expectation.blockId
			) {
				throw new DstHarnessFailure(
					'delete-selection-mismatch',
					engine,
					`${action.kind} should have selected block ${expectation.blockId} (${expectation.reason})`,
					{ action, expected: expectation.blockId, actual: after.selection }
				);
			}
		}
		return;
	}
	if (expectation.kind === 'tree') {
		if (beforeSemantic === afterSemantic) {
			throw new DstHarnessFailure(
				'action-produced-no-effect',
				engine,
				`${action.kind} did not change a deletable range — ${expectation.description}`,
				{ action, description: expectation.description }
			);
		}
		const diff = diffDeleteExpectation(
			expectation.children,
			(after.value as { children?: unknown[] } | undefined)?.children
		);
		if (diff) {
			throw new DstHarnessFailure(
				'delete-result-mismatch',
				engine,
				`${action.kind} produced the wrong document: ${diff} — ${expectation.description}`,
				{
					action,
					diff,
					before: (before.value as { children?: unknown[] } | undefined)?.children,
					expected: expectation.children,
					actual: (after.value as { children?: unknown[] } | undefined)?.children
				}
			);
		}
	}
	// 'indeterminate' — nothing provable remains; the intent check ran.
};

const compareEngines = (
	snapshots: Record<DstEngineName, DstBrowserSnapshot>,
	action: DstAction | null,
	selectionTolerant?: ReadonlySet<DstEngineName>
) => {
	const reference = snapshots.chromium;
	const referenceSemantic = semanticSignature(reference);
	// Pointer gestures let each browser own hit resolution — a click on
	// non-editable chrome can anchor the native range outside the editor on
	// one engine (WebKit shift-click) while another extends inside. The
	// escaped engine's model correctly keeps its sticky caret, so its
	// selection outcome isn't comparable — and neither is the reference's
	// when CHROMIUM is the one that escaped.
	//
	// Word-jump moves (Alt+Arrow*) are also browser-owned: moveByWord is
	// deterministic given equal starting offsets, so a divergence can only
	// come from the DOM caret having snapped to a different boundary before
	// keydown re-synced the model (shouldRefreshSelectionBeforeKeyDown) or
	// from one engine running the native word-jump path — engine-owned
	// caret/word segmentation either way. Per-engine move legality and the
	// semantic signature are still asserted; only cross-engine selection
	// identity is vacuous for the diverging engine.
	const wordJumpMove = action?.kind === 'move' && action.key.startsWith('Alt+');
	const compareSelection = !wordJumpMove && !selectionTolerant?.has('chromium');
	for (const engine of ['firefox', 'webkit'] as const) {
		const semantic = semanticSignature(snapshots[engine]);
		if (semantic !== referenceSemantic) {
			throw new DstHarnessFailure(
				'cross-browser-semantic-divergence',
				`${engine}/chromium`,
				'editor values diverged after the same trusted input',
				{
					chromium: reference.value,
					[engine]: snapshots[engine].value,
					action
				}
			);
		}
		const chromiumSelection = selectionSignature(reference);
		const engineSelection = selectionSignature(snapshots[engine]);
		if (
			compareSelection &&
			!selectionTolerant?.has(engine) &&
			engineSelection !== chromiumSelection
		) {
			throw new DstHarnessFailure(
				'cross-browser-selection-divergence',
				`${engine}/chromium`,
				'editor selections diverged after the same trusted input',
				{
					chromium: reference.selection,
					[engine]: snapshots[engine].selection,
					action
				}
			);
		}
		const chromiumDomRepair = domRepairSignature(reference);
		const engineDomRepair = domRepairSignature(snapshots[engine]);
		if (engineDomRepair !== chromiumDomRepair) {
			throw new DstHarnessFailure(
				'cross-browser-dom-repair-divergence',
				`${engine}/chromium`,
				'managed DOM repair state diverged after the same input',
				{
					chromium: reference.dom,
					[engine]: snapshots[engine].dom,
					action
				}
			);
		}
	}
	assertHistoryEquivalence(snapshots, action);
};

/**
 * Deepest path at which `left` and `right` first differ, or `null` when
 * they are deep-equal. `Object.is` alone cannot short-circuit structural
 * equality — deep-equal objects still recurse, and a "mismatch" that only
 * exists by reference previously STOPPED inside the first unchanged
 * block, reporting `:object`/`:array` stubs that collapsed every later
 * defect into one fingerprint. The walk now continues past equal
 * siblings, and an arity gap reports the position where the extra
 * element sits plus which side grew.
 */
const firstMismatchPath = (left: unknown, right: unknown, path = '$'): string | null => {
	if (Object.is(left, right)) return null;
	if (Array.isArray(left) || Array.isArray(right)) {
		if (!Array.isArray(left) || !Array.isArray(right)) return `${path}:type`;
		const shared = Math.min(left.length, right.length);
		for (let index = 0; index < shared; index++) {
			const sub = firstMismatchPath(left[index], right[index], `${path}[${index}]`);
			if (sub !== null) return sub;
		}
		if (left.length !== right.length) {
			return `${path}[${shared}]:arity-${left.length}v${right.length}`;
		}
		return null;
	}
	if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
		return path;
	}
	const leftObject = left as Record<string, unknown>;
	const rightObject = right as Record<string, unknown>;
	const keys = [...new Set([...Object.keys(leftObject), ...Object.keys(rightObject)])].sort();
	for (const key of keys) {
		if (!(key in leftObject) || !(key in rightObject)) return `${path}.${key}:presence`;
		const sub = firstMismatchPath(leftObject[key], rightObject[key], `${path}.${key}`);
		if (sub !== null) return sub;
	}
	return null;
};

/**
 * Shape-stable form of a mismatch path: indices normalize to `[]` for
 * bucketing, but the raw index sequence rides along as `@i,j,k` — a
 * defect at `children[0]` and an unrelated one at `children[3]` are
 * different reduction classes, while the same defect re-running at the
 * same positions keeps one fingerprint.
 */
const normalizeMismatchPath = (path: string | null): string => {
	if (path === null) return '$:equal';
	const indices = [...path.matchAll(/\[(\d+)\]/g)].map((m) => m[1]).join(',');
	const stripped = path.replace(/\[\d+\]/g, '[]');
	return indices === '' ? stripped : `${stripped}@${indices}`;
};

const parseSemanticSignature = (value: unknown): unknown => {
	if (typeof value !== 'string') return value;
	try {
		return JSON.parse(value) as unknown;
	} catch {
		return value;
	}
};

const failureSubtype = (failure: Pick<DstRunFailure, 'code' | 'engine' | 'details'>): string => {
	const details =
		failure.details && typeof failure.details === 'object'
			? (failure.details as Record<string, unknown>)
			: null;
	if (failure.code === 'cross-browser-semantic-divergence' && details) {
		const comparedEngine = failure.engine.split('/')[0];
		const chromium = details.chromium;
		const compared = details[comparedEngine];
		if (chromium && compared) {
			return normalizeMismatchPath(
				firstMismatchPath(
					canonicalDocumentValue(chromium as Parameters<typeof canonicalDocumentValue>[0]),
					canonicalDocumentValue(compared as Parameters<typeof canonicalDocumentValue>[0])
				)
			);
		}
	}
	if (failure.code === 'cross-browser-selection-divergence' && details) {
		const comparedEngine = failure.engine.split('/')[0];
		return normalizeMismatchPath(firstMismatchPath(details.chromium, details[comparedEngine]));
	}
	if (failure.code === 'selection-model-dom-mismatch' && details) {
		const selection = details.selection as
			| { isCollapsed?: boolean; isReversed?: boolean }
			| undefined;
		const native = details.native as
			| {
					isCollapsed?: boolean;
					isReversed?: boolean;
					start?: { kind?: string };
					end?: { kind?: string };
					selectedNode?: unknown;
			  }
			| undefined;
		if (!native) return 'native-missing';
		if (native.selectedNode) return 'native-node-for-text';
		if (selection?.isCollapsed !== native.isCollapsed) return 'collapsed';
		if (selection?.isReversed !== native.isReversed) return 'direction';
		if (native.start?.kind === 'outside' || native.end?.kind === 'outside') return 'outside';
		return `endpoint:${native.start?.kind ?? 'missing'}:${native.end?.kind ?? 'missing'}`;
	}
	if (failure.code === 'selection-kind-mismatch' && details) {
		const selection = details.selection as { kind?: string } | undefined;
		const native = details.native as { selectedNode?: { kind?: string } | null } | undefined;
		return `${selection?.kind ?? 'none'}:${native?.selectedNode?.kind ?? 'none'}`;
	}
	if (details && 'expected' in details && 'actual' in details) {
		return normalizeMismatchPath(
			firstMismatchPath(
				parseSemanticSignature(details.expected),
				parseSemanticSignature(details.actual)
			)
		);
	}
	if (details && 'model' in details && 'dom' in details) {
		return normalizeMismatchPath(firstMismatchPath(details.model, details.dom));
	}
	return failure.code;
};

export const failureFingerprint = (
	failure: Pick<
		DstRunFailure,
		'code' | 'engine' | 'message' | 'details' | 'step' | 'resolvedSelection'
	>
): string => {
	const payload = {
		version: 1,
		code: failure.code,
		engine: failure.engine,
		action: failure.step?.action.kind ?? null,
		selectionKind: failure.resolvedSelection?.kind ?? null,
		subtype: failureSubtype(failure)
	};
	return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
};

const normalizeFailure = (
	error: unknown,
	stepIndex: number,
	step: DstStep | null,
	resolvedSelection: ResolvedSelection | null,
	beforeSnapshots: Partial<Record<DstEngineName, DstBrowserSnapshot>>,
	snapshots: Partial<Record<DstEngineName, DstBrowserSnapshot>>,
	history: DstHistorySummary[]
): DstRunFailure => {
	let failure: Omit<DstRunFailure, 'fingerprint'>;
	if (error instanceof DstHarnessFailure) {
		failure = {
			code: error.code,
			engine: error.engine,
			message: error.message,
			details: error.details,
			stepIndex,
			step,
			resolvedSelection,
			beforeSnapshots,
			snapshots,
			history
		};
	} else {
		const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
		failure = {
			code: 'harness-or-browser-action-error',
			engine: 'unknown',
			message,
			stepIndex,
			step,
			resolvedSelection,
			beforeSnapshots,
			snapshots,
			history
		};
	}
	return {
		...failure,
		fingerprint: failureFingerprint(failure)
	};
};

export const launchDstEngines = async (): Promise<EngineSession[]> =>
	Promise.all(
		(Object.keys(ENGINE_TYPES) as DstEngineName[]).map(async (name) => {
			const browser = await ENGINE_TYPES[name].launch({ headless: true });
			return { name, version: browser.version(), browser };
		})
	);

export const closeDstEngines = async (engines: EngineSession[]) => {
	await Promise.all(engines.map(({ browser }) => browser.close()));
};

export const engineVersions = (engines: EngineSession[]): Record<string, string> =>
	Object.fromEntries(engines.map(({ name, version }) => [name, version]));

const summarizeHistoryStep = (
	stepIndex: number,
	action: DstAction,
	selection: ResolvedSelection,
	before: Record<DstEngineName, DstBrowserSnapshot>,
	after: Record<DstEngineName, DstBrowserSnapshot>
): DstHistorySummary => {
	const beforeSummary = {} as DstHistorySummary['before'];
	const afterSummary = {} as DstHistorySummary['after'];
	for (const engine of ['chromium', 'firefox', 'webkit'] as const) {
		beforeSummary[engine] = {
			semantic: semanticSignature(before[engine]),
			selection: selectionSignature(before[engine]),
			undoDepth: before[engine].history.undoDepth,
			redoDepth: before[engine].history.redoDepth
		};
		afterSummary[engine] = {
			semantic: semanticSignature(after[engine]),
			selection: selectionSignature(after[engine]),
			undoDepth: after[engine].history.undoDepth,
			redoDepth: after[engine].history.redoDepth,
			events: after[engine].events.map((event) =>
				[event.type, event.inputType ?? event.key ?? '', event.isTrusted ? 'trusted' : 'synthetic']
					.filter(Boolean)
					.join(':')
			),
			domRepair: domRepairSignature(after[engine])
		};
	}
	return {
		stepIndex,
		action,
		selection,
		status: 'captured',
		before: beforeSummary,
		after: afterSummary
	};
};

export const expectedHistorySemantic = (
	action: DstAction,
	selection: ResolvedSelection,
	history: DstHistorySummary[],
	engine: DstEngineName
): string | undefined => {
	if (selection.kind !== 'preserve') return undefined;
	const previous = history.at(-1);
	if (!previous) return undefined;
	if (
		action.kind === 'undo' &&
		previous.action.kind !== 'undo' &&
		previous.action.kind !== 'redo' &&
		previous.before[engine].semantic !== previous.after[engine].semantic &&
		previous.after[engine].undoDepth === previous.before[engine].undoDepth + 1
	) {
		return previous.before[engine].semantic;
	}
	if (
		action.kind === 'redo' &&
		previous.action.kind === 'undo' &&
		previous.before[engine].semantic !== previous.after[engine].semantic
	) {
		return previous.before[engine].semantic;
	}
	return undefined;
};

export const runDstSchedule = async (
	engines: EngineSession[],
	baseURL: string,
	schedule: DstSchedule
): Promise<DstRunResult> => {
	let activePages: ActivePage[] = [];
	let snapshots: Partial<Record<DstEngineName, DstBrowserSnapshot>> = {};
	let beforeSnapshots: Partial<Record<DstEngineName, DstBrowserSnapshot>> = {};
	const history: DstHistorySummary[] = [];
	let stepIndex = -1;
	let step: DstStep | null = null;
	let resolvedSelection: ResolvedSelection | null = null;
	try {
		activePages = await Promise.all(
			engines.map((engine) => createActivePage(engine, baseURL, schedule))
		);
		let currentSnapshots = await captureAll(activePages);
		snapshots = currentSnapshots;
		assertAllSnapshots(currentSnapshots);
		compareEngines(currentSnapshots, null);

		// Engines whose last pointer action ended in a tolerated sticky
		// escape, mapped to the model selection that was kept. A `preserve`
		// selection step carries the escape forward untouched — the same
		// physical event stays tolerable until the native range re-anchors
		// inside the editor or the model selection moves.
		const stickyEscapes = new Map<DstEngineName, DstSelection>();
		const escapeAllowed = (engine: DstEngineName, snapshot: DstBrowserSnapshot): boolean => {
			const sticky = stickyEscapes.get(engine);
			if (sticky && isPersistedStickyEscape(sticky, snapshot)) return true;
			stickyEscapes.delete(engine);
			return false;
		};
		const noteEscape = (
			engine: DstEngineName,
			action: DstAction,
			before: DstBrowserSnapshot,
			after: DstBrowserSnapshot
		): boolean => {
			if (isStickyOutsideEscape(action, before, after)) {
				stickyEscapes.set(engine, after.selection!);
				return true;
			}
			return escapeAllowed(engine, after);
		};
		const escapedSet = (snaps: Record<DstEngineName, DstBrowserSnapshot>) =>
			new Set(
				(['chromium', 'firefox', 'webkit'] as const).filter((engine) =>
					escapeAllowed(engine, snaps[engine])
				)
			);

		for (stepIndex = 0; stepIndex < schedule.steps.length; stepIndex++) {
			step = schedule.steps[stepIndex];
			resolvedSelection = resolveSelection(step.selection, currentSnapshots.chromium);

			await Promise.all(activePages.map((active) => setSelection(active.page, resolvedSelection!)));
			await Promise.all(activePages.map((active) => settleEditor(active.page)));
			const selectedSnapshots = await captureAll(activePages);
			snapshots = selectedSnapshots;
			beforeSnapshots = selectedSnapshots;
			currentSnapshots = selectedSnapshots;
			for (const engine of ['chromium', 'firefox', 'webkit'] as const) {
				assertBrowserSnapshot(engine, selectedSnapshots[engine], {
					requireSelection: true,
					allowOutsideNative: escapeAllowed(engine, selectedSnapshots[engine])
				});
			}
			compareEngines(selectedSnapshots, null, escapedSet(selectedSnapshots));

			await Promise.all(
				activePages.map(async (active) => {
					await performAction(active.page, step!.action, selectedSnapshots[active.engine.name]);
					await settleEditor(active.page);
				})
			);
			const afterSnapshots = await captureAll(activePages);
			snapshots = afterSnapshots;
			currentSnapshots = afterSnapshots;
			for (const engine of ['chromium', 'firefox', 'webkit'] as const) {
				assertBrowserSnapshot(engine, afterSnapshots[engine], {
					requireSelection: true,
					allowOutsideNative: noteEscape(
						engine,
						step.action,
						selectedSnapshots[engine],
						afterSnapshots[engine]
					)
				});
			}
			const historyEntry = summarizeHistoryStep(
				stepIndex,
				step.action,
				resolvedSelection,
				selectedSnapshots,
				afterSnapshots
			);
			history.push(historyEntry);
			for (const active of activePages) {
				const engine = active.engine.name;
				assertTrustedAction(engine, step.action, afterSnapshots[engine].events);
				assertDeleteIntent(engine, step.action, selectedSnapshots[engine], afterSnapshots[engine]);
				assertActionEffect(engine, step.action, selectedSnapshots[engine], afterSnapshots[engine], {
					expectedSemantic: expectedHistorySemantic(
						step.action,
						resolvedSelection,
						history.slice(0, -1),
						engine
					)
				});
				if (step.action.kind === 'lineDelete') {
					assertLineDeleteExpectation(
						engine,
						step.action,
						selectedSnapshots[engine],
						afterSnapshots[engine]
					);
				}
				assertSemanticPreservation(
					engine,
					step.action,
					selectedSnapshots[engine],
					afterSnapshots[engine]
				);
			}
			compareEngines(afterSnapshots, step.action, escapedSet(afterSnapshots));
			historyEntry.status = 'passed';
		}
		// F-O10: the settled host of every engine is the projection of its cells.
		for (const active of activePages)
			await assertTruth(active.page, `dst seed ${schedule.seed} ${active.engine.name}`);

		return {
			ok: true,
			finalSnapshots: snapshots as Record<DstEngineName, DstBrowserSnapshot>
		};
	} catch (error) {
		return {
			ok: false,
			failure: normalizeFailure(
				error,
				stepIndex,
				step,
				resolvedSelection,
				beforeSnapshots,
				snapshots,
				history
			)
		};
	} finally {
		await Promise.all(activePages.map(({ context }) => context.close().catch(() => undefined)));
	}
};

export const minimizeDstFailure = async (
	engines: EngineSession[],
	baseURL: string,
	schedule: DstSchedule,
	failure: DstRunFailure,
	maxAttempts = 40,
	maxDurationMs = Number(process.env.DST_SHRINK_BUDGET_MS ?? 90_000)
): Promise<{
	schedule: DstSchedule;
	attempts: number;
	fingerprint: string;
	termination: 'fixed-point' | 'attempt-limit' | 'time-budget';
}> => {
	const durationBudget =
		Number.isFinite(maxDurationMs) && maxDurationMs >= 0 ? maxDurationMs : 90_000;
	let steps = schedule.steps.slice(0, failure.stepIndex + 1);
	let chunk = Math.max(1, Math.floor(steps.length / 2));
	let attempts = 0;
	const deadline = Date.now() + durationBudget;
	while (chunk >= 1 && attempts < maxAttempts && Date.now() < deadline) {
		let reduced = false;
		for (
			let index = 0;
			index + chunk <= steps.length && attempts < maxAttempts && Date.now() < deadline;
			index++
		) {
			const candidate = steps.slice(0, index).concat(steps.slice(index + chunk));
			if (candidate.length === 0) continue;
			attempts += 1;
			const replay = await runDstSchedule(engines, baseURL, { ...schedule, steps: candidate });
			if (!replay.ok && replay.failure.fingerprint === failure.fingerprint) {
				steps = candidate;
				reduced = true;
				break;
			}
		}
		if (!reduced) chunk = Math.floor(chunk / 2);
	}
	return {
		schedule: { ...schedule, steps },
		attempts,
		fingerprint: failure.fingerprint,
		termination:
			Date.now() >= deadline
				? 'time-budget'
				: attempts >= maxAttempts
					? 'attempt-limit'
					: 'fixed-point'
	};
};
