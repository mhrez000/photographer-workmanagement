import { Link2, Mail, MailCheck } from "lucide-react";
import { SectionCard } from "@/components/common/section-card";
import { Badge } from "@/components/ui/badge";
import type { LinkOriginStatus } from "@/server/origin";

export interface EmailStatusCardProps {
  /** `GET /api/settings/email` → `EmailSettingsView` (RESEND_API_KEY + EMAIL_FROM set). */
  configured: boolean;
  provider: "resend" | "console";
  from: string | null;
  /** Which address generated links carry (`linkOriginStatus`); shows a one-line note when APP_URL disagrees with the page's own address. */
  links?: LinkOriginStatus;
}

/**
 * Settings → Studio → "Email" (front door): whether invite and password-reset links go out by email
 * or are shown on screen for the owner to copy. Read-only — the switch is the hosting environment,
 * not a setting in the app.
 */
export function EmailStatusCard({ configured, provider, from, links }: EmailStatusCardProps) {
  return (
    <SectionCard
      id="email"
      title="Email"
      description="How invite and password-reset links reach people."
      actions={
        configured ? (
          <Badge variant="success" dot>
            On
          </Badge>
        ) : (
          <Badge variant="neutral">Not set up</Badge>
        )
      }
    >
      {configured ? (
        <div className="flex items-start gap-3">
          <MailCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success" />
          <div className="text-sm">
            <p className="font-medium text-ink" data-email-status="on">
              Email sending: on via {provider === "resend" ? "Resend" : provider}
              {from ? (
                <>
                  , from <span className="font-normal text-ink-secondary">{from}</span>
                </>
              ) : null}
            </p>
            <p className="mt-1 text-ink-muted">Invite links and password resets are emailed automatically. Every link is also shown to you to copy, in case an email goes astray.</p>
          </div>
        </div>
      ) : (
        <div className="flex items-start gap-3">
          <Mail aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-ink-subtle" />
          <div className="text-sm">
            <p className="font-medium text-ink" data-email-status="off">
              Email sending: not set up.
            </p>
            <p className="mt-1 text-ink-secondary">Invite and reset links are shown for you to copy.</p>
            <p className="mt-2 text-ink-muted">
              To send them automatically, add <code className="rounded-xs bg-surface-muted px-1 py-0.5 font-mono text-xs text-ink">RESEND_API_KEY</code> and{" "}
              <code className="rounded-xs bg-surface-muted px-1 py-0.5 font-mono text-xs text-ink">EMAIL_FROM</code> to your hosting settings.
            </p>
          </div>
        </div>
      )}
      {links?.mismatch ? (
        <p className="mt-4 flex items-start gap-2 border-t border-border pt-3 text-xs text-ink-muted" data-link-origin-note="">
          <Link2 aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          <span>
            Links start with <code className="font-mono text-ink">{links.linkOrigin}</code>
            {links.production ? (
              <>
                {" "}
                (your <code className="font-mono">APP_URL</code>), not the address you are on now (<code className="font-mono">{links.requested}</code>). Change <code className="font-mono">APP_URL</code> in
                your hosting settings if that is wrong.
              </>
            ) : (
              <>
                {" "}
                (the address you are on now), not <code className="font-mono">APP_URL</code> (<code className="font-mono">{links.configured}</code>). In development the page&apos;s own address
                wins so copied links open; in production <code className="font-mono">APP_URL</code> is used.
              </>
            )}
          </span>
        </p>
      ) : null}
    </SectionCard>
  );
}
