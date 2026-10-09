"use client";

import { SettingsError } from "@/components/settings/settings-error";

export default function ErrorBoundary(props: { error: Error & { digest?: string }; retry: () => void }) {
  return <SettingsError {...props} what="teams" />;
}
