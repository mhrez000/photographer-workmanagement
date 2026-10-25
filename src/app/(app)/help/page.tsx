import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Camera, CheckCircle2, Eye, Keyboard, KeyRound, MessageSquareWarning, Settings2, Store, Wand2 } from "lucide-react";
import { SectionCard } from "@/components/common/section-card";
import { RoundBadge, StageDot, StagePill } from "@/components/jobs/stage-pill";
import { PageContainer } from "@/components/shell/page-container";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { PageHeader } from "@/components/ui/page-header";
import { SIMPLE_CHANGE_CHIPS } from "@/lib/constants";
import { STAGE_META, STAGE_TABS, type Stage } from "@/lib/stages";
import { advancedEnabled, allowed, pageContext } from "@/server/page";
import { loadIsPreSimplificationStudio } from "@/server/queries/simpleColumns";

export const metadata: Metadata = { title: "Help" };

/**
 * Plan §4: who each stage waits on and what moves it on — written for the reader. The owner /
 * photographer presses Assign editor and Approve; the editor presses Send for checking. Both columns
 * swap together, so "You" always means the person reading.
 */
const STAGE_HELP: Record<"photographer" | "editor", Record<Exclude<Stage, "cancelled">, { waitingOn: string; movesOn: string }>> = {
  photographer: {
    needs_editor: { waitingOn: "You", movesOn: "You press Assign editor (or pick an editor when you create the job, which skips this stage)." },
    with_editor: { waitingOn: "The editor", movesOn: "The editor pastes the finished link and presses Send for checking." },
    ready_to_check: { waitingOn: "You", movesOn: "You press Approve or Ask for changes." },
    changes_asked: { waitingOn: "The editor", movesOn: "The editor fixes it and presses Send for checking again." },
    done: { waitingOn: "Nobody", movesOn: "Finished. Reopen from the ⋯ menu if the client wants changes." },
  },
  editor: {
    needs_editor: { waitingOn: "The photographer", movesOn: "The photographer picks an editor." },
    with_editor: { waitingOn: "You", movesOn: "You paste the finished link and press Send for checking." },
    ready_to_check: { waitingOn: "The photographer", movesOn: "The photographer presses Approve or Ask for changes." },
    changes_asked: { waitingOn: "You", movesOn: "You fix it and press Send for checking again." },
    done: { waitingOn: "Nobody", movesOn: "Finished. The photographer can reopen it if the client wants changes." },
  },
};

const ROLES: { icon: typeof Camera; title: string; does: string; sees: string }[] = [
  { icon: Camera, title: "Owner (and any co-owner)", does: "Creates jobs, gives them to editors, checks the edits, approves, manages people and clients.", sees: "Everything." },
  { icon: Camera, title: "Photographer", does: "Creates jobs for their own shoots, gives them to editors and checks the edits on those shoots. The owner can always step in.", sees: "Only the jobs they shot or created, and the clients on them." },
  { icon: Wand2, title: "Editor", does: "Edits, sends for checking, fixes changes.", sees: "Only the jobs given to them." },
  { icon: Store, title: "Client (portal)", does: "Sees progress and the finished photos, leaves feedback.", sees: "Only their own work, as Booked → Shot → Editing → Delivered." },
];

/** One page (docs/SIMPLIFICATION-PLAN.md §6): the five stages, the three roles and how to check work. */
export default async function HelpPage() {
  const { ctx, db } = await pageContext();
  const editor = ctx.role === "editor";
  const advanced = advancedEnabled(ctx);
  const canManage = allowed(ctx, "settings.view");
  // Only a studio that used the old screens has "old bookmarks"; a new sign-up never saw All Work or Team Work.
  const preSimplification = await loadIsPreSimplificationStudio(db, ctx);

  return (
    <PageContainer width="narrow">
      <PageHeader
        eyebrow="Help"
        title="Shoot. Give it to an editor. Check it. Done."
        description="Proofline keeps one list of jobs. Every job is in one of five stages, says who it is waiting on, and shows one next button. This page is all you need."
      />

      <SectionCard id="stages" title="The five stages" description="Named after whose turn it is. The same words are used everywhere: lists, buttons, notifications." flush>
        <ol className="divide-y divide-border">
          {STAGE_TABS.map((stage, i) => {
            const meta = STAGE_META[stage];
            const help = STAGE_HELP[editor ? "editor" : "photographer"][stage as Exclude<Stage, "cancelled">];
            return (
              <li key={stage} className="flex flex-col gap-2 px-5 py-3.5 sm:flex-row sm:items-start sm:gap-5">
                <span className="flex w-48 shrink-0 items-center gap-2.5">
                  <span className="w-4 text-right text-xs text-ink-subtle numeric">{i + 1}</span>
                  <StageDot stage={stage} className="text-sm font-medium text-ink" />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
                  <span className="text-ink">{meta.description}.</span>
                  <span className="text-ink-muted">
                    <span className="font-medium text-ink-secondary">Waiting on:</span> {help.waitingOn}
                    {" · "}
                    <span className="font-medium text-ink-secondary">Moves on when:</span> {help.movesOn}
                  </span>
                </span>
              </li>
            );
          })}
        </ol>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border bg-surface-sunken/60 px-5 py-3 text-sm text-ink-muted">
          <span className="inline-flex items-center gap-2">
            <StagePill job={{ category: "resubmitted", revisionCount: 1 }} hideSubLabel /> <RoundBadge round={2} /> after changes came back
          </span>
          <span className="inline-flex items-center gap-2">
            <Badge variant="danger" size="sm">
              2 days late
            </Badge>
            is a chip and a filter, not a stage
          </span>
          <span className="inline-flex items-center gap-2">
            <StageDot stage="cancelled" /> shows with the “Show cancelled” filter; Restore brings it back
          </span>
        </div>
      </SectionCard>

      <SectionCard id="roles" title="Three roles" description="Who you are decides which jobs you see. It never decides which page you open.">
        <div className="grid gap-3 sm:grid-cols-2">
          {ROLES.map((r) => {
            const Icon = r.icon;
            return (
              <div key={r.title} className="rounded-lg border border-border bg-surface-sunken/60 p-4">
                <p className="flex items-center gap-2 text-sm font-semibold text-ink">
                  <Icon aria-hidden="true" className="size-4 text-ink-subtle" />
                  {r.title}
                </p>
                <p className="mt-1.5 text-sm text-ink-secondary">{r.does}</p>
                <p className="mt-1.5 text-xs text-ink-muted">
                  <span className="font-medium text-ink-secondary">Sees:</span> {r.sees}
                </p>
              </div>
            );
          })}
        </div>
      </SectionCard>

      {editor ? (
        <SectionCard id="my-jobs" title="Your page: My jobs" description="Everything you have, in the order to do it. Each section hides when it is empty.">
          <ol className="list-decimal space-y-1.5 pl-5 text-sm text-ink-secondary">
            <li>
              <span className="font-medium text-ink">Changes asked</span>: do these first. Each card quotes what was asked.
            </li>
            <li>
              <span className="font-medium text-ink">Late</span>: past the due date.
            </li>
            <li>
              <span className="font-medium text-ink">To do</span>, by due date. Open the raw files straight from the card, press <span className="font-medium text-ink">Start editing</span> when you begin.
            </li>
            <li>
              <span className="font-medium text-ink">Waiting for a check</span>: sent, nothing to do. You are told if anything needs changing.
            </li>
            <li>
              <span className="font-medium text-ink">Done recently</span>: the last 30 days.
            </li>
          </ol>
          <div className="mt-4 flex flex-col gap-2 rounded-md bg-surface-sunken px-3 py-2.5 text-sm text-ink-secondary">
            <p>
              <span className="font-medium text-ink">Send for checking</span> needs the finished photos link first. Any link counts, including a shared-drive folder. A new link replaces the old one; older ones sit under “Earlier versions”.
            </p>
            <p>
              <span className="font-medium text-ink">Can’t do this one</span> (in the ⋯ menu) asks for a reason and sends the job back to Needs editor. A question is just a message on the job.
            </p>
            <p>
              Your own numbers sit at the bottom of My jobs: finished · on time · needed changes. “On time” means you sent the job for checking by its due date. The time the photographer takes to check never counts against you.
            </p>
          </div>
        </SectionCard>
      ) : (
        <>
          <SectionCard id="checking" title="How to check work" description="Ready to check is your turn. It is the only place with two equal buttons, because it is the only real choice.">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-lg border border-border p-4">
                <p className="flex items-center gap-2 text-sm font-semibold text-ink">
                  <CheckCircle2 aria-hidden="true" className="size-4 text-success" />
                  Approve
                </p>
                <p className="mt-1.5 text-sm text-ink-secondary">
                  If the client uses the portal you are asked once: <span className="font-medium text-ink">Approve &amp; send</span> or <span className="font-medium text-ink">Approve only</span>. Photos are never shared without asking.
                </p>
                <p className="mt-1.5 text-sm text-ink-secondary">If they don’t, the job is Done straight away and offers “Copy link to send the client”.</p>
                <p className="mt-1.5 text-xs text-ink-muted">Edited it yourself? Owners and co-owners see “You edited this yourself. Approve anyway?” and can go ahead; it is recorded.</p>
              </div>
              <div className="rounded-lg border border-border p-4">
                <p className="flex items-center gap-2 text-sm font-semibold text-ink">
                  <MessageSquareWarning aria-hidden="true" className="size-4 text-stage-red" />
                  Ask for changes
                </p>
                <p className="mt-1.5 text-sm text-ink-secondary">
                  One box, <span className="font-medium text-ink">“What needs changing?”</span>, with tap-to-add chips. “Needed back by” defaults to tomorrow.
                </p>
                <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Example chips">
                  {SIMPLE_CHANGE_CHIPS.map((c) => (
                    <li key={c}>
                      <Badge variant="outline" size="sm">
                        {c}
                      </Badge>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-xs text-ink-muted">The job goes back to the editor as Changes asked; when it returns it shows a Round 2 badge.</p>
              </div>
            </div>
            <p className="mt-4 flex items-start gap-2 text-sm text-ink-secondary">
              <Eye aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-ink-subtle" />
              <span>
                Home lists what is <span className="font-medium text-ink">Ready to check</span> first, oldest first, with Open finished photos · Approve · Ask for changes on each row. Below it, “Needs attention” says plainly why: “2 days late · with Sam”, “No editor yet · shot yesterday”, “Question from Sam”.
              </span>
            </p>
          </SectionCard>

          <SectionCard id="new-job" title="A new job in eight fields" description="Client · address or job name · type of shoot · shoot date · due date · editor · raw files link · instructions for the editor.">
            <ul className="space-y-1.5 text-sm text-ink-secondary">
              <li>Shoot date defaults to today; due date to shoot date plus that type’s usual days to edit.</li>
              <li>Pick an editor and the button reads <span className="font-medium text-ink">Create &amp; send to Sam</span>. “Decide later” leaves the job in Needs editor.</li>
              <li>Rush job, a different photographer and other links sit under “More options”.</li>
              <li>You never pick a project: one is reused or created from the address, so the client portal still groups by property.</li>
            </ul>
          </SectionCard>

          {canManage ? (
            <SectionCard id="editors" title="Keeping an eye on editors" description="One page, Editors, with five plain numbers per editor. No hovering over graphs.">
              <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                {[
                  ["On their desk", "Jobs they have right now (With editor + Changes asked)."],
                  ["Late now", "Of those, how many are past the due date."],
                  ["Finished", "Jobs you approved in the period."],
                  ["On time", "Share of finished jobs they first sent for checking by the due date. Your own checking time never counts against them."],
                  ["Needed changes", "Share of finished jobs where you asked for changes at least once."],
                ].map(([k, v]) => (
                  <div key={k}>
                    <dt className="font-medium text-ink">{k}</dt>
                    <dd className="text-ink-secondary">{v}</dd>
                  </div>
                ))}
              </dl>
              <p className="mt-3 text-xs text-ink-muted">Below five finished jobs the percentages read “Not enough jobs yet”. The top line, “Waiting on you: N edits to check”, keeps everyone honest.</p>
            </SectionCard>
          ) : null}
        </>
      )}

      <SectionCard id="invites" title="Invites and passwords" description={canManage ? "How people get in, and what to do when a password is lost." : "What to do when a password is lost."}>
        <p className="flex items-start gap-2 text-sm text-ink-secondary">
          <KeyRound aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-ink-subtle" />
          <span>
            {canManage ? (
              <>
                Invite someone from{" "}
                <Link href="/settings/people?invite=1" className="font-medium text-accent-ink hover:underline">
                  Settings → People
                </Link>{" "}
                (or a client’s page for portal logins). They get a link to choose their own password: it is emailed when your studio has email set up, and always shown to you to copy. A link works for 7 days; until it is opened the person shows as “Invite pending”, and their page lets you send a new link or revoke it. You can also set a temporary password instead.{" "}
              </>
            ) : null}
            Forgot a password? Use <span className="font-medium text-ink">Forgot password?</span> on the sign-in page: the reset link works for 60 minutes, and using it logs you out on every other device.
            {canManage ? " An owner can also set a temporary password from a person’s page." : " Signed in? Change it any time under My account."}
          </span>
        </p>
      </SectionCard>

      <SectionCard
        id="where"
        title="Where things are"
        description={editor ? "Two pages and your account; that is all there is." : preSimplification ? "Everything else moved, rather than disappeared." : "Five menu items; everything else lives under Settings."}
      >
        <ul className="space-y-2 text-sm text-ink-secondary">
          <li className="flex items-start gap-2">
            <Keyboard aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-ink-subtle" />
            <span>
              Search anything with <Kbd keys={["Ctrl", "K"]} /> or the search box at the top. The bell shows only what needs you: eight kinds of notification are on by default.
            </span>
          </li>
          {editor ? (
            <li className="flex items-start gap-2">
              <Settings2 aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-ink-subtle" />
              <span>
                <span className="font-medium text-ink">Your account</span>: <Link href="/settings/account" className="font-medium text-accent-ink hover:underline">My account</Link> (name, password, notifications). Your jobs are on My jobs; your due dates on Calendar.
              </span>
            </li>
          ) : (
            <>
              <li className="flex items-start gap-2">
                <Settings2 aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-ink-subtle" />
                <span>
                  <span className="font-medium text-ink">Settings</span> is one place: Studio, People, Types of shoot, My account{canManage ? ", History (the permanent record of every change)" : ""}.
                  {canManage ? (
                    <>
                      {" "}
                      Boards, timelines, reports, automations and custom workflows live behind{" "}
                      <Link href="/settings/studio#advanced-tools" className="font-medium text-accent-ink hover:underline">
                        Settings → Studio → Advanced tools
                      </Link>
                      {advanced ? " (on for this studio: see the Advanced group in the menu)" : " (off by default)"}. Nothing was deleted.
                    </>
                  ) : null}
                </span>
              </li>
              {preSimplification ? (
                <li className="flex items-start gap-2" data-old-bookmarks="">
                  <ArrowRight aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-ink-subtle" />
                  <span>Old bookmarks still work: All Work, Team Work and the board open Jobs; the team pages open Editors; Activity opens Settings → History.</span>
                </li>
              ) : null}
            </>
          )}
        </ul>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button href={editor ? "/my-jobs" : "/home"} size="sm">
            {editor ? "Go to My jobs" : "Go to Home"}
          </Button>
          <Button href="/settings/account" size="sm" variant="outline">
            My account
          </Button>
        </div>
      </SectionCard>
    </PageContainer>
  );
}
