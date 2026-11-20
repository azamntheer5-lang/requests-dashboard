import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// خدمة البوت الرئيسي (أسطول المراقبة + بوابة قناة الطلبات)
const E3FY2_URL = (process.env.E3FY2_SERVICE_URL || "https://whatsapp-userbot-e3fy2.onrender.com").replace(/\/$/, "");

export type JoinStatusData = {
  ok: boolean;
  fetchedAt: string;
  serviceReachable: boolean;
  enabled?: boolean;
  joinUrl?: string;
  pending?: number;
  totals?: {
    code_requests: number;
    instant_joins: number;
    otp_joins: number;
    verify_attempts: number;
    failed: number;
  };
  recent?: {
    at: string;
    phone: string;
    name: string;
    method: string;
    groups_added: number;
    ok: boolean;
  }[];
};

export async function GET() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    // المسبار الأول يوقظ الخدمة من السكون إن كانت نائمة (الخطة المجانية)
    const res = await fetch(`${E3FY2_URL}/api/join_status`, {
      cache: "no-store",
      signal: ctrl.signal,
      headers: { Accept: "application/json" },
    });
    const json = (await res.json()) as Record<string, unknown>;
    const out: JoinStatusData = {
      ok: res.ok && json.ok === true,
      fetchedAt: new Date().toISOString(),
      serviceReachable: res.ok,
      enabled: Boolean(json.enabled),
      joinUrl: `${E3FY2_URL}/join`,
      pending: typeof json.pending === "number" ? json.pending : 0,
      totals: json.totals as JoinStatusData["totals"],
      recent: Array.isArray(json.recent) ? (json.recent as JoinStatusData["recent"]) : [],
    };
    return NextResponse.json(out);
  } catch {
    return NextResponse.json(
      {
        ok: false,
        fetchedAt: new Date().toISOString(),
        serviceReachable: false,
        enabled: false,
        joinUrl: `${E3FY2_URL}/join`,
        pending: 0,
        totals: { code_requests: 0, instant_joins: 0, otp_joins: 0, verify_attempts: 0, failed: 0 },
        recent: [],
      } satisfies JoinStatusData,
      { status: 200 },
    );
  } finally {
    clearTimeout(timer);
  }
}
