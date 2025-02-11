import { Edytor } from '../edytor.svelte.js';
import * as Y from 'yjs';
import { type JSONText, type SerializableContent } from '$lib/utils/json.js';
import { Block } from '../block/block.svelte.js';
import {
	batch,
	deleteText,
	removeMarksFromText,
	getMarksAtRange,
	insertText,
	markText,
	setText,
	splitText
} from './text.utils.js';
import { deltaToJson, jsonToDelta, toDeltas, type JSONDelta } from './deltas.js';
import { id } from '$lib/utils.js';
import { climb } from '$lib/selection/selection.utils.js';

export class Text {
	readonly = false;
	parent: Block;
	yText: Y.Text;
	edytor: Edytor;
	stringContent = $state('');
	index = $state(0);
	node: HTMLElement | undefined;
	// Used to add en empty string in the DOM if the text is empty in order to be abble to focus on it.
	isEmpty = $state(false);
	// Used to add en empty string at the end of the text if it ends with a newline in order to visually render the newline.
	endsWithNewline = $state(false);
	// Used when user toggles mark without selection range.
	markOnNextInsert: undefined | Record<string, SerializableContent | null> = undefined;
	id: string;
	#children = $state<JSONDelta[]>([]);

	get value(): JSONText[] {
		return deltaToJson(this.#children);
	}

	get length() {
		return this.yText.length;
	}

	get children() {
		const transformer = this.parent.definition.transformText;
		return transformer
			? jsonToDelta(transformer({ text: this, block: this.parent, content: this.value }))
			: this.#children;
	}

	set children(value: JSONDelta[]) {
		this.#children = value;
	}

	private setChildren = (text?: Y.Text) => {
		this.stringContent = this.yText.toJSON();
		[this.children, this.isEmpty] = toDeltas(text || this.yText);
		this.endsWithNewline = this.stringContent.endsWith('\n');
	};

	private observeText = (event: Y.YTextEvent, transaction: Y.Transaction): void => {
		if (transaction.origin !== this.edytor.transaction) {
			// If the transaction is not from the edytor, we need to restore the selection
			// If the current text is not focused, this action will be ignored
			this.edytor.selection.restoreRelativePosition(this);
		}
		this.setChildren(event.target);
	};

	constructor({
		parent,
		content,
		yText
	}: { parent: Block } & (
		| { yText?: undefined; content: string | JSONText[] }
		| { yText: Y.Text; content?: undefined }
	)) {
		this.parent = parent;
		this.edytor = parent.edytor;
		this.yText = yText || new Y.Text();
		this.id = this.yText.doc ? this.yText.getAttribute('id') : id('t');

		if (content !== undefined) {
			// If content is provided we need to initialize the text with the content
			this.yText._pending?.push(() => {
				this.yText.setAttribute('id', this.id);
				if (typeof content === 'string') {
					this.yText.insert(0, content);
				} else {
					this.yText.applyDelta(
						content.map((part) => ({
							insert: part.text,
							attributes: part.marks
						}))
					);
				}
				this.setChildren();
			});
		} else {
			this.setChildren();
		}
		this.edytor.idToText.set(this.id, this);

		if (!this.edytor.readonly) {
			this.yText.observe(this.observeText);
		}
	}
	private batch = batch.bind(this);
	getMarksAtRange = getMarksAtRange.bind(this);
	insertText = this.batch('insertText', insertText.bind(this));
	deleteText = this.batch('deleteText', deleteText.bind(this));
	splitText = this.batch('splitText', splitText.bind(this));
	setText = this.batch('setText', setText.bind(this));
	markText = this.batch('markText', markText.bind(this));
	removeMarksFromText = this.batch('removeMarksFromText', removeMarksFromText.bind(this));

	attach = (node: HTMLElement) => {
		this.node = node;
		this.edytor.nodeToText.set(node, this);
		node.setAttribute('data-edytor-id', `${this.id}`);
		node.setAttribute('data-edytor-text', `true`);

		let pluginDestroy = this.edytor.plugins.reduce(
			(acc, plugin) => {
				const action = plugin.onTextAttached?.({ node, text: this });
				action && acc.push(action);
				return acc;
			},
			[] as (() => void)[]
		);
		let insideVoid = this.parent.definition.void;
		climb(this.parent, (block) => {
			if (block instanceof Block && block.definition.void) {
				insideVoid = true;
				return true;
			}
		});

		if (insideVoid) {
			node.contentEditable = 'true';
			node.style.outline = 'none';
		}

		return {
			destroy: () => {
				this.yText?.unobserve(this.observeText);
				this.edytor.idToText.delete(this.id);
				pluginDestroy.forEach((destroy) => destroy());
			}
		};
	};
}
