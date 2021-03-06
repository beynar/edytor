import {
  Editor,
  EdytorSelection,
  copyNode,
  deleteLeafText,
  getIndex,
  getPath,
  leafLength,
  leafNodeContent,
  LeavesHarvest,
  mergeContentWithNextLeaf,
  mergeContentWithPrevLeaf,
  traverse,
  getNodeContainer,
  getNodeNode,
  isNodeContentEmpty,
  createLeaf
} from "..";

type deleteTextOpts = {
  mode: "forward" | "backward" | "none";
  selection?: EdytorSelection;
};
export const deleteText = (editor: Editor, { mode, selection }: deleteTextOpts) => {
  const { start, end, type, length, edges, setPosition } = selection || editor.selection;

  switch (type) {
    case "collapsed": {
      if (mode === "backward" && edges.startNode) {
        if (edges.startDocument) return;

        if (
          start.nodeIndex === getNodeContainer(start.node).length - 1 &&
          start.path.length > 2 &&
          (start.nodeIndex !== 0 || getNodeContainer(start.node).length === 1)
        ) {
          // unnest node if its the last of its parent and if he is nested or it's the first its the only child of its parent
          const node = copyNode(start.node);
          const nodeGrandParent = getNodeNode(start.node);
          const index = getIndex(nodeGrandParent);
          getNodeContainer(start.node).delete(start.nodeIndex);
          getNodeContainer(nodeGrandParent).insert(index + 1, [node]);
          return setPosition(start.leafId, { offset: 0 });
        } else {
          // merge with previous node if we are not nested
          return editor.doc.transact(() => {
            const [prevLeaf, offset] = mergeContentWithPrevLeaf(editor);
            setTimeout(() => {
              setPosition(prevLeaf.get("id"), { offset });
            });
          });
        }
      }
      if (mode === "backward" && edges.startLeaf) {
        // delete content in the previous leaf because we are at its edge start
        const prevLeaf = leafNodeContent(start.leaf).get(start.leafIndex - 1);
        deleteLeafText(prevLeaf, leafLength(prevLeaf) - 1, length || 1);
        return setPosition(prevLeaf.get("id"), { offset: leafLength(prevLeaf) });
      }

      if (mode === "forward" && edges.endNode) {
        // merge node with the next node because we are at edge end of it
        return editor.doc.transact(() => {
          mergeContentWithNextLeaf(editor);
          setTimeout(() => {
            setPosition(start.leafId, { offset: start.offset });
          });
        });
      }
      if (mode === "forward" && edges.endLeaf) {
        // delete content in the next leaf because we are at its edge end
        const nextLeaf = leafNodeContent(start.leaf).get(start.leafIndex + 1);
        return deleteLeafText(nextLeaf, 0, length || 1);
      }

      // just delete text
      deleteLeafText(start.leaf, start.offset + (mode === "backward" ? -length || -1 : length), length || 1);
      setPosition(start.leaf.get("id"), { offset: start.offset + (mode === "backward" ? -length || -1 : length) });
      break;
    }
    case "singlenode": {
      // delete text at range and remove it if empty
      deleteLeafText(start.leaf, start.offset, length, true);
      // ad a nex leaf if node is empty
      if (isNodeContentEmpty(start.node)) {
        const newLeaf = createLeaf();
        leafNodeContent(start.leaf).insert(0, [newLeaf]);
        setPosition(newLeaf.get("id"), { offset: start.offset });
      } else {
        setPosition(start.leafId, { offset: start.offset });
      }

      break;
    }
    case "multileaves":
    case "multinodes":
      {
        const startPathString = start.path.join(",");
        const endPathString = end.path.join(",");
        editor.doc.transact(() => {
          const { reap, burn } = new LeavesHarvest();
          traverse(editor, (leaf, isText) => {
            if (isText) {
              const path = getPath(leaf);
              const l = leafLength(leaf);
              if (path.join(",") === startPathString) {
                deleteLeafText(leaf, start.offset, l);
                reap(leaf, false);
              } else if (path > start.path && path < end.path) {
                deleteLeafText(leaf, 0, l);
                reap(leaf, true);
              } else if (path.join(",") === endPathString) {
                deleteLeafText(leaf, 0, end.offset);
                reap(leaf, end.offset === l);
              }
            }
          });
          return burn(editor);
        });
      }
      setPosition(start.leaf.get("id"), { offset: start.offset });
      break;
  }
};
