/**
 * The id of the default seed's block: an empty value seeds one `paragraph`
 * under an id derived from the seed hash (R13, D-3). It replaces the deleted
 * reserved bootstrap id in fixtures that type into a fresh document.
 */
import { Y } from '../../lib/crdt/engine.js';
import { bindEdytorDoc } from '../../lib/crdt/index.js';

const E = bindEdytorDoc(Y);
const doc = new Y.Doc();
E.seed(doc);

export const DEFAULT_SEED_ID: string = E.create(doc).childrenIds(null)[0]!;
