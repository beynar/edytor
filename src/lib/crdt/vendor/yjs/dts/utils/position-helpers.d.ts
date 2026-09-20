export function createRelativePositionsFromDeltaPositions(root: YNode<any> | Doc, positions: Array<DeltaPosition>, opts?: {
    renderer?: AbstractRenderer | null;
}): Array<import("./RelativePosition.js").RelativePosition | null>;
export function createDeltaPositionsFromRelativePositions(root: YNode<any> | Doc, rposs: Array<import("./RelativePosition.js").RelativePosition | null>, opts?: {
    renderer?: AbstractRenderer | null;
    followUndoneDeletions?: boolean;
}): Array<DeltaPosition | null>;
export function createRelativePositionFromDeltaPosition(root: YNode<any> | Doc, pos: DeltaPosition, opts?: {
    renderer?: AbstractRenderer | null;
}): import("./RelativePosition.js").RelativePosition | null;
export function createDeltaPositionFromRelativePosition(root: YNode<any> | Doc, rpos: import("./RelativePosition.js").RelativePosition | null, opts?: {
    renderer?: AbstractRenderer | null;
    followUndoneDeletions?: boolean;
}): DeltaPosition | null;
export type DeltaPosition = import("lib0-v14/delta/position").Pos;
export type AbstractRenderer = import("./Renderer.js").AbstractRenderer;
