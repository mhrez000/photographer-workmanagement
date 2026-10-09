import { TablePageSkeleton } from "@/components/team/page-skeletons";

export default function Loading() {
  return <TablePageSkeleton tiles={0} rows={6} columns={4} controls={false} />;
}
