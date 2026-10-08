/**
 * The soak's edit mix (WU-16), one owner for the soak's clients
 * (`clients.mjs`, over the network) and the size probe (`size.mjs`, in
 * memory): a writer on a headless document (`createDocument`) types at
 * its caret, presses Backspace and Enter (a split), merges, moves blocks,
 * sets marks and data, and cuts text, through the document's facade.
 */

/** A seeded PRNG (mulberry32): a run's choices replay from its seed. */
export const prng = (s) => () => {
	s |= 0;
	s = (s + 0x6d2b79f5) | 0;
	let t = Math.imul(s ^ (s >>> 15), 1 | s);
	t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const WORDS = 'the quick brown fox jumps over a lazy dog while every replica keeps typing'.split(
	' '
);

/** The seeded document every soak starts from: a title and 40 paragraphs. */
export const seedValue = () => ({
	children: [
		{ id: 'title', type: 'heading', data: { level: 1 }, content: [{ text: 'Soak document' }] },
		...Array.from({ length: 40 }, (_, i) => ({
			id: `seed-${i}`,
			type: 'paragraph',
			content: [{ text: `Seed paragraph ${i}: the quick brown fox jumps over the lazy dog.` }]
		}))
	]
});

/**
 * The mixes: `soak` (the soak's: weights shift toward deletes once the
 * document is long or crowded) and `insert` (typing only, nothing
 * deleted).
 */
const MIXES = {
	soak: ({ long, crowded }) => [
		['type', long ? 30 : 62],
		['backspace', long ? 30 : 10],
		['split', crowded ? 0 : 7],
		['merge', crowded ? 12 : 4],
		['move', 4],
		['mark', 4],
		['data', 3],
		['cut', long ? 15 : 3],
		['jump', 3]
	],
	insert: () => [
		['type', 97],
		['jump', 3]
	]
};

export class Writer {
	/**
	 * @param {object} options
	 * @param {{ doc: unknown, facade: any, transact: (fn: () => void) => void }} options.document
	 * @param {() => number} options.random
	 * @param {string} options.user
	 * @param {number} [options.maxBlocks]
	 * @param {number} [options.maxChars]
	 * @param {keyof typeof MIXES} [options.mix]
	 * @param {string[]} [options.without] edit kinds left out of the mix
	 * @param {() => number} [options.now] the clock (ms) the block list is re-read by
	 */
	constructor({
		document,
		random,
		user,
		maxBlocks = 400,
		maxChars = 60_000,
		mix = 'soak',
		without = [],
		now = () => performance.now()
	}) {
		this.document = document;
		this.random = random;
		this.now = now;
		this.user = user;
		this.maxBlocks = maxBlocks;
		this.maxChars = maxChars;
		if (!MIXES[mix]) throw new Error(`unknown mix ${mix}`);
		this.weights = (state) => MIXES[mix](state).filter(([kind]) => !without.includes(kind));
		this.seq = 0;
		this.caret = null;
		this.blocks = [];
		this.chars = 0;
		this.listedAt = -Infinity;
	}

	/** The top-level blocks and their text lengths, re-read at most every 2 s. */
	list() {
		const now = this.now();
		if (now - this.listedAt < 2000 && this.blocks.length) return this.blocks;
		this.listedAt = now;
		const length = (block) =>
			(block.content ?? []).reduce((n, piece) => n + ('text' in piece ? piece.text.length : 1), 0);
		const json = this.document.facade.toJSON();
		this.blocks = json.children.map((block) => ({
			id: block.id,
			type: block.type,
			length: length(block)
		}));
		this.chars = this.blocks.reduce((n, b) => n + b.length, 0);
		return this.blocks;
	}

	pick() {
		const blocks = this.list().filter((b) => b.type === 'paragraph' || b.type === 'heading');
		return blocks.length ? blocks[Math.floor(this.random() * blocks.length)] : null;
	}

	/** The caret's block and offset, valid in the document now (else a new one). */
	at() {
		const facade = this.document.facade;
		if (this.caret) {
			const text = facade.blockText(this.caret.id);
			if (typeof text === 'string' && this.caret.offset <= text.length)
				return { ...this.caret, length: text.length };
		}
		const block = this.pick();
		if (!block) return null;
		const text = facade.blockText(block.id) ?? '';
		this.caret = { id: block.id, offset: Math.floor(this.random() * (text.length + 1)) };
		return { ...this.caret, length: text.length };
	}

	/** One edit of the mix: `{ kind, status }` (`applied`, `applied-local`: the caret moved, else the facade's). */
	op() {
		const blocks = this.list();
		const weights = this.weights({
			crowded: blocks.length > this.maxBlocks,
			long: this.chars > this.maxChars
		});
		const total = weights.reduce((n, [, w]) => n + w, 0);
		let roll = this.random() * total;
		const [kind] = weights.find(([, w]) => (roll -= w) < 0) ?? weights[0];
		return { kind, status: this.perform(kind) };
	}

	perform(kind) {
		const { document } = this;
		const f = document.facade;
		const run = (fn) => {
			let result;
			document.transact(() => (result = fn()));
			return result?.status ?? 'applied';
		};
		if (kind === 'jump') {
			this.caret = null;
			return this.at() ? 'applied-local' : 'noop';
		}
		const caret = this.at();
		if (!caret) return 'noop';
		switch (kind) {
			case 'type': {
				const word = WORDS[Math.floor(this.random() * WORDS.length)];
				const text =
					this.random() < 0.8 ? word[Math.floor(this.random() * word.length)] : ` ${word}`;
				const status = run(() => f.insertText(caret.id, caret.offset, text));
				if (status === 'applied') this.caret.offset += text.length;
				return status;
			}
			case 'backspace': {
				if (caret.offset === 0) return 'noop';
				const status = run(() => f.deleteText(caret.id, caret.offset - 1, 1));
				if (status === 'applied') this.caret.offset -= 1;
				return status;
			}
			case 'split': {
				const id = `${this.user}-${document.doc.clientID}-${++this.seq}`;
				const status = run(() => f.splitBlock(caret.id, caret.offset, id));
				if (status === 'applied') {
					this.caret = { id, offset: 0 };
					this.listedAt = -Infinity;
				}
				return status;
			}
			case 'merge': {
				const status = run(() => f.mergeBackward(caret.id));
				this.caret = null;
				this.listedAt = -Infinity;
				return status;
			}
			case 'move': {
				const block = this.pick();
				if (!block) return 'noop';
				const index = Math.floor(this.random() * this.list().length);
				const status = run(() => f.moveBlock(block.id, { parent: null, index }));
				this.listedAt = -Infinity;
				return status;
			}
			case 'mark': {
				if (caret.length < 2) return 'noop';
				const from = Math.floor(this.random() * (caret.length - 1));
				const length = 1 + Math.floor(this.random() * Math.min(12, caret.length - from));
				const mark = ['bold', 'italic', 'code'][Math.floor(this.random() * 3)];
				return run(() =>
					f.formatRange(caret.id, from, length, { [mark]: this.random() < 0.7 ? true : null })
				);
			}
			case 'data':
				return run(() => f.patchData(caret.id, [{ path: ['soak', this.user], value: this.seq++ }]));
			case 'cut': {
				if (caret.length < 4) return 'noop';
				const from = Math.floor(this.random() * (caret.length - 3));
				const length = Math.min(caret.length - from, 3 + Math.floor(this.random() * 40));
				const status = run(() => f.deleteText(caret.id, from, length));
				if (status === 'applied') this.caret.offset = from;
				return status;
			}
		}
		return 'noop';
	}
}
