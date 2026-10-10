import { getViewer, requireContext } from "@/server/auth/session";
import { handle } from "@/server/http";
import { UnauthorizedError } from "@/server/errors";
import { unreadCount } from "@/server/services/notifications";
import { methodNotAllowed } from "@/app/api/_lib/route";

/** GET /api/auth/me → the signed-in user, organisation and unread count. */
export const GET = handle(async () => {
  const ctx = await requireContext();
  const viewer = await getViewer();
  if (!viewer) throw new UnauthorizedError();
  return {
    user: {
      id: viewer.id,
      name: viewer.name,
      email: viewer.email,
      role: viewer.role,
      title: viewer.title,
      avatarColour: viewer.avatarColour,
      canViewTeamWorkloads: ctx.canViewTeamWorkloads,
      canViewAnalytics: ctx.canViewAnalytics,
    },
    organisation: { id: viewer.organisationId, name: viewer.organisationName, timezone: ctx.settings.timezone },
    settings: ctx.settings,
    unreadCount: await unreadCount(ctx),
  };
});

/** Every other method → JSON 405 (not Next's empty-body 405). */
export const POST = methodNotAllowed(["GET"]);
export const PUT = methodNotAllowed(["GET"]);
export const PATCH = methodNotAllowed(["GET"]);
export const DELETE = methodNotAllowed(["GET"]);
