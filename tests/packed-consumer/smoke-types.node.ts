/**
 * Type-level smoke for the node-safe package surface — `edytor/crdt`
 * (vendored engine) + `edytor/crdt/edytor` (bindings) — under the strictest
 * realistic consumer posture: `moduleResolution: nodenext`, `strict`,
 * `skipLibCheck: false`. No `.svelte` types may leak into this surface, and
 * every `import()` path in the emitted declarations must carry `.js`.
 */
import * as Y from 'edytor/crdt';
import * as bindings from 'edytor/crdt/edytor';

const doc: Y.Doc = new Y.Doc();
const node: Y.Node = doc.get('content');
node.setAttr('type', 'root');
const child = new Y.Node('paragraph');
node.insert(0, [child]);
child.insert(0, 'typed');
const d = child.delta.toJSON();
const update: Uint8Array = Y.encodeStateAsUpdate(doc);
const doc2: Y.Doc = new Y.Doc();
Y.applyUpdate(doc2, update);
const um: Y.UndoManager = new Y.UndoManager(doc);
const rpos: Y.RelativePosition = Y.createRelativePositionFromTypeIndex(child, 1);
const json = Y.relativePositionToJSON(rpos);
void d;
void doc2;
void um;
void json;

// ── binding surface types (Doc + Awareness + facade + providers + sync) ──
const crdt: bindings.Crdt = bindings.bindCrdt(Y as bindings.EngineApi);
const crdtDoc: bindings.YDoc = crdt.createDoc();
const ed = crdt.doc.create(crdtDoc as unknown as bindings.EngineDoc);
ed.init();
const ids: string[] = ed.childrenIds(null);
ed.insertBlock({ parent: null, index: 0 }, { id: 'b1', type: 'paragraph' });
ed.insertText('b1', 0, 'typed');
ed.formatRange('b1', 0, 5, { bold: true });
const v: number | undefined = ed.schemaVersion();
const undo = ed.createUndoManager({ captureTimeout: 0 });
const storyJson: ReturnType<typeof ed.toJSON> = ed.toJSON();
const awareness: bindings.Awareness = new crdt.Awareness(crdtDoc);
const providers: bindings.ProviderStack = crdt.providers;
const migration: bindings.Migration = crdt.migration;
const sync: bindings.SyncProtocol = crdt.sync;
const sv: Uint8Array = Y.encodeStateVector(crdtDoc);
const delta: Uint8Array = Y.encodeStateAsUpdate(crdtDoc, sv);
const crdtDoc2: bindings.YDoc = crdt.createDoc();
Y.applyUpdate(crdtDoc2, delta);
ed.dispose();
crdtDoc.destroy();
crdtDoc2.destroy();
awareness.destroy();
void ids;
void v;
void undo;
void storyJson;
void awareness;
void providers;
void migration;
void sync;

// `<Edytor {sync}>` factories are reachable through the bound stack too —
// the node-safe equivalent of the root-level exports.
const idbSync: bindings.EdytorSync = crdt.providers.createIndexeddbSync('doc-id');
const wsSync: bindings.EdytorSync = crdt.providers.createWebsocketSync({
	serverUrl: 'wss://example.com',
	roomName: 'doc-id'
});
const IdbProvider: bindings.ProviderStack['IndexeddbPersistence'] =
	crdt.providers.IndexeddbPersistence;
void idbSync;
void wsSync;
void IdbProvider;

// ── the integrated document API (U9 headline) — fully typed, no casts ──
// The factories are pre-bound to the vendored engine; the canonical JSON
// and every document member are nameable through this subpath.
const jsonSeed: bindings.JSONDoc = {
	children: [{ type: 'paragraph', id: 'n1', content: [{ text: 'typed doc' }] }]
};
const edDoc: bindings.EdytorDocument = bindings.createDocument({
	value: jsonSeed,
	actor: { id: 'typed-actor', name: 'Typed', color: '#123456' }
});
const readiness: bindings.DocumentReadiness = edDoc.readiness;
const actor: bindings.DocumentActor = edDoc.actor;
const facade: bindings.EdytorDoc = edDoc.facade;
const exported: bindings.JSONDoc = facade.toJSON();
const projected: bindings.ProjectedDoc = facade.project();
const firstProjected: bindings.ProjectedBlock | undefined = projected.children[0];
edDoc.transact(() => facade.insertText(firstProjected!.id, 0, '!'));
const history: bindings.YUndoManager = edDoc.history;
history.undo();
const attribution: bindings.DocumentAttribution = edDoc.attribution;
const who: string | undefined = attribution.actorOf(edDoc.clientID);
const encoded: Uint8Array = edDoc.encode();
const loaded: bindings.EdytorDocument = bindings.loadDocument(encoded);
const borrowedRaw = new Y.Doc();
const attachedDoc: bindings.EdytorDocument = bindings.attachDocument(borrowedRaw);
const syncCleanup = attachedDoc.attachSync(
	({ doc: d, awareness: a, synced }: bindings.EdytorSyncPayload) => {
		void d;
		void a;
		synced();
	},
	{ value: jsonSeed }
);
const docErrors: (
	| typeof bindings.DocumentNotReadyError
	| typeof bindings.DocumentDestroyedError
	| typeof bindings.SemanticConflictError
)[] = [
	bindings.DocumentNotReadyError,
	bindings.DocumentDestroyedError,
	bindings.SemanticConflictError
];
// ── U2 attribution surface — compact per-block records + actor
// dictionary + the `legacy()` read over pre-existing `a/` records;
// `ContentRun` carries no per-item authorship.
const contentRun: bindings.ContentRun = { kind: 'text', text: 'x' };
const legacyMap: ReturnType<bindings.DocumentAttribution['legacy']> = attribution.legacy();
const blockAttr: bindings.BlockAttribution | undefined = attribution.block(firstProjected!.id);
const actorsMap: ReadonlyMap<string, bindings.ActorProfile> = attribution.actors;
// The server-coordinator frame contract (D-15 keeps it; README "Server coordinator").
const coordinatorFrame: Uint8Array = bindings.frame(bindings.messageSync, (e: bindings.Encoder) =>
	bindings.writeVarUint8Array(e, new Uint8Array())
);
type _engineTx = bindings.EngineTransaction;
void contentRun;
void legacyMap;
void blockAttr;
void actorsMap;
void coordinatorFrame;

void readiness;
void actor;
void exported;
void firstProjected;
void who;
void loaded;
void borrowedRaw;
void syncCleanup;
void docErrors;
