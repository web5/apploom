/** @type {import('next').NextConfig} */
const nextConfig = {
  // 关闭 dev 注入的构建指示器（避免 hydration mismatch 噪音）
  devIndicators: { buildActivity: false },
  // /api/* 代理到 NestJS（dev: 3001），避免浏览器跨域
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: 'http://localhost:3001/:path*',
      },
    ];
  },
};

export default nextConfig;
