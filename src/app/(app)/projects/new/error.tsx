"use client";

import { RouteError } from "@/components/common/route-error";

export default function ProjectsError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <RouteError
      error={error}
      retry={retry}
      title="Projects didn't load"
      message="Something interrupted loading this project view. Nothing was changed — try again."
      homeHref="/projects"
      homeLabel="All projects"
    />
  );
}
