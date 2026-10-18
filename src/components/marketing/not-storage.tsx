import { Link2 } from "lucide-react";
import { Container } from "./section";

/** The "what it is not" strip: Proofline is not photo storage. */
export function NotStorage() {
  return (
    <section aria-labelledby="not-storage-heading" className="border-y border-border bg-surface">
      <Container className="flex flex-col gap-4 py-10 sm:flex-row sm:items-center sm:gap-8">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent-ink">
          <Link2 aria-hidden="true" className="size-5" />
        </span>
        <div className="flex flex-col gap-1.5">
          <h2 id="not-storage-heading" className="text-lg font-semibold tracking-tight text-ink">
            What it is not: photo storage.
          </h2>
          <p className="text-base text-ink-secondary">
            Your photos stay where they are today. A job holds links to the raw files and the finished photos, in Google
            Drive, Dropbox, WeTransfer, a NAS or anything with a link. Proofline keeps track of whose turn it is.
          </p>
        </div>
      </Container>
    </section>
  );
}
