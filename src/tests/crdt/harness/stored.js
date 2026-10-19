// @ts-nocheck -- reads two engines' plain JS structs.
/**
 * What a document stores, as its own engine encodes and decodes it: each
 * struct's id, length, origins, parent, key and content, and the delete set,
 * as one JSON string. Two engines that store the same thing give the same
 * string whatever bytes their encodings write: the fork's encoding writes
 * each string once (fork patch YP24), upstream's v2 writes them all, so the
 * differentials compare stores, never encodings.
 */

const idOf = (id) => (id == null ? null : [id.client, id.clock]);

const contentOf = (c) => {
	const ref = c.getRef();
	switch (ref) {
		case 1:
			return [ref, c.len];
		case 3:
			return [ref, Array.from(c.content)];
		case 4:
			return [ref, c.str];
		case 6:
			return [ref, c.key, c.value];
		case 7:
			return [ref, c.type.name ?? null];
		case 8:
			return [ref, c.arr];
		default:
			return [ref, c.getContent()];
	}
};

const structOf = (s) =>
	s.content === undefined
		? [s.constructor.name, idOf(s.id), s.length]
		: [
				idOf(s.id),
				s.length,
				idOf(s.origin),
				idOf(s.rightOrigin),
				typeof s.parent === 'string' ? s.parent : idOf(s.parent),
				s.parentSub,
				contentOf(s.content)
			];

/** `doc`'s store as engine `E` writes and reads it back. */
export const storedOf = (E, doc) => {
	const update = (E.encodeStateAsUpdateV2 ?? E.encodeStateAsUpdate)(doc);
	const { structs, ds } = (E.decodeUpdateV2 ?? E.decodeUpdate)(update);
	const deletes = [...ds.clients.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([client, ranges]) => [client, ranges.getIds().map((r) => [r.clock, r.len])]);
	return JSON.stringify({ structs: structs.map(structOf), deletes });
};
