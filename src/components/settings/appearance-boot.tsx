import * as React from "react";
import { DENSITY_CSS } from "./appearance";
import { AppearanceSync } from "./appearance-sync";

/**
 * Mounted once in the root layout, next to the inline pre-paint boot script
 * (`APPEARANCE_BOOT_SCRIPT` in <head>): the compact-density rule as a hoisted,
 * de-duplicated stylesheet, plus a client re-sync for renders that skip the
 * server HTML. On client-side navigations the attributes persist on <html>.
 */
export function AppearanceBoot() {
  return (
    <>
      <style href="pwm-density" precedence="default">
        {DENSITY_CSS}
      </style>
      <AppearanceSync />
    </>
  );
}
