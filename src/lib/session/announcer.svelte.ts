/**
 * What a view tells assistive technology about a change a screen does not
 * say by itself: a block move or a block delete this view made, in the
 * view's labels (`edytor.labels`).
 * DOM-free: the surface renders `message` in a polite live region beside
 * the host (`components/Announcer.svelte`), a new node per announcement
 * (`serial`), so the same words twice are read twice. Only this view's own
 * gestures are announced, never a peer's.
 */
import type { Block } from '$lib/block/block.svelte.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import { kindLabel } from '$lib/kinds.js';
import type { BlockMoveRequest } from './moves.js';

/** The label saying a move, by direction (`to`: a placement, a drop). */
const MOVED = {
	up: 'movedUp',
	down: 'movedDown',
	in: 'indented',
	out: 'outdented',
	to: 'moved'
} as const;

export class Announcer {
	/** The last announcement. */
	message = $state('');
	/** Bumped by each announcement: the live region renders it as a new node. */
	serial = $state(0);

	constructor(private edytor: Edytor) {}

	/** Announce `message` (politely: after what the screen reader is saying). */
	say = (message: string) => {
		this.message = message;
		this.serial++;
	};

	/** `blocks` (one or several) as words: a kind's label for one, a count for several. */
	what = (blocks: readonly Block[]) => {
		const { labels } = this.edytor;
		return blocks.length === 1
			? labels.block(kindLabel(this.edytor, blocks[0]))
			: labels.blocks(blocks.length);
	};

	/** `request`'s blocks moved (`moveBlocks` answered them). */
	moved = (request: BlockMoveRequest, moved: readonly Block[]) => {
		if (!moved.length) return;
		const said = MOVED['direction' in request ? request.direction : 'to'];
		this.say(this.edytor.labels[said](this.what(moved)));
	};

	/** Blocks were deleted: `what` names them, read before they went. */
	deleted = (what: string) => this.say(this.edytor.labels.deleted(what));
}
