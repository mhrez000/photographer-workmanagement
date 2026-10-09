"use client";

import * as React from "react";
import { Check } from "lucide-react";
import { AVATAR_PALETTE } from "@/lib/constants";
import { cn } from "@/lib/utils";

export interface ColourFieldProps {
  value: string;
  onChange: (value: string) => void;
  /** Swatches offered (defaults to the avatar palette). */
  palette?: readonly string[];
  disabled?: boolean;
  id?: string;
  "aria-describedby"?: string;
  label?: string;
}

const HEX = /^#[0-9a-f]{6}$/i;

/** Swatch row + native colour input for any `#rrggbb` value. */
export function ColourField({ value, onChange, palette = AVATAR_PALETTE, disabled, id, label = "Colour", ...aria }: ColourFieldProps) {
  const normalised = value.toLowerCase();
  const isCustom = !palette.some((c) => c.toLowerCase() === normalised);
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap items-center gap-2" id={id} aria-describedby={aria["aria-describedby"]}>
      {palette.map((colour) => {
        const selected = colour.toLowerCase() === normalised;
        return (
          <button
            key={colour}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={colour}
            disabled={disabled}
            onClick={() => onChange(colour)}
            className={cn(
              "flex size-7 items-center justify-center rounded-full ring-offset-2 ring-offset-surface transition-[box-shadow,transform] duration-(--motion-fast) focus-ring",
              "disabled:cursor-not-allowed disabled:opacity-50",
              selected ? "ring-2 ring-ink/70" : "hover:scale-110",
            )}
            style={{ backgroundColor: colour }}
          >
            {selected ? <Check aria-hidden="true" className="size-3.5 text-white drop-shadow" /> : null}
          </button>
        );
      })}
      <label
        className={cn(
          "relative flex h-7 cursor-pointer items-center gap-1.5 rounded-full border border-border bg-surface pl-1 pr-2.5 text-xs text-ink-secondary shadow-xs hover:border-border-hover",
          isCustom && "border-border-strong text-ink",
          disabled && "pointer-events-none opacity-50",
        )}
      >
        <span className="size-5 rounded-full border border-border" style={{ backgroundColor: HEX.test(value) ? value : "#64748b" }} aria-hidden="true" />
        <span className="font-mono numeric">{isCustom && HEX.test(value) ? value : "Custom"}</span>
        <input
          type="color"
          value={HEX.test(value) ? value : "#64748b"}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          aria-label={`${label}: custom`}
          className="absolute inset-0 cursor-pointer opacity-0"
        />
      </label>
    </div>
  );
}
