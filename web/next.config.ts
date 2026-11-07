import type { NextConfig } from "next";

/**
 * Static export: the app is fully client-side (Cognito in the browser, data from the
 * API, images from CloudFront), so it's served as plain files by Amplify Hosting.
 * This avoids depending on Amplify's Next.js SSR runtime (officially Next.js 12-15).
 */
const nextConfig: NextConfig = {
  output: "export",
  // /albums -> albums/index.html, which static hosts serve without rewrites.
  trailingSlash: true,
  // Workspace package shipped as TypeScript source
  transpilePackages: ["@mypic/shared"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
