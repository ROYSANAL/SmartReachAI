import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Enable standalone output for Docker deployment
  output: 'standalone',
  
  // Optimize for production
  compress: true,
  
  // Enable experimental features for better performance
  experimental: {
    // Disable optimizeCss to avoid requiring 'critters' in build environment
    optimizeCss: false,
  },
  
  // Configure for containerized environment
  env: {
    CUSTOM_KEY: process.env.CUSTOM_KEY,
  },
  
  // Webpack configuration for better bundling
  webpack: (config, { isServer }) => {
    if (!isServer) {
      // Resolve fallbacks for client-side
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        path: false,
        crypto: false,
      };
    }
    return config;
  },
};

export default nextConfig;
