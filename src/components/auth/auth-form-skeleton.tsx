import { Skeleton } from "@/components/ui/skeleton";

export interface AuthFormSkeletonProps {
  /** How many fields the real form has. */
  fields?: number;
  label?: string;
}

/** Loading state shared by the front-door pages: title, lede, then a card of field placeholders. */
export function AuthFormSkeleton({ fields = 2, label = "Loading" }: AuthFormSkeletonProps) {
  return (
    <div role="status" aria-label={label} aria-busy="true" className="flex flex-col gap-8">
      <div className="flex flex-col items-start gap-4">
        <Skeleton className="size-10 rounded-lg lg:hidden" />
        <div className="flex flex-col gap-2">
          <Skeleton className="h-7 w-56" />
          <Skeleton className="h-4 w-72 max-w-full" />
        </div>
      </div>
      <div className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-6 shadow-md">
        {Array.from({ length: fields }, (_, i) => (
          <div key={i} className="flex flex-col gap-1.5">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-9 w-full rounded-md" />
          </div>
        ))}
        <Skeleton className="mt-1 h-10 w-full rounded-md" />
      </div>
    </div>
  );
}
