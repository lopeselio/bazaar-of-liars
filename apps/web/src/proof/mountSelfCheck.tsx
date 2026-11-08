import { createRoot, type Root } from "react-dom/client";
import { SelfCheckPanel } from "./SelfCheckPanel";

let root: Root | null = null;

/** Mount (or remount) the self-check panel into the evidence drawer. */
export function mountSelfCheck(el: HTMLElement, bundle: unknown, onDownload: () => void) {
  root?.unmount();
  root = createRoot(el);
  root.render(<SelfCheckPanel bundle={bundle} onDownload={onDownload} />);
}
