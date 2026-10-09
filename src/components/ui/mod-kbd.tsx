"use client";

import * as React from "react";
import { isApplePlatform } from "@/lib/utils";
import { Kbd, type KbdProps } from "./kbd";

function noopSubscribe() {
  return () => {};
}

export interface ModKbdProps extends Omit<KbdProps, "keys" | "children"> {
  /** Keys pressed together with the platform modifier, e.g. `["K"]` → ⌘ K / Ctrl K. */
  keys: string[];
}

/**
 * Key cap for a ⌘/Ctrl chord that shows the viewer's platform modifier
 * (⌘ on Apple devices, Ctrl elsewhere). Server render + first paint use
 * "Ctrl"; Apple devices switch to ⌘ after hydration.
 */
export function ModKbd({ keys, ...props }: ModKbdProps) {
  const apple = React.useSyncExternalStore(noopSubscribe, isApplePlatform, () => false);
  return <Kbd keys={[apple ? "⌘" : "Ctrl", ...keys]} {...props} />;
}
