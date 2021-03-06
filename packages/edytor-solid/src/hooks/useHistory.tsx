import { EdytorSelection } from "edytor/src";
import { createMemo, onMount, onCleanup } from "solid-js";
import { UndoManager } from "yjs";
import { YArray } from "yjs/dist/src/internals";

export const useHistory = (children: YArray<any>, selection: EdytorSelection) => {
  const undoManager = createMemo(
    (): UndoManager => {
      return new UndoManager(children);
    }
  );
  onMount(() => {
    // this don't work very well
    undoManager().on("stack-item-added", (event: any) => {
      // selection.onChange();
      // event.stackItem.meta.set("cursor-location", {
      //   leaf: selection.start.leaf.get("id"),
      //   offset: selection.start.offset
      // });
    });
    undoManager().on("stack-item-popped", (event: any) => {
      // const { leaf, offset } = event.stackItem.meta.get("cursor-location");
      // console.log(leaf, event.stackItem.meta.get("cursor-location"));
      // selection.setPosition(leaf, { offset });
    });
  });
  onCleanup(() => {
    undoManager().destroy();
  });
  return undoManager();
};
