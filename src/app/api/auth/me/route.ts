import { getViewer, requireAnyContext } from "@/server/auth/session";
import { handle } from "@/server/http";
import { UnauthorizedError } from "@/server/errors";
import { unreadCount } from "@/server/services/notifications";
import { methodNotAllowed } from "@/app/api/_lib/route";
import type { PortalViewer } from "@/lib/types";

/**
 * GET /api/auth/me → the signed-in user, organisation and unread count.
 * Clients get the client-safe shape (docs/ROLES.md §7.7): never settings,
 * switches or staff fields.
 */
export const GET = handle(async () => {
  const ctx = await requireAnyContext();
  const viewer = await getViewer();
  if (!viewer) throw new UnauthorizedError();
  if (ctx.role === "client") {
    const client: PortalViewer = {
      kind: "client",
      name: viewer.name,
      email: viewer.email,
      clientName: viewer.clientName ?? "",
      studioName: viewer.organisationName,
      unreadCount: await unreadCount(ctx),
    };
    return client;
  }
  return {
    kind: "staff" as const,
    user: {
      id: viewer.id,
      name: viewer.name,
      email: viewer.email,
      role: viewer.role,
      persona: viewer.persona,
      personaLabel: viewer.personaLabel,
      isAdmin: viewer.isAdmin,
      isPrimaryOwner: viewer.isPrimaryOwner,
      title: viewer.title,
      avatarColour: viewer.avatarColour,
      canCreateJobs: ctx.canCreateJobs,
      canViewAllJobs: ctx.canViewAllJobs,
      canAssignEditors: ctx.canAssignEditors,
      canReviewSubmissions: ctx.canReviewSubmissions,
      canViewTeamWorkloads: ctx.canViewTeamWorkloads,
      canViewAnalytics: ctx.canViewAnalytics,
      canViewTeamJobs: ctx.canViewTeamJobs,
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
