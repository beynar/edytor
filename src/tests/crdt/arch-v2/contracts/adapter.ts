/** A test boundary, not a candidate storage or public editor API. */
export type Seed = {
	id: string;
	text: string;
	type?: string;
	children?: Seed[];
};

export type ObservedBlock = {
	id: string;
	type: string;
	parent: string | null;
	children: string[];
	text: string;
	units: { id: string; value: string; marks: Record<string, string | boolean> }[];
};

export type Observation = {
	roots: string[];
	blocks: Record<string, ObservedBlock>;
};

export type Reference = unknown;
export type Edit = string;

export interface ContractPeer {
	observe(): Observation;
	insert(block: string, at: number, text: string): Edit;
	delete(block: string, from: number, to: number): Edit;
	split(block: string, from: number, newId: string, to?: number): Edit;
	join(left: string, right: string): Edit;
	move(block: string, parent: string | null, before: string | null): Edit;
	mark(block: string, from: number, to: number, key: string, value: string | boolean | null): Edit;
	anchor(block: string, offset: number, affinity: 'left' | 'right'): Reference;
	resolve(reference: Reference): { blockId: string; offset: number } | null;
	replaceObserved(reference: Reference, ids: string[], text: string): Edit;
	undo(edit?: Edit): Edit | null;
	encode(): Uint8Array;
	apply(bytes: Uint8Array): void;
	destroy(): void;
}

export interface ContractAdapter {
	create(actor: string, seed?: Seed[]): ContractPeer;
}

export function block(observation: Observation, id: string): ObservedBlock {
	const value = observation.blocks[id];
	if (!value) throw new Error(`Contract expected a live block: ${id}`);
	return value;
}

export function tree(observation: Observation): unknown {
	const visit = (id: string): unknown => {
		const value = block(observation, id);
		return {
			id: value.id,
			type: value.type,
			text: value.text,
			units: value.units.map(({ value: unit, marks }) => ({ value: unit, marks })),
			children: value.children.map(visit)
		};
	};
	return observation.roots.map(visit);
}
