import { Container } from "@/components/marketing";
import { Skeleton } from "@/components/ui/skeleton";

/** Mirrors the hero while the page streams (the landing page itself has no data, so this rarely shows). */
export default function PublicLoading() {
  return (
    <Container role="status" aria-label="Loading" aria-busy="true" className="flex flex-col items-center pt-14 sm:pt-20">
      <Skeleton className="h-3 w-48" />
      <Skeleton className="mt-5 h-10 w-full max-w-2xl" />
      <Skeleton className="mt-3 h-10 w-3/4 max-w-xl" />
      <Skeleton className="mt-6 h-5 w-full max-w-lg" />
      <div className="mt-8 flex w-full flex-col gap-3 sm:w-auto sm:flex-row">
        <Skeleton className="h-10 w-full rounded-md sm:w-44" />
        <Skeleton className="h-10 w-full rounded-md sm:w-28" />
      </div>
      <Skeleton className="mt-12 aspect-[1200/483] w-full max-w-[960px] rounded-xl sm:mt-16" />
    </Container>
  );
}
