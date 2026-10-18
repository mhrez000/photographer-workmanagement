import type { MetadataRoute } from "next";
import { appOrigin } from "@/server/origin";

/**
 * Only the public front door is listed. Everything behind a sign-in (the app, the portal, the API) is
 * disallowed in robots.ts and never belongs here. /login and /signup are reachable from the landing
 * page and are listed so a search for "Proofline sign in" lands on the right page.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const origin = appOrigin();
  const now = new Date();
  return [
    { url: `${origin}/`, lastModified: now, changeFrequency: "weekly", priority: 1 },
    { url: `${origin}/signup`, lastModified: now, changeFrequency: "monthly", priority: 0.8 },
    { url: `${origin}/login`, lastModified: now, changeFrequency: "monthly", priority: 0.5 },
  ];
}
