/** GET /api/projects?q&includeArchived&clientId -> ProjectListItem[]; POST (CreateProjectInput) */
import { mutate, read, methodNotAllowed } from "@/app/api/_lib/route";
import { listProjects } from "@/server/queries/projects";
import { createProject } from "@/server/services/projects";

export const GET = read((db, ctx, q) => listProjects(db, ctx, q));
export const POST = mutate(createProject);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const PUT = methodNotAllowed(["GET", "POST"]);
export const PATCH = methodNotAllowed(["GET", "POST"]);
export const DELETE = methodNotAllowed(["GET", "POST"]);
