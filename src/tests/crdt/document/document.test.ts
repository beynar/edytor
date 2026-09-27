/**
 * U1 — the assembled document (`createDocument`/`loadDocument`/`attachDocument`).
 *
 * Headless lifecycle: create → seed → edit → history → encode → load →
 * destroy, plus the readiness contract (pending vs ready) and the
 * owned/borrowed teardown matrix.
 */
import { describe, expect, it } from 'vitest';
import { Y } from '../../../lib/crdt/engine.js';
import {
	attachDocument,
	createDocument,
	DocumentNotReadyError,
	loadDocument,
	SemanticConflictError
} from '../../../lib/crdt/index.js';
import { bindEdytorDoc } from '../../../lib/crdt/edytor-doc.js';
import { DocumentDestroyedError } from '../../../lib/crdt/document.js';
import { Awareness } from '../../../lib/crdt/protocols/awareness.js';
import type { JSONDoc } from '../../../lib/utils/json.js';
import { DEFAULT_SEED_ID } from '../default-seed.js';

const E = bindEdytorDoc(Y);

const docValue = (text = 'hello'): JSONDoc => ({
	children: [{ type: 'paragraph', content: [{ text }] }]
});

const textOfBlock = (document: { facade: { blockText: (id: string) => string } }, id: string) =>
	document.facade.blockText(id);

describe('createDocument', () => {
	it('seeds synchronously with a value and arrives ready', () => {
		const document = createDocument({ value: docValue() });
		expect(document.ready).toBe(true);
		expect(document.readiness).toBe('local');
		expect(document.facade.isInitialized()).toBe(true);
		const children = document.facade.project().children;
		expect(children).toHaveLength(1);
		expect(textOfBlock(document, children[0].id)).toBe('hello');
		document.destroy();
	});

	it('stays pending without a value — nothing bootstrapped', () => {
		const document = createDocument();
		expect(document.ready).toBe(false);
		expect(document.readiness).toBe('pending');
		expect(document.facade.isInitialized()).toBe(false);
		expect(document.facade.project().children).toHaveLength(0);
		// History must never initialize content — gated access fails visibly.
		expect(() => document.history).toThrowError(DocumentNotReadyError);
		// The readiness transition seeds the canonical bootstrap block.
		document.sync();
		expect(document.ready).toBe(true);
		expect(document.readiness).toBe('local');
		expect(document.facade.project().children.map((b) => b.id)).toEqual([DEFAULT_SEED_ID]);
		expect(document.history.undoStack).toHaveLength(0);
		document.destroy();
	});

	it('edits headlessly and undoes via document.history', () => {
		const document = createDocument({ value: docValue('hi') });
		const [block] = document.facade.project().children;
		document.transact(() => document.facade.insertText(block.id, 2, ' there'));
		expect(textOfBlock(document, block.id)).toBe('hi there');
		document.history.undo();
		expect(textOfBlock(document, block.id)).toBe('hi');
		document.history.redo();
		expect(textOfBlock(document, block.id)).toBe('hi there');
		document.destroy();
	});

	it('never captures the seed/bootstrap as an undo step', () => {
		const document = createDocument({ value: docValue('seed') });
		while (document.history.undoStack.length > 0) {
			document.history.undo();
		}
		// The seed predates capture — undo cannot strip it.
		expect(document.facade.project().children).toHaveLength(1);
		document.destroy();
	});
});

describe('encode → loadDocument', () => {
	it('restores replicated state on a fresh replica identity', () => {
		const source = createDocument({ value: docValue('round-trip') });
		const update = source.encode();
		const restored = loadDocument(update, { actor: { id: 'restorer' } });

		expect(restored.ready).toBe(true);
		expect(restored.readiness).toBe('hydrated');
		expect(restored.doc.clientID).not.toBe(source.doc.clientID);
		expect(restored.doc.guid).not.toBe(source.doc.guid);
		expect(restored.actor.id).toBe('restorer');
		expect(restored.facade.toJSON()).toEqual(source.facade.toJSON());

		source.destroy();
		restored.destroy();
	});

	it('validates the schema BEFORE facade/history/awareness attach', () => {
		// A rogue doc with registry state but no meta.v version record.
		const rogue = new Y.Doc();
		rogue.get('blocks').setAttr('b1', { type: 'paragraph' });
		const update = Y.encodeStateAsUpdate(rogue);
		expect(() => loadDocument(update)).toThrowError(E.SchemaMismatchError);
	});

	it('restores an empty update as a ready bootstrap document', () => {
		const restored = loadDocument(Y.encodeStateAsUpdate(new Y.Doc()));
		expect(restored.ready).toBe(true);
		expect(restored.facade.project().children.map((b) => b.id)).toEqual([DEFAULT_SEED_ID]);
		restored.destroy();
	});
});

describe('actor', () => {
	it('uses the supplied actor and publishes it into awareness', () => {
		const document = createDocument({
			actor: { id: 'user-42', name: 'Arnaud', color: '#7559ee' }
		});
		expect(document.actor).toEqual({ id: 'user-42', name: 'Arnaud', color: '#7559ee' });
		const state = document.awareness.getLocalState();
		expect(state?.actor).toEqual({ id: 'user-42', name: 'Arnaud', color: '#7559ee' });
		expect(state?.user).toEqual({ name: 'Arnaud', color: '#7559ee' });
		document.destroy();
	});

	it('assigns an opaque anonymous actor when none is supplied', () => {
		const document = createDocument();
		expect(document.actor.id).toMatch(/^anon-/);
		expect(document.actor.name).toBeUndefined();
		expect(document.awareness.getLocalState()?.actor?.id).toBe(document.actor.id);
		document.destroy();
	});
});

describe('document-level semantics', () => {
	it('adopts first declarations and rejects conflicting rules', () => {
		const document = createDocument({
			semantics: { roles: { divider: { void: true } }, defaultType: 'paragraph' }
		});
		// Compatible re-declarations are a no-op; additive types adopt.
		document.adoptSemantics({ roles: { divider: { void: true } } });
		document.adoptSemantics({ roles: { code: { island: true } } });
		expect(document.semantics.roles.get('code')).toMatchObject({ island: true });
		expect(document.semantics.roles.get('divider')).toMatchObject({ void: true });

		expect(() => document.adoptSemantics({ roles: { divider: { void: false } } })).toThrowError(
			SemanticConflictError
		);
		expect(() => document.adoptSemantics({ roles: { divider: {} } })).toThrowError(
			SemanticConflictError
		);
		expect(() => document.adoptSemantics({ defaultType: 'other' })).toThrowError(
			SemanticConflictError
		);
		document.destroy();
	});

	it('adoption is atomic — a late conflict leaves no partial role behind', () => {
		const document = createDocument({
			semantics: { roles: { divider: { void: true } } }
		});
		// `a` precedes the conflict in iteration order — the old
		// incremental merge would have adopted it before throwing.
		expect(() =>
			document.adoptSemantics({ roles: { a: { island: true }, divider: { void: false } } })
		).toThrowError(SemanticConflictError);
		expect(document.semantics.roles.has('a')).toBe(false);
		expect(document.semantics.roles.get('divider')).toMatchObject({ void: true });
		document.destroy();
	});
});

describe('provider hydration deferral', () => {
	it('does not seed over hydrated content — remote state wins', () => {
		const remote = createDocument({ value: docValue('remote') });
		const document = createDocument(); // pending — a provider may hydrate it

		Y.applyUpdate(document.doc, remote.encode());
		expect(document.facade.isInitialized()).toBe(true);

		// The view/provider `synced` path must NOT overwrite hydration.
		document.sync(docValue('local override'));
		const [block] = document.facade.project().children;
		expect(textOfBlock(document, block.id)).toBe('remote');
		expect(document.ready).toBe(true);
		expect(document.readiness).toBe('hydrated');

		// History attaches after hydration — immediately usable.
		document.transact(() => document.facade.insertText(block.id, 0, 'x'));
		document.history.undo();
		expect(textOfBlock(document, block.id)).toBe('remote');

		remote.destroy();
		document.destroy();
	});

	it('seeds-if-empty on sync after a provider reports synced with no content', () => {
		const document = createDocument();
		// Simulated provider: synced without any remote state.
		document.attachSync(({ synced }) => {
			synced();
			return () => {};
		});
		expect(document.ready).toBe(true);
		expect(document.facade.project().children.map((b) => b.id)).toEqual([DEFAULT_SEED_ID]);
		document.destroy();
	});
});

describe('attachSync', () => {
	it('runs tracked provider cleanups on destroy', () => {
		const document = createDocument();
		let cleanups = 0;
		document.attachSync(({ synced }) => {
			synced();
			return () => {
				cleanups++;
			};
		});
		document.destroy();
		expect(cleanups).toBe(1);
	});

	it('the returned cleanup unregisters itself — destroy() does not re-run it', () => {
		const document = createDocument();
		let cleanups = 0;
		const cleanup = document.attachSync(({ synced }) => {
			synced();
			return () => {
				cleanups++;
			};
		});
		expect(typeof cleanup).toBe('function');
		cleanup!();
		expect(cleanups).toBe(1);
		document.destroy();
		expect(cleanups).toBe(1); // teardown must not run it a second time
	});

	it('a throwing sync factory leaves nothing tracked behind', () => {
		const document = createDocument();
		expect(() =>
			document.attachSync(() => {
				throw new Error('mid-build');
			})
		).toThrowError('mid-build');
		let cleanups = 0;
		document.attachSync(({ synced }) => {
			synced();
			return () => {
				cleanups++;
			};
		});
		document.destroy();
		expect(cleanups).toBe(1); // only the real cleanup ran — no phantom record
	});
});

describe('destroy — owned vs borrowed', () => {
	it('releases document-owned resources exactly once', () => {
		const document = createDocument({ value: docValue() });
		let destroyEvents = 0;
		document.doc.on('destroy', () => destroyEvents++);

		document.destroy();
		document.destroy(); // double-destroy is a safe no-op
		expect(destroyEvents).toBe(1);
		expect(document.destroyed).toBe(true);
		expect(document.doc.isDestroyed).toBe(true);
		// Document-created awareness was destroyed (local state dropped).
		expect(document.awareness.getLocalState()).toBeNull();
	});

	it('does not destroy a borrowed raw doc (attachDocument)', () => {
		const raw = new Y.Doc();
		const document = attachDocument(raw);
		document.sync();
		document.destroy();

		expect(document.destroyed).toBe(true);
		expect(raw.isDestroyed).toBe(false);
		// The facade/runs lease is released — a fresh one attaches cleanly.
		const facade = E.create(raw);
		expect(facade.isInitialized()).toBe(true);
		facade.dispose();
	});

	it('does not destroy a borrowed awareness', () => {
		const raw = new Y.Doc();
		const awareness = new Awareness(raw);
		const document = attachDocument(raw, { awareness });
		document.destroy();
		expect(awareness.getLocalState()).not.toBeNull();
		awareness.destroy();
	});

	it('gates every public service behind DocumentDestroyedError', () => {
		const document = createDocument({ value: docValue() });
		document.destroy();
		expect(() => document.history).toThrowError(DocumentDestroyedError);
		expect(() => document.sync()).toThrowError(DocumentDestroyedError);
		expect(() => document.adoptSemantics({})).toThrowError(DocumentDestroyedError);
		expect(() => document.trackOrigin({})).toThrowError(DocumentDestroyedError);
		expect(() => document.clearHistory()).toThrowError(DocumentDestroyedError);
		expect(() => document.attachSync(() => {})).toThrowError(DocumentDestroyedError);
	});

	it('refuses to attach a destroyed raw doc', () => {
		const raw = new Y.Doc();
		raw.destroy();
		expect(() => attachDocument(raw)).toThrowError(DocumentDestroyedError);
	});
});

describe('attach references (U6b/R3)', () => {
	it('retain() returns a one-shot release — a double release cannot consume another holder', () => {
		const raw = new Y.Doc();
		const document = attachDocument(raw);
		// A second holder acquires its own release capability.
		const release = document.retain();
		release();
		release(); // one-shot: the second call is a no-op, not an over-release
		expect(document.destroyed).toBe(false);
		// The attach reference still holds — only now does teardown run.
		document.destroy();
		expect(document.destroyed).toBe(true);
		expect(raw.isDestroyed).toBe(false);
	});

	it('retained references extend the shared document lifetime independently of destroy order', () => {
		const raw = new Y.Doc();
		const document = attachDocument(raw);
		const release = document.retain();
		document.destroy(); // attach ref released — the retained ref keeps it alive
		expect(document.destroyed).toBe(false);
		release();
		expect(document.destroyed).toBe(true);
	});

	it('retain() on a destroyed document refuses', () => {
		const document = createDocument({ value: docValue() });
		document.destroy();
		expect(() => document.retain()).toThrowError(DocumentDestroyedError);
	});
});

describe('history manager external teardown', () => {
	it('an externally destroyed manager is replaced — never handed back dead', () => {
		const document = createDocument({ value: docValue('x') });
		const dead = document.history;
		dead.destroy(); // external misuse — kills the manager's doc observers

		const replacement = document.history;
		expect(replacement).not.toBe(dead);
		// The reattached manager still captures — the dead one stopped
		// observing transactions entirely.
		const [block] = document.facade.project().children;
		document.transact(() => document.facade.insertText(block.id, 1, 'a'));
		expect(replacement.undoStack).toHaveLength(1);
		document.destroy();
	});
});
