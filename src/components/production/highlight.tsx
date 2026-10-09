import * as React from "react";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Wraps every case-insensitive occurrence of the query's words in <mark>.
 * Server-safe; renders plain text when there is nothing to highlight.
 */
export function Highlight({ text, query, className }: { text: string; query: string; className?: string }) {
  const words = query
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .slice(0, 6);
  if (words.length === 0) return <span className={className}>{text}</span>;
  const re = new RegExp(`(${words.map(escapeRegExp).join("|")})`, "gi");
  const parts = text.split(re);
  return (
    <span className={className}>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="rounded-xs bg-attention-soft px-0.5 text-ink [box-decoration-break:clone]">
            {part}
          </mark>
        ) : (
          <React.Fragment key={i}>{part}</React.Fragment>
        ),
      )}
    </span>
  );
}
