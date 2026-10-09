/**
 * Bare `/api` (the `[...path]` catch-all needs at least one segment): the same
 * JSON 404 as any other unknown API path, never the HTML not-found page.
 */
import { notFoundRoute } from "@/app/api/_lib/route";

export const GET = notFoundRoute();
export const POST = notFoundRoute();
export const PUT = notFoundRoute();
export const PATCH = notFoundRoute();
export const DELETE = notFoundRoute();
