import type { Position } from '../pragmatic-drag-and-drop/entry-point/types.js';
export type Operation = 'reorder-before' | 'reorder-after' | 'combine';
export type Axis = 'horizontal' | 'vertical';
export type Instruction = {
    [TOperation in Operation]: {
        operation: TOperation;
        blocked: boolean;
        axis: Axis;
    };
}[Operation];
export declare const uniqueKey: any;
export declare const axisLookup: {
    readonly vertical: {
        readonly start: 'top';
        readonly end: 'bottom';
        readonly size: 'height';
        readonly point: 'y';
    };
    readonly horizontal: {
        readonly start: 'left';
        readonly end: 'right';
        readonly size: 'width';
        readonly point: 'x';
    };
};
export type AxisDefinition = (typeof axisLookup)[keyof typeof axisLookup];
export declare function reorder({ client, borderBox, axis, }: {
    client: Position;
    borderBox: DOMRect;
    axis: AxisDefinition;
}): 'reorder-before' | 'reorder-after';
export type Availability = 'available' | 'not-available' | 'blocked';
export { attachInstruction } from './attach-instruction-2.js';
export { extractInstruction } from './extract-instruction-2.js';
