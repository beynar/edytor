import { createContext, useContext } from "solid-js";
import { Editor } from "edytor";

export const editorContext = createContext<Editor>({ renderBlock: () => <></>, renderLeaf: () => <></> });
export const EditorContext = editorContext.Provider;

export const useEditor = (): Editor => {
  return useContext(editorContext);
};
