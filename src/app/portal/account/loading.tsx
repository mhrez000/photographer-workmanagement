import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6" aria-busy="true" aria-label="Loading your account">
      <Skeleton className="h-8 w-40" />
      <Skeleton className="h-48" />
      <Skeleton className="h-40" />
      <Skeleton className="h-36" />
    </div>
  );
}
