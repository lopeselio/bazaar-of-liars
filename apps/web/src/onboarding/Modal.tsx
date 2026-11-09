import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { holdFocus } from "./focus";

/**
 * A modal on <body> (in the city, anything inside the HUD sits under the WebGPU canvas). While it
 * is open it takes every keydown first, so WASD, F, J and friends don't drive the game behind it.
 * `onKey` sees each key; Tab is kept inside the dialog.
 */
export function Modal({
  theme,
  label,
  className = "",
  onKey,
  children,
}: {
  theme: string;
  label: string;
  className?: string;
  onKey: (e: KeyboardEvent) => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const keyRef = useRef(onKey);
  keyRef.current = onKey;

  useEffect(() => {
    const release = holdFocus();
    const first = ref.current?.querySelector<HTMLElement>("[data-autofocus]") ?? ref.current?.querySelector<HTMLElement>("button");
    first?.focus();
    const h = (e: KeyboardEvent) => {
      const box = ref.current;
      if (!box) return;
      e.stopPropagation();
      if (e.key === "Tab") {
        const f = [...box.querySelectorAll<HTMLElement>("button:not(:disabled), a[href], input, [tabindex]:not([tabindex='-1'])")];
        if (!f.length) return;
        const i = f.indexOf(document.activeElement as HTMLElement);
        if (i < 0) {
          // Focus somehow outside the dialog: bring it back in.
          e.preventDefault();
          (e.shiftKey ? f[f.length - 1] : f[0]).focus();
        } else if (e.shiftKey && i === 0) {
          e.preventDefault();
          f[f.length - 1].focus();
        } else if (!e.shiftKey && i === f.length - 1) {
          e.preventDefault();
          f[0].focus();
        }
        return;
      }
      keyRef.current(e);
    };
    addEventListener("keydown", h, true);
    return () => {
      removeEventListener("keydown", h, true);
      release();
    };
  }, []);

  return createPortal(
    <div className={`ob ob-${theme} ob-backdrop`}>
      <div ref={ref} className={`ob-dialog ${className}`} role="dialog" aria-modal="true" aria-label={label}>
        {children}
      </div>
    </div>,
    document.body,
  );
}

/** Enter on a focused button already clicks it; only treat Enter as "next" elsewhere. */
export const onButton = () => (document.activeElement as HTMLElement | null)?.tagName === "BUTTON";
