import { expect } from 'vitest';
import type { ContractAdapter, ContractPeer, Observation, Seed } from './adapter.js';
import { block, tree } from './adapter.js';

export type ContractProgram = {
	id: string;
	family: string;
	source: string;
	run: (adapter: ContractAdapter) => void;
};

const paragraph = (
	id: string,
	text: string,
	children: unknown[] = [],
	marks: Record<number, Record<string, string | boolean>> = {}
) => ({
	id,
	type: 'paragraph',
	text,
	units: text.split('').map((value, index) => ({ value, marks: marks[index] ?? {} })),
	children
});

/** This checks relationships independently of the candidate's reachability code. */
export function assertWellFormed(observation: Observation): void {
	const reached = new Set<string>();
	const units = new Set<string>();
	const visit = (id: string, parent: string | null) => {
		if (reached.has(id)) throw new Error(`Duplicate or cyclic block ${id}`);
		const node = block(observation, id);
		if (node.parent !== parent) throw new Error(`Incorrect parent of ${id}`);
		if (node.units.map((unit) => unit.value).join('') !== node.text)
			throw new Error(`Text does not match units in ${id}`);
		reached.add(id);
		for (const unit of node.units) {
			if (units.has(unit.id)) throw new Error(`Duplicate content identity ${unit.id}`);
			units.add(unit.id);
		}
		for (const child of node.children) visit(child, id);
	};
	for (const root of observation.roots) visit(root, null);
	if (reached.size !== Object.keys(observation.blocks).length)
		throw new Error('A live block is unreachable');
}

function withPeers(
	adapter: ContractAdapter,
	seed: Seed[],
	run: (a: ContractPeer, peer: (actor: string) => ContractPeer) => void
): void {
	const a = adapter.create('a', seed);
	const peers = [a];
	try {
		run(a, (actor) => {
			const copy = adapter.create(actor);
			peers.push(copy);
			copy.apply(a.encode());
			return copy;
		});
	} finally {
		for (const peer of peers) peer.destroy();
	}
}

function converge(peers: ContractPeer[], order: number[] = peers.map((_, index) => index)): void {
	const updates = peers.map((peer) => peer.encode());
	for (const peer of peers) for (const index of order) peer.apply(updates[index]!);
	for (const peer of peers) {
		const beforeDuplicate = peer.observe();
		for (const index of order) peer.apply(updates[index]!);
		expect(peer.observe()).toEqual(beforeDuplicate);
		assertWellFormed(peer.observe());
		expect(peer.observe()).toEqual(peers[0]!.observe());
	}
}

/** Literal expected values come from the accepted behavior matrix, never candidate output. */
const executablePrograms: readonly ContractProgram[] = [
	{
		id: 'boundary.predecessor-append',
		family: 'reference continuity',
		source: 'rewrite plan §9, split-start/predecessor append',
		run(adapter) {
			withPeers(adapter, [{ id: 'P', text: 'alphaHello' }], (a, peer) => {
				a.split('P', 5, 'Q');
				const b = peer('b');
				const caret = b.anchor('Q', 0, 'left');
				a.insert('P', 5, 'X');
				b.apply(a.encode());
				expect(b.resolve(caret)).toEqual({ blockId: 'Q', offset: 0 });
				b.insert('Q', 0, 'Z');
				converge([a, b]);
				expect(tree(a.observe())).toEqual([paragraph('P', 'alphaX'), paragraph('Q', 'ZHello')]);
			});
		}
	},
	{
		id: 'boundary.same-gap-insert',
		family: 'reference continuity',
		source: 'rewrite plan §9, split-start/same-gap insert',
		run(adapter) {
			withPeers(adapter, [{ id: 'P', text: 'alphaHello' }], (a, peer) => {
				a.split('P', 5, 'Q');
				const b = peer('b');
				const caret = b.anchor('Q', 0, 'left');
				a.insert('Q', 0, 'X');
				b.apply(a.encode());
				expect(b.resolve(caret)).toEqual({ blockId: 'Q', offset: 0 });
				b.insert('Q', 0, 'Z');
				converge([a, b]);
				expect(tree(a.observe())).toEqual([paragraph('P', 'alpha'), paragraph('Q', 'ZXHello')]);
			});
		}
	},
	{
		id: 'boundary.remote-join',
		family: 'reference continuity',
		source: 'rewrite plan §9, split-start/remote join',
		run(adapter) {
			withPeers(adapter, [{ id: 'P', text: 'alphaHello' }], (a, peer) => {
				a.split('P', 5, 'Q');
				const b = peer('b');
				const caret = b.anchor('Q', 0, 'left');
				a.join('P', 'Q');
				b.apply(a.encode());
				expect(b.resolve(caret)).toEqual({ blockId: 'P', offset: 5 });
				b.insert('P', 5, 'Z');
				converge([a, b]);
				expect(tree(a.observe())).toEqual([paragraph('P', 'alphaZHello')]);
			});
		}
	},
	{
		id: 'move.remote-edit',
		family: 'structure and identity',
		source: 'rewrite plan §9, move B after C while remote appends',
		run(adapter) {
			withPeers(
				adapter,
				[
					{ id: 'A', text: 'alpha' },
					{ id: 'B', text: 'Hello' },
					{ id: 'C', text: 'world' }
				],
				(a, peer) => {
					const b = peer('b');
					const identities = block(a.observe(), 'B').units.map((unit) => unit.id);
					a.move('B', null, null);
					b.insert('B', 5, '!');
					converge([a, b], [1, 0]);
					expect(tree(a.observe())).toEqual([
						paragraph('A', 'alpha'),
						paragraph('C', 'world'),
						paragraph('B', 'Hello!')
					]);
					expect(
						block(a.observe(), 'B')
							.units.slice(0, 5)
							.map((unit) => unit.id)
					).toEqual(identities);
				}
			);
		}
	},
	{
		id: 'history.local-insert-remote-append',
		family: 'selective history',
		source: 'rewrite plan §9, local X and remote Y then local undo',
		run(adapter) {
			withPeers(adapter, [{ id: 'P', text: 'abc' }], (a, peer) => {
				const b = peer('b');
				const local = a.insert('P', 1, 'X');
				b.insert('P', 3, 'Y');
				converge([a, b]);
				expect(tree(a.observe())).toEqual([paragraph('P', 'aXbcY')]);
				a.undo(local);
				converge([a, b]);
				expect(tree(a.observe())).toEqual([paragraph('P', 'abcY')]);
			});
		}
	},
	{
		id: 'history.concurrent-double-delete',
		family: 'selective history',
		source: 'rewrite plan §9, deletion plus foreign concurrent edit and selective undo',
		run(adapter) {
			withPeers(adapter, [{ id: 'P', text: 'abc' }], (a, peer) => {
				const b = peer('b');
				const first = a.delete('P', 1, 2);
				const second = b.delete('P', 1, 2);
				converge([a, b], [1, 0]);
				expect(tree(a.observe())).toEqual([paragraph('P', 'ac')]);
				a.undo(first);
				converge([a, b]);
				expect(tree(a.observe())).toEqual([paragraph('P', 'ac')]);
				b.undo(second);
				converge([a, b]);
				expect(tree(a.observe())).toEqual([paragraph('P', 'abc')]);
			});
		}
	},
	{
		id: 'split.range-one-undo',
		family: 'command atomicity',
		source: 'editor selected-range Enter contract and prototype adversarial pin',
		run(adapter) {
			withPeers(adapter, [{ id: 'P', text: 'abcd' }], (a) => {
				const original = block(a.observe(), 'P').units.map((unit) => unit.id);
				const split = a.split('P', 1, 'Q', 3);
				expect(tree(a.observe())).toEqual([paragraph('P', 'a'), paragraph('Q', 'd')]);
				a.undo(split);
				expect(tree(a.observe())).toEqual([paragraph('P', 'abcd')]);
				expect(block(a.observe(), 'P').units.map((unit) => unit.id)).toEqual(original);
			});
		}
	},
	{
		id: 'structure.nested-move',
		family: 'structure and identity',
		source: 'rewrite plan §9, inside move of nested subtree',
		run(adapter) {
			withPeers(
				adapter,
				[
					{
						id: 'P',
						text: 'parent',
						children: [{ id: 'C', text: 'child', children: [{ id: 'D', text: 'leaf' }] }]
					},
					{ id: 'Q', text: 'destination' }
				],
				(a) => {
					const original = block(a.observe(), 'C').units.map((unit) => unit.id);
					a.move('C', 'Q', null);
					assertWellFormed(a.observe());
					expect(tree(a.observe())).toEqual([
						paragraph('P', 'parent'),
						paragraph('Q', 'destination', [paragraph('C', 'child', [paragraph('D', 'leaf')])])
					]);
					expect(block(a.observe(), 'C').units.map((unit) => unit.id)).toEqual(original);
				}
			);
		}
	},
	{
		id: 'structure.join-move-undo',
		family: 'structure and history',
		source: 'rewrite plan §9, join × move × undo',
		run(adapter) {
			for (const order of [
				[0, 1],
				[1, 0]
			]) {
				withPeers(
					adapter,
					[
						{ id: 'P', text: 'p' },
						{ id: 'Q', text: 'q' },
						{ id: 'R', text: 'r' }
					],
					(a, peer) => {
						const b = peer('b');
						const observer = peer('observer');
						const join = a.join('P', 'Q');
						b.insert('R', 0, 'X');
						b.move('R', 'Q', null);
						const updates = [a.encode(), b.encode()];
						for (const index of order) observer.apply(updates[index]!);
						converge([a, b, observer]);
						expect(tree(observer.observe())).toEqual([
							paragraph('P', 'pq', [paragraph('R', 'Xr')])
						]);
						a.undo(join);
						converge([a, b, observer]);
						expect(tree(observer.observe())).toEqual([
							paragraph('P', 'p'),
							paragraph('Q', 'q', [paragraph('R', 'Xr')])
						]);
					}
				);
			}
		}
	},
	{
		id: 'transport.three-author-held-release',
		family: 'transport and structure',
		source: 'rewrite plan §10, named three-author held-delivery program',
		run(adapter) {
			for (const order of [
				[2, 1, 0],
				[0, 2, 1]
			]) {
				withPeers(
					adapter,
					[
						{ id: 'P', text: 'one' },
						{ id: 'Q', text: 'two' },
						{ id: 'R', text: 'three' }
					],
					(a, peer) => {
						const b = peer('b');
						const c = peer('c');
						const observer = peer('observer');
						a.split('P', 1, 'S');
						b.move('Q', 'R', null);
						c.insert('P', 0, 'X');
						const updates = [a.encode(), b.encode(), c.encode()];
						for (const index of order) observer.apply(updates[index]!);
						converge([a, b, c, observer]);
						expect(tree(observer.observe())).toEqual([
							paragraph('P', 'Xo'),
							paragraph('S', 'ne'),
							paragraph('R', 'three', [paragraph('Q', 'two')])
						]);
					}
				);
			}
		}
	},
	{
		id: 'marks.split-preserves-valued-mark',
		family: 'formatting and structure',
		source: 'rewrite plan §9, marked split seam',
		run(adapter) {
			withPeers(adapter, [{ id: 'P', text: 'abcde' }], (a) => {
				a.mark('P', 2, 5, 'color', 'red');
				a.split('P', 2, 'Q');
				expect(tree(a.observe())).toEqual([
					paragraph('P', 'ab'),
					paragraph('Q', 'cde', [], {
						0: { color: 'red' },
						1: { color: 'red' },
						2: { color: 'red' }
					})
				]);
			});
		}
	},
	{
		id: 'composition.observed-identity-replacement',
		family: 'composition semantics',
		source:
			'rewrite plan §9, provisional selection with unseen remote insert; headless semantic slice only',
		run(adapter) {
			withPeers(adapter, [{ id: 'P', text: 'abcd' }], (a, peer) => {
				const selected = block(a.observe(), 'P')
					.units.slice(1, 3)
					.map((unit) => unit.id);
				const start = a.anchor('P', 1, 'left');
				const b = peer('b');
				b.insert('P', 2, 'X');
				b.insert('P', 0, 'Y');
				a.apply(b.encode());
				a.replaceObserved(start, selected, '漢');
				converge([a, b]);
				expect(tree(a.observe())).toEqual([paragraph('P', 'Ya漢Xd')]);
			});
		}
	}
];

/** The prototype currently violates this program; the candidate must run it unchanged. */
export const candidateOnlyPrograms = executablePrograms.filter(
	({ id }) => id === 'transport.three-author-held-release'
);
export const supportedPrograms = executablePrograms.filter(
	({ id }) => id !== 'transport.three-author-held-release'
);
export const candidatePrograms = executablePrograms;
