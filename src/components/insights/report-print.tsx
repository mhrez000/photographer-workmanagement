"use client";

import * as React from "react";
import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Print stylesheet for report pages: hides the app chrome (sidebar, topbar,
 * mobile tab bar) and anything marked `data-print="hide"`, removes scroll
 * clipping so long tables paginate, and prints on white.
 */
const PRINT_CSS = `
@media print {
  @page { margin: 14mm 12mm; }
  html, body { background: #fff !important; color: #000 !important; }
  [data-sidebar] > aside,
  [data-sidebar] > div > header,
  [data-sidebar] > nav,
  [data-print="hide"] { display: none !important; }
  [data-sidebar] > div { padding-left: 0 !important; }
  #main { padding-bottom: 0 !important; }
  [data-print="flat"] { box-shadow: none !important; }
  [data-print="flat"] * { max-height: none !important; overflow: visible !important; }
  thead { display: table-header-group; }
  tr { break-inside: avoid; }
  a[href]::after { content: none !important; }
}
`;

export function ReportPrintStyles() {
  return <style>{PRINT_CSS}</style>;
}

export function PrintButton() {
  return (
    <Button variant="outline" onClick={() => window.print()} leadingIcon={<Printer aria-hidden="true" />}>
      Print
    </Button>
  );
}
