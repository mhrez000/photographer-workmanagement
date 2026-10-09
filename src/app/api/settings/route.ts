/** GET /api/settings -> SettingsView; PATCH { expectedVersion, organisationName?, ...settings } (owner) */
import { mutate, read, methodNotAllowed } from "@/app/api/_lib/route";
import { getSettingsView } from "@/server/queries/settings";
import { updateSettings } from "@/server/services/settings";

export const GET = read((db, ctx) => getSettingsView(db, ctx));
export const PATCH = mutate(updateSettings);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const POST = methodNotAllowed(["GET", "PATCH"]);
export const PUT = methodNotAllowed(["GET", "PATCH"]);
export const DELETE = methodNotAllowed(["GET", "PATCH"]);
