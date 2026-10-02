/**
 * The live editor's AI demo: no model, no key. "Ask AI" (the bar's button or
 * `/ai`) proposes a canned answer after the caret's block and streams it
 * word by word; "Continue writing" (`/continue`) streams a sentence after
 * the caret's text. The answer is a suggestion (`edytor.suggestions`): it
 * shows only on this screen and reaches the shared room only once accepted.
 */
import type { EdytorInstance, JSONBlock, Plugin, Suggestion } from 'edytor';

/** A tiny bundled picture (an inline SVG): the image block of an answer. */
const PICTURE = `data:image/svg+xml,${encodeURIComponent(
	`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 240"><defs><linearGradient id="g" x2="1" y2="1"><stop offset="0" stop-color="#e0ecff"/><stop offset="1" stop-color="#f6e8ff"/></linearGradient></defs><rect width="640" height="240" fill="url(#g)"/><g fill="#2383e2" opacity=".85"><path d="M320 62l14 44 44 14-44 14-14 44-14-44-44-14 44-14z"/><path d="M412 48l6 18 18 6-18 6-6 18-6-18-18-6 18-6z" opacity=".6"/><path d="M226 150l5 15 15 5-15 5-5 15-5-15-15-5 15-5z" opacity=".5"/></g></svg>`
)}`;

const text = (value: string) => [{ text: value }];

/** Canned answers: Try again takes the next one. */
const ANSWERS: JSONBlock[][] = [
	[
		{ type: 'heading', data: { level: 'h2' }, content: text('Launch plan') },
		{
			type: 'paragraph',
			content: text('Ship the beta to ten teams first, then open it up once the feedback settles.')
		},
		{ type: 'bulleted-list-item', content: text('Write the announcement post') },
		{ type: 'bulleted-list-item', content: text('Record a two-minute demo') },
		{ type: 'todo-item', data: { checked: false }, content: text('Book the launch review') },
		{ type: 'todo-item', data: { checked: false }, content: text('Send the beta invites') },
		{ type: 'image', data: { src: PICTURE }, content: text('Our north star') }
	],
	[
		{ type: 'heading', data: { level: 'h2' }, content: text('Meeting notes') },
		{
			type: 'paragraph',
			content: [
				{ text: 'We agreed to keep the editor ' },
				{ text: 'local-first', marks: { bold: true } },
				{ text: ' and to sync through one room per document.' }
			]
		},
		{ type: 'bulleted-list-item', content: text('Presence shows who is where') },
		{ type: 'bulleted-list-item', content: text('Undo only takes back your own edits') },
		{ type: 'todo-item', data: { checked: false }, content: text('Draft the API page') },
		{ type: 'image', data: { src: PICTURE }, content: text('Whiteboard, cleaned up') }
	],
	[
		{ type: 'heading', data: { level: 'h2' }, content: text('Three ideas') },
		{ type: 'numbered-list-item', content: text('A weekly digest of what changed') },
		{ type: 'numbered-list-item', content: text('Templates for the common pages') },
		{ type: 'numbered-list-item', content: text('A calmer dark theme') },
		{ type: 'todo-item', data: { checked: false }, content: text('Pick one for next week') }
	]
];

const CONTINUATIONS = [
	' and everyone sees the result the moment it lands.',
	' which keeps the page tidy while people write together.',
	' so nobody has to wait for a save button.'
];

/** `blocks` cut after `words` words (a block without text counts one): what a stream has shown so far. */
const upTo = (blocks: JSONBlock[], words: number): JSONBlock[] => {
	const out: JSONBlock[] = [];
	for (const block of blocks) {
		if (words <= 0) break;
		const content = [];
		for (const part of block.content ?? []) {
			if (!('text' in part)) continue;
			const pieces = part.text.split(/(?<=\s)/);
			const kept = pieces.slice(0, Math.max(0, words));
			words -= kept.length;
			if (kept.length) content.push({ ...part, text: kept.join('') });
		}
		if (!block.content?.length) words--;
		out.push({ ...block, content });
	}
	return out;
};
/** The words `upTo` counts in `blocks`. */
const count = (blocks: JSONBlock[]) =>
	blocks.reduce(
		(sum, block) =>
			sum +
			Math.max(
				1,
				(block.content ?? []).reduce(
					(n, part) => n + ('text' in part ? part.text.split(/(?<=\s)/).length : 0),
					0
				)
			),
		0
	);

/** Stream `blocks` into `suggestion` over about 2.5 s, then mark it ready. */
const stream = (suggestion: Suggestion, blocks: JSONBlock[]) => {
	const total = count(blocks);
	let shown = 0;
	const timer = setInterval(() => {
		// Accepted or discarded meanwhile: stop.
		if (!suggestion.live) return clearInterval(timer);
		shown = Math.min(total, shown + 2);
		suggestion.update(upTo(blocks, shown));
		if (shown === total) {
			clearInterval(timer);
			suggestion.done();
		}
	}, 2500 / Math.ceil(total / 2));
};

let next = 0;
const answer = () => ANSWERS[next++ % ANSWERS.length]!;

/** The block a command acts on: the caret's, else the document's last. */
const blockOf = (edytor: EdytorInstance) =>
	edytor.selection.state.startBlock ?? edytor.root?.children.at(-1);

/**
 * Ask the "AI": its answer streams after the caret's block, or in place of
 * an empty line. Try again streams another one.
 */
export const askAI = (edytor: EdytorInstance) => {
	const block = blockOf(edytor);
	if (!block) return;
	// Any empty line (a paragraph, a to-do, a heading, a list item): Turn into's lines.
	const empty = block.isEmpty && block.convertible;
	const suggestion = edytor.suggestions.add(empty ? { replace: [block.id] } : { after: block.id }, undefined, {
		label: 'AI',
		onRetry: (again) => stream(again, answer())
	});
	stream(suggestion, answer());
};

/** Continue the caret's text with a canned sentence (an `end` suggestion: Tab accepts it). */
export const continueWriting = (edytor: EdytorInstance) => {
	const block = blockOf(edytor);
	if (!block?.rendersContent || block.definition.void) return;
	const suggestion = edytor.suggestions.add({ end: block.id }, undefined, { label: 'AI' });
	let sentence = CONTINUATIONS[next++ % CONTINUATIONS.length]!;
	if (/\s$/.test(edytor.facade.blockText(block.id) ?? '')) sentence = sentence.trimStart();
	stream(suggestion, [{ type: block.type, content: text(sentence) }]);
};

/**
 * `/ai` and `/continue` in the slash menu. They run once the `/query` is
 * removed (after a microtask), so an empty line reads as empty.
 */
export const aiDemoPlugin: Plugin = () => ({
	commands: [
		{
			id: 'ai.ask',
			label: 'Ask AI',
			icon: '✦',
			group: 'AI',
			keywords: ['ai', 'write', 'generate', 'draft'],
			run: async (edytor) => {
				await Promise.resolve();
				askAI(edytor);
			}
		},
		{
			id: 'ai.continue',
			label: 'Continue writing',
			icon: '✦',
			group: 'AI',
			keywords: ['ai', 'continue', 'write', 'complete'],
			run: async (edytor) => {
				await Promise.resolve();
				continueWriting(edytor);
			}
		}
	]
});
