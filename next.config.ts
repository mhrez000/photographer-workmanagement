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
};

export default nextConfig;
