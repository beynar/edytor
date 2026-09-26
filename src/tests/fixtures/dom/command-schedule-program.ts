// @ts-nocheck
/**
 * Shared seeded command-schedule program — extracted so both the pinned
 * spec (command-schedules.test.ts) and the bounded qualification campaign
 * (command-campaign.test.ts) drive the SAME op generator, expectation
 * oracle, and settle ordering. See the spec file for the claim list.
 */
import { expect } from 'vitest';
import '../../crdt/harness/vclock.js';
import { mulberry32 } from '../../crdt/harness/rng.js';
import { serializeTrace } from '../../crdt/harness/trace.js';
import { vclock } from '../../crdt/harness/vclock.js';
import {
	createCommandPeers,
	installDeterministicIds,
	installTimerAccounting,
	runCommand,
	at,
	type CommandPeer
} from './command-peer-set.js';
import {
	canonicalTree,
	flushDomUpdates,
	setNativeSelection,
	type CanonicalBlock
} from '../../dom/test.utils.js';
import type { BeforeInputCommand } from '$lib/events/beforeInputCommands.js';

export const SCHEDULE_SEED = {
	children: [
		{ type: 'paragraph', content: [{ text: 'northwind' }] },
		{ type: 'paragraph', content: [{ text: 'harbor light' }] },
		{ type: 'paragraph', content: [{ text: 'third quay' }] }
	]
};

export type ScheduleOp = {
	actor: 'A' | 'B';
	block: number;
	offset: number;
	inputType: BeforeInputCommand;
	data?: string;
};

/** Derive the next op from the rng + the actor's LIVE document state —
 * offsets are clamped to real text lengths so the program stays legal
 * under divergence (peers disagree mid-partition by construction). */
export const pickOp = (
	rng: ReturnType<typeof mulberry32>,
	peer: CommandPeer,
	step: number
): ScheduleOp => {
	const children = peer.edytor.root!.children;
	const block = Math.floor(rng() * children.length);
	const text = children[block]!.firstText;
	const len = text.length;
	const offset = Math.floor(rng() * (len + 1));
	const roll = rng();
	if (roll < 0.55) {
		// Deterministic glyph stream — collisions across steps merge runs.
		return {
			actor: peer.peer.name as 'A' | 'B',
			block,
			offset,
			inputType: 'insertText',
			data: String.fromCharCode(97 + ((step * 7 + Math.floor(rng() * 26)) % 26))
		};
	}
	if (roll < 0.82 && offset > 0) {
		return {
			actor: peer.peer.name as 'A' | 'B',
			block,
			offset,
			inputType: 'deleteContentBackward'
		};
	}
	return {
		actor: peer.peer.name as 'A' | 'B',
		block,
		offset: Math.min(offset, len),
		inputType: 'deleteContentForward'
	};
};

/**
 * Independent per-command expectation: from the actor's pre-command
 * canonical tree, compute the tree the op MUST produce. Every generated
 * op is text-local except `deleteContentForward` at a text end (a
 * flat-paragraph merge) and at document end (a legal no-op). Throws —
 * fails the step loudly — when asked beyond the flat-paragraph model.
 */
export const expectedAfterOp = (
	before: CanonicalBlock[],
	op: ScheduleOp
): { tree: CanonicalBlock[]; caret: number } => {
	const tree = structuredClone(before);
	const block = tree[op.block];
	const part = block?.content?.find((p) => 'text' in p) as { text: string } | undefined;
	if (!block || !part) {
		throw new Error(`generated op targets no text part: b${op.block}`);
	}
	const text = part.text;
	if (op.inputType === 'insertText') {
		part.text = text.slice(0, op.offset) + op.data + text.slice(op.offset);
		return { tree, caret: op.offset + (op.data?.length ?? 0) };
	}
	if (op.inputType === 'deleteContentBackward') {
		part.text = text.slice(0, op.offset - 1) + text.slice(op.offset);
		return { tree, caret: op.offset - 1 };
	}
	if (op.inputType === 'deleteContentForward') {
		if (op.offset < text.length) {
			part.text = text.slice(0, op.offset) + text.slice(op.offset + 1);
			return { tree, caret: op.offset };
		}
		const next = tree[op.block + 1];
		if (!next) {
			// Forward-delete at the document end: a legal no-op — the tree
			// and the caret are exactly what they were.
			return { tree, caret: op.offset };
		}
		const nextPart = next.content?.find((p) => 'text' in p) as { text: string } | undefined;
		if (!nextPart || next.children?.length || block.children?.length) {
			throw new Error('merge expectation outside the flat-paragraph model');
		}
		part.text = text + nextPart.text;
		tree.splice(op.block + 1, 1);
		return { tree, caret: text.length };
	}
	throw new Error(`no expectation model for ${op.inputType}`);
};

export const runSchedule = async (
	seed: number,
	steps: number,
	opts: { runOp?: typeof runCommand } = {}
) => {
	vclock.set(1_000);
	const restoreIds = installDeterministicIds(seed);
	const timers = installTimerAccounting();
	const { set, peers } = await createCommandPeers(SCHEDULE_SEED, 2, {
		rngSeed: seed,
		undoCaptureTimeout: 0
	});
	set.clock = () => vclock.now;
	const [A, B] = peers;
	const rng = mulberry32(seed ^ 0x5eed);
	const exec = opts.runOp ?? runCommand;
	const quiesce = async (label: string) => {
		// The pending count is recorded, never discarded — an out-of-horizon
		// remainder is evidence in the trace, not silence.
		const beyond = await timers.quiesce();
		set.record({
			kind: 'command',
			a: 'sched',
			d: `${label} quiesce settled (${beyond} out-of-horizon pending)`
		});
	};

	try {
		for (let step = 0; step < steps; step++) {
			// Fixed partition window: hold during the middle third of every
			// schedule so held windows exercise true concurrency.
			if (step === Math.floor(steps / 3)) set.partition('A', 'B');
			if (step === Math.floor((steps * 2) / 3)) set.heal('A', 'B');

			const actor = rng() < 0.5 ? A : B;
			const op = pickOp(rng, actor, step);
			// Snapshot BEFORE the command — the expectation is derived from
			// the pre-state, not observed from the post-state.
			const expected = expectedAfterOp(canonicalTree(actor.edytor), op);
			await setNativeSelection(actor.edytor, at(actor, op.block), op.offset);
			set.record({
				kind: 'command',
				a: op.actor,
				i: op.inputType,
				d: `b${op.block}@${op.offset}${op.data ? ` "${op.data}"` : ''}`
			});
			exec(actor.edytor, op.inputType, op.data);
			await flushDomUpdates();

			// LOCAL settle BEFORE the expectation — deferred work the
			// command scheduled (verification rewrites, chained timers,
			// microtask-registered callbacks) is part of THIS command's
			// result. Asserting before the drain lets a deferred mutation
			// land after the check and become the next step's accepted
			// baseline — the deferred-corruption escape the reviewer found.
			await timers.quiesce();

			// Per-command effect oracle — independent of convergence and
			// repeatability. A no-op command implementation fails HERE.
			expect(canonicalTree(actor.edytor)).toEqual(expected.tree);
			expect(actor.edytor.selection.state.yStart).toBe(expected.caret);

			// Per-step delivery coin — withheld deliveries accumulate
			// through the partition window into real divergence.
			if (rng() < 0.55) {
				set.deliver(op.actor, op.actor === 'A' ? 'B' : 'A');
			}
			await flushDomUpdates();
			// Remote-apply settle is a SEPARATE phase — a delivery schedules
			// its own deferred work on the receiving peer (selection
			// repair, reconciles), and that work must drain before the next
			// step starts, not leak into it.
			await timers.quiesce();
			vclock.advance(1);
		}

		set.heal('A', 'B');
		while (set.deliverAll() > 0) {
			// Remote application can enqueue further diffs — drain to empty.
		}
		await flushDomUpdates();
		await quiesce('final');

		return {
			trace: serializeTrace(set.trace),
			// Raw events for coverage accounting — the serialized form drops
			// `i` (inputType), so op-kind coverage must read these.
			events: set.trace,
			signature: {
				A: canonicalTree(A.edytor, true),
				B: canonicalTree(A.edytor, true)
			}
		};
	} finally {
		for (const p of peers) p.unmount();
		restoreIds();
		timers.restore();
	}
};
