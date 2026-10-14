/**
 * Static demo catalogue (people, clients, projects, copy) for the seed.
 * Every organisation, brand and couple here is fictional; street names and
 * suburbs are real Sydney places so the data reads naturally.
 */
import { DEFAULT_USUAL_DAYS_BY_JOB_TYPE, type PermissionFlag, type Role } from "@/lib/constants";

/** Raw users.* switch columns set for a seeded person (docs/ROLES.md §2.2, §13). */
export type SeedFlags = Partial<Record<PermissionFlag, boolean>>;

export interface SeedUserDef {
  key: string;
  email: string;
  name: string;
  role: Role;
  title: string;
  avatarColour: string;
  capacityHoursPerWeek?: number;
  /** Photographer with admin (owner / co-owner). */
  isAdmin?: boolean;
  /** Team-member / editor switches, applied explicitly after the invite. */
  flags?: SeedFlags;
}

export const NORTHLIGHT = {
  name: "Northlight Studios",
  slug: "northlight",
  timezone: "Australia/Sydney",
} as const;

export const OTHER_STUDIO = {
  name: "Other Studio",
  slug: "other-studio",
  timezone: "Australia/Sydney",
} as const;

export const SEED_PASSWORD = "Password123!";

const P = (n: number) => `photographer${String(n).padStart(2, "0")}`;
const E = (n: number) => `editor${String(n).padStart(2, "0")}`;

/** Owner / Photographer (admin, primary owner): runs the business and also shoots (~12 % of jobs). */
export const OWNER: SeedUserDef = {
  key: "owner",
  email: "owner@studio.test",
  name: "Hannah Brooks",
  role: "photographer",
  isAdmin: true,
  title: "Studio Director",
  avatarColour: "#6366f1",
};

/** photographer02..11: established team members (create ✓, assign ✓, review ✓). */
const ESTABLISHED: SeedFlags = {
  canCreateJobs: true,
  canAssignEditors: true,
  canReviewSubmissions: true,
  canViewTeamWorkloads: false,
  canViewAllJobs: false,
  canViewAnalytics: false,
};
/** photographer01: every team-member switch (sees all jobs, workloads, analytics; reviews). */
const SENIOR: SeedFlags = {
  canCreateJobs: true,
  canAssignEditors: true,
  canReviewSubmissions: true,
  canViewTeamWorkloads: true,
  canViewAllJobs: true,
  canViewAnalytics: true,
};
/** photographer12: invite defaults with assign off — the owner assigns and reviews her work. */
const JUNIOR: SeedFlags = {
  canCreateJobs: true,
  canAssignEditors: false,
  canReviewSubmissions: false,
  canViewTeamWorkloads: false,
  canViewAllJobs: false,
  canViewAnalytics: false,
};

const PHOTOGRAPHERS: readonly (readonly [string, string, string])[] = [
  ["Liam Carter", "Senior photographer", "#22c55e"],
  ["Chloe Nguyen", "Real Estate Photographer", "#f59e0b"],
  ["Jack Morrison", "Real Estate Photographer", "#f97316"],
  ["Isla Patel", "Drone & Real Estate Photographer", "#ef4444"],
  ["Noah Fitzgerald", "Wedding Photographer", "#ec4899"],
  ["Ruby Thompson", "Twilight Specialist", "#8b5cf6"],
  ["Oscar Delaney", "Lead Wedding Photographer", "#64748b"],
  ["Mia Russo", "Wedding Photographer", "#d97706"],
  ["Ethan Walsh", "Commercial Photographer", "#0891b2"],
  ["Zara Ahmed", "Product Photographer", "#6366f1"],
  ["Harvey Kim", "Commercial & Video", "#0ea5e9"],
  ["Matilda O'Brien", "Junior photographer", "#14b8a6"],
];

const EDITORS: readonly (readonly [string, string, number, string])[] = [
  ["Ava Mitchell", "Senior Editor", 38, "#f59e0b"],
  ["Lucas Pham", "Editor", 36, "#f97316"],
  ["Sienna Clarke", "Editor", 34, "#ef4444"],
  ["Hamish Reid", "Editor", 38, "#ec4899"],
  ["Priya Sharma", "Senior Editor", 40, "#8b5cf6"],
  ["Declan Murphy", "Editor", 32, "#64748b"],
  ["Freya Jensen", "Wedding Editor", 32, "#d97706"],
  ["Tariq Hassan", "Retoucher", 36, "#0891b2"],
  ["Georgia Lane", "Editor", 30, "#6366f1"],
  ["Marcus Webb", "Video Editor", 38, "#0ea5e9"],
  ["Elena Rossi", "Editor", 35, "#14b8a6"],
  ["Kai Tanaka", "Editor", 36, "#22c55e"],
  ["Jasper Hughes", "Editor", 38, "#94a3b8"],
];

/** Key of the junior photographer whose jobs the owner assigns and reviews. */
export const JUNIOR_PHOTOGRAPHER = P(12);

/** Everyone the owner invites (no manager accounts in roles v2). */
export const STAFF: readonly SeedUserDef[] = [
  ...PHOTOGRAPHERS.map(([name, title, colour], i): SeedUserDef => ({
    key: P(i + 1),
    email: `${P(i + 1)}@studio.test`,
    name,
    role: "photographer",
    title,
    avatarColour: colour,
    flags: i === 0 ? SENIOR : i === 11 ? JUNIOR : ESTABLISHED,
  })),
  ...EDITORS.map(([name, title, capacity, colour], i): SeedUserDef => ({
    key: E(i + 1),
    email: `${E(i + 1)}@studio.test`,
    name,
    role: "editor",
    title,
    avatarColour: colour,
    capacityHoursPerWeek: capacity,
    // editor02 sees other editors' jobs (read-only); editor09 cannot create jobs.
    flags: { canCreateJobs: i !== 8, canViewTeamJobs: i === 1 },
  })),
];

/* ------------------------------------------------------------------ */
/*  Client portal (docs/ROLES.md §7, §13)                              */
/* ------------------------------------------------------------------ */

export interface SeedPortalClientDef {
  clientName: string;
  portalEnabled: boolean;
  feedbackEnabled: boolean;
  users: readonly { key: string; email: string; name: string; avatarColour: string }[];
}

export const PORTAL_CLIENTS: readonly SeedPortalClientDef[] = [
  {
    clientName: "Harbourline Realty",
    portalEnabled: true,
    feedbackEnabled: true,
    users: [{ key: "client", email: "client@studio.test", name: "Sarah Kingsley", avatarColour: "#d97706" }],
  },
  {
    clientName: "Coastal Key Property",
    portalEnabled: true,
    feedbackEnabled: false,
    users: [{ key: "client2", email: "client2@studio.test", name: "Daniel Ward", avatarColour: "#0891b2" }],
  },
];

export const TEAMS: readonly { name: string; description: string; lead: string; members: readonly string[] }[] = [
  {
    name: "Real Estate Crew",
    description: "Residential listings, drone, twilight and floor plans.",
    lead: P(1),
    members: [P(1), P(2), P(3), P(4), E(1), E(2), E(4), E(5)],
  },
  {
    name: "Weddings",
    description: "Wedding days, engagements and albums.",
    lead: P(7),
    members: [P(5), P(7), P(8), P(12), E(6), E(7), E(9), E(2)],
  },
  {
    name: "Commercial",
    description: "Brand campaigns, product and hospitality.",
    lead: P(9),
    members: [P(9), P(10), P(11), P(6), E(8), E(10), E(12), E(3)],
  },
];

/* ------------------------------------------------------------------ */
/*  Clients & projects                                                 */
/* ------------------------------------------------------------------ */

export type ClientKind = "real_estate" | "wedding" | "commercial";

export interface SeedProjectDef {
  name: string;
  address?: string;
  description?: string;
}

export interface SeedClientDef {
  name: string;
  kind: ClientKind;
  contactName: string;
  email: string;
  phone: string;
  /** Archived at the end of the seed (only ever gets completed history). */
  archived?: boolean;
  projects: readonly SeedProjectDef[];
}

const RE_AGENCIES: readonly (readonly [string, string, readonly (readonly [string, string])[]])[] = [
  ["Harbourline Realty", "Sarah Kingsley", [["14 Ocean Street", "Bondi NSW 2026"], ["7/22 Campbell Parade", "Bondi Beach NSW 2026"]]],
  ["Coastal Key Property", "Daniel Ward", [["38 Arden Street", "Coogee NSW 2034"], ["5 Carr Street", "Coogee NSW 2034"]]],
  ["Northshore Estate Agents", "Melissa Grant", [["112 Military Road", "Neutral Bay NSW 2089"], ["9 Shellcove Road", "Kurraba Point NSW 2089"]]],
  ["Paddington & Co Real Estate", "James Whitlam", [["27 Glenmore Road", "Paddington NSW 2021"], ["61 Underwood Street", "Paddington NSW 2021"]]],
  ["Eastbound Property Group", "Rachel Moore", [["3 Wolseley Road", "Point Piper NSW 2027"], ["18 Bellevue Road", "Bellevue Hill NSW 2023"]]],
  ["Sapphire Coast Realty", "Ben Cartwright", [["44 Pittwater Road", "Manly NSW 2095"], ["2/9 North Steyne", "Manly NSW 2095"]]],
  ["Inner West Homes", "Laura Chen", [["85 Darling Street", "Balmain NSW 2041"], ["12 Short Street", "Birchgrove NSW 2041"]]],
  ["Bayside Residential", "Peter Doukas", [["220 The Grand Parade", "Brighton-Le-Sands NSW 2216"], ["6 Bay Street", "Rockdale NSW 2216"]]],
  ["Blue Gum Property", "Kate Henderson", [["17 Pacific Highway", "Wahroonga NSW 2076"], ["4 Burns Road", "Wahroonga NSW 2076"]]],
  ["Parkside Agency", "Michael Tran", [["31 Station Street", "Newtown NSW 2042"], ["58 Australia Street", "Camperdown NSW 2050"]]],
  ["Cove & Crest Realty", "Anna Sorensen", [["10 Fitzroy Street", "Kirribilli NSW 2061"], ["23 Upper Pitt Street", "Kirribilli NSW 2061"]]],
  ["Lane Cove Living", "Chris Bailey", [["40 Burns Bay Road", "Lane Cove NSW 2066"], ["8 Penrose Street", "Lane Cove West NSW 2066"]]],
  ["Sterling Avenue Property", "Natalie Price", [["66 Edgecliff Road", "Woollahra NSW 2025"], ["3 Ocean Avenue", "Double Bay NSW 2028"]]],
  ["Seabreeze Estates", "Tim Fogarty", [["101 Ramsgate Avenue", "North Bondi NSW 2026"], ["15 Hastings Parade", "North Bondi NSW 2026"]]],
  ["Laneway Property Co", "Jess Albrecht", [["72 Crown Street", "Surry Hills NSW 2010"], ["19 Albion Street", "Surry Hills NSW 2010"]]],
  ["Greenleaf Realty", "Andrew Nolan", [["5 Tryon Road", "Lindfield NSW 2070"], ["28 Nelson Road", "Killara NSW 2071"]]],
  ["Ironbark Realty", "Fiona McRae", [["90 Victoria Road", "Rozelle NSW 2039"], ["11 Merton Street", "Rozelle NSW 2039"]]],
  ["Wattle & Stone", "Graham Pike", [["47 Ferry Road", "Glebe NSW 2037"], ["2 Toxteth Road", "Glebe NSW 2037"]]],
];

const WEDDINGS: readonly (readonly [string, string, string])[] = [
  ["Sophie & James Whitaker", "Sophie Whitaker", "Whitaker Wedding, Bendooley Estate"],
  ["Amelia & Raj Kapoor", "Amelia Kapoor", "Kapoor Wedding, Gunners' Barracks"],
  ["Charlotte & Ben O'Connell", "Charlotte O'Connell", "O'Connell Wedding, Gledswood Homestead"],
  ["Grace & Daniel Huang", "Grace Huang", "Huang Wedding, The Grounds of Alexandria"],
  ["Olivia & Marco Bianchi", "Olivia Bianchi", "Bianchi Wedding, Kangaroo Valley"],
  ["Emily & Sam Turner", "Emily Turner", "Turner Wedding, Palm Beach"],
  ["Zoe & Hugo Laurent", "Zoe Laurent", "Laurent Wedding, Bowral"],
  ["Lily & Tom Fraser", "Lily Fraser", "Fraser Wedding, Watsons Bay"],
];

const BRANDS: readonly (readonly [string, string, readonly string[]])[] = [
  ["Bondi Brew Co.", "Nick Halloran", ["Summer Lager Launch", "Taproom Interiors"]],
  ["Saltwater Swimwear", "Tessa Marlow", ["SS27 Lookbook", "Resort Collection E-commerce"]],
  ["Kindred Ceramics", "Hana Ito", ["Autumn Glaze Catalogue"]],
  ["Harbour Kitchen Group", "Luca Romano", ["Spring Menu Shoot", "Venue Refresh, Darling Harbour"]],
  ["Fernwood Skincare", "Bianca Ellis", ["Botanical Serum Launch", "Website Product Range"]],
  ["Atlas Fitness Studios", "Jordan Price", ["Brand Campaign 2026", "Coach Headshots"]],
];

const slug = (s: string) => s.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "").slice(0, 20);
const first = (name: string) => (name.split(" ")[0] ?? name).toLowerCase().replace(/[^a-z]/g, "");

export const CLIENTS: readonly SeedClientDef[] = [
  ...RE_AGENCIES.map(([name, contact, props], i): SeedClientDef => ({
    name,
    kind: "real_estate",
    contactName: contact,
    email: `${first(contact)}@${slug(name)}.example`,
    phone: `02 9${String(310 + i * 7).padStart(3, "0")} ${String(1200 + i * 37).padStart(4, "0")}`,
    archived: name === "Ironbark Realty" || name === "Wattle & Stone",
    projects: props.map(([street, suburb]) => ({ name: street, address: `${street}, ${suburb}` })),
  })),
  ...WEDDINGS.map(([name, contact, project], i): SeedClientDef => ({
    name,
    kind: "wedding",
    contactName: contact,
    email: `${first(contact)}.${slug(name).slice(-8)}@mail.example`,
    phone: `04${String(12 + i * 3).padStart(2, "0")} ${String(310 + i * 41).padStart(3, "0")} ${String(500 + i * 13).padStart(3, "0")}`,
    projects: [{ name: project, description: "Full-day coverage, ceremony and reception, highlight gallery and album selects." }],
  })),
  ...BRANDS.map(([name, contact, campaigns], i): SeedClientDef => ({
    name,
    kind: "commercial",
    contactName: contact,
    email: `${first(contact)}@${slug(name)}.example`,
    phone: `02 8${String(400 + i * 11).padStart(3, "0")} ${String(3000 + i * 71).padStart(4, "0")}`,
    projects: campaigns.map((c) => ({ name: c, description: `${c} for ${name}.` })),
  })),
];

/* ------------------------------------------------------------------ */
/*  Job types                                                          */
/* ------------------------------------------------------------------ */

export type JobTypeName =
  | "Real Estate"
  | "Wedding"
  | "Commercial"
  | "Product"
  | "Drone"
  | "Twilight"
  | "Video"
  | "Floor Plans"
  | "Virtual Staging"
  | "Retouching";

export type WorkflowKind = "default" | "quick" | "video";

export const TYPE_WORKFLOW: Record<JobTypeName, WorkflowKind> = {
  "Real Estate": "default",
  Wedding: "default",
  Commercial: "default",
  Product: "default",
  Drone: "default",
  Twilight: "default",
  Video: "video",
  "Floor Plans": "default",
  "Virtual Staging": "quick",
  Retouching: "quick",
};

export const TYPE_CLIENT_KIND: Record<JobTypeName, ClientKind> = {
  "Real Estate": "real_estate",
  Drone: "real_estate",
  Twilight: "real_estate",
  "Floor Plans": "real_estate",
  "Virtual Staging": "real_estate",
  Wedding: "wedding",
  Commercial: "commercial",
  Product: "commercial",
  Video: "commercial",
  Retouching: "commercial",
};

/** Typical days from shoot to editing deadline. */
export const TURNAROUND_DAYS: Record<JobTypeName, number> = { ...(DEFAULT_USUAL_DAYS_BY_JOB_TYPE as Record<JobTypeName, number>) };

/** Elapsed hours from "start editing" to "submit" [min, max]. */
export const EDIT_SPAN_HOURS: Record<JobTypeName, readonly [number, number]> = {
  "Real Estate": [2, 16],
  Drone: [1, 8],
  Twilight: [2, 12],
  "Floor Plans": [1, 6],
  "Virtual Staging": [4, 20],
  Retouching: [2, 18],
  Product: [18, 48],
  Commercial: [24, 72],
  Video: [60, 120],
  Wedding: [96, 240],
};

export const JOB_NAME_SUFFIX: Record<JobTypeName, readonly string[]> = {
  "Real Estate": ["Listing photos", "Sales campaign photos", "Pre-auction photos"],
  Drone: ["Aerial set", "Drone stills"],
  Twilight: ["Twilight exteriors", "Dusk hero shots"],
  "Floor Plans": ["Floor plan and site plan", "2D floor plan"],
  "Virtual Staging": ["Virtual staging, living and dining", "Virtual staging, bedrooms"],
  Retouching: ["Hero image retouch", "Beauty retouch selects"],
  Product: ["Product pack shots", "E-commerce cut-outs"],
  Commercial: ["Campaign hero images", "Lifestyle campaign"],
  Video: ["Campaign film", "Social cut-downs"],
  Wedding: ["Wedding day edit", "Engagement session edit"],
};

/* ------------------------------------------------------------------ */
/*  Copy                                                               */
/* ------------------------------------------------------------------ */

export const PHOTOGRAPHER_NOTES: readonly string[] = [
  "Shot on an overcast morning. Please lift the exteriors and swap the sky on the hero.",
  "Key shots: front elevation, kitchen, main bedroom, alfresco and the view from the balcony.",
  "Vendor asked us to feature the pool and the renovated bathroom.",
  "Bracketed 5 stops for interiors; window pulls on the living room please.",
  "Some frames have the agent's car in the driveway, remove where possible.",
  "Low light in the hallway, high ISO on a few frames.",
  "Ceremony was backlit, expect some heavy recovery on the aisle shots.",
  "Styling team moved props between setups, keep colour consistent across the set.",
];

export const CLIENT_NOTES: readonly string[] = [
  "Agent prefers warm, bright tones. No heavy HDR look.",
  "Listing goes live Thursday 9am; they need the hero image the night before.",
  "Client wants square crops for socials as well as the 3:2 set.",
  "Couple asked for a few black-and-white versions of the portraits.",
  "Brand guidelines: keep whites neutral, no warm cast on the product.",
  "Client will review on mobile, so check the crops on a phone-sized preview.",
];

export const INTERNAL_NOTES: readonly string[] = [
  "Priority client. Keep turnaround tight, they book us every week.",
  "Bill at the premium rate; includes two rounds of revisions.",
  "Client is on 30-day terms, accounts flagged a late payment last month.",
  "Repeat booking, quote approved over the phone.",
  "Trial job for a new agency. Make it count.",
];

export const EDITOR_NOTES: readonly string[] = [
  "Using the Coastal Bright preset as a base, interiors blended by hand.",
  "HDR blend done for interiors; flash-ambient blend for the kitchen.",
  "Sky replaced on 3 exteriors, kept the twilight glow natural.",
  "Skin retouch kept light, per the brief.",
  "Colour-matched the two camera bodies before grading.",
];

export const PHOTOGRAPHER_COMMENTS: readonly string[] = [
  "Client wants the kitchen to feel brighter. Can you lift the whites a touch?",
  "Please prioritise the hero exterior, the agent wants it for tonight's email.",
  "Sky replacement on the front elevation please, it was grey all morning.",
  "Heads up: vendor asked us to remove the bins from the side path.",
  "Any chance we can have the first 10 selects early?",
  "Thanks, these are looking great so far.",
  "Can you check the verticals on the living room set?",
];

export const EDITOR_COMMENTS: readonly string[] = [
  "Started on these. Lens corrections done, working through the interiors now.",
  "Quick question: window pulls on the living room, or keep the view soft?",
  "Uploaded a first pass to the workspace if you want a quick look.",
  "A couple of the bracketed sets are missing a frame, I'll blend what we have.",
  "Should be done within the hour.",
  "Finished set is uploaded, let me know if anything needs a tweak.",
];

export const MANAGER_COMMENTS: readonly string[] = [
  "Client called. They'd love this by end of day if possible.",
  "Agent confirmed the listing goes live Thursday, so let's keep this on track.",
  "Just checking in on this one, anything blocking?",
  "Moving this up the queue, the client has an auction on Saturday.",
];

export const REPLY_COMMENTS: readonly string[] = [
  "Will do!",
  "Thanks, on it now.",
  "Done, have a look when you get a sec.",
  "Yep, makes sense. Updated.",
  "Good catch, fixed in the latest upload.",
];

export const REVISION_REQUESTS: readonly { reason: string; description: string; instructions: string }[] = [
  { reason: "Colour", description: "Interiors are a little too warm compared with the exteriors.", instructions: "Neutralise the white balance in the living and dining shots." },
  { reason: "Retouching", description: "A few distractions are still visible.", instructions: "Remove the power lines on the hero and the hose in the backyard." },
  { reason: "Cropping", description: "The agent wants more breathing room above the roofline.", instructions: "Re-crop the exteriors to 3:2 with extra sky." },
  { reason: "Missing images", description: "The ensuite and laundry shots are missing from the set.", instructions: "Add the ensuite and laundry frames from the raw folder." },
  { reason: "Client feedback", description: "Client asked for a brighter, airier feel overall.", instructions: "Lift exposure by about a third of a stop across the set and soften shadows." },
  { reason: "Technical", description: "Verticals are converging on several interior shots.", instructions: "Fix verticals on the kitchen and hallway frames." },
];

export const RESUBMIT_NOTES: readonly string[] = [
  "All fixed. Updated set uploaded to the same folder.",
  "Changes done, swapped the 6 affected frames.",
  "Re-exported with the corrections, let me know if that's better.",
];

export const CANCEL_REASONS: readonly string[] = [
  "Listing withdrawn by the vendor",
  "Client postponed the shoot indefinitely",
  "Duplicate booking, merged into the earlier job",
  "Campaign cancelled by the client",
  "Property sold off-market before launch",
];

export const PAUSE_REASONS: readonly string[] = [
  "Waiting on the client's brand assets",
  "Waiting on the agent to confirm which images go to print",
];
