import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Next 16 serves /_next/* dev assets only to origins it recognises. The dev
  // server is reached here through 127.0.0.1 and through tunnelled preview
  // hosts, both of which it treats as cross-origin, and the resulting 403s
  // leave the page as unhydrated HTML: no map, no working controls.
  allowedDevOrigins: [
    "127.0.0.1",
    "localhost",
    "0.0.0.0",
    "*.cursor.sh",
    "*.cursor.com",
    "*.ngrok-free.app",
    "*.trycloudflare.com",
  ],
};

export default nextConfig;
