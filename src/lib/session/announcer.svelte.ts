/**
 * What a view tells assistive technology about a change a screen does not
 * say by itself (WU-27, F7): a block move or a block delete this view made.
 * DOM-free: the surface renders `message` in a polite live region beside
 * the host (`components/Announcer.svelte`), a new node per announcement
 * (`serial`), so the same words twice are read twice. Only this view's own
 * gestures are announced, never a peer's.
 */
import type { Block } from '$lib/block/block.svelte.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import { kindLabel } from '$lib/kinds.js';
import type { BlockMoveRequest } from './moves.js';

/** How a move is said, by direction (`undefined`: a placement, a drop). */
const MOVED = {
	up: (what: string) => `Moved ${what} up`,
	down: (what: string) => `Moved ${what} down`,
	in: (what: string) => `Indented ${what}`,
	out: (what: string) => `Outdented ${what}`,
	to: (what: string) => `Moved ${what}`
};

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
	what = (blocks: readonly Block[]) =>
		blocks.length === 1 ? `${kindLabel(this.edytor, blocks[0])} block` : `${blocks.length} blocks`;

	/** `request`'s blocks moved (`moveBlocks` answered them). */
	moved = (request: BlockMoveRequest, moved: readonly Block[]) => {
		if (!moved.length) return;
		this.say(MOVED['direction' in request ? request.direction : 'to'](this.what(moved)));
	};

	/** Blocks were deleted: `what` names them, read before they went. */
	deleted = (what: string) => this.say(`Deleted ${what}`);
}
