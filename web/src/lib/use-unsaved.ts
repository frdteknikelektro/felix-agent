import { useCallback, useEffect } from "react";
import { useNavigate } from "react-router-dom";

/**
 * Warn before losing unsaved edits. Guards the browser tab (beforeunload) and
 * returns a `guardedNavigate` for in-app links that confirms first.
 */
export function useUnsavedGuard(dirty: boolean) {
  const navigate = useNavigate();

  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  const guardedNavigate = useCallback(
    (to: string) => {
      if (dirty && !window.confirm("Discard unsaved changes?")) return;
      navigate(to);
    },
    [dirty, navigate],
  );

  return { guardedNavigate };
}
