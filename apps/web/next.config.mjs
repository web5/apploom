/** @type {import('next').NextConfig} */
const nextConfig = {
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
