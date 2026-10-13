/**
 * GET   /api/settings/advanced -> AdvancedState { enabled, forcedOn, forcedReasons[], effective, canManage, columnPresent }
 *       — Settings → Studio → Advanced tools (owner). `forcedOn` = the studio relies on custom workflows
 *       or live automations, so the switch is on automatically (SIMPLIFICATION-PLAN §8).
 * PATCH /api/settings/advanced { enabled, expectedVersion? (organisation_settings version) }
 *       -> SetAdvancedToolsResult { enabled, settings, changed } (admin; audited as settings.updated).
 */
import { methodNotAllowed, mutate, read } from "@/app/api/_lib/route";
import { getAdvancedState } from "@/server/queries/settingsSimple";
import { setAdvancedTools } from "@/server/services/simple";

export const GET = read((db, ctx) => getAdvancedState(db, ctx));
export const PATCH = mutate(setAdvancedTools);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const POST = methodNotAllowed(["GET", "PATCH"]);
export const PUT = methodNotAllowed(["GET", "PATCH"]);
export const DELETE = methodNotAllowed(["GET", "PATCH"]);
