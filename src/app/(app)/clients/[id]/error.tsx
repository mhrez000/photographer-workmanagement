"use client";

import { RouteError } from "@/components/common/route-error";

export default function ClientsError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <RouteError
      error={error}
      retry={retry}
      title="Clients didn't load"
      message="Something interrupted loading this client view. Nothing was changed — try again."
      homeHref="/clients"
      homeLabel="All clients"
    />
  );
}
