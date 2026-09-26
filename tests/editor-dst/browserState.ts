import type { Page } from '@playwright/test';

import { inputClassOf, type DstAction } from './generator.js';
import { describeDelete, diffDeleteExpectation } from './deleteOracle.js';

type JsonText = { text: string; marks?: Record<string, unknown> };
type JsonInline = { type: string; id?: string; data?: unknown };
type JsonBlock = {
	type: string;
	id?: string;
	data?: unknown;
	content?: Array<JsonText | JsonInline>;
	children?: JsonBlock[];
};
type JsonRoot = { type?: string; children: JsonBlock[] };

export type DstEvent = {
	type: string;
	isTrusted: boolean;
	cancelable: boolean;
	inputType?: string;
	data?: string | null;
	key?: string;
	isComposing?: boolean;
	detail?: number;
	button?: number;
	targetRange?: {
		collapsed: boolean;
		startOffset: number;
		endOffset: number;
		startTextIndex: number;
		endTextIndex: number;
		yStart: number;
		yEnd: number;
	} | null;
	modelSelection?: {
		yStart: number;
		yEnd: number;
		isCollapsed: boolean;
		startTextId: string | null;
		endTextId: string | null;
	};
};

type NativeTextPoint = { textIndex: number; offset: number };

type NativeEndpoint =
	| ({ kind: 'text' } & NativeTextPoint)
	| {
			kind: 'boundary';
			before: NativeTextPoint | null;
			after: NativeTextPoint | null;
	  }
	| { kind: 'outside' };

export type DstTextSelection = {
	kind: 'text';
	startTextIndex: number;
	endTextIndex: number;
	yStart: number;
	yEnd: number;
	isCollapsed: boolean;
	isReversed: boolean;
};

export type DstSelection =
	| DstTextSelection
	| { kind: 'inline'; ids: string[] }
	| { kind: 'block'; ids: string[] };

export type DstBrowserSnapshot = {
	value: JsonRoot;
	history: { undoDepth: number; redoDepth: number; canUndo: boolean; canRedo: boolean };
	model: {
		blocks: Array<{
			id: string;
			type: string;
			data: Record<string, unknown>;
			contentKinds: Array<'text' | 'inline'>;
			/**
			 * Content parts in order — text parts carry their JSON runs
			 * (text+marks), inline parts their identity. The delete oracle
			 * rebuilds expected post-state at this granularity; part ids map
			 * `renderedTextIds` entries back to their owning part index.
			 */
			parts: Array<
				| { kind: 'text'; id: string; runs: Array<{ text: string; marks: unknown }> }
				| { kind: 'inline'; id: string; type: string; data: Record<string, unknown> }
			>;
			/**
			 * Tree position (index path from the root) — used by the tab /
			 * shiftTab effect oracles to reason about nestability.
			 */
			path: number[];
			void: boolean;
			island: boolean;
			/**
			 * Text parts this block contributes to `renderedTexts` (0 for
			 * void blocks and blocks hidden inside them) — lets oracles map a
			 * rendered text index back to its owning block.
			 */
			renderedTextCount: number;
		}>;
		/**
		 * `edytor.defaultType` — the semantic default used for island-merge
		 * type resets — and the root-sensitive default a repopulated empty
		 * root receives (`getDefaultBlock(root)`).
		 */
		defaultType: string | null;
		rootDefaultType: string | null;
		texts: string[];
		textIds: string[];
		renderedTexts: string[];
		renderedTextIds: string[];
		inlineIds: string[];
	};
	dom: {
		blockCount: number;
		inlineIds: string[];
		texts: string[];
		textIds: string[];
		textBindings: Array<{
			dataId: string;
			nodeMapId: string | null;
			idMapId: string | null;
			idMapNodeMatches: boolean;
		}>;
		emptyAttributes: boolean[];
		placeholderBlockIndexes: number[];
		/**
		 * `data-edytor-type` per rendered block element, in document order —
		 * per-engine healing proof for managed-attribute damage (the
		 * observer must restore the model-driven type).
		 */
		blockTypeAttrs: Array<string | null>;
		/**
		 * `data-edytor-mark` attribute values in document order — the mark
		 * projection the subtree-refresh heal path must reproduce.
		 * Compared across engines via `domRepairSignature`.
		 */
		markAttrs: Array<string | null>;
		/**
		 * Foreign DOM residue after healing: injected elements still tagged
		 * `data-dst-foreign-node` and managed elements still carrying the
		 * DST foreign-marker attributes. Nodes must always heal to empty;
		 * attributes legitimately survive on tolerant surfaces (blocks,
		 * root), so parity is asserted cross-engine.
		 */
		foreignResidual: {
			nodes: string[];
			attrs: string[];
		};
	};
	selection: DstSelection | null;
	nativeSelection: {
		anchor: NativeEndpoint | null;
		focus: NativeEndpoint | null;
		start: NativeEndpoint | null;
		end: NativeEndpoint | null;
		isCollapsed: boolean;
		isReversed: boolean;
		selectedNode: { kind: 'inline' | 'block'; id: string } | null;
		debug: {
			anchor: string;
			focus: string;
		};
	} | null;
	events: DstEvent[];
};

export class DstHarnessFailure extends Error {
	readonly code: string;
	readonly engine: string;
	readonly details: unknown;

	constructor(code: string, engine: string, message: string, details?: unknown) {
		super(`${code} [${engine}]: ${message}`);
		this.name = 'DstHarnessFailure';
		this.code = code;
		this.engine = engine;
		this.details = details;
	}
}

const fail = (code: string, engine: string, message: string, details?: unknown): never => {
	throw new DstHarnessFailure(code, engine, message, details);
};

export const installEventRecorder = (page: Page) =>
	page.addInitScript(() => {
		type RecordedEvent = {
			type: string;
			isTrusted: boolean;
			cancelable: boolean;
			inputType?: string;
			data?: string | null;
			key?: string;
			isComposing?: boolean;
			detail?: number;
			button?: number;
			targetRange?: {
				collapsed: boolean;
				startOffset: number;
				endOffset: number;
				startTextIndex: number;
				endTextIndex: number;
				yStart: number;
				yEnd: number;
			} | null;
			modelSelection?: {
				yStart: number;
				yEnd: number;
				isCollapsed: boolean;
				startTextId: string | null;
				endTextId: string | null;
			};
		};
		const target = window as Window & {
			__EDYTOR_DST_EVENTS__?: RecordedEvent[];
			__EDYTOR_DST_LAST_EVENT_AT__?: number;
		};
		target.__EDYTOR_DST_EVENTS__ = [];
		target.__EDYTOR_DST_LAST_EVENT_AT__ = performance.now();
		for (const type of [
			'keydown',
			'keyup',
			'beforeinput',
			'input',
			'compositionstart',
			'compositionupdate',
			'compositionend',
			'selectionchange',
			// trusted pointer proof for pointer* / shiftClick actions
			'pointerdown',
			'pointerup',
			'mousedown',
			'mouseup',
			'click',
			'dblclick',
			// synthetic input classes — the dispatch must reach the editor
			'paste',
			'copy',
			'cut',
			'dragover',
			'drop',
			'dragstart',
			'dragend'
		]) {
			window.addEventListener(
				type,
				(event) => {
					const input = event instanceof InputEvent ? event : null;
					const keyboard = event instanceof KeyboardEvent ? event : null;
					const mouse = event instanceof MouseEvent ? event : null;
					target.__EDYTOR_DST_LAST_EVENT_AT__ = performance.now();
					const targetRange = input?.getTargetRanges?.()[0] ?? null;
					const editorTexts = Array.from(
						document.querySelectorAll<HTMLElement>('[data-edytor-text="true"]')
					);
					const textIndexOf = (node: Node) => {
						const element = node instanceof Element ? node : node.parentElement;
						const text = element?.closest<HTMLElement>('[data-edytor-text="true"]');
						return text ? editorTexts.indexOf(text) : -1;
					};
					// Mirror of `getYIndex`: resolve a DOM (container, offset) to the
					// part-local model offset — text-node offsets sum preceding
					// siblings' text; element-boundary offsets count child text.
					const yOffsetOf = (container: Node, offset: number) => {
						const element = (
							container instanceof Element ? container : container.parentElement
						)?.closest<HTMLElement>('[data-edytor-text="true"]');
						if (!element) return -1;
						if (element.querySelector('[data-edytor-trailing-newline]')?.contains(container)) {
							return -1;
						}
						const childTextLength = (el: Node, upto: number) => {
							let len = 0;
							for (let i = 0; i < Math.min(upto, el.childNodes.length); i++) {
								len += el.childNodes[i].textContent?.length ?? 0;
							}
							return len;
						};
						const walker = document.createTreeWalker(element, NodeFilter.SHOW_ALL);
						let total = 0;
						for (let node = walker.nextNode(); node; node = walker.nextNode()) {
							if (node === container) {
								return (
									total +
									(node.nodeType === Node.TEXT_NODE
										? Math.min(offset, node.textContent?.length ?? 0)
										: childTextLength(node, offset))
								);
							}
							if (node.nodeType === Node.TEXT_NODE) {
								total += node.textContent?.length ?? 0;
							}
						}
						return container === element ? childTextLength(element, offset) : -1;
					};
					const selection = (
						window as Window & {
							__EDYTOR__?: {
								selection?: {
									state?: {
										yStart: number;
										yEnd: number;
										isCollapsed: boolean;
										startText?: { id: string };
										endText?: { id: string };
									};
								};
							};
						}
					).__EDYTOR__?.selection?.state;
					target.__EDYTOR_DST_EVENTS__?.push({
						type: event.type,
						isTrusted: event.isTrusted,
						cancelable: event.cancelable,
						...(input
							? {
									inputType: input.inputType,
									data: input.data,
									targetRange: targetRange
										? {
												collapsed: targetRange.collapsed,
												startOffset: targetRange.startOffset,
												endOffset: targetRange.endOffset,
												startTextIndex: textIndexOf(targetRange.startContainer),
												endTextIndex: textIndexOf(targetRange.endContainer),
												yStart: yOffsetOf(targetRange.startContainer, targetRange.startOffset),
												yEnd: yOffsetOf(targetRange.endContainer, targetRange.endOffset)
											}
										: null
								}
							: {}),
						...(keyboard ? { key: keyboard.key, isComposing: keyboard.isComposing } : {}),
						...(mouse ? { detail: mouse.detail, button: mouse.button } : {}),
						...(selection
							? {
									modelSelection: {
										yStart: selection.yStart,
										yEnd: selection.yEnd,
										isCollapsed: selection.isCollapsed,
										startTextId: selection.startText?.id ?? null,
										endTextId: selection.endText?.id ?? null
									}
								}
							: {})
					});
				},
				true
			);
		}
	});

export const settleEditor = async (page: Page) => {
	await page.evaluate(
		() =>
			new Promise<void>((resolve) => {
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
			})
	);
	const fixedDelay = Number(process.env.DST_SETTLE_MS);
	if (Number.isFinite(fixedDelay) && fixedDelay >= 0) {
		await page.waitForTimeout(fixedDelay);
		return;
	}

	await page.waitForFunction(
		() => {
			const browserWindow = window as Window & {
				__EDYTOR__?: Record<string, unknown>;
				__EDYTOR_DST_LAST_EVENT_AT__?: number;
			};
			const edytor = browserWindow.__EDYTOR__;
			const hasPendingRepair = Boolean(
				edytor?.structuralKeyFallbackTimer ||
				edytor?.inputFallbackSuppressionTimer ||
				edytor?.observedMutationFallbackSuppressionTimer ||
				edytor?.inputFallbackRepairTimer ||
				edytor?.compositionSelectionRestoreFrame ||
				edytor?.danglingCompositionBlurTimer ||
				edytor?.shouldSuppressNextInputFallback ||
				edytor?.shouldSuppressObservedMutationFallback ||
				edytor?.shouldRepairSuppressedInputFallback ||
				edytor?.isComposing
			);
			const quietFor = performance.now() - (browserWindow.__EDYTOR_DST_LAST_EVENT_AT__ ?? 0);
			return !hasPendingRepair && quietFor >= 50;
		},
		undefined,
		{ polling: 10, timeout: 1_500 }
	);
};

export const captureBrowserSnapshot = (page: Page): Promise<DstBrowserSnapshot> =>
	page.evaluate(() => {
		type RecordedEvent = {
			type: string;
			isTrusted: boolean;
			cancelable: boolean;
			inputType?: string;
			data?: string | null;
			key?: string;
			isComposing?: boolean;
			detail?: number;
			button?: number;
			targetRange?: {
				collapsed: boolean;
				startOffset: number;
				endOffset: number;
				startTextIndex: number;
				endTextIndex: number;
				yStart: number;
				yEnd: number;
			} | null;
			modelSelection?: {
				yStart: number;
				yEnd: number;
				isCollapsed: boolean;
				startTextId: string | null;
				endTextId: string | null;
			};
		};
		type BrowserText = { node?: HTMLElement };
		type BrowserPart = {
			id: string;
			node?: HTMLElement;
			stringContent?: string;
			value?: Array<{ text: string; marks?: Record<string, unknown> }>;
			type?: string;
			data?: Record<string, unknown>;
		};
		type BrowserBlock = {
			id: string;
			type: string;
			data?: Record<string, unknown>;
			path: number[];
			definition?: { void?: boolean; island?: boolean };
			content: BrowserPart[];
			children: BrowserBlock[];
		};
		type BrowserSelectionState = {
			startText?: BrowserText;
			endText?: BrowserText;
			yStart: number;
			yEnd: number;
			isCollapsed: boolean;
			isReversed: boolean;
		};
		type BrowserEdytor = {
			value: unknown;
			defaultType?: string;
			getDefaultBlock?: (parent?: unknown) => string;
			idToText: Map<string, BrowserPart>;
			nodeToText: Map<Node, BrowserPart>;
			root?: { children: BrowserBlock[] };
			undoManager?: {
				undoStack?: unknown[];
				redoStack?: unknown[];
				canUndo?: () => boolean;
				canRedo?: () => boolean;
			};
			selection: {
				state: BrowserSelectionState;
				selectedInlineBlock?: Iterable<{ id: string }>;
				selectedBlocks?: Iterable<{ id: string }>;
			};
		};
		type BrowserWindow = Window & {
			__EDYTOR__?: BrowserEdytor;
			__EDYTOR_DST_EVENTS__?: RecordedEvent[];
		};

		const browserWindow = window as BrowserWindow;
		const edytor = browserWindow.__EDYTOR__;
		const editor = document.querySelector<HTMLElement>('[data-edytor]');
		if (!edytor || !editor) {
			throw new Error('DST capture: missing editor runtime');
		}

		const textElements = Array.from(
			editor.querySelectorAll<HTMLElement>('[data-edytor-text="true"]')
		);
		const blockElements = Array.from(
			editor.querySelectorAll<HTMLElement>('[data-edytor-block="true"]')
		);
		const readDomText = (textElement: HTMLElement) => {
			const fragment = textElement.cloneNode(true) as HTMLElement;
			fragment
				.querySelectorAll('[data-edytor-trailing-newline]')
				.forEach((marker) => marker.remove());
			const value = fragment.textContent ?? '';
			return textElement.dataset.edytorTextEmpty === 'true' && value === '\u200b' ? '' : value;
		};
		const endpoint = (node: Node | null, offset: number): NativeEndpoint | null => {
			if (!node) return null;
			if (node !== editor && !editor.contains(node)) return { kind: 'outside' };
			const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
			const textElement = element?.closest<HTMLElement>('[data-edytor-text="true"]');
			if (textElement) {
				const textIndex = textElements.indexOf(textElement);
				if (textIndex >= 0) {
					try {
						const range = document.createRange();
						range.selectNodeContents(textElement);
						range.setEnd(node, offset);
						const fragment = document.createElement('span');
						fragment.append(range.cloneContents());
						fragment
							.querySelectorAll('[data-edytor-trailing-newline]')
							.forEach((marker) => marker.remove());
						const value = fragment.textContent ?? '';
						return {
							kind: 'text',
							textIndex,
							offset:
								textElement.dataset.edytorTextEmpty === 'true' && value === '\u200b'
									? 0
									: value.length
						};
					} catch {
						return { kind: 'outside' };
					}
				}
			}

			let before: NativeTextPoint | null = null;
			let after: NativeTextPoint | null = null;
			for (let textIndex = 0; textIndex < textElements.length; textIndex++) {
				const candidate = textElements[textIndex];
				const range = document.createRange();
				range.selectNodeContents(candidate);
				try {
					const comparison = range.comparePoint(node, offset);
					if (comparison > 0) {
						before = { textIndex, offset: readDomText(candidate).length };
						continue;
					}
					if (comparison < 0) {
						after = { textIndex, offset: 0 };
						break;
					}
				} catch {
					return { kind: 'outside' };
				}
			}
			return { kind: 'boundary', before, after };
		};

		const selectedNodeFromRange = (range: Range | null) => {
			if (
				!range ||
				range.startContainer !== range.endContainer ||
				range.endOffset !== range.startOffset + 1
			) {
				return null;
			}
			const selected = range.startContainer.childNodes[range.startOffset];
			const selectedElement = selected instanceof Element ? selected : selected?.parentElement;
			const inline = selectedElement?.closest<HTMLElement>('[data-edytor-inline-block]');
			if (inline?.dataset.edytorId) {
				return { kind: 'inline' as const, id: inline.dataset.edytorId };
			}
			const block = selectedElement?.closest<HTMLElement>('[data-edytor-block="true"]');
			return block?.dataset.edytorId
				? { kind: 'block' as const, id: block.dataset.edytorId }
				: null;
		};
		const describeBoundary = (node: Node | null, offset: number) => {
			if (!node) return 'null';
			const describeNode = (candidate: Node | undefined) => {
				if (!candidate) return '-';
				if (candidate.nodeType === Node.TEXT_NODE) {
					return `#text(${JSON.stringify(candidate.textContent?.slice(0, 40) ?? '')})`;
				}
				if (candidate.nodeType === Node.COMMENT_NODE) return '#comment';
				const element = candidate as Element;
				return `${element.tagName?.toLowerCase() ?? candidate.nodeName}${
					element instanceof HTMLElement && element.dataset.edytorId
						? `[${element.dataset.edytorId}]`
						: ''
				}`;
			};
			return `${describeNode(node)}@${offset}/${node.childNodes.length} prev=${describeNode(
				node.childNodes[offset - 1]
			)} next=${describeNode(node.childNodes[offset])}`;
		};

		const selection = edytor.selection.state;
		const startTextIndex = selection.startText?.node
			? textElements.indexOf(selection.startText.node)
			: -1;
		const endTextIndex = selection.endText?.node
			? textElements.indexOf(selection.endText.node)
			: -1;
		const native = window.getSelection();
		const placeholderBlockIndexes = Array.from(
			editor.querySelectorAll<HTMLElement>('[data-edytor-text-placeholder]')
		).map((placeholder) => {
			const block = placeholder.closest<HTMLElement>('[data-edytor-block="true"]');
			return block ? blockElements.indexOf(block) : -1;
		});
		// Foreign-residual accounting: the same marker names the runner's
		// foreignMutation payloads use, so leftover damage is attributable
		// to a managed surface. Strict surfaces (text/mark/inlineBlock)
		// must strip them; tolerant surfaces (block/root) may keep them —
		// either way the residue is compared across engines.
		const foreignMarkerAttributes = ['data-dst-foreign', 'data-gramm', 'title'];
		const foreignAttrs: string[] = [];
		const managedSurfaces: Array<[string, HTMLElement[]]> = [
			['text', textElements],
			['mark', Array.from(editor.querySelectorAll<HTMLElement>('[data-edytor-mark]'))],
			[
				'inlineBlock',
				Array.from(editor.querySelectorAll<HTMLElement>('[data-edytor-inline-block]'))
			],
			['block', blockElements]
		];
		for (const [surface, elements] of managedSurfaces) {
			elements.forEach((element, index) => {
				for (const name of foreignMarkerAttributes) {
					if (element.hasAttribute(name)) {
						foreignAttrs.push(`${surface}:${index}:${name}`);
					}
				}
			});
		}
		for (const name of foreignMarkerAttributes) {
			if (editor.hasAttribute(name)) {
				foreignAttrs.push(`root:0:${name}`);
			}
		}
		const foreignNodes = Array.from(
			editor.querySelectorAll<HTMLElement>('[data-dst-foreign-node]')
		).map((element) => {
			const text = element.closest<HTMLElement>('[data-edytor-text="true"]');
			const block = element.closest<HTMLElement>('[data-edytor-block="true"]');
			const at = text
				? `text:${textElements.indexOf(text)}`
				: block
					? `block:${blockElements.indexOf(block)}`
					: 'root';
			return `${element.tagName.toLowerCase()}@${at}`;
		});
		const events = browserWindow.__EDYTOR_DST_EVENTS__?.splice(0) ?? [];
		const model = {
			blocks: [] as Array<{
				id: string;
				type: string;
				data: Record<string, unknown>;
				contentKinds: Array<'text' | 'inline'>;
				parts: Array<
					| { kind: 'text'; id: string; runs: Array<{ text: string; marks: unknown }> }
					| { kind: 'inline'; id: string; type: string; data: Record<string, unknown> }
				>;
				path: number[];
				void: boolean;
				island: boolean;
				renderedTextCount: number;
			}>,
			defaultType: edytor.defaultType ?? null,
			rootDefaultType: edytor.getDefaultBlock?.(edytor.root) ?? null,
			texts: [] as string[],
			textIds: [] as string[],
			renderedTexts: [] as string[],
			renderedTextIds: [] as string[],
			inlineIds: [] as string[]
		};
		const visitBlock = (block: BrowserBlock, hiddenByVoid = false) => {
			const contentKinds: Array<'text' | 'inline'> = [];
			const parts: Array<
				| { kind: 'text'; id: string; runs: Array<{ text: string; marks: unknown }> }
				| { kind: 'inline'; id: string; type: string; data: Record<string, unknown> }
			> = [];
			const isRendered = !hiddenByVoid && !block.definition?.void;
			let renderedTextCount = 0;
			for (const part of block.content) {
				if ('stringContent' in part && typeof part.stringContent === 'string') {
					contentKinds.push('text');
					parts.push({
						kind: 'text',
						id: part.id,
						runs: (part.value ?? [{ text: part.stringContent }]).map((run) => ({
							text: run.text,
							marks: run.marks ?? null
						}))
					});
					model.texts.push(part.stringContent);
					model.textIds.push(part.id);
					if (isRendered) {
						renderedTextCount += 1;
						model.renderedTexts.push(part.stringContent);
						model.renderedTextIds.push(part.id);
					}
				} else {
					contentKinds.push('inline');
					parts.push({
						kind: 'inline',
						id: part.id,
						type: part.type ?? 'inline',
						data: JSON.parse(JSON.stringify(part.data ?? {})) as Record<string, unknown>
					});
					model.inlineIds.push(part.id);
				}
			}
			model.blocks.push({
				id: block.id,
				type: block.type,
				data: JSON.parse(JSON.stringify(block.data ?? {})) as Record<string, unknown>,
				contentKinds,
				parts,
				path: [...(block.path ?? [])],
				void: Boolean(block.definition?.void),
				island: Boolean(block.definition?.island),
				renderedTextCount
			});
			for (const child of block.children) {
				visitBlock(child, hiddenByVoid || Boolean(block.definition?.void));
			}
		};
		for (const block of edytor.root?.children ?? []) visitBlock(block);
		const selectedInlineIds = Array.from(
			edytor.selection.selectedInlineBlock ?? [],
			({ id }) => id
		);
		const selectedBlockIds = Array.from(edytor.selection.selectedBlocks ?? [], ({ id }) => id);
		const nativeRange = native && native.rangeCount > 0 ? native.getRangeAt(0) : null;
		const nativeIsReversed = Boolean(
			native?.anchorNode &&
			native.focusNode &&
			(native.anchorNode === native.focusNode
				? native.focusOffset < native.anchorOffset
				: native.anchorNode.compareDocumentPosition(native.focusNode) &
					Node.DOCUMENT_POSITION_PRECEDING)
		);

		return {
			value: JSON.parse(JSON.stringify(edytor.value)),
			history: {
				undoDepth: edytor.undoManager?.undoStack?.length ?? 0,
				redoDepth: edytor.undoManager?.redoStack?.length ?? 0,
				canUndo: edytor.undoManager?.canUndo?.() ?? false,
				canRedo: edytor.undoManager?.canRedo?.() ?? false
			},
			model,
			dom: {
				blockCount: blockElements.length,
				inlineIds: Array.from(
					new Set(
						Array.from(
							editor.querySelectorAll<HTMLElement>('[data-edytor-inline-block]'),
							(inline) => inline.dataset.edytorId ?? ''
						).filter(Boolean)
					)
				),
				texts: textElements.map(readDomText),
				textIds: textElements.map((text) => text.dataset.edytorId ?? ''),
				textBindings: textElements.map((textElement) => {
					const dataId = textElement.dataset.edytorId ?? '';
					const byNode = edytor.nodeToText.get(textElement);
					const byId = edytor.idToText.get(dataId);
					return {
						dataId,
						nodeMapId: byNode?.id ?? null,
						idMapId: byId?.id ?? null,
						idMapNodeMatches: byId?.node === textElement
					};
				}),
				emptyAttributes: textElements.map(
					(text) => text.getAttribute('data-edytor-text-empty') === 'true'
				),
				placeholderBlockIndexes,
				blockTypeAttrs: blockElements.map((block) => block.getAttribute('data-edytor-type')),
				markAttrs: Array.from(editor.querySelectorAll<HTMLElement>('[data-edytor-mark]'), (mark) =>
					mark.getAttribute('data-edytor-mark')
				),
				foreignResidual: { nodes: foreignNodes, attrs: foreignAttrs }
			},
			selection:
				selectedInlineIds.length > 0
					? { kind: 'inline' as const, ids: selectedInlineIds }
					: selectedBlockIds.length > 0
						? { kind: 'block' as const, ids: selectedBlockIds }
						: startTextIndex >= 0 && endTextIndex >= 0
							? {
									kind: 'text' as const,
									startTextIndex,
									endTextIndex,
									yStart: selection.yStart,
									yEnd: selection.yEnd,
									isCollapsed: selection.isCollapsed,
									isReversed: selection.isReversed
								}
							: null,
			nativeSelection:
				native && nativeRange
					? {
							anchor: endpoint(native.anchorNode, native.anchorOffset),
							focus: endpoint(native.focusNode, native.focusOffset),
							start: endpoint(nativeRange.startContainer, nativeRange.startOffset),
							end: endpoint(nativeRange.endContainer, nativeRange.endOffset),
							isCollapsed: native.isCollapsed,
							isReversed: nativeIsReversed,
							selectedNode: selectedNodeFromRange(nativeRange),
							debug: {
								anchor: describeBoundary(native.anchorNode, native.anchorOffset),
								focus: describeBoundary(native.focusNode, native.focusOffset)
							}
						}
					: null,
			events
		};
	});

const isText = (item: JsonText | JsonInline): item is JsonText => 'text' in item;

const isWellFormedUtf16 = (value: string): boolean => {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
			index += 1;
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			return false;
		}
	}
	return true;
};

const flattenBlocks = (root: JsonRoot): JsonBlock[] => {
	const output: JsonBlock[] = [];
	const visit = (block: JsonBlock) => {
		output.push(block);
		for (const child of block.children ?? []) visit(child);
	};
	for (const child of root.children) visit(child);
	return output;
};

export const flattenTextSegments = (
	root: JsonRoot,
	liveBlocks: DstBrowserSnapshot['model']['blocks']
): string[] => {
	const segments: string[] = [];
	for (const [blockIndex, block] of flattenBlocks(root).entries()) {
		if (!liveBlocks[blockIndex]?.contentKinds.includes('text')) continue;
		let current = '';
		for (const item of block.content ?? []) {
			if (isText(item)) {
				current += item.text;
			} else {
				segments.push(current);
				current = '';
			}
		}
		segments.push(current);
	}
	return segments;
};

const areEquivalentTextPoints = (
	left: NativeTextPoint,
	right: NativeTextPoint,
	segments: string[]
): boolean => {
	if (left.textIndex === right.textIndex && left.offset === right.offset) return true;
	return (
		(left.textIndex + 1 === right.textIndex &&
			left.offset === segments[left.textIndex]?.length &&
			right.offset === 0) ||
		(right.textIndex + 1 === left.textIndex &&
			right.offset === segments[right.textIndex]?.length &&
			left.offset === 0)
	);
};

/**
 * Model selection offsets are UTF-16 positions into the rendered text and
 * may legally sit inside a grapheme cluster — e.g. between the two halves
 * of a surrogate pair — when a programmatic write (the DST installer, an
 * undo snapshot restore, a mutation-repair caret restore) asked for that
 * exact offset. The DOM cannot always represent such a caret: engines
 * normalize the endpoint to an enclosing cluster boundary, and whether
 * they snap left, snap right, or keep the raw offset is engine- and
 * timing-dependent (Chromium may even hold the raw offset on `addRange`
 * and normalize it on a later `setBaseAndExtent`). When the expected point
 * is mid-cluster, the native endpoint is equivalent at the raw offset or
 * at either edge of the enclosing cluster.
 */
const graphemeClusterBounds = (
	value: string | undefined,
	offset: number
): [number, number] | null => {
	if (!value || offset <= 0 || offset >= value.length) return null;
	const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
	for (const part of segmenter.segment(value)) {
		if (offset > part.index && offset < part.index + part.segment.length) {
			return [part.index, part.index + part.segment.length];
		}
	}
	return null;
};

const endpointMatches = (
	endpoint: NativeEndpoint | null,
	expected: NativeTextPoint,
	segments: string[]
): boolean => {
	if (!endpoint || endpoint.kind === 'outside') return false;
	if (endpoint.kind === 'text') {
		if (areEquivalentTextPoints(endpoint, expected, segments)) return true;
		if (endpoint.textIndex === expected.textIndex) {
			const cluster = graphemeClusterBounds(segments[expected.textIndex], expected.offset);
			if (cluster && (endpoint.offset === cluster[0] || endpoint.offset === cluster[1])) {
				return true;
			}
		}
		return false;
	}
	return [endpoint.before, endpoint.after].some(
		(candidate) => candidate && areEquivalentTextPoints(candidate, expected, segments)
	);
};

const assertSelectionParity = (
	engine: string,
	selection: DstTextSelection,
	native: NonNullable<DstBrowserSnapshot['nativeSelection']>,
	segments: string[]
) => {
	if (
		!endpointMatches(
			native.start,
			{ textIndex: selection.startTextIndex, offset: selection.yStart },
			segments
		) ||
		!endpointMatches(
			native.end,
			{ textIndex: selection.endTextIndex, offset: selection.yEnd },
			segments
		) ||
		native.isCollapsed !== selection.isCollapsed ||
		native.isReversed !== selection.isReversed
	) {
		fail('selection-model-dom-mismatch', engine, 'model and native selection disagree', {
			selection,
			native
		});
	}
};

const nativeFullyOutside = (snapshot: DstBrowserSnapshot): boolean =>
	snapshot.nativeSelection !== null &&
	snapshot.nativeSelection.start.kind === 'outside' &&
	snapshot.nativeSelection.end.kind === 'outside';

const sameModelSelection = (a: DstSelection | null, b: DstSelection | null): boolean => {
	if (!a || !b || a.kind !== b.kind) return false;
	if (a.kind === 'text' && b.kind === 'text') {
		return (
			a.startTextIndex === b.startTextIndex &&
			a.endTextIndex === b.endTextIndex &&
			a.yStart === b.yStart &&
			a.yEnd === b.yEnd &&
			a.isCollapsed === b.isCollapsed &&
			a.isReversed === b.isReversed
		);
	}
	return (
		a.kind !== 'text' &&
		b.kind !== 'text' &&
		a.ids.length === b.ids.length &&
		a.ids.every((id, i) => id === b.ids[i])
	);
};

/**
 * Whether a native selection that escaped outside the editor is the legal
 * "sticky caret" outcome of a pointer action. Pointer gestures let the
 * browser own native placement, and a hit on non-editable chrome (e.g. the
 * pixel beside a zero-width empty text) can anchor the range outside the
 * editable root — WebKit does this on shift-click. The editor must IGNORE
 * outside anchors; the proof is the model selection keeping its previous
 * position. Anything else — a half-outside range, a moved model caret — is
 * still a parity failure.
 */
export const isStickyOutsideEscape = (
	action: DstAction,
	before: DstBrowserSnapshot,
	after: DstBrowserSnapshot
): boolean => {
	if (
		action.kind !== 'pointerClick' &&
		action.kind !== 'shiftClick' &&
		action.kind !== 'pointerDoubleClick' &&
		action.kind !== 'pointerDrag'
	) {
		return false;
	}
	return nativeFullyOutside(after) && sameModelSelection(before.selection, after.selection);
};

/**
 * Whether a snapshot still shows an earlier sticky escape: the native
 * range is still fully outside AND the model selection is still the one
 * recorded when the escape was tolerated. A `preserve` selection step
 * carries the escape forward untouched — this is the same physical event,
 * not a new divergence.
 */
export const isPersistedStickyEscape = (
	sticky: DstSelection,
	snapshot: DstBrowserSnapshot
): boolean => nativeFullyOutside(snapshot) && sameModelSelection(sticky, snapshot.selection);

export const assertBrowserSnapshot = (
	engine: string,
	snapshot: DstBrowserSnapshot,
	options: { requireSelection?: boolean; allowOutsideNative?: boolean } = {}
) => {
	if (!Array.isArray(snapshot.value.children)) {
		fail('invalid-root', engine, 'serialized root has no children array', snapshot.value);
	}

	const ids = new Set<string>();
	const blocks = flattenBlocks(snapshot.value);
	for (const block of blocks) {
		if (!block.type) fail('invalid-block-type', engine, 'block has no type', block);
		if (block.id) {
			if (ids.has(block.id)) fail('duplicate-id', engine, `duplicate id ${block.id}`);
			ids.add(block.id);
		}
		const content = block.content ?? [];
		for (let index = 0; index < content.length; index++) {
			const item = content[index];
			if (isText(item)) {
				if (typeof item.text !== 'string' || !isWellFormedUtf16(item.text)) {
					fail('invalid-text', engine, 'text is not a well-formed string', item);
				}
				JSON.stringify(item.marks ?? {});
				continue;
			}
			if (item.id) {
				if (ids.has(item.id)) fail('duplicate-id', engine, `duplicate id ${item.id}`);
				ids.add(item.id);
			}
		}
	}

	const liveIds = new Set<string>();
	for (const block of snapshot.model.blocks) {
		if (liveIds.has(block.id)) fail('duplicate-id', engine, `duplicate live id ${block.id}`);
		liveIds.add(block.id);
		if (
			block.contentKinds.length > 0 &&
			(block.contentKinds[0] !== 'text' || block.contentKinds.at(-1) !== 'text')
		) {
			fail(
				'content-edge-invariant',
				engine,
				'live content does not start and end with text',
				block
			);
		}
		for (let index = 1; index < block.contentKinds.length; index++) {
			if (block.contentKinds[index] === block.contentKinds[index - 1]) {
				fail('content-alternation-invariant', engine, 'live content kinds do not alternate', block);
			}
		}
	}
	for (const id of [...snapshot.model.textIds, ...snapshot.model.inlineIds]) {
		if (liveIds.has(id)) fail('duplicate-id', engine, `duplicate live id ${id}`);
		liveIds.add(id);
	}

	const segments = snapshot.model.renderedTexts;
	if (snapshot.model.blocks.length !== blocks.length) {
		fail('model-serialization-block-count', engine, 'live and serialized block counts differ', {
			serialized: blocks.length,
			live: snapshot.model.blocks.length
		});
	}
	const serializedBlocks = blocks.map((block) => ({ id: block.id ?? null, type: block.type }));
	const liveBlocks = snapshot.model.blocks.map((block) => ({ id: block.id, type: block.type }));
	if (JSON.stringify(serializedBlocks) !== JSON.stringify(liveBlocks)) {
		fail(
			'model-serialization-block-projection',
			engine,
			'serialized block identity, type, or order differs from the live model',
			{
				serialized: serializedBlocks,
				live: liveBlocks
			}
		);
	}
	const serializedSegments = flattenTextSegments(snapshot.value, snapshot.model.blocks);
	if (JSON.stringify(serializedSegments) !== JSON.stringify(snapshot.model.texts)) {
		fail(
			'model-serialization-text-projection',
			engine,
			'serialized text differs from the live model',
			{
				serialized: serializedSegments,
				live: snapshot.model.texts
			}
		);
	}
	const serializedInlineIds = blocks.flatMap((block) =>
		(block.content ?? []).flatMap((item) => (isText(item) ? [] : [item.id ?? null]))
	);
	if (JSON.stringify(serializedInlineIds) !== JSON.stringify(snapshot.model.inlineIds)) {
		fail(
			'model-serialization-inline-projection',
			engine,
			'serialized inline identities differ from the live model',
			{
				serialized: serializedInlineIds,
				live: snapshot.model.inlineIds
			}
		);
	}
	if (snapshot.dom.blockCount !== snapshot.model.blocks.length) {
		fail('dom-block-count', engine, 'DOM block count differs from the model', {
			model: snapshot.model.blocks.length,
			dom: snapshot.dom.blockCount
		});
	}
	const expectedBlockTypes = snapshot.model.blocks.map((block) => block.type);
	if (JSON.stringify(snapshot.dom.blockTypeAttrs) !== JSON.stringify(expectedBlockTypes)) {
		fail(
			'dom-block-type-attribute',
			engine,
			'DOM block type attributes differ from the model (attribute healing incomplete)',
			{
				model: expectedBlockTypes,
				dom: snapshot.dom.blockTypeAttrs
			}
		);
	}
	if (JSON.stringify(snapshot.dom.inlineIds) !== JSON.stringify(snapshot.model.inlineIds)) {
		fail('dom-inline-projection', engine, 'DOM inline identities differ from the model', {
			model: snapshot.model.inlineIds,
			dom: snapshot.dom.inlineIds
		});
	}
	if (JSON.stringify(snapshot.dom.texts) !== JSON.stringify(segments)) {
		fail('dom-text-projection', engine, 'DOM text differs from live model text', {
			model: segments,
			dom: snapshot.dom.texts
		});
	}
	if (JSON.stringify(snapshot.dom.textIds) !== JSON.stringify(snapshot.model.renderedTextIds)) {
		fail('dom-text-identities', engine, 'DOM text identities differ from rendered model text', {
			model: snapshot.model.renderedTextIds,
			dom: snapshot.dom.textIds
		});
	}
	// Strict managed surfaces (text, mark, and inline-block elements) strip
	// foreign attributes outright — a DST marker left on one means the heal
	// missed. Tolerant surfaces (blocks, plugin chrome, the root) may
	// legitimately keep foreign attrs; their residue is covered by the
	// cross-engine repair signature instead.
	const strictForeignAttrs = snapshot.dom.foreignResidual.attrs.filter((entry) =>
		/^(text|mark|inlineBlock):/.test(entry)
	);
	if (strictForeignAttrs.length > 0) {
		fail(
			'foreign-attribute-survived',
			engine,
			'a foreign attribute survived on a strict managed surface',
			{ residual: strictForeignAttrs }
		);
	}
	const invalidTextBinding = snapshot.dom.textBindings.find(
		(binding) =>
			binding.nodeMapId !== binding.dataId ||
			binding.idMapId !== binding.dataId ||
			!binding.idMapNodeMatches
	);
	if (invalidTextBinding) {
		fail('dom-text-binding', engine, 'a rendered text node is bound to a stale model wrapper', {
			binding: invalidTextBinding,
			bindings: snapshot.dom.textBindings
		});
	}
	const expectedEmpty = segments.map((text) => text.length === 0);
	if (JSON.stringify(snapshot.dom.emptyAttributes) !== JSON.stringify(expectedEmpty)) {
		fail('dom-empty-attribute', engine, 'empty text attributes are stale', {
			expected: expectedEmpty,
			actual: snapshot.dom.emptyAttributes
		});
	}
	const placeholderCounts = new Map<number, number>();
	for (const index of snapshot.dom.placeholderBlockIndexes) {
		placeholderCounts.set(index, (placeholderCounts.get(index) ?? 0) + 1);
	}
	for (const [blockIndex, count] of placeholderCounts) {
		if (blockIndex < 0 || count > 1) {
			fail('duplicate-placeholder', engine, 'a block has duplicate or detached placeholders', {
				blockIndex,
				count
			});
		}
	}

	if (options.requireSelection && !snapshot.selection) {
		fail('missing-editor-selection', engine, 'the scheduled input lost the editor selection', {
			native: snapshot.nativeSelection
		});
	}

	if (snapshot.selection?.kind === 'text') {
		const selection = snapshot.selection;
		const startLength = segments[selection.startTextIndex]?.length;
		const endLength = segments[selection.endTextIndex]?.length;
		if (
			startLength === undefined ||
			endLength === undefined ||
			selection.yStart < 0 ||
			selection.yStart > startLength ||
			selection.yEnd < 0 ||
			selection.yEnd > endLength
		) {
			fail('selection-out-of-bounds', engine, 'model selection is outside live text', {
				selection,
				segments
			});
		}
		// A native range that escaped fully outside the editor after a
		// pointer action is the browser owning placement (sticky caret) —
		// the caller's `allowOutsideNative` marks that legal outcome.
		const nativeEscaped = options.allowOutsideNative === true && nativeFullyOutside(snapshot);
		if (snapshot.nativeSelection && !nativeEscaped) {
			assertSelectionParity(engine, selection, snapshot.nativeSelection, segments);
		} else if (options.requireSelection && !snapshot.nativeSelection) {
			fail('missing-native-selection', engine, 'text selection has no native DOM range', selection);
		}
	} else if (snapshot.selection) {
		const nativeNode = snapshot.nativeSelection?.selectedNode ?? null;
		const nativeEscaped = options.allowOutsideNative === true && nativeFullyOutside(snapshot);
		if (
			snapshot.nativeSelection &&
			!nativeEscaped &&
			(!nativeNode ||
				nativeNode.kind !== snapshot.selection.kind ||
				!snapshot.selection.ids.includes(nativeNode.id))
		) {
			fail('selection-kind-mismatch', engine, 'model and native node selection kinds differ', {
				selection: snapshot.selection,
				native: snapshot.nativeSelection
			});
		}
	}
};

const canonicalizeJsonValue = (value: unknown): unknown => {
	if (Array.isArray(value)) return value.map(canonicalizeJsonValue);
	if (value === null || typeof value !== 'object') return value;
	const object = value as Record<string, unknown>;
	return Object.fromEntries(
		Object.keys(object)
			.sort()
			.map((key) => [key, canonicalizeJsonValue(object[key])])
	);
};

type CanonicalContext = { actorIds: Map<string, string> };

const canonicalActorId = (context: CanonicalContext, actorId: string): string => {
	const existing = context.actorIds.get(actorId);
	if (existing) return existing;
	const canonical = `actor-${context.actorIds.size}`;
	context.actorIds.set(actorId, canonical);
	return canonical;
};

const canonicalizeAttribution = (value: unknown, context: CanonicalContext): unknown => {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		return canonicalizeJsonValue(value);
	}
	const attribution = value as Record<string, unknown>;
	const entries = Object.keys(attribution)
		.sort()
		.flatMap((key) => {
			const entry = attribution[key];
			if ((key === 'insert' || key === 'delete') && Array.isArray(entry)) {
				if (entry.length === 0) return [];
				return [
					[
						key,
						entry.map((actor) =>
							typeof actor === 'string'
								? canonicalActorId(context, actor)
								: canonicalizeJsonValue(actor)
						)
					]
				];
			}
			if (key === 'format' && entry && typeof entry === 'object' && !Array.isArray(entry)) {
				const formats = entry as Record<string, unknown>;
				const canonicalFormats = Object.fromEntries(
					Object.keys(formats)
						.sort()
						.flatMap((mark) => {
							const actors = formats[mark];
							if (Array.isArray(actors) && actors.length === 0) return [];
							return [
								[
									mark,
									Array.isArray(actors)
										? actors.map((actor) =>
												typeof actor === 'string'
													? canonicalActorId(context, actor)
													: canonicalizeJsonValue(actor)
											)
										: canonicalizeJsonValue(actors)
								]
							];
						})
				);
				if (Object.keys(canonicalFormats).length === 0) return [];
				return [[key, canonicalFormats]];
			}
			return [[key, canonicalizeJsonValue(entry)]];
		});
	return entries.length === 0 ? undefined : Object.fromEntries(entries);
};

const canonicalizeContent = (
	item: JsonText | JsonInline,
	context: CanonicalContext,
	options: { omitMarks?: boolean } = {}
): Record<string, unknown> => {
	const isTextItem = isText(item);
	return Object.fromEntries(
		Object.keys(item)
			.filter(
				(key) =>
					!(key === 'id' && !isTextItem) &&
					!(options.omitMarks && (key === 'marks' || key === 'attribution'))
			)
			.sort()
			.flatMap((key) => {
				const value =
					key === 'attribution'
						? canonicalizeAttribution((item as Record<string, unknown>)[key], context)
						: canonicalizeJsonValue((item as Record<string, unknown>)[key]);
				return value === undefined ? [] : [[key, value]];
			})
	);
};

const canonicalizeSemanticContent = (
	content: Array<JsonText | JsonInline>,
	context: CanonicalContext
): unknown[] => {
	const canonical: unknown[] = [];
	for (const item of content) {
		const current = canonicalizeContent(item, context);
		const previous = canonical.at(-1);
		if (isText(item) && previous && typeof previous === 'object' && 'text' in previous) {
			const previousText = previous as Record<string, unknown>;
			const previousMetadata = { ...previousText, text: '' };
			const currentMetadata = { ...current, text: '' };
			if (JSON.stringify(previousMetadata) === JSON.stringify(currentMetadata)) {
				previousText.text = String(previousText.text ?? '') + item.text;
				continue;
			}
		}
		canonical.push(current);
	}
	return canonical;
};

const canonicalizeStructuralContent = (
	content: Array<JsonText | JsonInline>,
	context: CanonicalContext
): unknown[] => {
	const canonical: unknown[] = [];
	let text = '';
	let hasText = false;
	const flushText = () => {
		if (!hasText) return;
		canonical.push({ text });
		text = '';
		hasText = false;
	};
	for (const item of content) {
		if (isText(item)) {
			text += item.text;
			hasText = true;
		} else {
			flushText();
			canonical.push(canonicalizeContent(item, context, { omitMarks: true }));
		}
	}
	flushText();
	return canonical;
};

const canonicalizeBlock = (
	block: JsonBlock,
	context: CanonicalContext,
	options: { omitMarks?: boolean } = {}
): unknown =>
	Object.fromEntries(
		Object.keys(block)
			.filter((key) => key !== 'id')
			.sort()
			.map((key) => {
				if (key === 'content') {
					return [
						key,
						options.omitMarks
							? canonicalizeStructuralContent(block.content ?? [], context)
							: canonicalizeSemanticContent(block.content ?? [], context)
					];
				}
				if (key === 'children') {
					return [
						key,
						(block.children ?? []).map((child) => canonicalizeBlock(child, context, options))
					];
				}
				return [key, canonicalizeJsonValue((block as Record<string, unknown>)[key])];
			})
	);

export const canonicalDocumentValue = (
	root: JsonRoot,
	options: { omitMarks?: boolean } = {}
): unknown => {
	const context: CanonicalContext = { actorIds: new Map() };
	return Object.fromEntries(
		Object.keys(root)
			.sort()
			.map((key) =>
				key === 'children'
					? [key, root.children.map((block) => canonicalizeBlock(block, context, options))]
					: [key, canonicalizeJsonValue((root as Record<string, unknown>)[key])]
			)
	);
};

export const semanticSignature = (snapshot: DstBrowserSnapshot): string =>
	JSON.stringify(canonicalDocumentValue(snapshot.value));

export const structureSignature = (snapshot: DstBrowserSnapshot): string =>
	JSON.stringify(canonicalDocumentValue(snapshot.value, { omitMarks: true }));

/**
 * Managed-DOM repair state that is NOT derivable from the model alone:
 * healed block-type attributes, the live mark-element projection, and any
 * foreign residue a `foreignMutation` step left behind. Foreign DOM is
 * outside the semantic signature by definition — this is the honest
 * cross-engine channel for repair divergence.
 */
export const domRepairSignature = (snapshot: DstBrowserSnapshot): string =>
	JSON.stringify({
		blockTypes: snapshot.dom.blockTypeAttrs,
		marks: snapshot.dom.markAttrs,
		foreign: snapshot.dom.foreignResidual
	});

export const selectionSignature = (snapshot: DstBrowserSnapshot): string | null =>
	snapshot.selection === null
		? null
		: snapshot.selection.kind === 'text'
			? JSON.stringify(snapshot.selection)
			: JSON.stringify({
					kind: snapshot.selection.kind,
					indexes: snapshot.selection.ids.map((id) =>
						snapshot.selection?.kind === 'inline'
							? snapshot.model.inlineIds.indexOf(id)
							: snapshot.model.blocks.findIndex((block) => block.id === id)
					)
				});

const POINTER_INPUT_KINDS = new Set([
	'pointerClick',
	'pointerDrag',
	'pointerDoubleClick',
	'shiftClick'
]);

/**
 * The synthetic event sequence a synthetic action must deliver to the
 * editor, checked as an in-order subsequence over the recorder's
 * `isTrusted:false` events. Proves the dispatched input reached the page —
 * we never fake `isTrusted`.
 */
const expectedSyntheticSequence = (
	action: DstAction
): Array<{ type: string; inputType?: string }> => {
	switch (action.kind) {
		case 'composition':
			return [
				{ type: 'compositionstart' },
				...action.updates.flatMap(() => [
					{ type: 'compositionupdate' },
					{ type: 'beforeinput', inputType: 'insertCompositionText' }
				]),
				...(action.commitViaBeforeinput
					? [{ type: 'beforeinput', inputType: 'insertFromComposition' }]
					: []),
				{ type: 'compositionend' }
			];
		case 'paste':
			return [{ type: 'paste' }];
		case 'cut':
			return [{ type: 'cut' }];
		case 'copy':
			return [{ type: 'copy' }];
		case 'drop':
			// Accepted foreign drops are consumed by onDrop's
			// dispatchInsertFromDrop — a synthetic `beforeinput` (a plain
			// Event carrying inputType via defineProperty, so the recorder
			// sees no inputType) is part of the expected delivery.
			return [{ type: 'dragover' }, { type: 'drop' }, { type: 'beforeinput' }];
		case 'foreignMutation':
			// Scripted DOM writes dispatch no events — the input-event guard
			// in assertTrustedAction is the real check for this action.
			return [];
		default:
			return [];
	}
};

const assertSyntheticSequence = (engine: string, action: DstAction, events: DstEvent[]) => {
	const expected = expectedSyntheticSequence(action);
	const synthetic = events.filter((event) => !event.isTrusted);
	let cursor = 0;
	const missing: Array<{ type: string; inputType?: string }> = [];
	for (const want of expected) {
		let found = false;
		while (cursor < synthetic.length) {
			const candidate = synthetic[cursor++];
			if (
				candidate.type === want.type &&
				(!want.inputType || candidate.inputType === want.inputType)
			) {
				found = true;
				break;
			}
		}
		if (!found) missing.push(want);
	}
	if (missing.length > 0) {
		fail(
			'synthetic-input-not-delivered',
			engine,
			`action ${action.kind} did not deliver the expected synthetic event sequence`,
			{ action, missing, expected, events }
		);
	}
};

export const assertTrustedAction = (engine: string, action: DstAction, events: DstEvent[]) => {
	if (inputClassOf(action) === 'synthetic') {
		assertSyntheticSequence(engine, action, events);
		if (action.kind === 'foreignMutation') {
			// Foreign DOM damage must be absorbed by the mutation observer's
			// repair paths — a beforeinput/input event here means the
			// synthetic write was routed through the input pipeline, which
			// the honest-channel contract forbids.
			const inputEvent = events.find(
				(event) => event.type === 'beforeinput' || event.type === 'input'
			);
			if (inputEvent) {
				fail(
					'foreign-mutation-emitted-input',
					engine,
					'foreign DOM mutation produced an input event',
					{ action, event: inputEvent, events }
				);
			}
		}
		return;
	}
	const trusted = events.filter((event) => event.isTrusted);
	const expectedEventTypes =
		action.kind === 'insertText'
			? ['beforeinput', 'input']
			: POINTER_INPUT_KINDS.has(action.kind)
				? ['pointerdown', 'mousedown']
				: ['keydown'];
	const hasTrustedInput = trusted.some((event) => expectedEventTypes.includes(event.type));
	if (!hasTrustedInput) {
		fail(
			'untrusted-input-path',
			engine,
			`action ${action.kind} produced no trusted browser event`,
			{
				action,
				expectedEventTypes,
				events
			}
		);
	}
};

const mod = (value: number, divisor: number): number =>
	divisor === 0 ? 0 : (value >>> 0) % divisor;

const textSelectionHasRange = (selection: DstTextSelection): boolean =>
	!selection.isCollapsed &&
	(selection.startTextIndex !== selection.endTextIndex || selection.yStart !== selection.yEnd);

const selectedText = (snapshot: DstBrowserSnapshot, selection: DstTextSelection): string => {
	const segments = snapshot.model.renderedTexts;
	if (selection.startTextIndex === selection.endTextIndex) {
		return segments[selection.startTextIndex]?.slice(selection.yStart, selection.yEnd) ?? '';
	}
	const selected = [segments[selection.startTextIndex]?.slice(selection.yStart) ?? ''];
	for (let index = selection.startTextIndex + 1; index < selection.endTextIndex; index++) {
		selected.push(segments[index] ?? '');
	}
	selected.push(segments[selection.endTextIndex]?.slice(0, selection.yEnd) ?? '');
	return selected.join('');
};

/** Index of the model block that owns renderedTexts[textIndex], or -1. */
const blockIndexForRenderedText = (snapshot: DstBrowserSnapshot, textIndex: number): number => {
	let covered = 0;
	for (const [index, block] of snapshot.model.blocks.entries()) {
		covered += block.renderedTextCount;
		if (textIndex < covered) return index;
	}
	return -1;
};

/**
 * `[firstTextIndex, endExclusive)` — the rendered-text range a block
 * contributes, used for Home/End line-boundary reasoning.
 */
const blockRenderedTextRange = (
	snapshot: DstBrowserSnapshot,
	blockIndex: number
): [number, number] => {
	let start = 0;
	for (let index = 0; index < blockIndex; index++) {
		start += snapshot.model.blocks[index].renderedTextCount;
	}
	return [start, start + (snapshot.model.blocks[blockIndex]?.renderedTextCount ?? 0)];
};

const blockIndexById = (snapshot: DstBrowserSnapshot, id: string): number =>
	snapshot.model.blocks.findIndex((block) => block.id === id);

const samePath = (left: number[], right: number[]): boolean =>
	left.length === right.length && left.every((value, index) => value === right[index]);

const isPrefixPath = (prefix: number[], path: number[]): boolean =>
	prefix.length < path.length && prefix.every((value, index) => value === path[index]);

/** True iff any strict ancestor of `block` is island-typed (island-sealed). */
const isInsideIsland = (snapshot: DstBrowserSnapshot, blockIndex: number): boolean => {
	const path = snapshot.model.blocks[blockIndex]?.path ?? [];
	return snapshot.model.blocks.some(
		(block, index) => index !== blockIndex && block.island && isPrefixPath(block.path, path)
	);
};

/**
 * `model.nestUnder(previousSibling)` admits the move iff a previous sibling
 * exists, the source block is not island-sealed, and the target sibling is
 * neither void nor island nor inside an island
 * (edytor-doc.ts `canAcceptMove`/`insideIsland`).
 */
const canProvablyNest = (snapshot: DstBrowserSnapshot, blockIndex: number): boolean => {
	const path = snapshot.model.blocks[blockIndex]?.path ?? [];
	if (path.length === 0 || path.at(-1) === 0) return false;
	if (isInsideIsland(snapshot, blockIndex)) return false;
	const siblingPath = [...path.slice(0, -1), path.at(-1)! - 1];
	const siblingIndex = snapshot.model.blocks.findIndex((block) =>
		samePath(block.path, siblingPath)
	);
	const sibling = snapshot.model.blocks[siblingIndex];
	if (!sibling || sibling.void || sibling.island) return false;
	return !isInsideIsland(snapshot, siblingIndex);
};

/**
 * `model.unNest()` moves the block beside its parent — possible iff the
 * block is nested and not island-sealed.
 */
const canProvablyUnnest = (snapshot: DstBrowserSnapshot, blockIndex: number): boolean =>
	(snapshot.model.blocks[blockIndex]?.path.length ?? 0) > 1 &&
	!isInsideIsland(snapshot, blockIndex);

/**
 * Exact landing oracle for a collapsed-caret `type`/`insertText`: the
 * typed text must appear at the caret the model reported — the text part
 * identified by `renderedTextIds[startTextIndex]` must equal its prior
 * content with `action.text` spliced in at `yStart` (UTF-16). "Some
 * document changed" cannot catch a caret that LOOKS recovered but routes
 * input elsewhere — the remote-delete phantom-selection defect class.
 *
 * Returns true once the comparison ran (a mismatch throws); false when
 * the anchor text part is absent from `after` — a remote apply
 * mid-action can legitimately remove it on the collab lane, and the
 * caller degrades to the coarse changed-something check.
 */
const assertTypedLanding = (
	engine: string,
	action: Extract<DstAction, { kind: 'type' | 'insertText' }>,
	before: DstBrowserSnapshot,
	after: DstBrowserSnapshot,
	selection: DstTextSelection
): boolean => {
	const textId = before.model.renderedTextIds[selection.startTextIndex];
	const beforeText = before.model.renderedTexts[selection.startTextIndex];
	if (textId === undefined || beforeText === undefined || action.text === '') return false;
	const expected =
		beforeText.slice(0, selection.yStart) + action.text + beforeText.slice(selection.yStart);
	for (const block of after.model.blocks) {
		for (const part of block.parts) {
			if (part.kind === 'text' && part.id === textId) {
				const actual = part.runs.map((run) => run.text).join('');
				if (actual !== expected) {
					fail(
						'type-landing-mismatch',
						engine,
						`${action.kind} landed at the wrong position in text ${textId}`,
						{
							action,
							selection,
							textId,
							blockId: block.id,
							expected,
							actual
						}
					);
				}
				return true;
			}
		}
	}
	return false;
};

/** The block the action applies to: caret block for text selections, the
 * selected block for single-block node selections, -1 when unknown. */
const actionAnchorBlockIndex = (snapshot: DstBrowserSnapshot): number => {
	const selection = snapshot.selection;
	if (selection?.kind === 'text') {
		return blockIndexForRenderedText(snapshot, selection.startTextIndex);
	}
	if (selection?.kind === 'block' && selection.ids.length === 1) {
		return blockIndexById(snapshot, selection.ids[0]);
	}
	return -1;
};

const canMoveSelection = (
	snapshot: DstBrowserSnapshot,
	selection: DstTextSelection,
	action: Extract<DstAction, { kind: 'move' }>
): boolean => {
	if (textSelectionHasRange(selection) && !action.extend) return true;
	const focusIndex = selection.isReversed ? selection.startTextIndex : selection.endTextIndex;
	const focusOffset = selection.isReversed ? selection.yStart : selection.yEnd;
	const segments = snapshot.model.renderedTexts;
	const segment = segments[focusIndex] ?? '';
	const length = segment.length;
	const blockIndex = blockIndexForRenderedText(snapshot, focusIndex);
	const [blockFirstText, blockTextEnd] =
		blockIndex >= 0 ? blockRenderedTextRange(snapshot, blockIndex) : ([-1, -1] as [number, number]);

	switch (action.key) {
		case 'ArrowLeft':
		case 'Alt+ArrowLeft':
			// A word jump may skip further but still requires a position to
			// move to — same coarse movability as ArrowLeft. Word-boundary
			// granularity divergence (esp. on unicode samples) is reported by
			// the cross-engine selection compare, not hidden here.
			return focusOffset > 0 || focusIndex > 0;
		case 'ArrowRight':
		case 'Alt+ArrowRight':
			return focusOffset < length || focusIndex < segments.length - 1;
		case 'ArrowUp':
			// Provable only when a visual line exists above: an earlier block
			// that renders text, or a soft break before the caret inside this
			// segment. ArrowUp on the first visual line is a legitimate
			// no-op; wrapped lines are engine-dependent so we only assert the
			// provable case.
			return (
				segment.slice(0, focusOffset).includes('\n') ||
				snapshot.model.blocks
					.slice(0, Math.max(blockIndex, 0))
					.some((block) => block.renderedTextCount > 0)
			);
		case 'ArrowDown':
			return (
				segment.slice(focusOffset).includes('\n') ||
				snapshot.model.blocks
					.slice(Math.max(blockIndex, 0) + 1)
					.some((block) => block.renderedTextCount > 0)
			);
		case 'Home': {
			// Line start positions: first text of the block at offset 0,
			// right after a '\n' inside the segment, or segment start right
			// after a '\n'-terminated segment.
			const atLineStart =
				(focusIndex === blockFirstText && focusOffset === 0) ||
				segment[focusOffset - 1] === '\n' ||
				(focusOffset === 0 && (segments[focusIndex - 1] ?? '').endsWith('\n'));
			return !atLineStart;
		}
		case 'End': {
			const atLineEnd =
				(focusIndex === blockTextEnd - 1 && focusOffset === length) ||
				segment[focusOffset] === '\n' ||
				(focusOffset === length && (segments[focusIndex + 1] ?? 'x').startsWith('\n'));
			return !atLineEnd;
		}
	}
};

export const assertActionEffect = (
	engine: string,
	action: DstAction,
	before: DstBrowserSnapshot,
	after: DstBrowserSnapshot,
	options: { expectedSemantic?: string } = {}
) => {
	const beforeSemantic = semanticSignature(before);
	const afterSemantic = semanticSignature(after);
	const selection = before.selection?.kind === 'text' ? before.selection : null;
	const nodeSelection =
		before.selection?.kind === 'inline' || before.selection?.kind === 'block'
			? before.selection
			: null;
	const requireSemanticChange = (reason: string) => {
		if (beforeSemantic === afterSemantic) {
			fail('action-produced-no-effect', engine, reason, {
				action,
				selection,
				blocks: before.model.blocks.map((block) => ({
					id: block.id,
					path: block.path,
					void: block.void,
					island: block.island
				})),
				renderedTexts: before.model.renderedTexts
			});
		}
	};

	if (options.expectedSemantic !== undefined && afterSemantic !== options.expectedSemantic) {
		fail('history-roundtrip-mismatch', engine, `${action.kind} restored the wrong editor value`, {
			action,
			expected: options.expectedSemantic,
			actual: afterSemantic
		});
	}

	if (action.kind === 'undo' || action.kind === 'redo') {
		const isUndo = action.kind === 'undo';
		const available = isUndo ? before.history.canUndo : before.history.canRedo;
		if (!available) {
			if (beforeSemantic !== afterSemantic) {
				fail(
					'unavailable-history-mutated-document',
					engine,
					`${action.kind} changed the document`,
					{
						action,
						beforeHistory: before.history,
						afterHistory: after.history
					}
				);
			}
			return;
		}
		// Stack advancement is the mechanical invariant — check it FIRST:
		// a remote edit can make an available undo semantically empty (its
		// target is already gone), but the stack must still move. Ordering
		// matters because `history-produced-no-effect` is tolerated under
		// collaboration while a stack that never advanced is always broken.
		//
		// "Moved" means the command CONSUMED stack items, not necessarily
		// that it pushed to the opposite stack: UndoManager drops a popped
		// item whose inverse performs no change (its content was already
		// superseded — e.g. by a remote delete) and keeps popping, and an
		// empty undo transaction pushes nothing to the opposite stack. So
		// `undoDepth 1→0, redoDepth 0→0, doc unchanged` is a legal dead-item
		// pop; only a command that changed NEITHER depth was truly ignored.
		// (Residual collab race: a remote capture clearing the redo stack
		// can masquerade as source-shrink for a redo — remoteApplies is
		// recorded on failure details to disambiguate.)
		const movedToOppositeStack = isUndo
			? after.history.redoDepth > before.history.redoDepth
			: after.history.undoDepth > before.history.undoDepth;
		const consumedFromSource = isUndo
			? after.history.undoDepth < before.history.undoDepth
			: after.history.redoDepth < before.history.redoDepth;
		if (!movedToOppositeStack && !consumedFromSource) {
			fail(
				'history-stack-did-not-advance',
				engine,
				`${action.kind} did not advance history stacks`,
				{
					beforeHistory: before.history,
					afterHistory: after.history
				}
			);
		}
		if (beforeSemantic === afterSemantic) {
			fail(
				'history-produced-no-effect',
				engine,
				`${action.kind} ignored an available history item`,
				{
					action,
					beforeHistory: before.history,
					afterHistory: after.history
				}
			);
		}
		return;
	}

	if (action.kind === 'backspace' || action.kind === 'delete' || action.kind === 'wordDelete') {
		// Exact-result oracle: the expected post-delete tree is derived from
		// the pre-action snapshot + the delivered inputType, not just "did
		// something change" — a wrong-but-changed merge is a failure here.
		const expectation = describeDelete(before, action, after.events);
		if (expectation.kind === 'unchanged') {
			if (beforeSemantic !== afterSemantic) {
				fail(
					'delete-noop-mutated-document',
					engine,
					`${action.kind} mutated the document but ${expectation.reason}`,
					{ action, selection, reason: expectation.reason }
				);
			}
			return;
		}
		if (expectation.kind === 'selectOnly') {
			if (beforeSemantic !== afterSemantic) {
				fail(
					'delete-noop-mutated-document',
					engine,
					`${action.kind} mutated the document but ${expectation.reason}`,
					{ action, selection, reason: expectation.reason }
				);
			}
			const landed = after.selection;
			if (
				landed?.kind !== 'block' ||
				landed.ids.length !== 1 ||
				landed.ids[0] !== expectation.blockId
			) {
				fail(
					'delete-selection-mismatch',
					engine,
					`${action.kind} should have selected block ${expectation.blockId} (${expectation.reason})`,
					{ action, selection, expected: expectation.blockId, actual: after.selection }
				);
			}
			return;
		}
		if (expectation.kind === 'invalid') {
			fail('delete-range-implausible', engine, `${action.kind}: ${expectation.reason}`, {
				action,
				selection,
				reason: expectation.reason
			});
		}
		if (expectation.kind === 'tree') {
			// A delete that provably should mutate but didn't is a no-effect
			// failure first — the exact diff only applies once something moved.
			if (beforeSemantic === afterSemantic) {
				fail(
					'action-produced-no-effect',
					engine,
					`${action.kind} did not change a deletable range — ${expectation.description}`,
					{ action, selection, description: expectation.description }
				);
				return;
			}
			const diff = diffDeleteExpectation(
				expectation.children,
				(after.value as { children?: unknown[] } | undefined)?.children
			);
			if (diff) {
				fail(
					'delete-result-mismatch',
					engine,
					`${action.kind} produced the wrong document: ${diff} — ${expectation.description}`,
					{
						action,
						selection,
						diff,
						before: (before.value as { children?: unknown[] } | undefined)?.children,
						beforeParts: before.model.blocks.map((block) => ({
							id: block.id,
							parts: block.parts
						})),
						expected: expectation.children,
						actual: (after.value as { children?: unknown[] } | undefined)?.children
					}
				);
			}
			return;
		}
		// 'indeterminate' — fall back to the coarse "something deletable
		// changed" check below; the shapes it can't prove stay unproven.
		if (selection) {
			const hasRange = textSelectionHasRange(selection);
			const textLength = before.model.renderedTexts[selection.startTextIndex]?.length ?? 0;
			const forward =
				action.kind === 'delete' ||
				(action.kind === 'wordDelete' && action.direction === 'forward');
			const hasDeletable = forward ? selection.yStart < textLength : selection.yStart > 0;
			if (hasRange || (selection.isCollapsed && hasDeletable)) {
				requireSemanticChange(`${action.kind} did not change a deletable text range`);
			}
		}
		return;
	}

	if (nodeSelection && ['type', 'insertText', 'enter', 'softBreak'].includes(action.kind)) {
		requireSemanticChange(`${action.kind} ignored a selected ${nodeSelection.kind} node`);
		return;
	}

	if ((action.kind === 'type' || action.kind === 'insertText') && selection) {
		if (selection.isCollapsed) {
			// Exact landing: the typed text must appear at the caret the
			// model reported — block, text part, UTF-16 offset. A caret
			// that LOOKS recovered but routes input elsewhere (the
			// remote-delete phantom-selection defect) fails here even
			// though the document changed.
			if (!assertTypedLanding(engine, action, before, after, selection)) {
				// The anchor text part vanished between snapshots — a remote
				// apply can do that mid-action on the collab lane; degrade to
				// the coarse check rather than guess.
				requireSemanticChange(`${action.kind} did not change an editable text selection`);
			}
			return;
		}
		if (selectedText(before, selection) !== action.text) {
			requireSemanticChange(`${action.kind} did not change an editable text selection`);
		}
		return;
	}
	if ((action.kind === 'enter' || action.kind === 'softBreak') && selection) {
		// A soft break replacing a lone '\n' inside a single text is
		// idempotent — the edit is provable, but its result equals the
		// prior state, so no semantic change can be required.
		const idempotentSoftBreak =
			action.kind === 'softBreak' &&
			selection.startTextIndex === selection.endTextIndex &&
			selectedText(before, selection) === '\n';
		if (!idempotentSoftBreak) {
			requireSemanticChange(`${action.kind} did not change an editable text selection`);
		}
		return;
	}
	if (action.kind === 'format' && selection && textSelectionHasRange(selection)) {
		if (selectedText(before, selection).length > 0) {
			requireSemanticChange('format did not change a non-empty text range');
		}
		return;
	}
	if (action.kind === 'tab' || action.kind === 'shiftTab') {
		// Nest requires a non-void/non-island previous sibling and an
		// unsealed source; unnest requires a nested unsealed block. Only
		// assert in the provable case — the structural rules live in
		// edytor-doc.ts (`canAcceptMove`/`insideIsland`).
		const anchor = actionAnchorBlockIndex(before);
		const provable =
			anchor >= 0 &&
			(action.kind === 'tab' ? canProvablyNest(before, anchor) : canProvablyUnnest(before, anchor));
		if (provable && beforeSemantic === afterSemantic) {
			fail(
				'action-produced-no-effect',
				engine,
				`${action.kind} did not (un)nest a provably movable block`,
				{
					action,
					selection,
					anchorBlock: before.model.blocks[anchor],
					blocks: before.model.blocks.map((block) => ({
						id: block.id,
						path: block.path,
						void: block.void,
						island: block.island
					}))
				}
			);
		}
		return;
	}
	if (action.kind === 'pointerDrag' || action.kind === 'pointerDoubleClick') {
		// A drag across block contents — or a double-click on a word — must
		// leave a non-collapsed selection (or, at minimum, change it), but
		// only when the gesture actually spans rendered characters. A drag
		// whose endpoints both live inside empty blocks, or a double-click
		// on an empty text, legitimately selects nothing.
		const afterSelection = after.selection;
		const nonCollapsed = Boolean(
			afterSelection && (afterSelection.kind !== 'text' || !afterSelection.isCollapsed)
		);
		const changed = selectionSignature(before) !== selectionSignature(after);
		let required = !nonCollapsed && !changed;
		if (action.kind === 'pointerDrag') {
			const blockCount = before.model.blocks.length;
			if (blockCount === 0) {
				required = false;
			} else {
				const lo = Math.min(mod(action.startBlock, blockCount), mod(action.endBlock, blockCount));
				const hi = Math.max(mod(action.startBlock, blockCount), mod(action.endBlock, blockCount));
				const [firstText] = blockRenderedTextRange(before, lo);
				const [, endText] = blockRenderedTextRange(before, hi);
				const spanned = before.model.renderedTexts.slice(firstText, endText).join('').length;
				if (spanned === 0) required = false;
			}
		} else if (before.model.renderedTexts.length > 0) {
			// Double-click over whitespace or an empty text selects engine-
			// specific nothings — only insist when the middle char is a
			// non-space (word-boundary granularity remains a legitimate
			// divergence surface reported by the cross-engine compare).
			const text = before.model.renderedTexts[mod(action.index, before.model.renderedTexts.length)];
			const mid = text === undefined || text === '' ? '' : text.charAt(Math.floor(text.length / 2));
			if (mid === '') {
				required = false;
			} else if (!/\s/.test(mid)) {
				required = !nonCollapsed;
			}
		} else {
			required = false;
		}
		if (required) {
			fail('pointer-selection-no-effect', engine, `${action.kind} produced no selection change`, {
				action,
				beforeSelection: before.selection,
				afterSelection
			});
		}
		return;
	}
	if (action.kind === 'composition') {
		// The pipeline lands synthetic IME input through
		// insertCompositionText / insertFromComposition /
		// onCompositionEnd — a non-empty commit over an editable selection
		// must change the document unless it re-inserts identical text.
		if (selection) {
			if (action.commit !== selectedText(before, selection)) {
				requireSemanticChange('composition commit did not change the editable selection');
			}
		} else if (nodeSelection && action.commit !== '') {
			requireSemanticChange(`composition ignored a selected ${nodeSelection.kind} node`);
		}
		return;
	}
	if (action.kind === 'paste') {
		// Paste is real: onPaste routes text/html through htmlPlugin's
		// parseHtml, edytor fragments through insertEdytorClipboardFragment,
		// and plain text through a synthetic insertFromPaste beforeinput.
		// An empty payload is a legitimate uniform no-op.
		const hasPayload = Boolean(action.text) || Boolean(action.html) || action.fragment != null;
		if (selection) {
			const replaced = selectedText(before, selection);
			if (
				hasPayload &&
				(Boolean(action.html) || action.fragment != null || action.text !== replaced)
			) {
				requireSemanticChange('paste did not change the editable selection');
			}
		} else if (nodeSelection && hasPayload) {
			requireSemanticChange(`paste ignored a selected ${nodeSelection.kind} node`);
		}
		return;
	}
	if (action.kind === 'cut') {
		// onCut writes the fragment then removes the selection — it must
		// mutate iff a range or node was selected. Collapsed cut is a
		// legitimate no-op.
		if ((selection && textSelectionHasRange(selection)) || nodeSelection) {
			requireSemanticChange('cut did not remove the selected content');
		}
		return;
	}
	if (action.kind === 'foreignMutation') {
		const mutation = action.mutation;
		// Foreign text writes inside an editable island are adopted like
		// any other browser-owned input (GBoard spans, type-overs). Every
		// other payload is pure DOM damage the observer must heal without
		// touching the model — a semantic change here means foreign DOM
		// corrupted it.
		const adoptsForeignText =
			(mutation.kind === 'insertForeignElement' && mutation.where === 'text') ||
			(mutation.kind === 'typeOver' && mutation.data !== null);
		if (!adoptsForeignText && beforeSemantic !== afterSemantic) {
			fail('foreign-mutation-mutated-model', engine, 'foreign DOM mutation changed the model', {
				action,
				before: beforeSemantic,
				after: afterSemantic
			});
		}
		// Injected elements must never survive reconciliation: they are
		// removed outright outside editable islands, or unwrapped once so
		// their text can be adopted — the tagged element itself is always
		// settled away.
		if (after.dom.foreignResidual.nodes.length > 0) {
			fail(
				'foreign-element-survived',
				engine,
				'an injected foreign element survived reconciliation',
				{ action, residual: after.dom.foreignResidual }
			);
		}
		return;
	}
	if (action.kind === 'drop') {
		// Foreign drops are real input: onDrop accepts the payload
		// (text/plain et al.), funnels it through a synthetic
		// insertFromDrop beforeinput, and moves the caret to the insert
		// point. An empty payload is the only uniform no-op.
		if (action.text !== '') {
			requireSemanticChange('drop did not insert the accepted payload');
		}
		return;
	}
	if (action.kind === 'copy') {
		// copy never mutates and must not move the selection.
		if (selectionSignature(before) !== selectionSignature(after)) {
			fail('non-mutating-action-moved-selection', engine, `${action.kind} moved the selection`, {
				action,
				beforeSelection: before.selection,
				afterSelection: after.selection
			});
		}
		return;
	}
	if (action.kind === 'pointerClick' || action.kind === 'shiftClick') {
		// Clicking may or may not move the caret — a click re-establishing
		// the same selection is legal. Trust + cross-engine asserts carry
		// the weight here.
		return;
	}
	if (action.kind === 'move' && selection && canMoveSelection(before, selection, action)) {
		if (selectionSignature(before) === selectionSignature(after)) {
			fail('move-produced-no-effect', engine, 'navigation did not move or extend the selection', {
				action,
				selection
			});
		}
	}
	if (action.kind === 'move' && nodeSelection?.kind === 'block' && nodeSelection.ids.length === 1) {
		// The arrowup/arrowdown hotkeys relocate a single selected block's
		// selection to the previous/next display block (island interiors
		// climb to the island root). Assert only when a navigation target
		// provably exists.
		const blockIndex = blockIndexById(before, nodeSelection.ids[0]);
		const block = before.model.blocks[blockIndex];
		if (!block) return;
		const navigable =
			action.key === 'ArrowUp'
				? blockIndex > 0
				: action.key === 'ArrowDown'
					? block.island || block.void
						? before.model.blocks.some((candidate) =>
								samePath(candidate.path, [...block.path.slice(0, -1), block.path.at(-1)! + 1])
							)
						: before.model.blocks
								.slice(blockIndex + 1)
								.some((candidate) => !isPrefixPath(block.path, candidate.path))
					: false;
		if (navigable && selectionSignature(before) === selectionSignature(after)) {
			fail(
				'move-produced-no-effect',
				engine,
				'block-selection navigation did not move the selection',
				{ action, selection: nodeSelection }
			);
		}
	}
};

export const assertSemanticPreservation = (
	engine: string,
	action: DstAction,
	before: DstBrowserSnapshot,
	after: DstBrowserSnapshot
) => {
	// These action kinds must never mutate the document. `format` may change
	// marks only (structureSignature omits them); everything else — moves,
	// pointer gestures, copy, and non-adopting foreign DOM damage — must
	// preserve the whole semantic value.
	const preservesSemantics =
		action.kind === 'move' ||
		action.kind === 'copy' ||
		// Foreign DOM damage must heal without touching the model — except
		// the two adoption-capable payloads (injected text inside an
		// editable island, non-identical type-over), which may legitimately
		// land in the document like any other browser-owned write.
		(action.kind === 'foreignMutation' &&
			!(action.mutation.kind === 'insertForeignElement' && action.mutation.where === 'text') &&
			!(action.mutation.kind === 'typeOver' && action.mutation.data !== null)) ||
		POINTER_INPUT_KINDS.has(action.kind);
	if (action.kind !== 'format' && !preservesSemantics) return;
	const beforeValue = preservesSemantics ? semanticSignature(before) : structureSignature(before);
	const afterValue = preservesSemantics ? semanticSignature(after) : structureSignature(after);
	if (beforeValue !== afterValue) {
		fail('non-text-action-mutated-structure', engine, `${action.kind} changed protected content`, {
			before: beforeValue,
			after: afterValue,
			action
		});
	}
};
