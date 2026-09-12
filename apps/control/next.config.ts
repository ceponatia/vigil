import type { NextConfig } from "next";

// Every workspace package this app imports must be listed in
// transpilePackages: workspace packages ship TypeScript source with no build
// step of their own, so Next has to compile them the same way it compiles
// src/ rather than loading prebuilt output. apps/control may depend only on
// @vigil/contracts, @vigil/db, and @vigil/policy among workspace packages
// (docs/architecture.md "Layer graph and import rules") — the same three names
// belong in this list.
const nextConfig: NextConfig = {
  transpilePackages: ["@vigil/contracts", "@vigil/db", "@vigil/policy"],
  typedRoutes: true,
  reactStrictMode: true,
};

export default nextConfig;
