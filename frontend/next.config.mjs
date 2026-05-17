/** @type {import('next').NextConfig} */
const nextConfig = {
  // Pure static site so the container image is just the built bundle —
  // nginx (distroless) serves it directly, no Node runtime in production.
  // Combined with relative API URLs this makes the image portable: it works
  // on any host without rebuilding.
  output: "export",
  // Mirror every page as ``<route>/index.html`` so nginx ``try_files`` can
  // resolve a deep link without guessing whether to append ``.html``.
  trailingSlash: true,
  // Static export rejects the Next.js image optimisation pipeline because it
  // requires a server. Plain <img> is fine here — icons are already PNG-
  // optimised at upload and the catalogue isn't image-heavy.
  images: { unoptimized: true },
  reactStrictMode: true,
  poweredByHeader: false,
  experimental: {
    optimizePackageImports: ["lucide-react"],
  },
};

export default nextConfig;
