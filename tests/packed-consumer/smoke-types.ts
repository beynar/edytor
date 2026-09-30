/**
 * Type-level smoke for the FULL package surface — the real Svelte-consumer
 * posture (`moduleResolution: bundler`, `strict`, `skipLibCheck: false`).
 * Covers `import 'edytor'` (component + plugins + bound sync factories),
 * `edytor/crdt`, and `edytor/crdt/edytor`. The node-only posture lives in
 * smoke-types.node.ts.
 */
import * as Y from 'edytor/crdt';
import {
	Edytor,
	bindCrdt,
	createDocument,
	loadDocument,
	attachDocument,
	createIndexeddbSync,
	createWebsocketSync,
	clearDocument,
	storeState,
	IndexeddbPersistence,
	WebsocketProvider,
	richTextPlugin,
	type ContentRun,
	type DocumentActor,
	type DocumentAttribution,
	type DocumentReadiness,
	type EdytorDocument,
	type EdytorSync,
	type WebsocketSync,
	type JSONDoc,
	type Plugin,
	type ProjectedDoc
} from 'edytor';
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

// ── public binding surface types ─────────────────────────────────────────
const crdt: bindings.Crdt = bindCrdt(Y as bindings.EngineApi);
const crdtDoc: bindings.YDoc = crdt.createDoc();
const ed = crdt.doc.create(crdtDoc as unknown as bindings.EngineDoc);
ed.init();
const ids: string[] = ed.childrenIds(null);
const v: number | undefined = ed.schemaVersion();
const undo = ed.createUndoManager({ captureTimeout: 0 });
const awareness: bindings.Awareness = new crdt.Awareness(crdtDoc);
const providers: bindings.ProviderStack = crdt.providers;
const migration: bindings.Migration = crdt.migration;
const sync: bindings.SyncProtocol = crdt.sync;
void ids;
void v;
void undo;
void awareness;
void providers;
void migration;
void sync;

// ── the real consumer story must be fully typed ──────────────────────────
// Doc + Awareness + facade ops + update exchange + provider/sync factories
// — all through the three public subpaths, never a vendored deep import.
const storyDoc: bindings.YDoc = crdt.createDoc();
const storyAwareness: bindings.Awareness = new crdt.Awareness(storyDoc);
const storyEd = crdt.doc.create(storyDoc as unknown as bindings.EngineDoc);
storyEd.init();
storyEd.insertBlock({ parent: null, index: 0 }, { id: 'b1', type: 'paragraph' });
storyEd.insertText('b1', 0, 'typed');
storyEd.formatRange('b1', 0, 5, { bold: true });
const storyJson: ReturnType<typeof storyEd.toJSON> = storyEd.toJSON();
const sv: Uint8Array = Y.encodeStateVector(storyDoc);
const delta: Uint8Array = Y.encodeStateAsUpdate(storyDoc, sv);
const storyDoc2: bindings.YDoc = crdt.createDoc();
Y.applyUpdate(storyDoc2, delta);
storyEd.dispose();
storyDoc.destroy();
storyDoc2.destroy();
storyAwareness.destroy();
void storyJson;

// `<Edytor {sync}>` wiring — the factories bound to the vendored engine,
// exported at the package root as the README documents.
const idbSync: EdytorSync = createIndexeddbSync('doc-id');
const wsSync: EdytorSync = createWebsocketSync({
	serverUrl: 'wss://example.com',
	roomName: 'doc-id'
});
// Local persistence is on by default; its database name is on the sync.
const persisted: WebsocketSync = createWebsocketSync({
	serverUrl: 'wss://example.com',
	roomName: 'doc-id',
	persistName: 'user-1:doc-id'
});
const persistName: string | undefined = persisted.persistName;
const socketOnly: WebsocketSync = createWebsocketSync({
	serverUrl: 'wss://example.com',
	roomName: 'doc-id',
	persist: false
});
void persistName;
void socketOnly;
const IdbProvider: typeof IndexeddbPersistence = IndexeddbPersistence;
const WsProvider: typeof WebsocketProvider = WebsocketProvider;
const clearDoc: typeof clearDocument = clearDocument;
const store: typeof storeState = storeState;
const plugins: Plugin[] = [richTextPlugin];
void idbSync;
void wsSync;
void IdbProvider;
void WsProvider;
void clearDoc;
void store;
void plugins;
void Edytor;

// ── the integrated document API — the headline surface, fully typed ────
// `createDocument`/`loadDocument`/`attachDocument` + the canonical JSON
// reach Svelte consumers straight from the package root (the same names
// the node-safe `edytor/crdt/edytor` surface exports).
const docSeed: JSONDoc = {
	children: [{ type: 'paragraph', id: 'root-p1', content: [{ text: 'typed' }] }]
};
const rootDoc: EdytorDocument = createDocument({
	value: docSeed,
	actor: { id: 'root-actor' } satisfies DocumentActor,
	semantics: bindings.defaultSemantics
});
const rootReadiness: DocumentReadiness = rootDoc.readiness;
const rootProjected: ProjectedDoc = rootDoc.facade.project();
rootDoc.transact(() => rootDoc.facade.insertText(rootProjected.children[0]!.id, 0, '!'));
rootDoc.facade.insertBlock(
	{ parent: null, index: 1 },
	bindings.toBlockSpec(rootDoc.facade.blockJSON('root-p1'), { freshIds: true })
);
rootDoc.history.undo();
const rootAttribution: DocumentAttribution = rootDoc.attribution;
const rootUpdate: Uint8Array = rootDoc.encode();
const rootLoaded: EdytorDocument = loadDocument(rootUpdate);
const rootAttached: EdytorDocument = attachDocument(doc);

// U2: the run vocabulary carries no per-item attribution — `ContentRun`
// stays nameable; `document.attribution` exposes block records + the
// actor dictionary + the `legacy()` read over pre-existing `a/` records.
const rootContentRun: ContentRun = { kind: 'text', text: 'x' };
const rootLegacy = rootAttribution.legacy();
const rootBlockAttr = rootAttribution.block(rootProjected.children[0]!.id);
void rootContentRun;
void rootLegacy;
void rootBlockAttr;
void rootReadiness;
void rootAttribution;
void rootLoaded;
void rootAttached;

// BW-08: the `view` argument types of the range and flow operations.
const rangeView: bindings.RangeView = { hidden: (id) => id === 'body' };
const flowView: bindings.FlowView = { ...rangeView, itemKind: () => 'list-item' };
rootDoc.facade.prepare.deleteRange({ block: 'a', offset: 0 }, { block: 'a', offset: 1 }, rangeView);
rootDoc.facade.prepare.insertFlow({ block: 'a', offset: 0 }, { lines: [] }, flowView);
