"use client";

import { useEffect, useRef } from "react";

const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function useDialogA11y({
  dialogRef,
  initialRef,
  onEscape,
  suspended = false,
}) {
  const restoreRef = useRef(null);
  const escapeRef = useRef(onEscape);
  const suspendedRef = useRef(suspended);
  escapeRef.current = onEscape;
  suspendedRef.current = suspended;

  useEffect(() => {
    restoreRef.current = document.activeElement;
    const dialog = dialogRef.current;
    const focusInitial = () =>
      (
        initialRef?.current ?? dialog?.querySelector(focusableSelector)
      )?.focus();
    const frame = requestAnimationFrame(focusInitial);
    function onKeyDown(event) {
      if (
        suspendedRef.current ||
        !dialog ||
        !dialog.contains(document.activeElement)
      )
        return;
      if (event.key === "Escape") {
        event.preventDefault();
        escapeRef.current?.();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...dialog.querySelectorAll(focusableSelector)].filter(
        (node) => !node.closest("[inert]") && node.getClientRects().length,
      );
      if (!focusable.length) return;
      const first = focusable[0],
        last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown);
      const restore = restoreRef.current;
      requestAnimationFrame(() => restore?.isConnected && restore.focus());
    };
  }, [dialogRef, initialRef]);
}

export function UnsavedDialog({ onCancel, onDiscard }) {
  const dialogRef = useRef(null),
    initialRef = useRef(null);
  useDialogA11y({ dialogRef, initialRef, onEscape: onCancel });
  return (
    <div className="confirm-backdrop confirm-backdrop--nested">
      <div
        ref={dialogRef}
        className="confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="unsaved-title"
      >
        <h2 id="unsaved-title">ยังไม่ได้บันทึก</h2>
        <p>การเปลี่ยนแปลงในแบบฟอร์มนี้จะหายไปหากปิดตอนนี้</p>
        <div>
          <button
            ref={initialRef}
            className="button button--secondary"
            type="button"
            onClick={onCancel}
          >
            กลับไปแก้ไข
          </button>
          <button
            className="button button--danger"
            type="button"
            onClick={onDiscard}
          >
            ทิ้งการเปลี่ยนแปลง
          </button>
        </div>
      </div>
    </div>
  );
}
