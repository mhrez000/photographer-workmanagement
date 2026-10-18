import type { Metadata } from "next";
import { AuthPageHeader } from "@/components/auth/auth-page-header";
import { SignUpForm } from "@/components/auth/signup-form";

export const metadata: Metadata = { title: "Create your studio" };

/**
 * /signup — "Create your studio" (POST /api/auth/signup). Public; a signed-in person is sent to their
 * landing page by `src/proxy.ts` before this renders. Free to start: the studio, its owner, the five
 * stages and the usual types of shoot are created in one go.
 */
export default function SignUpPage() {
  return (
    <div className="flex flex-col gap-8">
      <AuthPageHeader title="Create your studio" lede="You’ll be the owner. Invite your editors and clients once you’re in." />
      <SignUpForm />
    </div>
  );
}
