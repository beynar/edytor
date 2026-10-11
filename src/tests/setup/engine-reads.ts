/**
 * Every vitest lane reads engine state through the node's test-side reads
 * (`toJSON`, `toArray`, `getAttrs`, …): the fork ships none of them (fork
 * patch YP19), so they are installed here, before any test runs.
 */
import { installNodeReads } from '../crdt/harness/node-reads.js';

installNodeReads();
