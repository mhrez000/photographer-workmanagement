/** GET /api/settings -> SettingsView; PATCH { expectedVersion, organisationName?, ...settings } (owner) */
import { mutate, read } from "@/app/api/_lib/route";
import { getSettingsView } from "@/server/queries/settings";
import { updateSettings } from "@/server/services/settings";

export const GET = read((db, ctx) => getSettingsView(db, ctx));
export const PATCH = mutate(updateSettings);
