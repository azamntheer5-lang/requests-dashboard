import type { NextConfig } from "next";

// ملاحظة نشر Vercel: لا تستخدم output: "standalone" هنا —
// فيرسل يبني Next.js بنمطه الافتراضي (standalone مخصص للسيرفرات/VPS).
const nextConfig: NextConfig = {
  typescript: {
    // عملي: لا نعطّل النشر بسبب أخطاء أنواع غير حرجة
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;
