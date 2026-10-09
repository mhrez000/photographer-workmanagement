"use client";

import * as React from "react";
import { DENSITY_KEY, THEME_KEY } from "./appearance";

/**
 * Safety net for renders that skip the server HTML (e.g. a 403/404 thrown by
 * a segment layout, which the dev client renders from scratch): re-applies the
 * stored theme/density after mount. Normal loads are already handled before
 * paint by the boot script, so this only re-sets the same attributes.
 */
export function AppearanceSync() {
  React.useEffect(() => {
    try {
      const root = document.documentElement;
      const theme = localStorage.getItem(THEME_KEY);
      if (theme === "light" || theme === "dark") root.setAttribute("data-theme", theme);
      else root.removeAttribute("data-theme");
      if (localStorage.getItem(DENSITY_KEY) === "compact") root.setAttribute("data-density", "compact");
      else root.removeAttribute("data-density");
    } catch {
      // Storage blocked (private mode / disabled site data): keep the defaults.
    }
  }, []);
  return null;
}
