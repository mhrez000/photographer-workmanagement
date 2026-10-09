/**
 * Per-device appearance preferences (theme + density), kept in localStorage
 * and applied as `<html data-theme>` / `<html data-density>`. Shared by the
 * Appearance page and the pre-paint boot script.
 */
export const THEME_KEY = "pwm-theme";
export const DENSITY_KEY = "pwm-density";
export const APPEARANCE_EVENT = "pwm:appearance";

export const THEMES = ["system", "light", "dark"] as const;
export type ThemePreference = (typeof THEMES)[number];
export const DENSITIES = ["comfortable", "compact"] as const;
export type DensityPreference = (typeof DENSITIES)[number];

/**
 * Runs before paint on every authenticated page: applies the stored theme
 * and density so there is no flash. Wrapped in try/catch — storage can be
 * blocked (private mode, disabled site data).
 */
export const APPEARANCE_BOOT_SCRIPT = `(function(){try{var d=document.documentElement;var t=localStorage.getItem("${THEME_KEY}");if(t==="light"||t==="dark"){d.setAttribute("data-theme",t)}else{d.removeAttribute("data-theme")}var n=localStorage.getItem("${DENSITY_KEY}");if(n==="compact"){d.setAttribute("data-density","compact")}else{d.removeAttribute("data-density")}}catch(e){}})();`;

/**
 * Compact density: Tailwind v4 derives every spacing utility from
 * `--spacing`, so tightening it by 10 % compacts padding, gaps and control
 * heights everywhere without touching component code.
 */
export const DENSITY_CSS = `:root[data-density="compact"]{--spacing:0.225rem}`;
