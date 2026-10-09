"use client";

import * as React from "react";
import { Avatar } from "@/components/ui/avatar";
import { Spinner } from "@/components/ui/spinner";
import { Textarea, type TextareaProps } from "@/components/ui/textarea";
import { api } from "@/lib/api-client";
import { ROLE_LABELS } from "@/lib/constants";
import type { UserOption, UserRef } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * People who may be @mentioned on a job: `GET /api/users/options?jobId=` only
 * returns users who can view the job, so a mention never points at someone
 * who cannot open it. Loaded once, on the first "@".
 */
function useMentionOptions(jobId: string, enabled: boolean) {
  const [state, setState] = React.useState<{ options: UserRef[]; status: "idle" | "loaded" | "error" }>({ options: [], status: "idle" });

  React.useEffect(() => {
    if (!enabled || state.status !== "idle") return undefined;
    const controller = new AbortController();
    api
      .get<UserOption[]>("/api/users/options", { query: { jobId, excludeSelf: 1 }, signal: controller.signal })
      .then((rows) => setState({ options: (Array.isArray(rows) ? rows : []).filter((u) => u.isActive), status: "loaded" }))
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setState({ options: [], status: "error" });
      });
    return () => controller.abort();
  }, [enabled, jobId, state.status]);

  return { options: state.options, loading: enabled && state.status === "idle", error: state.status === "error" };
}

const TRIGGER = /(^|[\s(])@([\p{L}\p{N}._'-]{0,30})$/u;

export interface MentionTextareaProps extends Omit<TextareaProps, "value" | "onChange"> {
  jobId: string;
  value: string;
  onValueChange: (value: string) => void;
  /** Called when a person is picked from the list. */
  onMention: (user: UserRef) => void;
}

/** Textarea with "@" autocomplete for people who can view this job. */
export const MentionTextarea = React.forwardRef<HTMLTextAreaElement, MentionTextareaProps>(function MentionTextarea(
  { jobId, value, onValueChange, onMention, onKeyDown, className, ...props },
  forwardedRef,
) {
  const innerRef = React.useRef<HTMLTextAreaElement | null>(null);
  const [query, setQuery] = React.useState<{ text: string; start: number } | null>(null);
  const [activeIndex, setActiveIndex] = React.useState(0);
  const [everTriggered, setEverTriggered] = React.useState(false);
  const { options, loading, error } = useMentionOptions(jobId, everTriggered);
  const listId = React.useId();

  const setRefs = (el: HTMLTextAreaElement | null) => {
    innerRef.current = el;
    if (typeof forwardedRef === "function") forwardedRef(el);
    else if (forwardedRef) forwardedRef.current = el;
  };

  const detect = (text: string, caret: number) => {
    const before = text.slice(0, caret);
    const m = TRIGGER.exec(before);
    if (!m) {
      setQuery(null);
      return;
    }
    setEverTriggered(true);
    setQuery({ text: m[2], start: caret - m[2].length - 1 });
    setActiveIndex(0);
  };

  const matches = query
    ? options.filter((o) => o.name.toLowerCase().includes(query.text.toLowerCase())).slice(0, 6)
    : [];

  const pick = (user: UserRef) => {
    const el = innerRef.current;
    if (!query || !el) return;
    const caret = el.selectionStart ?? value.length;
    const next = `${value.slice(0, query.start)}@${user.name} ${value.slice(caret)}`;
    onValueChange(next);
    onMention(user);
    setQuery(null);
    const pos = query.start + user.name.length + 2;
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  };

  const open = query !== null && (loading || matches.length > 0 || error || options.length === 0);

  return (
    <div className="relative">
      <Textarea
        ref={setRefs}
        value={value}
        onChange={(e) => {
          onValueChange(e.target.value);
          detect(e.target.value, e.target.selectionStart ?? e.target.value.length);
        }}
        onKeyDown={(e) => {
          if (open && matches.length > 0) {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActiveIndex((i) => (i + 1) % matches.length);
              return;
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setActiveIndex((i) => (i - 1 + matches.length) % matches.length);
              return;
            }
            if (e.key === "Enter" || e.key === "Tab") {
              e.preventDefault();
              pick(matches[activeIndex] ?? matches[0]);
              return;
            }
          }
          if (open && e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            setQuery(null);
            return;
          }
          onKeyDown?.(e);
        }}
        onClick={(e) => detect(value, e.currentTarget.selectionStart ?? value.length)}
        onBlur={() => setTimeout(() => setQuery(null), 120)}
        role="combobox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={open && matches[activeIndex] ? `${listId}-${matches[activeIndex].id}` : undefined}
        className={className}
        {...props}
      />
      {open ? (
        <div
          id={listId}
          role="listbox"
          aria-label="Mention someone"
          className="absolute left-0 top-full z-40 mt-1 w-72 max-w-full overflow-hidden rounded-md border border-border bg-surface-raised p-1 shadow-pop animate-slide-down"
        >
          {loading ? (
            <div className="flex items-center gap-2 px-2.5 py-2 text-sm text-ink-muted">
              <Spinner size="xs" /> Loading people…
            </div>
          ) : error ? (
            <div className="px-2.5 py-2 text-sm text-danger">Could not load people.</div>
          ) : matches.length === 0 ? (
            <div className="px-2.5 py-2 text-sm text-ink-muted">No one on this job matches “{query?.text}”.</div>
          ) : (
            matches.map((u, i) => (
              <button
                key={u.id}
                id={`${listId}-${u.id}`}
                type="button"
                role="option"
                aria-selected={i === activeIndex}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(u)}
                onMouseEnter={() => setActiveIndex(i)}
                className={cn("flex w-full items-center gap-2.5 rounded-sm px-2.5 py-1.5 text-left text-sm", i === activeIndex ? "bg-surface-muted text-ink" : "text-ink-secondary")}
              >
                <Avatar name={u.name} colour={u.avatarColour || undefined} size="xs" />
                <span className="flex-1 truncate">{u.name}</span>
                <span className="text-2xs text-ink-subtle">{ROLE_LABELS[u.role]}</span>
              </button>
            ))
          )}
          <p className="border-t border-border px-2.5 pb-1 pt-1.5 text-2xs text-ink-subtle">Only people who can see this job are listed.</p>
        </div>
      ) : null}
    </div>
  );
});
