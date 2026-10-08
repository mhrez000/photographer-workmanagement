# Product Brief: Professional Photography Work Management Platform

A complete, production-ready **work management platform for professional photography businesses**, inspired by the best parts of Monday.com, ClickUp and Asana, but purpose-built for photographers, photography studios and their editing teams.

Primary purpose:

> **To give photographers and photography businesses complete visibility over every job, who is working on it, what stage it is at, what has been completed, what is overdue, what editors are working on, editor performance, deadlines, revisions and the complete history of every piece of work.**

This is NOT a photo/video storage platform. Do NOT build a system where users upload large photography or video files. Users attach external links instead (Google Drive, Dropbox, OneDrive, Frame.io, WeTransfer, Lightroom/other editing workflow links, finished gallery links, any other URL). The platform manages the **work and people**; media stays in external storage.

---

# 1. CORE PRODUCT CONCEPT

Monday.com + ClickUp + production management + photography-specific workflow.

The photographer/studio owner should open the platform and immediately understand: active jobs; responsible photographer; editor per job; stage of every job; due today; overdue; completed; waiting for review; sent back for revisions; each editor's workload; how quickly editors complete jobs; revision counts; what an editor worked on last week/month; who changed a job, when, what changed; when work was submitted; when approved; where the finished work is; what is blocking a job.

The entire system is designed around **visibility and accountability**.

# 2. USERS & ROLES

## Owner / Admin — full access
Create jobs; assign photographers; assign editors; reassign work; create workflows; create custom statuses; set deadlines; view all jobs, employees, workloads, performance, activity history, completed work, revisions; approve work; manage users, permissions, teams, settings; view analytics.

## Photographer
Create jobs; view their own jobs; view assigned editors; add job details; add external media links; set deadlines; communicate with editors; review completed work; request revisions; approve work; see job history. Depending on permissions, may see team-wide workloads.

## Editor — focused workspace
### My Work
Assigned jobs, priority, due date, client/project, photographer, job type, current status, estimated workload, notes, external media link, delivery link, revision requests.

Editors can: start work; pause work; mark complete; submit for review; add notes; add external finished-work links; comment; ask questions; request clarification; see revision requests; resubmit. Editors must NOT be able to alter things they lack permission for.

# 3. MAIN DASHBOARD
Answers "What is happening in my business right now?"

KPI cards: Active Jobs, Due Today, Overdue, Awaiting Editor, In Editing, Awaiting Review, Revision Required, Completed This Week.

Workload overview per editor: Assigned, In Progress, Due Today, Overdue, Completed This Week, Revision Rate. Visual indicators: 🟢 Healthy / 🟡 Near capacity / 🔴 Overloaded.

# 4. JOB MANAGEMENT
Jobs are the core object.

Basic: Job ID, name, client, photographer, editor, job type, priority, created date, shoot date, due date, completion date.
Workflow: current status, previous status, status history, current assignee, previous assignee, review status, revision count, approval status.
Links (external URLs only): raw files, editing workspace, finished files, gallery, client delivery, reference material.
Notes (structured): photographer notes, editor notes, internal notes, revision notes, client notes.

# 5. JOB STATUS WORKFLOW
Configurable. Default: New → Ready for Assignment → Assigned → Accepted → In Progress → Submitted for Review → Review Required → Revision Required → Resubmitted → Approved → Delivered → Completed; plus Cancelled. Admins customise statuses. Every status change is recorded ("10:42 AM — John Smith changed status from Assigned → In Progress"). History must NEVER disappear.

# 6. COMPLETE AUDIT TRAIL
Permanent activity timeline. Track: job created/edited; assignee changed; status changed; priority changed; deadline changed; notes added; comments added; links added; work started/paused/submitted/approved; revision requested/completed; job completed/reopened. Every event records Who, What, When, Before, After.

# 7. EDITOR WORKSPACE
My Queue sections: Due Today, Due Tomorrow, Upcoming, Overdue, Waiting for Review, Revision Required. Each card: job name, client, photographer, due date, priority, status, time in current status, revision count, external work link, notes. Quick flow: Start → Work → Submit → Complete.

# 8. PHOTOGRAPHER / OWNER WORKSPACE
All Work table (Monday-style). Columns: Job, Client, Photographer, Editor, Status, Priority, Created, Shoot Date, Due Date, Days Remaining, Revision Count, Last Activity, Completion %, External Link. Sorting, filtering, searching, grouping, column customisation, saved views.

# 9. KANBAN VIEW
Columns: New, Assigned, In Progress, Review, Revision, Approved, Completed. Drag between columns → backend updates status + records activity/user/timestamp.

# 10. CALENDAR VIEW
Shoot dates, editing deadlines, review deadlines, delivery deadlines. Day / Week / Month. Colour by status, priority, overdue, assigned editor.

# 11. TIMELINE / GANTT VIEW
Job → Assignment → Editing → Review → Revision → Approval → Delivery. Reveal bottlenecks.

# 12. EDITOR WORKLOAD MANAGEMENT
Table/cards: Editor | Active | Due Today | Overdue | Completed | Revision Rate. Click → detail: current/completed/overdue jobs, average completion time, average time per stage, revision rate, completed this week/month, current + historical workload.

# 13. PERFORMANCE ANALYTICS
Operational, not vanity. Editor: jobs completed, average turnaround, average editing time, average review time, revision rate, on-time %, overdue, active, completed this week/month.

# 14. BOTTLENECK DETECTION
E.g. "⚠️ Review bottleneck — 7 jobs waiting for review > 24h"; "⚠️ Editing bottleneck — Sarah has 14 active jobs, 5 due within 48h"; "⚠️ Revision bottleneck — 12 jobs required revisions this week". Visible on the management dashboard.

# 15. TIME TRACKING (optional, admin-enabled)
Start / Pause / Stop. Record total active time, sessions, time per job, time per workflow stage.

# 16. COMMENTS & COMMUNICATION
Comment, reply, @mention, notes, questions, respond to revision requests. Comments are permanent history.

# 17. REVISION MANAGEMENT (first-class)
Request revision: reason, description, priority, specific instructions; assigned to; due. Numbered Revision #1, #2, #3… never overwritten.

# 18. JOB HISTORY
Chronological timeline (created, assigned, accepted, started, submitted, revision requested, resubmitted, approved, completed). Visually excellent.

# 19. SEARCH
Global: job names, clients, photographers, editors, job IDs, status, notes, comments. Search by job ID retrieves full history.

# 20. FILTERS
My Jobs, Unassigned, Overdue, Due Today, Due This Week, Awaiting Review, Revision Required, Completed, by Photographer/Editor/Client/Job Type/Priority. Saved custom views.

# 21. NOTIFICATIONS
Assigned, deadline changed, comment, revision requested, work submitted, work approved, overdue, mentioned, reassigned. In-app centre with read/unread. Email/push addable later.

# 22. AUTOMATIONS
Simple rule engine: "When status → Submitted for Review → notify photographer"; "When overdue → notify editor + manager"; "When revision requested → assign back to original editor"; "When approved → mark Completed"; "When editor reaches workload threshold → notify manager". Admin-created rules.

# 23. CLIENT / PROJECT STRUCTURE
Organisation → Client → Project → Jobs (e.g. ABC Real Estate → 123 Smith Street → Photography, Editing, Twilight, Floorplan, Drone).

# 24. CUSTOM JOB TYPES
Admin-created (Real Estate, Wedding, Commercial, Product, Drone, Twilight, Video, Floor Plans, Virtual Staging, Retouching). Each may have its own workflow.

# 25. DASHBOARD CUSTOMISATION
Widgets: my workload, team workload, due today, overdue, recent activity, editor performance, completion rate, revision rate, bottlenecks, calendar, recent completed. Rearrangeable.

# 26. DESIGN DIRECTION
Premium modern SaaS (Monday/Linear/ClickUp/Asana/Notion usability) with a unique identity. Excellent typography, spacing, hierarchy, navigation, tables, filters, subtle animation, responsive, keyboard shortcuts, empty/loading/error states.

# 27. MAIN NAVIGATION
Dashboard · Workspace (All Work, My Work, Team Work, Kanban, Calendar, Timeline) · Production (Jobs, Projects, Clients) · Team (Photographers, Editors, Workloads, Performance) · Insights (Analytics, Bottlenecks, Reports) · Activity (Activity Log) · Settings (Organisation, Users, Roles, Workflows, Job Types, Automations, Notifications).

# 28. MOBILE RESPONSIVENESS
Desktop, tablet, mobile. Photographers on phones at shoots; editors on desktop.

# 29. BACKEND ARCHITECTURE
Real backend: authentication, RBAC, database, API layer, audit logging, validation, secure data access. Critical actions happen through the backend, never frontend state.

# 30. DATA MODEL
Users, Organisations, Teams, Clients, Projects, Jobs, Job Types, Statuses, Comments, Revisions, Assignments, Activity Events, Notifications, Work Sessions, External Links, Automations, Saved Views. Proper relations; no needless duplication.

# 31. AUDIT LOG REQUIREMENT
Every modification → immutable activity event: ID, organisation ID, user ID, job ID, event type, action, previous value, new value, timestamp, metadata. Impossible to silently change history.

# 32. PERMISSIONS
Owner: everything. Manager: team + production + analytics. Photographer: own + assigned jobs + relevant team visibility. Editor: assigned jobs + permitted team info. No sensitive management info to editors unless permitted.

# 33. PRINCIPLE
"Who is doing what, when will it be finished, what has happened, and what needs attention?"

# 34. TRACEABILITY
Who worked on it; when they started; what they did; when submitted; who reviewed; what revisions; how many; when approved; who approved; when completed; where the finished work is — without hunting across screens.

# 35. FINISHED WORK LINKS
Prominent "Finished Work" section on completed jobs: gallery / Dropbox / Drive / Frame.io / client delivery links; show Added by, Date, Link; keep link history on change.

# 36. REPORTING
Production (completed, outstanding, overdue, average turnaround); Editors (completed, turnaround, revision rate, on-time %); Photographers (submitted, completed, processing time); Business (volume, bottlenecks, capacity, trends). Ranges: today, this week, this month, last month, custom.

# 37. ACTIVITY FEED
Global feed ("John completed '123 Smith Street'"; "Sarah assigned '45 Collins Street' to Michael"…). Filter by user, job, event, date.

# 38. UX REQUIREMENT
Progressive disclosure. Main row: "123 Smith Street | John | Editing | Due Today" → click → details → Activity / Comments / Revisions / Links / Timeline / History.

# 39. DEMO DATA
At least 10 photographers, 10 editors, 30 clients, 50 projects, 150 jobs across statuses incl. completed, overdue, revision, awaiting review.

# 40. FINAL QUALITY REQUIREMENT
Test everything: auth, permissions, job creation, assignment, status changes, comments, revisions, links, notifications, activity history, audit trail, workloads, analytics, filters, search, kanban, calendar, mobile. Edge cases: reassigned mid-edit; deadline changed; reopened after completion; multiple revisions; editor unavailable; becomes overdue; two users editing same job; user loses permission; link changed; user deactivated. Historical records must remain intact.

# SUCCESS CRITERIA
Immediately understand WHAT is being worked on, WHO is working on it, WHEN it is due, WHERE it is in the workflow, WHAT has happened, WHAT needs attention, WHO is overloaded, WHO is performing well, WHETHER it was completed on time, and the COMPLETE history. A professional operating system for a photography production business. Build for scalability, reliability, security, maintainability. Before completion: full UX, functionality, database, permissions and workflow audit.
