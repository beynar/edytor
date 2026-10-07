/**
 * U8 — the document-admission boundary (`src/lib/crdt/admission.ts`).
 *
 * One gate for every content-entry path, pinned end to end:
 *
 * - `createDocument` / `loadDocument` / `attachDocument` / `sync()` all
 *   run the same ordered checks (usable → schema → verdict);
 * - refusal preserves data: refused docs stay byte-identical, refused
 *   updates keep their bytes, nothing half-composes;
 * - `sync()` is the single explicit readiness transition — a doc that
 *   enters a problem state between attach and sync refuses there (stays
 *   `pending`, state preserved) instead of being silently seeded over;
 * - a pending document never writes or broadcasts a bootstrap block
 *   before `sync()` — pinned through a real `IndexeddbPersistence`
 *   provider and its BC frames;
 * - hydration/migration/admission writes never enter local undo.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import * as Y13 from 'yjs';
import * as bc from 'lib0-v14/broadcastchannel';
import * as decoding from 'lib0-v14/decoding';
import * as idb from 'lib0-v14/indexeddb';
import { Y } from '../../../lib/crdt/engine.js';
import {
	attachDocument,
	createDocument,
	loadDocument,
	SchemaMismatchError,
	UndecodableUpdateError,
	UnsupportedDocError,
	type EngineDoc
} from '../../../lib/crdt/index.js';
import { assertAdmission, inspectAdmission, SCHEMA_VERSION } from '../../../lib/crdt/protocol.js';
import { bindEdytorDoc } from '../../../lib/crdt/edytor-doc.js';
import { bindProviders } from '../../../lib/crdt/providers/index.js';
import { bindSync } from '../../../lib/crdt/protocols/sync.js';
import {
	GENERATION_KEY,
	GENERATION_RECORD,
	generationDbName,
	readProtocolVersion
} from '../../../lib/crdt/protocols/envelope.js';
import type { JSONDoc } from '../../../lib/utils/json.js';
import type { YDoc } from '../../../lib/crdt/engine-api.js';
import { DEFAULT_SEED_ID } from '../default-seed.js';

const E = bindEdytorDoc(Y);
const providers = bindProviders(Y);
const syncProtocol = bindSync(Y);

const engineDoc = (doc: YDoc): EngineDoc => doc as unknown as EngineDoc;

const docValue = (text = 'hello'): JSONDoc => ({
	children: [{ type: 'paragraph', content: [{ text }] }]
});

const uniqueName = (() => {
	let n = 0;
	return (base: string) => `${base}-${n++}`;
})();

const until = async (cond: () => boolean, timeout = 5000): Promise<void> => {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > timeout) throw new Error('until() timed out');
		await new Promise((r) => setTimeout(r, 10));
	}
};

// ── refused/fixture doc states ─────────────────────────────────────────

/** Registry content but no `meta.v` — the classic rogue write. */
const makeUnversionedDoc = (): YDoc => {
	const doc = new Y.Doc();
	doc.get('blocks').setAttr('b1', { type: 'paragraph' });
	return doc;
};

/** A future-schema claim this build cannot speak (`meta.v = 99`). */
const makeV99Doc = (): YDoc => {
	const doc = new Y.Doc();
	doc.get('meta').setAttr('v', 99);
	doc.get('meta').setAttr('schema', 'edytor-doc');
	doc.get('blocks').setAttr('b1', { type: 'paragraph' });
	return doc;
};

/** Supported version but a manifest naming another schema. */
const makeForeignManifestDoc = (): YDoc => {
	const doc = new Y.Doc();
	doc.get('meta').setAttr('v', SCHEMA_VERSION);
	doc.get('meta').setAttr('schema', 'other-schema');
	doc.get('blocks').setAttr('b1', { type: 'paragraph' });
	return doc;
};

/** Unrelated roots, no schema claim at all — must admit `pending`. */
const makeForeignRootsDoc = (): YDoc => {
	const doc = new Y.Doc();
	doc.get('todos').setAttr('t1', { text: 'milk' });
	return doc;
};

const encoded = (doc: YDoc): Uint8Array => Y.encodeStateAsUpdate(doc);

describe('assertAdmission / inspectAdmission', () => {
	it('verdicts the full state matrix with typed refusals', () => {
		expect(assertAdmission(engineDoc(new Y.Doc()))).toBe('fresh');

		const seeded = createDocument({ value: docValue() });
		expect(assertAdmission(engineDoc(seeded.doc))).toBe('initialized');
		seeded.destroy();

		const unversioned = inspectAdmission(engineDoc(makeUnversionedDoc()));
		expect(unversioned.admitted).toBe(false);
		if (!unversioned.admitted) {
			expect(unversioned.error).toBeInstanceOf(SchemaMismatchError);
			expect((unversioned.error as SchemaMismatchError).problem.kind).toBe('unversioned');
		}

		const unsupported = inspectAdmission(engineDoc(makeV99Doc()));
		expect(unsupported.admitted).toBe(false);
		if (!unsupported.admitted) {
			expect((unsupported.error as SchemaMismatchError).problem.kind).toBe('unsupported');
		}

		const foreign = inspectAdmission(engineDoc(makeForeignManifestDoc()));
		expect(foreign.admitted).toBe(false);
		if (!foreign.admitted) {
			expect((foreign.error as SchemaMismatchError).problem.kind).toBe('foreign');
		}

		const v13 = inspectAdmission(engineDoc(new Y13.Doc() as unknown as YDoc));
		expect(v13.admitted).toBe(false);
		if (!v13.admitted) {
			expect(v13.error).toBeInstanceOf(UnsupportedDocError);
			expect((v13.error as UnsupportedDocError).kind).toBe('foreign');
		}
	});

	it('is write-free — refused docs stay byte-identical', () => {
		for (const doc of [makeUnversionedDoc(), makeV99Doc(), makeForeignManifestDoc()]) {
			const before = encoded(doc);
			inspectAdmission(engineDoc(doc));
			expect(encoded(doc)).toEqual(before);
		}
	});
});

describe('loadDocument admission', () => {
	it('admits a valid update → hydrated, content intact, history clean', () => {
		const source = createDocument({ value: docValue('round-trip') });
		const restored = loadDocument(source.encode());
		expect(restored.readiness).toBe('hydrated');
		expect(restored.facade.toJSON()).toEqual(source.facade.toJSON());
		expect(restored.history.undoStack).toHaveLength(0);
		source.destroy();
		restored.destroy();
	});

	it('admits an empty update → local bootstrap', () => {
		const restored = loadDocument(encoded(new Y.Doc()));
		expect(restored.readiness).toBe('local');
		expect(restored.facade.project().children.map((b) => b.id)).toEqual([DEFAULT_SEED_ID]);
		restored.destroy();
	});

	it.each([
		['unversioned', makeUnversionedDoc(), SchemaMismatchError],
		['unsupported', makeV99Doc(), SchemaMismatchError],
		['foreign', makeForeignManifestDoc(), SchemaMismatchError]
	] as const)('refuses a %s payload — the offered bytes are untouched', (_kind, doc, errorType) => {
		const update = encoded(doc);
		const bytes = new Uint8Array(update);
		expect(() => loadDocument(update)).toThrowError(errorType);
		// Refusal preserved the payload: the same bytes still decode to the
		// same state on a plain doc.
		const verify = new Y.Doc();
		Y.applyUpdate(verify, bytes);
		expect(encoded(verify)).toEqual(bytes);
	});

	it('refuses a corrupt payload with UndecodableUpdateError', () => {
		expect(() => loadDocument(new TextEncoder().encode('not-an-update'))).toThrowError(
			UndecodableUpdateError
		);
	});

	// (v13-era payload → UnsupportedDocError 'legacy' — covered against the
	// real fixture binaries in ../migration/migration-admission.test.ts.)
});

describe('attachDocument admission', () => {
	it('admits a fresh doc → pending until explicit sync()', () => {
		const doc = new Y.Doc();
		const document = attachDocument(doc);
		expect(document.readiness).toBe('pending');
		expect(document.facade.isInitialized()).toBe(false);
		document.sync();
		expect(document.readiness).toBe('local');
		expect(document.facade.project().children.map((b) => b.id)).toEqual([DEFAULT_SEED_ID]);
		document.destroy();
	});

	it('admits an initialized doc → pending → hydrated on sync()', () => {
		const source = createDocument({ value: docValue('attached') });
		const doc = new Y.Doc();
		Y.applyUpdate(doc, source.encode());
		const document = attachDocument(doc);
		expect(document.readiness).toBe('pending');
		document.sync();
		expect(document.readiness).toBe('hydrated');
		expect(document.facade.toJSON()).toEqual(source.facade.toJSON());
		source.destroy();
		document.destroy();
	});

	it.each([
		['unversioned', makeUnversionedDoc()],
		['unsupported', makeV99Doc()],
		['foreign manifest', makeForeignManifestDoc()]
	] as const)('refuses a %s doc — byte-identical after refusal, reattach heals', (_kind, doc) => {
		const before = encoded(doc);
		let updates = 0;
		doc.on('update', () => updates++);
		expect(() => attachDocument(doc)).toThrowError(SchemaMismatchError);
		expect(encoded(doc)).toEqual(before);
		expect(updates).toBe(0);
		doc.destroy();
	});

	it('refuses a real v13 yjs Doc as foreign — its data is untouched', () => {
		const v13 = new Y13.Doc();
		v13.getMap('content').set('k', 'v');
		expect(() => attachDocument(v13 as unknown as YDoc)).toThrowError(UnsupportedDocError);
		// The foreign doc's CONTENT is intact. (Its own engine's `get`
		// materializes an empty root type during the gate's shape read —
		// engine-level noise, not a write to user data.)
		expect(v13.getMap('content').get('k')).toBe('v');
		v13.destroy();
	});

	it('heals: stamping the version record makes the doc attachable', () => {
		const doc = makeUnversionedDoc();
		expect(() => attachDocument(doc)).toThrowError(SchemaMismatchError);
		// The state heals in place — version + manifest arrive (here: raw,
		// as a peer update would deliver them).
		doc.get('meta').setAttr('v', SCHEMA_VERSION);
		doc.get('meta').setAttr('schema', 'edytor-doc');
		const document = attachDocument(doc);
		document.sync();
		expect(document.readiness).toBe('hydrated');
		// The formerly-rogue content was adopted, not rewritten.
		expect(doc.get('blocks').getAttr('b1')).toEqual({ type: 'paragraph' });
		document.destroy();
		doc.destroy();
	});

	it('admits foreign roots without a schema claim → seeds alongside them', () => {
		const doc = makeForeignRootsDoc();
		const document = attachDocument(doc);
		expect(document.readiness).toBe('pending');
		document.sync();
		expect(document.readiness).toBe('local');
		// Foreign content coexists next to the seeded schema.
		expect(doc.get('todos').getAttr('t1')).toEqual({ text: 'milk' });
		expect(document.facade.project().children.map((b) => b.id)).toEqual([DEFAULT_SEED_ID]);
		document.destroy();
		doc.destroy();
	});
});

describe('sync() — the admission re-check', () => {
	it('refuses readiness when the doc went rogue between attach and sync', () => {
		const doc = new Y.Doc();
		const document = attachDocument(doc);
		const before = encoded(doc);
		// A raw bypass write lands unversioned content (no transport gate
		// on raw applies) — sync() must refuse rather than stamp a schema
		// over it.
		doc.get('blocks').setAttr('rogue', { type: 'paragraph' });
		expect(encoded(doc)).not.toEqual(before); // the rogue write landed
		expect(() => document.sync()).toThrowError(SchemaMismatchError);
		expect(document.readiness).toBe('pending');
		// The doc's state is preserved — no cleanup/normalization writes.
		expect(doc.get('blocks').getAttr('rogue')).toEqual({ type: 'paragraph' });
		// …and a retry after healing works.
		doc.get('meta').setAttr('v', SCHEMA_VERSION);
		doc.get('meta').setAttr('schema', 'edytor-doc');
		document.sync();
		expect(document.readiness).toBe('hydrated');
		document.destroy();
		doc.destroy();
	});

	it('hydrates on sync() after a remote apply — never enters local undo', () => {
		const source = createDocument({ value: docValue('remote') });
		const doc = new Y.Doc();
		const document = attachDocument(doc);
		// Originless applyUpdate — the remote-exclusion contract works via
		// transaction.local, no stamped origin needed.
		Y.applyUpdate(doc, source.encode());
		document.sync();
		expect(document.readiness).toBe('hydrated');
		expect(document.history.undoStack).toHaveLength(0);
		source.destroy();
		document.destroy();
		doc.destroy();
	});

	it('is idempotent once ready', () => {
		const document = createDocument({ value: docValue('idem') });
		document.sync({ children: [{ type: 'paragraph', content: [{ text: 'ignored' }] }] });
		expect(document.facade.project().children).toHaveLength(1);
		document.destroy();
	});
});

describe('pending doc — no bootstrap before sync', () => {
	it('a stubbed sync that never fires leaves the doc untouched', async () => {
		const doc = new Y.Doc();
		const document = attachDocument(doc);
		// attach() itself publishes the actor's attribution records — that
		// is the designed pre-readiness write; pin state AFTER it so the
		// assertion is "nothing further lands while pending".
		const before = encoded(doc);
		let updates = 0;
		doc.on('update', () => updates++);
		document.attachSync(() => {});
		await new Promise((r) => setTimeout(r, 60));
		expect(updates).toBe(0);
		expect(encoded(doc)).toEqual(before);
		expect(document.readiness).toBe('pending');
		document.destroy();
		doc.destroy();
	});

	it('IndexeddbPersistence on a pending doc publishes no bootstrap state', async () => {
		const name = uniqueName('admit-idb');
		const doc = new Y.Doc();
		const document = attachDocument(doc);
		const frames: Uint8Array[] = [];
		bc.subscribe(generationDbName(name), (data: ArrayBuffer) => {
			frames.push(new Uint8Array(data));
		});
		let updates = 0;
		doc.on('update', () => updates++);
		const preSeed = Y.encodeStateVector(doc);
		document.attachSync(providers.createIndexeddbSync(name));
		// While pending, the doc emits NOTHING — the provider's hello
		// (SyncStep1, awareness) may publish, but the doc itself never
		// writes a bootstrap before the synced callback runs sync().
		const start = Date.now();
		while (!document.ready) {
			expect(updates).toBe(0);
			if (Date.now() - start > 5000) throw new Error('provider never synced');
			await new Promise((r) => setTimeout(r, 10));
		}
		expect(updates).toBeGreaterThan(0); // the seed commits at the synced transition
		// The provider joined the room and said hello — its SyncStep1 is the
		// pre-seed state vector (arch-v2 T2 join rule: a joiner publishes no
		// unsolicited state; a member asks for what it lacks) — the attach
		// state exactly: no bootstrap was written before the synced
		// transition.
		const step1 = frames
			.map((buf) => {
				const decoder = decoding.createDecoder(buf);
				if (!readProtocolVersion(decoder)) return null;
				if (decoding.readVarUint(decoder) !== 0 /* messageSync */) return null;
				if (decoding.readVarUint(decoder) !== syncProtocol.messageYjsSyncStep1) return null;
				return decoding.readVarUint8Array(decoder);
			})
			.find((u) => u !== null);
		expect(step1).toBeDefined();
		expect(step1).toEqual(preSeed);
		expect(document.readiness).toBe('local');
		expect(document.facade.project().children.map((b) => b.id)).toEqual([DEFAULT_SEED_ID]);
		document.destroy();
		doc.destroy();
	});
});

describe('IndexedDB hydration → document admission', () => {
	const seedGeneration = async (name: string, update: Uint8Array) => {
		const db = await idb.openDB(generationDbName(name), (db) =>
			idb.createStores(db, [['updates', { autoIncrement: true }], ['custom']])
		);
		try {
			const [updatesStore, customStore] = idb.transact(db, ['updates', 'custom']);
			await idb.rtop(customStore.put({ ...GENERATION_RECORD }, GENERATION_KEY));
			const stored = new Uint8Array(update.byteLength);
			stored.set(update);
			await idb.addAutoKey(updatesStore, stored.buffer);
		} finally {
			db.close();
		}
	};

	const generationRows = async (name: string): Promise<Uint8Array[]> => {
		const db = await idb.openDB(generationDbName(name), () => {});
		try {
			const [updatesStore] = idb.transact(db, ['updates'], 'readonly');
			return (await idb.getAll(updatesStore)).map((row) => new Uint8Array(row as ArrayBuffer));
		} finally {
			db.close();
		}
	};

	it('accepted hydration → document lands hydrated via provider synced', async () => {
		const name = uniqueName('admit-idb-ok');
		const source = createDocument({ value: docValue('persisted') });
		const expected = source.facade.toJSON();
		await seedGeneration(name, source.encode());
		source.destroy();

		const doc = new Y.Doc();
		const document = attachDocument(doc);
		document.attachSync(providers.createIndexeddbSync(name));
		await until(() => document.ready);
		expect(document.readiness).toBe('hydrated');
		expect(document.facade.toJSON()).toEqual(expected);
		expect(document.history.undoStack).toHaveLength(0);
		document.destroy();
		doc.destroy();
	});

	it('a forged stamp in a same-generation container → pending, read-only, rows preserved', async () => {
		// D-2: the container record proves the generation, so its rows
		// hydrate; the document — not the transport — refuses the stamp.
		const name = uniqueName('admit-idb-refused');
		const v99 = encoded(makeV99Doc());
		await seedGeneration(name, v99);

		const doc = new Y.Doc();
		const document = attachDocument(doc);
		let readyEvents = 0;
		document.onReady(() => readyEvents++);
		document.attachSync(providers.createIndexeddbSync(name));
		await new Promise((r) => setTimeout(r, 200));
		// Admission refused readiness; the document stays pending and no
		// readiness event wakes a view into a decision refused the same way.
		expect(document.readiness).toBe('pending');
		expect(document.syncPending).toBe(false);
		expect(readyEvents).toBe(0);
		// Read-only: no write lands, nothing is persisted or compacted.
		expect(document.writable).toBe(false);
		const rows = await generationRows(name);
		expect(rows[0]).toEqual(v99);
		document.destroy();
		doc.destroy();
	});
});
