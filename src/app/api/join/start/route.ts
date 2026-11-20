import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// وكيل الانضمام (الخطوة 1): POST {phone} → انضمام فوري أو إرسال كود
// يمرر الطلب من المتصفح إلى خدمة البوت (تجنب CORS + إخفاء الخدمة).
const SERVICE_URL = (process.env.E3FY2_SERVICE_URL || "https://whatsapp-userbot-e3fy2.onrender.com").replace(/\/$/, "");

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 40000); // إرسال الكود قد يوقظ الخدمة النائمة
    const res = await fetch(`${SERVICE_URL}/api/join/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ phone: String(body?.phone ?? "") }),
      cache: "no-store",
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const json = await res.json().catch(() => ({ ok: false, status: "error" }));
    return NextResponse.json(json, { status: 200 });
  } catch {
    return NextResponse.json(
      { ok: false, status: "unreachable", error: "تعذر الوصول للخدمة — قد تكون نائمة، جرّب بعد لحظات" },
      { status: 200 },
    );
  }
}
