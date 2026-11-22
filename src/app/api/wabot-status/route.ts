import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// الخدمة الحية بعد ترحيل 2026-11-20 هي whatsapp-userbot-e3fy2.
// الافتراضي القديم كان um-raham-bot (موقوف الآن من المالك) فتظهر لوحة
// الحالة بيانات خدمة ميتة — الإعداد الوحيد: E3FY2_SERVICE_URL
// (حذفنا أولوية RENDER_SERVICE_URL نهائيًا: لو بقيت قيمة قديمة في
//  متغيرات بيئة Vercel فستتجاهلها الواجهة ولن تعود تقيس الخدمة الميتة)
const SERVICE_URL = (process.env.E3FY2_SERVICE_URL || "https://whatsapp-userbot-e3fy2.onrender.com").replace(/\/$/, "");
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const SUPA_BASE = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const GH_TOKEN = process.env.GITHUB_TOKEN || "";
const EXPECTED_SHA = (process.env.WABOT_COMMIT_SHA || "").trim().toLowerCase();

type FetchResult = { status: number; text: string; json: unknown } | null;

type LiveStats = {
  connectedAccounts: number | null;
  activeWatchers: number | null;
  totalLinks: number | null;
  monitoredChats: number | null;
} | null;

async function jget(url: string, ms: number, headers?: Record<string, string>): Promise<FetchResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { headers, cache: "no-store", signal: ctrl.signal });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* ليس JSON */
    }
    return { status: res.status, text, json };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function GET() {
  const out: Record<string, unknown> = { fetchedAt: new Date().toISOString() };

  // الفحوصات الجانبية تبدأ فوراً وتجري بالتوازي مع مسبار الخدمة
  const tgPromise: Promise<FetchResult> = TG_TOKEN
    ? jget(`https://api.telegram.org/bot${TG_TOKEN}/getMe`, 9000)
    : Promise.resolve(null);
  const supaPromise: Promise<FetchResult> =
    SUPA_BASE && SUPA_KEY
      ? jget(`${SUPA_BASE}/rest/v1/watchers?select=phone,role,is_active,display_name&limit=50`, 10000, {
          apikey: SUPA_KEY,
          Authorization: `Bearer ${SUPA_KEY}`,
        })
      : Promise.resolve(null);
  const ghPromise: Promise<FetchResult> = GH_TOKEN
    ? jget("https://api.github.com/repos/azamntheer5-lang/whatsapp-link-monitor/branches/main", 9000, {
          Authorization: `Bearer ${GH_TOKEN}`,
          Accept: "application/vnd.github+json",
        })
      : Promise.resolve(null);

  // مسبار الخدمة الحية — /ready للنسخة الجديدة، ثم /api/health للرشق القديم
  // (المسبار الأول يوقظ الخدمة من السكون إن كانت نائمة على الخطة المجانية)
  const ready = await jget(`${SERVICE_URL}/ready`, 25000);
  let health: FetchResult = null;
  if (!ready || ready.status !== 200) {
    health = await jget(`${SERVICE_URL}/api/health`, 25000);
  }

  if (ready && ready.status === 200) {
    out.service = { flavor: "wabot", ready: true, statusCode: 200, body: ready.text.slice(0, 500) };
  } else if (health && health.status === 200) {
    out.service = { flavor: "rashq-old", ready: false, statusCode: ready ? ready.status : 0 };
  } else if (!ready && !health) {
    out.service = { flavor: "unreachable", ready: false, statusCode: 0 };
  } else {
    out.service = { flavor: "unknown", ready: false, statusCode: ready ? ready.status : health ? health.status : 0 };
  }

  // إحصاءات حية من البوت (فقط إذا كانت النسخة الجديدة تعمل)
  const isWabot = (out.service as { flavor?: string }).flavor === "wabot";
  let live: LiveStats = null;
  if (isWabot) {
    const [stats, monch] = await Promise.all([
      jget(`${SERVICE_URL}/api/stats`, 15000),
      jget(`${SERVICE_URL}/api/monitored_chats`, 15000),
    ]);
    const sj = stats?.json as Record<string, unknown> | null;
    const mj = monch?.json as { summary?: { total?: number } } | null;
    live = {
      connectedAccounts: (sj?.connected_accounts as number) ?? null,
      activeWatchers: (sj?.active_watchers as number) ?? null,
      totalLinks: (sj?.total_links as number) ?? null,
      monitoredChats: mj?.summary?.total ?? null,
    };
  }
  out.live = live;

  const tgd = await tgPromise;
  const tgJson = (tgd?.json as { ok?: boolean; result?: { id?: number; username?: string } }) ?? null;
  out.telegram = {
    ok: !!tgJson?.ok,
    username: tgJson?.result?.username ?? null,
    id: tgJson?.result?.id ?? null,
  };

  const sd = await supaPromise;
  if (sd && sd.status === 200) {
    const rows = (sd.json as { phone: string; role: string; is_active: boolean; display_name: string | null }[]) || [];
    out.supabase = {
      state: "ready",
      watchers: rows.map((r) => ({ phone: r.phone, role: r.role, isActive: r.is_active, displayName: r.display_name })),
    };
  } else if (sd && sd.text.includes("permission denied")) {
    out.supabase = { state: "needs-grant" };
  } else if (sd && sd.text.includes("PGRST205")) {
    out.supabase = { state: "no-tables" };
  } else {
    out.supabase = { state: sd ? "error" : "unknown", hint: sd ? sd.text.slice(0, 140) : undefined };
  }

  // فحص جدول links (يخزّن الروابط الملتقطة — البوت يسجل خطأ لكل إدراج بدونه)
  if (SUPA_BASE && SUPA_KEY) {
    const ld = await jget(`${SUPA_BASE}/rest/v1/links?select=id&limit=1`, 10000, {
      apikey: SUPA_KEY,
      Authorization: `Bearer ${SUPA_KEY}`,
    });
    const supa = out.supabase as { linksState?: string };
    if (ld && ld.status === 200) supa.linksState = "ready";
    else if (ld && ld.text.includes("PGRST205")) supa.linksState = "no-table";
    else if (ld && ld.text.includes("permission denied")) supa.linksState = "needs-grant";
    else supa.linksState = "unknown";
  }

  const gd = await ghPromise;
  const ghJson = (gd?.json as { commit?: { sha?: string; commit?: { message?: string } } }) ?? null;
  const head = ghJson?.commit?.sha ?? null;
  out.github = {
    head: head ? head.slice(0, 8) : null,
    message: (ghJson?.commit?.commit?.message || "").split("\n")[0].slice(0, 90) || null,
    pushed: !!head && !!EXPECTED_SHA && head.toLowerCase() === EXPECTED_SHA,
  };

  return NextResponse.json(out);
}
