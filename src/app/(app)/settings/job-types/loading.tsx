import { SettingsTableSkeleton } from "@/components/settings/settings-skeletons";

export default function Loading() {
  return <SettingsTableSkeleton narrow rows={10} columns={4} />;
}
