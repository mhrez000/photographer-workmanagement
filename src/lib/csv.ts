/**
 * Safe CSV generation (RFC 4180 quoting + spreadsheet formula-injection
 * neutralisation). Pure module: used by `src/server/queries/reports.ts` and
 * any client-side "export" button.
 *
 * - Fields containing `,` `"` CR or LF, or leading/trailing whitespace, are
 *   wrapped in double quotes with inner quotes doubled.
 * - String cells starting with `=`, `+`, `-`, `@`, TAB or CR are prefixed
 *   with `'` so Excel / Sheets never evaluate them as formulas (OWASP CSV
 *   injection). Numbers are written raw (negative numbers stay numeric).
 * - Lines end with CRLF; `null`/`undefined` become empty fields.
 */

export type CsvValue = string | number | boolean | Date | null | undefined;

export interface CsvOptions {
  /** Prefix formula-looking strings with `'` (default true). */
  neutraliseFormulas?: boolean;
  /** Prepend a UTF-8 BOM so Excel detects the encoding (default false). */
  bom?: boolean;
}

const FORMULA_START = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[",\r\n]|^\s|\s$/;

/** Formats one cell. */
export function escapeCsvCell(value: CsvValue, opts: CsvOptions = {}): string {
  if (value === null || value === undefined) return "";
  let text: string;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "";
    text = String(value);
  } else if (typeof value === "boolean") {
    text = value ? "true" : "false";
  } else if (value instanceof Date) {
    text = Number.isNaN(value.getTime()) ? "" : value.toISOString();
  } else {
    text = value;
    if ((opts.neutraliseFormulas ?? true) && FORMULA_START.test(text)) text = `'${text}`;
  }
  return NEEDS_QUOTES.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** One CSV line (no terminator). */
export function csvRow(values: readonly CsvValue[], opts: CsvOptions = {}): string {
  return values.map((v) => escapeCsvCell(v, opts)).join(",");
}

/** Header + rows, CRLF-terminated lines. */
export function buildCsv(headers: readonly string[], rows: readonly (readonly CsvValue[])[], opts: CsvOptions = {}): string {
  const lines = [csvRow(headers, opts), ...rows.map((r) => csvRow(r, opts))];
  return `${opts.bom ? "﻿" : ""}${lines.join("\r\n")}\r\n`;
}

/** CSV from objects, columns chosen (and ordered) by `columns`. */
export function csvFromObjects<T extends Record<string, CsvValue>>(
  columns: readonly { key: string; label: string }[],
  rows: readonly T[],
  opts: CsvOptions = {},
): string {
  return buildCsv(
    columns.map((c) => c.label),
    rows.map((r) => columns.map((c) => r[c.key])),
    opts,
  );
}

/** A filesystem/header-safe file name stem ("editors-report-2026-10-01"). */
export function csvFileName(stem: string): string {
  const safe = stem
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return `${safe || "export"}.csv`;
}
