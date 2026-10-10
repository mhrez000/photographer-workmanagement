/**
 * Who may open Team Work (docs/ROLES.md §10.1): admins, members with "See all
 * jobs", editors with "See other editors' jobs". Rows are still
 * visibility-scoped by `getTeamWork`; this is the page-level gate.
 */
export { canViewTeamWork } from "@/server/nav-gates";
