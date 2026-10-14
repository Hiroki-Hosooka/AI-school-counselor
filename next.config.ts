import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // next dev が CLAUDE.md の末尾に Next.js 向けの案内を書き足さないようにする(このリポジトリの CLAUDE.md は人が管理する)
  agentRules: false,
};

export default nextConfig;
