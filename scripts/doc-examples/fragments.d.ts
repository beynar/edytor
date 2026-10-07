/**
 * The handles a snippet reads from the page around it (`edytor.*`,
 * `block.*`), for fragments only: `.ts` blocks with no `import` or `export`.
 * A component or a module declares, imports or binds what it uses, as an app
 * does, so `pnpm check:docs` never lets one read these.
 */
import type { Block, EdytorDocument, EdytorInstance, InlineBlock } from 'edytor';

declare global {
	/** The editor instance a page bound with `bind:edytor` (`edytor.*` snippets). */
	const edytor: EdytorInstance;
	/** A document's facade, `document.facade` or `edytor.facade` (`facade.*` snippets). */
	const facade: EdytorDocument['facade'];
	/** A block handle, as `edytor.idToBlock.get(id)` returns it (`block.*` snippets). */
	const block: Block;
	/** An inline block handle (`atom.*` snippets). */
	const atom: InlineBlock;
	/** A block's id (`blockId` in snippets). */
	const blockId: string;
	/** The signed-in user's id, the document's id and a session token your app holds. */
	const userId: string;
	const documentId: string;
	const token: string;
}

export {};
