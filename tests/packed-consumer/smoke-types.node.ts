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
const doc2: Y.Doc = Y.createDocFromUpdate(update);
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
