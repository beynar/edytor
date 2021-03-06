import {
  Editor,
  NodesArray,
  YLeaf,
  YNode,
  YNodeProps,
  YArray,
  leafLength,
  leafNodeContent,
  leafNodeContentLength,
  leafString,
  createLeaf,
  getChildren,
  getIndex,
  getNode,
  nanoid,
  traverse,
  mergeLeafs,
  EdytorArray
} from "..";
import { Map, Array } from "yjs";

export const mergeContentWithPrevLeaf = (editor: Editor) => {
  const { start } = editor.selection;
  let prevLeaf;
  let stop = false;

  traverse(editor, (node, isText) => {
    if (isText) {
      if (node === start.leaf) {
        stop = true;
      } else if (!stop) {
        prevLeaf = node;
      }
    }
  });
  if (!prevLeaf) return;
  const prevLeafLength = leafLength(prevLeaf);
  leafNodeContent(prevLeaf).insert(
    leafNodeContentLength(prevLeaf),
    leafNodeContent(start.leaf)
      .toArray()
      .map(
        (leaf: YLeaf): YLeaf => {
          return createLeaf(leaf.toJSON());
        }
      )
  );
  mergeLeafs(leafNodeContent(prevLeaf));

  const children = start.node
    .get("children")
    .toArray()
    .map(copyNode);
  const parent = start.node.parent as EdytorArray;
  if (children.length) {
    parent.insert(start.nodeIndex, children);
  }
  parent.delete(start.nodeIndex + children.length);
  return [prevLeaf, prevLeafLength];
  // (start.leaf.parent.parent as YArray<YNode>).delete(index);
};

export const mergeContentWithNextLeaf = (editor: Editor) => {
  const { start } = editor.selection;

  // 1 .get the next leaf
  let nextLeaf;
  let stop = false;

  traverse(editor, (node, isText) => {
    if (isText) {
      if (node === start.leaf) {
        stop = true;
      } else if (stop) {
        nextLeaf = node;
        stop = false;
      }
    }
  });
  // end of document do nothing
  if (!nextLeaf) return;

  // 2 .merge the next leaf with the start leaf
  leafNodeContent(start.leaf).insert(
    leafNodeContentLength(start.leaf),
    leafNodeContent(nextLeaf)
      .toArray()
      .map(
        (leaf: YLeaf): YLeaf => {
          return createLeaf(leaf.toJSON());
        }
      )
  );
  mergeLeafs(leafNodeContent(start.leaf));

  // 3 get the merged node children if any and place it where the merged node was
  const node = getNode(nextLeaf);
  const index = getIndex(node);
  const parent = node.parent as YArray<any>;
  const children = node.get("children").toArray();
  children.length > 0 && parent.insert(index, children.map(copyNode));
  parent.delete(index + children.length);
  return nextLeaf;
};

export const deleteNode = (node, defaultBlock: string) => {
  if (isNodeEmpty(node)) {
    (node.parent as NodesArray).delete(getIndex(node));
  } else if (isNodeContentEmpty(node)) {
    const children = getNodeChildren(node).toJSON();
    const index = getIndex(node);
    node.parent.delete(index);
    node.parent.insert(
      index,
      children.map(({ type, ...props }) => createNode(type, props))
    );
  }
  if (node.parent === (node.doc.getArray("children") && node.doc.getArray("children").length === 0)) {
    (node.parent as NodesArray).insert(0, [createNode(defaultBlock, { content: [createLeaf()] })]);
  }
};

export const getNodeNode = (node) => getNodeContainer(node).parent as YNode;
export const getNodeContainer = (node) => node.parent as NodesArray;
export const getNodeChildren = (node) => node.get("children") as NodesArray;
export const getNodeContent = (node) => node.get("content") as NodesArray;
export const hasChildren = (node) => getNodeChildren(node).length > 0;
export const isNodeEmpty = (node) => isNodeContentEmpty(node) && !hasChildren(node);
export const isNodeContentEmpty = (node) =>
  getNodeContent(node).length === 0 ||
  getNodeContent(node)
    .toArray()
    .map(leafString)
    .join("").length === 0;

export const copyNode = (node: YNode) => {
  const jsonNode = node.toJSON();
  return createNode(jsonNode.type, {
    ...jsonNode,
    children: jsonNode.children.map(getChildren),
    content: jsonNode.content.map(createLeaf)
  });
};

export const nodeString = (node: YNode) => {
  let text = "";
  getNodeContent(node).forEach((leaf) => {
    text += leafString(leaf);
  });
  getNodeChildren(node).forEach((node) => {
    text += nodeString(node);
  });
  return text;
};

export const createNode = (type: string, props?: YNodeProps): YNode => {
  const node = new Map();
  node.set("id", props?.id || nanoid());
  node.set("type", type);
  if (props?.data) {
    node.set("data", new Map(Object.entries(props.data)));
  }
  node.set("content", props?.content instanceof Array ? props.content : Array.from(props?.content || [createLeaf()]));
  node.set("children", props?.children instanceof Array ? props.children : Array.from(props?.children || []));
  return node;
};
