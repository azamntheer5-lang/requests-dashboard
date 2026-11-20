import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// قفل الواجهة: الرمز السري يُقارن على الخادم — لا يظهر في كود المتصفح.
const PIN = (process.env.DASHBOARD_PIN || "").trim();

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const pin = String(body?.pin ?? "").trim();
    if (!PIN) {
      return NextResponse.json({ ok: false, error: "قفل الواجهة غير مضبوط" });
    }
    if (pin === PIN) {
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ ok: false, error: "الرمز غير صحيح" });
  } catch {
    return NextResponse.json({ ok: false, error: "طلب غير صالح" });
  }
}
