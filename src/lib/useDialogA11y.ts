// AT-A11Y-03 / AT-A11Y-04 / AT-A11Y-05: Accessible modal dialog keyboard & focus management
import { useEffect, useRef } from "react";

/**
 * Manages modal dialog keyboard accessibility:
 * - Closes on Escape key press
 * - Captures previously focused element on open
 * - Moves initial focus to the dialog container
 * - Restores focus back to the trigger element on close
 */
export function useDialogA11y<T extends HTMLElement = HTMLDivElement>(
  isOpen: boolean,
  onClose: () => void,
  disabled: boolean = false
) {
  const dialogRef = useRef<T | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!isOpen) return;

    previousFocusRef.current =
      typeof document !== "undefined" && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    const focusTimer = setTimeout(() => {
      if (dialogRef.current && !dialogRef.current.contains(document.activeElement)) {
        dialogRef.current.focus();
      }
    }, 0);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !disabled) {
        event.stopPropagation();
        onCloseRef.current();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      clearTimeout(focusTimer);
      document.removeEventListener("keydown", handleKeyDown);
      const prev = previousFocusRef.current;
      if (prev && typeof prev.focus === "function" && document.contains(prev)) {
        prev.focus();
      }
    };
  }, [isOpen, disabled]);

  return dialogRef;
}
