/**
 * GATE H adversarial probes — R4 (public snapshot isolation).
 *
 * Pinned tests cover mutation through project()/contentItems()/block.items,
 * canonical identity, proxy payloads, nested data. Probed here:
 *
 *  1. RAW engine writes bypass the facade's sanitizeWireJson boundary —
 *     a mark value that survives the wire but breaks the read interner
 *     (`JSON.stringify` throws on BigInt / cyclic). If a peer can ship
 *     such a mark, every public read (`runs`, `contentItems`, `project`,
 *     `toJSON`, `snapshot`) becomes a crash — the isolation fix turns
 *     into an availability hole.
 *
 *  2. `__proto__` keys through sanitizeWireJson's `out[k] = ...` walk —
 *     sets the clone's PROTOTYPE, not an own key (silent drop locally);
 *     verify the wire form agrees (no divergence), not corruption.
 *
 *  3. Caller-held object mutation AFTER write (write-side clone check).
 *
 *  4. decorateRuns deep-freezes the caller's decoration `value` objects
 *     in place — a mutation side effect on caller-owned data.
 */
// @ts-nocheck -- exercises private model/engine internals on purpose.
import { describe, expect, test } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { bindEdytorDoc } from '../../../lib/crdt/index.js';
import { decorateRuns } from '../../../lib/crdt/text/runs.js';
import { DEFAULT_SEED_ID as BOOTSTRAP_BLOCK } from '../default-seed.js';

const E = bindEdytorDoc(Y);
let cid = 500_000;

const seed = () => {
	const doc = new Y.Doc();
	doc.clientID = cid++;
	const ed = E.create(doc);
	ed.init({
		content: [{ id: 'b', type: 'paragraph', content: [{ kind: 'text', text: 'hello world' }] }]
	});
	return { doc, ed };
};

const contentNodeOf = (ed: any, id: string) => ed.resolveBlock(id)!.getAttr('content');

describe('gateH-R4 — non-JSON mark values via RAW engine write (facade bypass)', () => {
	test('a Map mark value stored raw: reads normalize it; mutation of caller Map is inert', () => {
		const { ed } = seed();
		const m = new Map([['x', 1]]);
		const t = contentNodeOf(ed, 'b');
		// RAW insert — bypasses sanitizeWireJson (callers CAN reach this via
		// ed.doc / resolveBlock). Stores {m: Map} verbatim.
		t.insert(0, 'QQ', { m });
		expect(ed.blockText('b')).toContain('QQ');
		const runs = ed.runs('b');
		const raw = runs.find((r) => (r as any).text === 'QQ') as any;
		// The interner JSON-clones: published marks = {m:{}} — the live Map
		// is not aliased; caller mutation cannot reach engine state.
		m.set('y', 2);
		const runs2 = ed.runs('b');
		const raw2 = runs2.find((r) => (r as any).text === 'QQ') as any;
		console.log(
			`[r4-map] marks=${JSON.stringify(raw?.marks)} after-mut=${JSON.stringify(raw2?.marks)}`
		);
		expect(raw2?.marks).toEqual(raw?.marks);
	});

	test('a BigInt mark value stored raw: does it crash reads? does it replicate?', () => {
		const { doc, ed } = seed();
		const t = contentNodeOf(ed, 'b');
		let stored = true;
		try {
			t.insert(0, 'BB', { big: 10n });
		} catch (e) {
			stored = false;
			console.log(`[r4-bigint] insert threw: ${e}`);
		}
		if (!stored) return; // engine refused — no hole
		let readThrew: unknown = null;
		try {
			void ed.runs('b');
		} catch (e) {
			readThrew = e;
		}
		let encoded: Uint8Array | null = null;
		try {
			encoded = Y.encodeStateAsUpdate(doc);
		} catch (e) {
			console.log(`[r4-bigint] encode threw: ${e}`);
		}
		let remoteThrew: unknown = null;
		if (encoded) {
			const remote = new Y.Doc();
			remote.clientID = cid++;
			try {
				Y.applyUpdate(remote, encoded);
				const red = E.create(remote);
				void red.runs('b');
			} catch (e) {
				remoteThrew = e;
			}
		}
		console.log(
			`[r4-bigint] stored=${stored} readThrew=${String(readThrew)} ` +
				`encoded=${encoded !== null} remoteThrew=${String(remoteThrew)}`
		);
	});

	test('a cyclic mark value stored raw: encode behavior + read behavior', () => {
		const { doc, ed } = seed();
		const t = contentNodeOf(ed, 'b');
		const cyc: Record<string, unknown> = {};
		cyc.self = cyc;
		let stored = true;
		try {
			t.insert(0, 'CC', { cyc });
		} catch (e) {
			stored = false;
		}
		if (!stored) return;
		let readThrew: unknown = null;
		try {
			void ed.runs('b');
		} catch (e) {
			readThrew = e;
		}
		let encThrew: unknown = null;
		try {
			Y.encodeStateAsUpdate(doc);
		} catch (e) {
			encThrew = e;
		}
		console.log(`[r4-cyc] readThrew=${String(readThrew)} encThrew=${String(encThrew)}`);
	});

	test('a remote BigInt attr is projected, not crashed, on every replica (R4 fixed)', () => {
		// Raw Yjs writes are outside the facade's sanitizeWireJson boundary —
		// peers, migration tools, or raw consumers can ship them. Attr
		// payloads encode via lib0 writeAny (BigInt encodes fine), so a
		// BigInt block `data` replicates. FIXED: read paths project it
		// through `cloneJsonSafe` — `{big:10n}` reads as `{big:10}` on every
		// replica instead of throwing (deterministic normalization).
		const src = new Y.Doc();
		src.clientID = cid++;
		const sn = new Y.Node('block');
		src.get('blocks').setAttr('bad', sn);
		sn.setAttr('id', 'bad');
		sn.setAttr('type', 'paragraph');
		sn.setAttr('data', { big: 10n });
		const update = Y.encodeStateAsUpdate(src); // wire-valid: writeAny path
		const doc = new Y.Doc();
		doc.clientID = cid++;
		Y.applyUpdate(doc, update);
		const ed = E.create(doc);
		expect(ed.blockDataOf('bad')).toEqual({ big: 10 });
		const proj = ed.project();
		expect(proj.children.find((b: any) => b.id === 'bad')?.data).toEqual({ big: 10 });
		// Convergence: a second replica projects the same normalized form.
		const doc2 = new Y.Doc();
		doc2.clientID = cid++;
		Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc));
		const ed2 = E.create(doc2);
		expect(ed2.blockDataOf('bad')).toEqual({ big: 10 });
	});

	test('a local BigInt mark cannot poison reads; facade refuses pre-commit (R4 fixed)', () => {
		// `text.format`/`applyDelta` accepts a BigInt mark (unlike `insert`,
		// which validates). The format item integrates; then the commit's
		// own update payload is encoded for 'update' listeners →
		// ContentFormat.write's JSON.stringify throws mid-commit — the raw
		// store keeps the hostile item (vendored write path, out of scope).
		// FIXED side: `runs()` projects the mark through `cloneJsonSafe`
		// instead of crashing (residual: full-store encode still throws —
		// the poisoned ITEM is inside vendored serialization).
		const doc = new Y.Doc();
		doc.clientID = cid++;
		const ed = E.create(doc);
		ed.init();
		const cn = contentNodeOf(ed, BOOTSTRAP_BLOCK);
		cn.insert(0, 'hi');
		expect(() => cn.format(0, 2, { big: 5n })).toThrow(/BigInt/i); // throws at commit
		// Reads survive: the hostile mark projects as its JSON value.
		const runs = ed.runs(BOOTSTRAP_BLOCK);
		expect(runs.find((r: any) => r.text === 'hi')?.marks).toEqual({ big: 5 });
		// The FACADE write boundary refuses before any mutation — the doc
		// stays encodable (the raw-write poison above is separate).
		const doc2 = new Y.Doc();
		doc2.clientID = cid++;
		const ed2 = E.create(doc2);
		ed2.init();
		expect(() => ed2.setMark(BOOTSTRAP_BLOCK, 0, 0, 'big', 5n)).toThrow(/BigInt|JSON/i);
		expect(() => Y.encodeStateAsUpdate(doc2)).not.toThrow();
	});
});

describe('gateH-R4 — __proto__ key handling', () => {
	test('marks with __proto__ key: local store vs wire form agree (no divergence)', () => {
		const { doc, ed } = seed();
		// Facade write — sanitizeWireJson walks via `out[k] = v` which sets
		// the clone's PROTOTYPE for k='__proto__' rather than an own key.
		const payload = JSON.parse('{"__proto__":{"polluted":1},"b":true}');
		ed.insertText('b', 0, 'PP', payload);
		const remote = new Y.Doc();
		remote.clientID = cid++;
		Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc));
		const red = E.create(remote);
		const lr = ed.runs('b').find((r) => (r as any).text === 'PP') as any;
		const rr = red.runs('b').find((r) => (r as any).text === 'PP') as any;
		console.log(
			`[r4-proto] local=${JSON.stringify(lr?.marks)} remote=${JSON.stringify(rr?.marks)}`
		);
		expect(JSON.stringify(lr?.marks)).toBe(JSON.stringify(rr?.marks));
		// And the object prototype must not leak pollution into fresh objects.
		expect(({} as any).polluted).toBeUndefined();
	});
});

describe('gateH-R4 — caller mutation after write', () => {
	test('mutating the caller-held marks object post-insert cannot reach engine state', () => {
		const { ed } = seed();
		const marks = { b: true, nested: { x: 1 } };
		ed.insertText('b', 0, 'MM', marks);
		marks.b = false;
		marks.nested.x = 999;
		delete (marks as any).nested;
		const run = ed.runs('b').find((r) => (r as any).text === 'MM') as any;
		expect(run?.marks).toEqual({ b: true, nested: { x: 1 } });
	});

	test('mutating an array-typed mark value post-insert cannot reach engine state', () => {
		const { ed } = seed();
		const marks = { tags: ['a', 'b'] };
		ed.insertText('b', 0, 'AA', marks);
		marks.tags.push('EVIL');
		const run = ed.runs('b').find((r) => (r as any).text === 'AA') as any;
		expect(run?.marks).toEqual({ tags: ['a', 'b'] });
	});
});

describe('gateH-R4 — decorateRuns side effects on caller data', () => {
	test('decorateRuns clones caller-owned values before freezing (R4 fixed)', () => {
		const { ed } = seed();
		const runs = ed.runs('b');
		const decoValue = { cls: 'hl' };
		const out = decorateRuns(runs, [{ from: 0, to: 5, key: 'bg', value: decoValue }]);
		const decorated = out.find((r) => (r as any).decorations?.bg !== undefined) as any;
		expect(decorated?.decorations?.bg).toEqual({ cls: 'hl' });
		// FIXED contract: the emitted decorations value is a frozen CLONE —
		// it never aliases the caller's object, so the caller's copy stays
		// mutable (no freeze-in-place side effect) and later caller
		// mutation cannot reach the emitted snapshot.
		expect(decorated?.decorations?.bg).not.toBe(decoValue);
		expect(Object.isFrozen(decorated?.decorations?.bg)).toBe(true);
		let threw = false;
		try {
			(decoValue as any).cls = 'MUTATED';
		} catch {
			threw = true;
		}
		expect(threw, 'caller-owned decoration value was frozen in place').toBe(false);
		expect(decoValue.cls).toBe('MUTATED'); // caller keeps ownership
		expect(decorated?.decorations?.bg?.cls).toBe('hl'); // snapshot unaffected
	});
});

describe('gateH-R4 — DocChange payload isolation', () => {
	test('change.order is frozen — it cannot corrupt the retained diff baseline (R4 fixed)', () => {
		const { ed } = seed();
		const changes: any[] = [];
		ed.onChange((c: any) => changes.push(c));
		ed.insertBlock({ parent: null, index: 1 }, { id: 'x', type: 'paragraph' });
		const first = changes.at(-1)!;
		const orderArr = first.order.get(null);
		// FIXED: the published array IS the retained baseline — frozen at
		// takeSnap so caller vandalism throws instead of poisoning the next
		// commit's diff.
		expect(Object.isFrozen(orderArr)).toBe(true);
		let threw = false;
		try {
			orderArr.length = 0; // caller vandalism attempt — must fail
			orderArr.push('FAKE');
		} catch {
			threw = true;
		}
		expect(threw).toBe(true);
		ed.insertBlock({ parent: null, index: 1 }, { id: 'y', type: 'paragraph' });
		const second = changes.at(-1)!;
		// The second commit DID change root order (y inserted) — the intact
		// baseline diffs it correctly.
		expect(second.order.get(null)).toEqual(['b', 'y', 'x']);
		expect([...second.added.keys()]).toEqual(['y']);
	});

	test('change.content runs array is frozen (cannot corrupt published baseline)', () => {
		const { ed } = seed();
		const changes: any[] = [];
		ed.onChange((c: any) => changes.push(c));
		ed.insertText('b', 0, 'Z');
		const runs = changes.at(-1)!.content.get('b');
		console.log(
			`[r4-content] frozen=${Object.isFrozen(runs)} marksFrozen=${Object.isFrozen(runs?.[0]?.marks)}`
		);
		let threw = false;
		try {
			(runs as any).length = 0;
		} catch {
			threw = true;
		}
		console.log(`[r4-content] mutationThrew=${threw} lenAfter=${runs?.length}`);
	});

	test('snapshot()/contentJSON() throw on a BigInt mark (availability surface)', () => {
		const { ed } = seed();
		// Raw engine write bypasses the facade boundary (same vector as the
		// pinned BigInt defect) — then exercise the remaining read surface.
		const t = contentNodeOf(ed, 'b');
		try {
			t.insert(0, 'ZZ', { big: 10n });
		} catch (e) {
			console.log(`[r4-snap] raw insert threw at write: ${String(e).slice(0, 120)}`);
			return; // engine refused at write — nothing to read
		}
		let threwSnap: unknown = null;
		let threwJson: unknown = null;
		try {
			ed.snapshot('b');
		} catch (e) {
			threwSnap = e;
		}
		try {
			ed.contentJSON('b');
		} catch (e) {
			threwJson = e;
		}
		console.log(
			`[r4-snap] snapshotThrew=${String(threwSnap).slice(0, 100)} contentJSONThrew=${String(threwJson).slice(0, 100)}`
		);
	});

	test('blockDataOf/snapshot surface on cyclic block data', () => {
		const { ed } = seed();
		const cyclic: any = { a: 1 };
		cyclic.self = cyclic;
		let writeThrew: unknown = null;
		let readThrew: unknown = null;
		try {
			ed.setBlockData('b', cyclic);
		} catch (e) {
			writeThrew = e;
		}
		try {
			ed.blockDataOf('b');
		} catch (e) {
			readThrew = e;
		}
		console.log(
			`[r4-cyclicdata] writeThrew=${String(writeThrew).slice(0, 100)} readThrew=${String(readThrew).slice(0, 100)}`
		);
	});
});
