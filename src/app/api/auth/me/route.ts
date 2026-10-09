import { getViewer, requireContext } from "@/server/auth/session";
import { handle } from "@/server/http";
import { UnauthorizedError } from "@/server/errors";
import { unreadCount } from "@/server/services/notifications";

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
    unreadCount: unreadCount(ctx),
  };
});
