"use client";

import * as React from "react";

/**
 * After a failed submit, put keyboard focus on the first field with an error (UX-09). The fields are disabled while the
 * form is sending, which drops focus to <body>; call `focusFirstInvalid()` in the catch and the focus moves once the
 * form has re-rendered with its errors and enabled fields again (or to the first field when the error is form-wide).
 */
export function useFocusFirstInvalid<T extends HTMLElement = HTMLFormElement>(): { ref: React.RefObject<T | null>; focusFirstInvalid: () => void } {
  const ref = React.useRef<T>(null);
  const [request, setRequest] = React.useState(0);

  React.useEffect(() => {
    if (request === 0) return;
    const root = ref.current;
    if (!root) return;
    const enabled = ":not([disabled]):not([type='hidden']):not([hidden])";
    const target =
      root.querySelector<HTMLElement>(`[aria-invalid='true']${enabled}`) ??
      root.querySelector<HTMLElement>(`input${enabled}, textarea${enabled}, select${enabled}`);
    target?.focus();
  }, [request]);

  const focusFirstInvalid = React.useCallback(() => setRequest((n) => n + 1), []);
  return { ref, focusFirstInvalid };
}
