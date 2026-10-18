# Proofline, simplified

**Shoot. Give it to an editor. Check it. Done.**

This plan answers your feedback: *"it's way over the top... isn't All Work and Team Work the same?"*

Yes, they are the same. All Work, Team Work, Jobs and the "My shoots / Whole business" switch all show the same list of jobs, cut different ways. Proofline was built from a very large brief written for a 25-person agency. Your studio is one owner-photographer, a few editors and some clients. This plan rebuilds the screens around that.

The plan changes **what people see**, not what is stored. Every job, link, note, revision, history entry and permission stays exactly as it is. Power features are **hidden behind one switch**, not deleted.

---

## 1. The ideas in one page

1. **One list of jobs.** There is one page called **Jobs**. Who you are decides which jobs you see; it never decides which page you open. The owner always sees the whole business. An editor only sees the jobs given to them. There is no "mine / team / all" split anywhere.
2. **Five stages, named after whose turn it is.** Needs editor, With editor, Ready to check, Changes asked, Done. The same words are used everywhere: lists, buttons, notifications and emails.
3. **Every job says who it's waiting on.** For example "Waiting on: Sam" or "Waiting on: You". That single line is the "clear roles and responsibilities" you asked for.
4. **One obvious next button.** A job shows one main button for the next step. The only place with two equal buttons is checking an edit (Approve / Ask for changes), because that is the only real choice in the loop.
5. **Track editors with five plain numbers** on one page. No capacity, utilisation, turnaround or "bands".
6. **Be fair to editors.** "On time" means the editor sent the job for checking by its due date. The time *you* take to check never counts against them, and your own waiting pile is shown on its own line.
7. **Fixed screens.** No widget picker, saved views or column chooser. A first-time user sees the same thing every time.
8. **Hide, don't delete.** Everything advanced goes behind **Settings → Studio → Advanced tools** (off by default).
9. **Fewer, louder notifications.** 8 types on by default instead of 26, so a red badge always means "something needs you".

---

## 2. Roles: who does what

| Role | What they do | What they see |
|---|---|---|
| **Owner** (you; also any **Co-owner**) | Create jobs, give them to editors, check edits, approve, manage people and clients | Everything |
| **Photographer** (an extra shooter, optional) | Create jobs for their own shoots, give them to editors, check edits on their own shoots | Only jobs they shot or created, and the clients on those jobs |
| **Editor** | Edit, send for checking, fix changes | Only jobs given to them |
| **Client** (portal) | See progress and the finished photos, leave feedback | Only their own work |

The six photographer switches become **one choice** when you invite someone: **Photographer: "Only their own shoots"** or **"Everything (co-owner)"**. Anyone with an unusual mix of switches today keeps it and shows as "Custom" until you edit them.

Editors cannot add jobs by default. You can tick **"Can add their own jobs"** on a single editor. Existing editors keep whatever they have today.

---

## 3. Navigation, before and after

### Owner / co-owner

| Today (about 30 menu items) | After (5 items) |
|---|---|
| Dashboard | **Home** |
| Workspace: All Work, My Work, Team Work, Kanban, Calendar, Timeline | **Jobs** (one list, with a **List / Calendar** switch at the top) |
| Production: Jobs, Projects, Clients | **Clients** |
| Team: Photographers, Editors, Workloads, Performance | **Editors** |
| Insights: Analytics, Bottlenecks, Reports | (gone from the menu; Advanced) |
| Activity: Activity Log | Moved to **Settings → History** |
| Settings: 8 items (Organisation, Users, Roles, Teams, Workflows, Job Types, Automations, Notifications) | **Settings** (one entry: Studio, People, Types of shoot, My account, History) |
| Topbar "My shoots / Whole business" switch | **Removed.** You always see everything. |

Topbar for every staff member: Search (Ctrl K still works), **+ New job**, the bell, and your avatar (My account, Help, Log out).

Phone tabs: **Home** (with a red "to check" count) · **Jobs** · **(+) New job** · **Editors** · **More** (Clients, Settings).

When Advanced tools is on, one extra item appears: **Advanced** (Board, Timeline, Reports & stats, Automations, Workflows).

### Extra photographer ("Only their own shoots")

**Home · Jobs · Clients** (only clients on their jobs). Phone: Home · Jobs · (+) · More.
A co-owner photographer gets the owner's menu, minus "Transfer ownership".

### Editor

| Today | After |
|---|---|
| Dashboard, All Work, My Work, Kanban, Calendar, Timeline, Jobs, Projects, Clients, Activity Log | **My jobs** (their home) · **Calendar** (their own due dates) |

Editors no longer see Projects, Clients, Activity, Board, Timeline or other editors' work. Phone: My jobs · Calendar · Search · Me.

### Client (portal)

**Unchanged:** Your work · Notifications · Account. The portal is already the model the rest of the app should follow.

### Old links keep working

Old addresses redirect: All Work, Team Work and Kanban → **Jobs**; Team and Insights pages → **Editors**; Activity → **Settings → History**; Dashboard → **Home**. Hidden pages are also blocked on the server, not only removed from the menu.

---

## 4. The five stages

Every job is in exactly one stage and shows **who it's waiting on**.

| Stage | Colour | Means | Waiting on | Moves on when… |
|---|---|---|---|---|
| **1. Needs editor** | Grey | Shot, nobody is editing it yet | Owner / photographer | someone presses **Assign editor** (or picks an editor on the New job form, which skips this stage) |
| **2. With editor** | Blue | The editor has it. Small label: "Not started" or "Editing since Tue" | The editor | the editor pastes the finished link and presses **Send for checking** |
| **3. Ready to check** | Amber | Your turn. Shows a **Round 2** badge if it came back after changes | Owner / photographer | you press **Approve** or **Ask for changes** |
| **4. Changes asked** | Red | Back with the editor, with your note attached | The editor | the editor presses **Send for checking** again |
| **5. Done** | Green | Finished. The client sees "Delivered" if they use the portal | Nobody | (Reopen from the ⋯ menu if needed) |
| Cancelled | Dark grey | Not a tab; shown with the "Show cancelled" filter | — | **Restore** brings it back |

"Late" is a red chip and a filter, not a stage. Done jobs never count as "active". This fixes the editor screen that showed "Active jobs 12" next to "Active 9".

**The happy path is 4 presses:** Assign editor → Start editing (optional) → Send for checking → Approve. Today it is 7 to 9 statuses.

### How today's 13 statuses map onto the stages

Nothing in the database is rewritten. This is a display layer: each job keeps its exact status and history, and the screen shows the stage.

| Today's status | Shows as |
|---|---|
| New | Needs editor |
| Ready for Assignment | Needs editor |
| Assigned | With editor · Not started |
| Accepted | With editor · Not started |
| In Progress | With editor · Editing since … |
| Submitted for Review | Ready to check |
| Review Required | Ready to check |
| Resubmitted | Ready to check · Round 2+ |
| Revision Required | Changes asked |
| Approved | Done · with a small **"Not sent to client"** badge and a **Send to client** button |
| Delivered | Done |
| Completed | Done |
| Cancelled | Cancelled |

The new buttons simply stop creating "Ready for Assignment", "Accepted" and "Review Required". Those statuses stay valid for old jobs and for custom workflows under Advanced.

### What the client sees (unchanged)

Booked → Shot → Editing → Delivered.
- Needs editor, and With editor before work starts, show as **Booked** or **Shot** (depending on the shoot date).
- With editor (editing), Ready to check and Changes asked show as **Editing**.
- Done shows as **Delivered**.

---

## 5. The job page

**One scrolling page with no tabs.** Today there are 9 tabs (Overview, Links, Notes, Comments, Revisions, Timeline, Activity, History, Time), three side panels and a "More" menu.

### Header

Address / job name · client · type of shoot · stage pill · **"Waiting on: Sam"** · due chip ("Due Fri" or "2 days late" in red) · "Round 2" (only after changes) · "Rush" (only if ticked) · "Shot by Mo · Edited by Sam" · the job number in small grey text.

### The "Next step" card (top of the page)

One sentence and at most two buttons, depending on the stage and who you are.

| Stage | Owner / photographer sees | Editor sees |
|---|---|---|
| Needs editor | "Who should edit this?" An editor picker showing each editor's "On their desk 3 · Late 1". **[Assign editor]** | (never sees this stage) |
| With editor, not started | "Waiting on Sam · due tomorrow." **[Change editor]** | "Raw files are ready." **[Open raw files]** **[Start editing]** (optional) |
| With editor, editing | "Sam is editing · due tomorrow." **[Change editor]** | A **"Finished photos link"** box and **[Send for checking]**. The button stays off until a link is filled in. |
| Ready to check | "Sam sent this 3 hours ago." **[Open finished photos]** **[Approve]** **[Ask for changes]** | "Sent to Mo for checking. You'll be told if anything needs changing." No buttons. |
| Changes asked | "Back with Sam." ⋯ Edit request | Your note highlighted (round, who, when), the link box pre-filled with the last link (or tick "I updated the same link"), **[Send for checking]** |
| Done | "Done 12 Oct · on time · edited by Sam · 1 round of changes." [Copy finished link] | Nothing |
| Cancelled | **[Restore]** | — |

**Approve:**
- If the client uses the portal, a one-line confirm appears: *"Share the finished photos with Ray White Bondi?"* **[Approve & send]** / **[Approve only]**.
- If they don't, the job finishes straight away and offers **[Copy link to send the client]**.

**Ask for changes** is one box, **"What needs changing?"** (required). Optional tap-to-add chips: Sky, Straighten, Colour, Remove items, Crop, Missing photos. "Needed back by" defaults to tomorrow and sits behind a small "Change" link. The old priority, reason list and "assign to" fields go.

**⋯ menu:**
- Owner / photographer: Edit details, Change editor, Take back from editor, Cancel job (reason required), and on Done jobs **Reopen** with two reasons: "Client wants changes" (goes to Changes asked) or "Fix the delivery link" (stays Done and records a new link).
- Editor: **"Can't do this one"** (asks for a reason and sends the job back to Needs editor), Ask a question.

### Sections below, in order

1. **Files.** Three slots:
   - **Raw files** (from the photographer): Open, Copy.
   - **Finished photos** (from the editor): a new link replaces the old one, and older ones sit under "Earlier versions".
   - **Other links** (collapsed): floor plan, references and so on.
   - Any link counts as the finished link, including a shared-drive folder.
2. **Instructions for the editor.** One text box. The description, photographer notes and editor notes merge into it.
3. **Changes asked.** Shown only after a round. Each round shows what was asked, by whom and when, and "Fixed and sent back" or "Open".
4. **Messages.** One thread between the owner, photographers and the editor, with @mentions. A question is just a message.
5. **Private notes** (owner and photographers only). A separate, clearly tinted box, never a toggle inside the editor thread, so nothing private can be sent to an editor by one wrong click.
6. **From the client** (owner and photographers only, and only when the client uses the portal). Client feedback with a [Reply to client] button.
7. **Who did what.** A short dated list, for example: Created by Mo · Given to Sam · Started · Sent for checking (on time) · Changes asked · Sent back · Approved by Mo · Sent to client. A **Full history** link opens the complete, permanent audit log for that job.

**Side column** (below the content on phones): Shoot date, Due date, Client delivery date (only if the client has the portal), Type of shoot, Rush, and **"Client can see this job: Yes / No"**.

### What disappears from the job page

- The 9 tabs, the Effort panel, the Completion % slider, Estimated hours, and "1d 22h in In Progress".
- The timer and **Pause job / Resume**.
- The buttons Accept, Mark ready, Back to draft, Begin review, separate Deliver… and Complete, Client bounce, Un-approve and the three Reopen variants (now one Reopen).
- "Move to any status…" and the status-picker dialog (Advanced only).
- Review due and Revision due dates.
- The 4-level priority (now a single **Rush job** tick).
- 6 note kinds, 5 comment kinds and 7 link kinds as visible choices.

### New job form: one screen, 8 fields

1. Client (pick one, or type a new name)
2. Address / job name
3. Type of shoot (defaults to the last one used)
4. Shoot date (defaults to today)
5. Due date (defaults to shoot date + that shoot type's usual days, e.g. +1)
6. Editor (optional; shows "On their desk N · Late N"; "Decide later" leaves it in Needs editor)
7. Raw files link
8. Instructions for the editor

The button reads **[Create & send to Sam]** when an editor is picked, or **[Create job]** otherwise.

Collapsed **More options**: Rush job, Photographer (only if the studio has more than one), Client delivery date, Other links.

**Projects** disappear from the form. Behind the scenes a project is reused when the client and address match, or created from the address, so the portal's "grouped by property" view still works. That is about 9 clicks instead of 12.

---

## 6. Home screens

### Owner: Home (fixed layout, no "Customise")

**Top line:** "Good morning, Mo. 3 to check · 2 late · 1 needs an editor." Each part links to that filtered Jobs tab. A big **+ New job** sits on the right.

1. **Ready to check (3).** Oldest first. Each row shows address, client, "Edited by Sam · sent 5 h ago", Round 2 if it applies, and **[Open finished photos]** **[Approve]** **[Ask for changes]**. Approve uses the same confirm as on the job page. Footer link: "See all in Jobs".
2. **Needs attention.** One list, each row with a plain reason: "2 days late · with Sam", "No editor yet · shot yesterday" [Assign editor], "Question from Sam", "Message from the client". When the list is empty it says **"Nothing needs you right now."**
3. **Your editors.** One row per editor: On their desk 4 · Late 1 (red) · On time this month 92%. Clicking a row opens that editor's page.
4. **Coming up this week.** Shoots and due dates for the next 7 days.

**Removed from Home:** the 8 KPI tiles, Turnaround, Revision rate and On-time widgets, Recent activity, the My shoots widget, Customise, and the scope notice.

**Empty studio:** "No jobs yet. [+ Create your first job] [Invite an editor]".

**After the change ships:** a one-time card, "Proofline got simpler", links to a rewritten one-page Help that covers the 5 stages and 3 roles.

### Extra photographer: Home

The same layout, limited to their own shoots, with no "Your editors" block. If the owner checks their edits, cards say "Mo will check this" and have no buttons.

### Editor: My jobs (their only home)

**Top line:** "Hi Sam. Next up: 8 Penrose St, due today. [Open]"

Sections in this order, each hidden when empty:
1. **Changes asked** (red, do these first). Each card quotes your request.
2. **Late**
3. **To do**, sorted by due date. Each card shows "New" or "Editing".
4. **Waiting for Mo to check** (collapsed, read only)
5. **Done recently** (collapsed, last 30 days)

Each card shows address · client · "Due tomorrow" / "1 day late" · "Shot by Mo" · **[Raw files]** (opens straight from the card) · one button: [Start editing] or [Send for checking].

A footer line shows **their own numbers, measured exactly the way you see them**: "This month: 14 finished · 93% on time · 2 needed changes".

**Removed for editors:** the capacity bar ("68% of 38h / week"), the Healthy/Overloaded band, KPI tiles, "Awaiting editor", Paused, the timer banner and Recent activity.

### Client

Unchanged.

---

## 7. Tracking your editors

There is one page, **Editors** (owner and co-owners only). It replaces Team Work, Team → Editors, Workloads, Performance, Photographers, Analytics, Reports and Bottlenecks.

**Top line, to keep everyone honest:** *"Waiting on you: 4 edits to check (oldest 2 days)."* Your own delay is visible and is never counted against an editor.

**Period:** This month · Last month · Last 3 months.

**One row per editor, five numbers.** Rows are sorted with "Late now" first. Each number has a one-line explanation when you hover or tap it.

| Number | Plain meaning | Answers |
|---|---|---|
| **On their desk** | Jobs they have right now (With editor + Changes asked) | Who has what? |
| **Late now** | Of those, how many are past the due date (red if above 0) | What's late? |
| **Finished** | Jobs you approved in the period | How much are they doing? |
| **On time** | % of finished jobs they *first* sent for checking on or before the due date | Are they reliable? |
| **Needed changes** | % of finished jobs where you asked for changes at least once | Is the quality right? |

- **Small numbers stay fair.** Below 5 finished jobs, the percentages show "Not enough jobs yet" instead of a number.
- **Optional "Usually handles up to N"** per editor (blank by default). When it is set, "On their desk" shows "4 of 6" and turns amber when full, and the Assign picker shows it too. This replaces capacity hours, utilisation and bands.
- **[Download CSV]** sits on the page. It replaces Reports and includes "average days to edit" for anyone who wants it.
- **Extra photographers**, if you have any, get a small table underneath: Shoots this month · Waiting for their check · Late.

**Clicking an editor** opens their page:
- The same five numbers, each with a small "vs last month" arrow.
- **On their desk now**, with stage and due date, and a "Change editor" action per job.
- **Recently finished** (last 20), each marked On time / 2 days late, with the number of rounds of changes.
- A simple "finished per week" bar chart.
- **[Give them a job]**, **[Move their jobs to…]** and [Edit person].

**Dropped words:** turnaround, median, utilisation, headroom, capacity hours, workload band, revision rate, completion rate, processing time, throughput, bottleneck.

> **Note on "On time".** Today "on time" is measured when *you approve*, so a slow check made the editor look late. The new number is measured when the *editor sends it*, so it is fairer. Because the meaning changes, the Editors page shows a one-time note, and the old formula stays available under Advanced → Reports.

---

## 8. Hidden vs removed

### Hidden: the code and data stay, behind **Settings → Studio → Advanced tools** (off by default, owner only)

- Board (Kanban) and Timeline. **The Board shows the five stages as columns** (Cancelled behind "Show cancelled"), with the same filters as Jobs and cards drawn like the Jobs rows (stage pill, "Waiting on", due chip, Round). A drag is allowed only where the matching button would be for you — Needs editor → With editor opens *Assign editor*; With editor / Changes asked → Ready to check opens *Send for checking* (the editor's); Ready to check → Done is *Approve* (with the share question) and → Changes asked is *Ask for changes*; Done → Changes asked is *Reopen* — and every other drop snaps back with a plain note saying why. *(The 5-column follow-up shipped 14 Oct 2026; the old 7-column drop API stays for integrations.)*
- Reports & stats (Analytics, Bottlenecks, Reports), the 12 workload/bottleneck thresholds and the review time limit
- Workloads with capacity hours, estimated hours and bands
- Workflows editor, custom statuses and "Move to any status…"
- Automations (builder, templates, dry run, run history)
- Teams, the full permission table and the individual photographer switches
- Saved views, Group by, Column chooser and bulk actions
- Projects as a page
- Time tracking (timers, Time tab, running-timer banner). It also stays switched off in studio settings.
- Pause / Resume, Completion %, the 4-level priority, Review due and Revision due
- Extra link, note and comment kinds as visible choices
- Keyboard chords and the shortcuts sheet (Ctrl K stays)
- Appearance density; avatar colour, title and capacity at invite (still editable on the person's profile)
- 18 of the 26 notification types: off by default, and still selectable in My account → Notifications

**Safety for existing studios:** if a studio already uses custom workflows or has automations switched on, Advanced tools turns **on automatically** for it, so nothing it relies on disappears.

### Removed: the screens go, the data stays

- The "My shoots / Whole business" switch, its notice and its cookie. This also fixes a number on Home that ignored the switch ("Completed: 18 this month").
- The **All Work** and **Team Work** pages (redirected), the separate editor dashboard, and **My Work** for photographers.
- Dashboard Customise, the widget picker and the 8-tile KPI strip.
- Team → Editors / Workloads / Performance / Photographers as separate pages (merged into Editors), and the second person page.
- The 8-item Settings sidebar and the duplicate "Notifications" item in it.
- The "N former managers are now team members" notice card.
- The unused Teams loading code and its misleading empty-state text.
- An unused "claim a job" API endpoint that no screen calls.
- The design-system page being reachable without logging in (it becomes dev-only).
- In the **demo only**: the two seeded automations that duplicate built-in notifications, and the 160-job, 25-person demo. The new demo is 1 owner, 1 extra photographer, 3 editors, 2 clients (1 on the portal), about 20 jobs across all stages, time tracking off. The large demo stays as a test fixture. Automations in live studios are not touched.

### Kept, and polished

+ New job, Jobs (stage tabs: All active · Needs editor · With editor · Ready to check · Changes asked · Done, plus Late and Show cancelled filters, and Search / Editor / Client), Calendar, the job page, Assign / Change / Take back / Can't do this one, Start editing, Send for checking, Approve, Ask for changes, Reopen, Cancel / Restore, Home, My jobs, Editors, Clients (with the portal switch per client), the client portal, search, the bell, People (invite, deactivate with "move their jobs to…", temporary password), Types of shoot (name, colour and **usual days to edit**), Studio settings (name, timezone, job number prefix), My account, **Settings → History** (the studio-wide audit log, for the owner), and the "someone else just changed this job" protection.

**The 8 notifications on by default:**
1. A job was given to you
2. Ready to check
3. Changes asked
4. Approved
5. New message or @mention
6. Client feedback
7. A daily "late jobs" summary
8. A job was taken off you or cancelled

Old unread notifications of now-hidden types get a one-click **"Mark old updates as read"**. Nothing is deleted.

---

## 9. What stays exactly the same under the hood

- **Statuses and workflows.** All 13 status categories, workflow statuses, transitions and per-job-type workflows stay. The 5 stages are just a translation layer on top. **No job row is rewritten. Nothing is bulk-updated.**
- **History.** Every button still writes every underlying step as its own permanent history entry. For example, "Approve & send" records Approved → Delivered → Completed, as three rows, in one go. Assigning skips the "Ready" step through moves that already exist. If a studio's custom workflow lacks a step, the action stops at the furthest step it can reach; it **never adds steps to anyone's workflow**. "Every change, by everyone, forever" stays true.
- **Old finished jobs.** Jobs sitting at Approved or Delivered are not touched; they simply show as Done. If you want them closed properly, there is an optional, owner-confirmed **"Close delivered jobs"** button that runs the normal, recorded steps one job at a time.
- **Permissions.** Every action is still checked on the server. That covers who-can-see-what, the primary-owner protection, deactivation with job hand-over and conflict protection. The new role choices just pre-fill the existing switches.
- **Data.** Revisions and rounds, link versions, note and comment kinds, time sessions, saved views, dashboard layouts, automations and their history, teams, capacity and estimated hours, projects and client-sharing flags all stay in their tables. Turning Advanced on brings them back exactly as they were.
- **Notifications.** All 26 types and everyone's preferences stay; only the defaults change.
- **Tests.** The 3,800 unit tests on the engine keep guarding it. Mostly the screen tests (end-to-end) change.

**Two rules get stricter, and one gets looser (see the decisions below):**
- **Stricter:** "Send for checking" now **requires** a finished link. Today it only warns.
- **Stricter:** hidden pages are blocked on the server, not just removed from the menu.
- **Looser, if you agree:** the owner may approve a job they edited themselves.

---

## 10. Implementation plan

**Overall effort: L, about 3 weeks for one developer, shipped in 5 small releases.** Each release works on its own. There is one small, additive database change (the Advanced tools switch, plus two optional fields). About 30% of the time goes on updating screen tests. Proofline is web-only, so the ListingsReady three-app rule does not apply.

| Phase | What ships | Effort |
|---|---|---|
| **0. Quick wins** | Remove the scope switch: it is read in 12 files, and this also fixes the Home number that ignored it. Rewrite the menu per role (new mobile tabs). Redirect old addresses. Make the design-system page dev-only. Remove the roles notice card, the duplicate Settings → Notifications item and the unused claim endpoint. | S–M, 2–3 days |
| **1. Stages and words** | The 5-stage translation layer (stage, sub-label, "Waiting on"). "Done is not active" is handled inside this layer only, so existing numbers and automations don't shift. A new stage pill everywhere. Jobs page with stage tabs, simple filters and List / Calendar. New labels across links, notes, messages, notifications and emails. | M, 3 days |
| **2. Job actions and job page** | Next-step buttons per stage and role. **Send for checking** takes and requires the finished link. One **Approve** action (with "Approve & send" / "Approve only" when the portal is on). One Reopen with two reasons. "Can't do this one". The simple Ask-for-changes dialog. When a workflow has two statuses that mean the same stage, the first is picked automatically instead of asking. The single-scroll job page with Who did what and Full history. Owner self-approval (if you agree). | M–L, 5–6 days |
| **3. Home, My jobs, Editors** | The fixed owner and photographer Home, the editor's My jobs, the Editors page and editor pages with the five numbers (submit-based "On time", "Not enough jobs yet", the "Waiting on you" line, the optional "Usually handles up to N", CSV). | M, 4–5 days |
| **4. Settings, roles, defaults, demo** | One Settings page (Studio with the Advanced tools switch, People, Types of shoot with usual days, My account, History). Three plain role cards plus the invite choice. Advanced switches on automatically for studios that need it. Server gates on hidden pages. 8 default notifications plus "Mark old updates as read". The slim New job form with smart defaults and silent projects. New demo seed. One-page Help and the "Proofline got simpler" card. | M, 3–4 days |

Phases 0–2 alone (about 2 weeks) deliver most of the relief: one Jobs list, five stages and one-button steps.

**Risks we've planned for:**
- **Numbers change meaning.** "On time" moves to the editor's send, not your approval. This is flagged once on the Editors page, and the old formula stays in Advanced.
- **Sharing by accident.** Approve never shares with a portal client silently; it asks first.
- **Bookmarks and notification links.** Redirects keep them working, and job links themselves don't change.
- **Duplicate properties.** A project is reused when the client and address match.
- **The private-notes leak risk.** Private notes live in their own tinted box, never in the editor thread.

---

## 11. Four decisions for you

Each has a recommended default. If you say nothing, the default is used.

1. **What is the last stage called?**
   - **Recommended: "Done"** for you and your editors, while the client keeps seeing "Delivered".
   - "Delivered" everywhere matches the portal, but it isn't true when the client has no portal and you only texted them a link.

2. **When you approve a job for a client who uses the portal, should it share with them automatically?**
   - **Recommended: ask each time, with one line:** *"Share with Ray White Bondi?"* [Approve & send] / [Approve only].
   - Approving straight from a Home card is allowed and uses the same question.
   - The alternative is one-click "Approve & deliver". It is faster, but easier to release photos you meant to hold back.

3. **May the owner approve a job they edited themselves?**
   - **Recommended: yes, for owners and co-owners only.** It shows an "You edited this yourself. Approve anyway?" check and is recorded in history.
   - Today the app blocks this, which stops a solo owner who does their own edit from ever finishing the job. Editors and regular photographers stay blocked.

4. **Who checks the edits on an extra photographer's shoots?**
   - **Recommended: the photographer checks their own shoots, and you can always step in.**
   - The alternative is that you check everything, and their Home just shows "Mo will check this". This only matters if you take on extra photographers.

Everything else that the three reviews disagreed on has been settled in this plan in favour of the simplest option:
- Calendar is a view inside Jobs for you, and a page for editors.
- Editors get five numbers.
- "Usually handles up to N" is optional and blank by default.
- Extra photographers see their own clients.
- The studio history stays under Settings for you.
- "Rush job" is a single tick.
- Projects are hidden and created automatically.

---

## 12. Decisions confirmed (13 Oct 2026)

The owner approved the plan with all four recommended defaults:

1. Last stage is **"Done"** for staff; clients keep seeing **"Delivered"**.
2. Approving a job whose client uses the portal **asks each time**: **Approve & send** / **Approve only**.
3. **Owners and co-owners may approve a job they edited themselves**, after a one-line "You edited this yourself. Approve anyway?" check; recorded in history. Editors and regular photographers stay blocked.
4. **An extra photographer checks the edits on their own shoots**; the owner can always step in.
