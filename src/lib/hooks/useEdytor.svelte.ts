/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { getContext, hasContext, setContext, tick, type Snippet, onMount } from 'svelte';
import {
	Text,
	Array as YArray,
	Doc,
	UndoManager,
	type RelativePosition,
	createRelativePositionFromTypeIndex,
	createAbsolutePositionFromRelativePosition,
	YEvent
} from 'yjs';
import { onBeforeInput } from '../events/onBeforeInput.js';

import { moveCursor, setCursorAtPosition } from '$lib/utils/setCursor.js';
import { type JSONDoc, type YBlock, docFromJson, docToJson } from '$lib/utils/json.js';
import { onKeyDown, type HotKeys } from '$lib/events/onKeyDown.js';
import { onSelectionChange, type EdytorSelection } from '$lib/events/onSelectionChange.js';

// import type { Awareness } from 'y-protocols/awareness';
export const useEdytor = (options?: {
	endpoint: string;
	readonly: boolean;
	renderMarks: Snippet<[Record<string, any>, Snippet]>;
	renderBlocks: Snippet<[Record<string, any>, Snippet, Snippet]>;
	value: JSONDoc;
	hotKeys?: HotKeys;
	id: string;
}) => {
	const hasEdytorContext = hasContext('edytor');

	if (hasEdytorContext) {
		return getContext<Edytor>('edytor');
	}

	const {
		renderMarks,
		renderBlocks,
		endpoint = 'ws://localhost:1234',
		readonly = false,
		value,
		id = '',
		hotKeys = {
			'mod+b': { toggleMark: 'bold' },
			'mod+i': { toggleMark: 'italic' },
			'mod+u': { toggleMark: 'underline' },
			'mod+`': { toggleMark: 'code' },
			'mod+k': { toggleMark: 'link' }
		}
	} = options || {};
	const doc = docFromJson(value);

	class Edytor {
		renderMarks: Snippet<[Record<string, any>, Snippet]> = renderMarks;
		renderBlocks: Snippet<[Record<string, any>, Snippet, Snippet]> = renderBlocks;
		lastInsert: string | null = null;
		container = $state<HTMLDivElement>();
		doc: Doc = doc;
		nodesToYElements = $state(new Map<Node, Text | YBlock>());
		hotKeys: HotKeys = hotKeys || {};
		YElementsToNodes = $state(new Map<Text | YBlock, Node>());
		readonly = $state(false);
		children = $state(this.doc.getArray<YBlock>('children').toArray());
		undoManager = new UndoManager(this.doc.getArray('children'));
		// provider: typeof WebsocketProvider;
		// awareness = this.provider.awareness;
		selection = $state<EdytorSelection>({
			selection: window.getSelection()!,
			start: 0,
			length: 0,
			startNode: null,
			endNode: null,
			end: 0,
			rects: [],
			text: '',
			ranges: [],
			isCollapsed: true,
			yStartElement: null,
			yEndElement: null,
			yStart: null,
			yEnd: null
		});

		constructor() {
			const getRelativeCursorLocation = () => {
				const { yStartElement, yStart, length } = this.selection;

				return {
					yStart,
					yStartElement,
					length
				};
			};

			const restoreCursorLocation = (cursorLocation: {
				yStart: RelativePosition | null;
				yStartElement: Text | null;
				length: number;
			}) => {
				if (!cursorLocation.yStart) return;
				const pos = createAbsolutePositionFromRelativePosition(cursorLocation.yStart, this.doc);
				if (!pos) return;
				setCursorAtPosition(
					`${cursorLocation.yStartElement?._item?.id.client}-${cursorLocation.yStartElement?._item?.id.clock}`,
					pos.index + cursorLocation.length
				);
			};

			this.undoManager.on('stack-item-added', (event) => {
				event.stackItem.meta.set('cursor-location', getRelativeCursorLocation());
			});
			this.undoManager.on('stack-item-popped', (event) => {
				restoreCursorLocation(event.stackItem.meta.get('cursor-location'));
			});
		}

		moveCursor = moveCursor.bind(this);
		onSelectionChange = onSelectionChange.bind(this);
		onBeforeInput = onBeforeInput.bind(this);
		attach = (node: HTMLDivElement) => {
			this.container = node;
			// this.container.contentEditable = 'true';
			document.addEventListener('selectionchange', this.onSelectionChange);
			document.addEventListener('keydown', onKeyDown.bind(this));
			node.addEventListener('beforeinput', this.onBeforeInput);
			node.setAttribute('contenteditable', 'true');
		};
	}
	const edytor = new Edytor();
	const setChildren = () => {
		edytor.children = edytor.doc.getArray('children').toArray();
	};
	onMount(() => {
		edytor.doc.getArray('children').observeDeep(setChildren);

		return () => {
			edytor.doc.getArray('children').observeDeep(setChildren);
		};
	});
	setContext('edytor', edytor);
	return edytor;
};

export type Edytor = ReturnType<typeof useEdytor>;
