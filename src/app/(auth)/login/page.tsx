import type { Metadata } from "next";
import { BrandMark } from "@/components/shell";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const next = firstParam(params.next);
  const expired = firstParam(params.expired) !== undefined;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col items-start gap-4">
        <BrandMark size={40} className="lg:hidden" />
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Sign in to Proofline</h1>
          <p className="mt-1.5 text-base text-ink-muted">Use the email and password your studio gave you.</p>
        </div>
      </div>
      <LoginForm next={next} expired={expired} />
    </div>
  );
}
