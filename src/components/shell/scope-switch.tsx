"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { Briefcase, Camera } from "lucide-react";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { toast } from "@/components/ui/toast";
import { api, errorMessage } from "@/lib/api-client";
import { VIEW_SCOPE_LABELS, type ViewScope } from "@/lib/constants";
import { cn } from "@/lib/utils";

/**
 * Personal vs business view (docs/ROLES.md §8). Persists the choice in the
 * `pwm_scope` cookie (`POST /api/me/scope`), drops any `?scope=` override from
 * the current URL (a param wins over the cookie) and refreshes the server
 * components so every list re-resolves its scope.
 *
 * The query string is read at click time (`window.location.search`), not with
 * `useSearchParams()`: the shell renders on statically prerendered pages too, and
 * `useSearchParams()` there needs a Suspense boundary (build error on /design-system).
 */
export function useScopeSwitch(current: ViewScope) {
  const router = useRouter();
  const pathname = usePathname();
  const [optimistic, setOptimistic] = React.useState<ViewScope>(current);
  const [pending, startTransition] = React.useTransition();
  const [base, setBase] = React.useState(current);

  // Server value changed (refresh, navigation): follow it.
  if (base !== current) {
    setBase(current);
    setOptimistic(current);
  }

  const change = React.useCallback(
    async (next: ViewScope) => {
      if (next === optimistic) return;
      const previous = optimistic;
      setOptimistic(next);
      try {
        await api.post("/api/me/scope", { scope: next });
      } catch (err) {
        setOptimistic(previous);
        toast.error("The view did not change", errorMessage(err));
        return;
      }
      startTransition(() => {
        const params = new URLSearchParams(window.location.search);
        if (params.has("scope")) {
          params.delete("scope");
          const qs = params.toString();
          router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
        }
        router.refresh();
      });
    },
    [optimistic, pathname, router],
  );

  return { value: optimistic, change, pending };
}

export const SCOPE_ICONS: Record<ViewScope, React.ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" }>> = {
  mine: Camera,
  business: Briefcase,
};

export interface ScopeSwitchProps {
  scope: ViewScope;
  className?: string;
}

/** Topbar segmented control "My shoots | Whole business" (≥ md; the account menu carries it on small screens). */
export function ScopeSwitch({ scope, className }: ScopeSwitchProps) {
  const { value, change, pending } = useScopeSwitch(scope);
  return (
    <SegmentedControl<ViewScope>
      aria-label="Which work to show"
      size="sm"
      value={value}
      onValueChange={(next) => void change(next)}
      data-scope-switch=""
      aria-busy={pending || undefined}
      className={cn(pending && "opacity-80", className)}
      options={(["mine", "business"] as const).map((s) => {
        const Icon = SCOPE_ICONS[s];
        return { value: s, label: VIEW_SCOPE_LABELS[s], icon: <Icon aria-hidden="true" /> };
      })}
    />
  );
}
