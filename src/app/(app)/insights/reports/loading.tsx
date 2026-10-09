import { TablePageSkeleton } from "@/components/team/page-skeletons";

export default function Loading() {
  return <TablePageSkeleton tiles={4} rows={10} columns={8} />;
}
