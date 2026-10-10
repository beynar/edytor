/**
 * What the comments and find plugins share with the document: a command
 * that is one prepared plan (its hooks see the plan's steps; one
 * transaction, one undo step), and showing an offset of a block's text.
 */
import type { Prepared } from '$lib/crdt/edytor-doc.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { CommandResult } from '$lib/session/commands.js';
import { reveal } from '$lib/selection/replaceSelection.js';

/**
 * Dispatch `operation` as the plan `prepare` makes of `payload` (an
 * extension's replacement payload is prepared again), in `block` (else the
 * root). Answers its status.
 */
export const dispatchPlan = <P>(
	edytor: Edytor,
	operation: string,
	payload: P,
	block: string,
	prepare: (payload: P) => Prepared
): CommandResult['status'] => {
	const { facade, dispatcher } = edytor;
	dispatcher.dispatch(
		operation,
		payload,
		{ block: edytor.idToBlock.get(block) ?? edytor.root! },
		(payload, plan = prepare(payload)) => {
			if ('writes' in plan) facade.apply(plan);
		},
		prepare
	);
	return dispatcher.last?.operation === operation ? dispatcher.last.status : 'refused';
};

/**
 * Show `offset` of block `id`'s text: the closed toggles it sits in open
 * (Notion), and it scrolls into view. The selection stays where it was.
 */
export const showText = (edytor: Edytor, id: string, offset: number) => {
	const block = edytor.idToBlock.get(id);
	if (!block) return;
	reveal(block);
	block.textAtOffset(offset)?.text.node?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
};
