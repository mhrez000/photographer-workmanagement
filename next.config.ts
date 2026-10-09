import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Authenticated, per-request data on every page: keep the classic dynamic
  // rendering model (no Cache Components / PPR) so DB reads are always fresh.
  cacheComponents: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  serverExternalPackages: ["better-sqlite3"],
  // forbidden() + src/app/forbidden.tsx for permission-denied pages.
  experimental: { authInterrupts: true },
  // Legacy paths from PRODUCT-SPEC / SPEC-CHECKLIST, renamed in ARCHITECTURE §10.
  // Temporary (307) so the canonical routes stay free to move again.
  async redirects() {
    return [
      { source: "/workspace/my-work", destination: "/workspace/my", permanent: false },
      { source: "/workspace/all-work", destination: "/workspace/all", permanent: false },
      { source: "/workspace/team-work", destination: "/workspace/team", permanent: false },
      { source: "/team/editors/:id", destination: "/team/users/:id", permanent: false },
      { source: "/team/photographers/:id", destination: "/team/users/:id", permanent: false },
    ];
  },
};

export default nextConfig;
