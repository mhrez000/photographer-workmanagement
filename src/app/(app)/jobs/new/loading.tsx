import { PageContainer } from "@/components/shell";
import { JobFormSkeleton } from "@/components/job-form/job-form-skeleton";

export default function NewJobLoading() {
  return (
    <PageContainer width="narrow">
      <JobFormSkeleton />
    </PageContainer>
  );
}
