export function idAtIndex(type: YNode, index: number, assoc?: number): ID | null;
export function indexOfId(doc: Doc, id: ID, assoc?: number): {
    type: YNode;
    index: number;
} | null;
