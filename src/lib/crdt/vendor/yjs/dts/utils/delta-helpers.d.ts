export function diffDocsToDelta(v1: Doc, v2: Doc, { renderer }?: {
    renderer?: import("./Renderer.js").DiffRenderer | undefined;
}): delta.DeltaBuilderAny;
import * as delta from 'lib0-v14/delta';
