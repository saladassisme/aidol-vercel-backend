/** @type {import('next').NextConfig} */
const nextConfig = {
  // Build on CI/local machines and run the lightweight standalone server in
  // production. This avoids compiling on the memory-constrained mainland host.
  output: 'standalone',
  experimental: {
    serverActions: { bodySizeLimit: '12mb' }
  }
};

export default nextConfig;
