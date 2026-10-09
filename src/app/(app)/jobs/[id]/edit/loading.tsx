import { PageContainer } from "@/components/shell";
import { JobFormSkeleton } from "@/components/job-form/job-form-skeleton";

export default function EditJobLoading() {
  return (
    <PageContainer>
      <JobFormSkeleton sections={3} />
    </PageContainer>
  );
}
