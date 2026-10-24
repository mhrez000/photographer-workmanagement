import type { MetadataRoute } from "next";
import { appOrigin } from "@/server/origin";

/**
 * Crawlers may index the landing page, sign-in and sign-up. Everything that needs a session, the API,
 * and the one-time links (invite / reset) are kept out: they are either private or useless in a result.
 */
export default function robots(): MetadataRoute.Robots {
  const origin = appOrigin();
  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/", "/login", "/signup"],
        disallow: [
          "/api/",
          "/home",
          "/jobs",
          "/my-jobs",
          "/editors",
          "/clients",
          "/calendar",
          "/settings",
          "/search",
          "/notifications",
          "/activity",
          "/dashboard",
          "/workspace",
          "/insights",
          "/projects",
          "/team",
          "/help",
          "/portal",
          "/design-system",
          "/invite/",
          "/forgot-password",
          "/reset-password",
          "/verify-email",
          "/change-email",
          "/signup/google",
        ],
      },
    ],
    sitemap: `${origin}/sitemap.xml`,
  };
}
