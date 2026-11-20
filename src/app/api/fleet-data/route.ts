import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// ============================================================
// /api/fleet-data — لوحة الأسطول (سوبابس + البوت الحي)
// المصادر:
//   1) Supabase watchers  — الحسابات والأدوار والحالة (دائم)
//   2) Supabase links     — أرشيف الروابط + الأحدث (دائم)
//   3) البوت /api/monitored_chats — التغطية الحية لكل حساب
//      (عدد المجموعات التي يقرأها فعليًا + المكتشفة حديثًا)
//   4) البوت /api/stats   — الحسابات المتصلة الآن
// مع كاش ذاكرة قصير كي لا يُغمَر البوت بالاستقصاء المتزامن.
// ============================================================

const SERVICE_URL = (process.env.E3FY2_SERVICE_URL || "https://whatsapp-userbot-e3fy2.onrender.com").replace(/\/$/, "");
const SUPA_BASE = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY || "";

type MonChat = {
  chat_id: number;
  chat_title: string;
  username?: string;
  link_type?: string;
  monitored_by?: string;
  reader_phones?: string;
  primary_reader?: string;
  first_seen?: string;
  last_seen?: string;
};

type MonitoredSnapshot = {
  total: number;
  awake: boolean;
  perPhone: Record<string, { reader: number; discovered: number }>;
  recentGroups: { chatId: number; title: string; username: string; by: string; at: string; readers: number }[];
  fetchedAt: string;
};

type Cache = { ts: number; monitored: MonitoredSnapshot | null };

// كاش مشترك بين الطلبات (ذاكرة العملية) — 10 ثوانٍ فقط كي يبقى التحديث
// «لحظيًا» للمستخدم دون قصف البوت بمئة استقصاء متزامن.
const g = globalThis as unknown as { __fleetCache?: Cache };

async function jget(url: string, ms: number, headers?: Record<string, string>): Promise<{ status: number; json: unknown } | null> {
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
    return { status: res.status, json };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function parseReaders(raw: unknown): string[] {
  if (typeof raw === "string") {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return arr.filter((x): x is string => typeof x === "string");
    } catch {
      return raw.replace(/[\[\]"]/g, "").split(",").map((s) => s.trim()).filter(Boolean);
    }
  }
  if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === "string");
  return [];
}

export async function GET() {
  const out: Record<string, unknown> = { fetchedAt: new Date().toISOString() };
  const now = Date.now();

  // ---------- (1) Supabase: watchers (دائم — يعمل حتى لو البوت نائم) ----------
  if (SUPA_BASE && SUPA_KEY) {
    const headers = { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` };

    const wd = await jget(`${SUPA_BASE}/rest/v1/watchers?select=phone,role,is_active,display_name,health_score&limit=200`, 12000, headers);
    if (wd && wd.status === 200 && Array.isArray(wd.json)) {
      const rows = wd.json as { phone: string; role: string; is_active: boolean; display_name: string | null; health_score?: number | null }[];
      // فقط حسابات حقيقية (أرقام +) — يستبعد صفوف ign:/gate:/tg: التنظيمية
      out.watchers = rows
        .filter((r) => typeof r.phone === "string" && r.phone.startsWith("+"))
        .map((r) => ({ phone: r.phone, role: r.role, isActive: !!r.is_active, displayName: r.display_name, healthScore: r.health_score ?? null }));
      out.supabase = "ready";
    } else {
      out.supabase = wd ? "error" : "unreachable";
    }

    // ---------- (2) Supabase: links (الأحدث + العدد الكلي) ----------
    const ld = await jget(
      `${SUPA_BASE}/rest/v1/links?select=id,link,link_type,group_name,sender_name,ai_country,ai_is_ad,created_at&order=created_at.desc&limit=12`,
      12000,
      headers,
    );
    if (ld && ld.status === 200 && Array.isArray(ld.json)) {
      const rows = ld.json as { id: number; link: string; link_type: string | null; group_name: string | null; sender_name: string | null; ai_country: string | null; ai_is_ad: boolean | null; created_at: string | null }[];
      out.recentLinks = rows.map((r) => ({
        id: r.id,
        link: r.link,
        type: r.link_type || "",
        group: r.group_name || "",
        sender: r.sender_name || "",
        country: r.ai_country || "",
        isAd: r.ai_is_ad ?? null,
        at: r.created_at || "",
      }));
    }
    // العدد الكلي (رأس Content-Range مع Prefer: count=exact)
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 10000);
      const res = await fetch(`${SUPA_BASE}/rest/v1/links?select=id&limit=1`, {
        headers: { ...headers, Prefer: "count=exact" },
        cache: "no-store",
        signal: ctrl.signal,
      });
      clearTimeout(t);
      const range = res.headers.get("content-range"); // "0-0/27602"
      if (range) {
        const total = Number(range.split("/")[1]);
        if (Number.isFinite(total)) out.linksTotal = total;
      }
    } catch {
      /* العدد تحسيني */
    }
  } else {
    out.supabase = "no-env";
  }

  // ---------- (3) البوت الحي: monitored_chats (تغطية كل حساب) ----------
  const cacheOk = g.__fleetCache && now - g.__fleetCache.ts < 10000;
  if (!cacheOk) {
    const md = await jget(`${SERVICE_URL}/api/monitored_chats`, 22000);
    if (md && md.status === 200) {
      const body = md.json as { chats?: MonChat[] } | null;
      const chats = body?.chats || [];
      const perPhone: Record<string, { reader: number; discovered: number }> = {};
      const bump = (phone: string, key: "reader" | "discovered") => {
        const p = phone.trim();
        if (!p.startsWith("+")) return;
        perPhone[p] = perPhone[p] || { reader: 0, discovered: 0 };
        perPhone[p][key] += 1;
      };
      const cutoff = Date.now() - 24 * 3600 * 1000;
      const recent: { chatId: number; title: string; username: string; by: string; at: string; readers: number }[] = [];
      for (const c of chats) {
        if (c.monitored_by) bump(c.monitored_by, "discovered");
        const readers = parseReaders(c.reader_phones);
        for (const r of readers) bump(r, "reader");
        const fs = c.first_seen ? Date.parse(c.first_seen) : NaN;
        if (Number.isFinite(fs) && fs >= cutoff) {
          recent.push({
            chatId: c.chat_id,
            title: c.chat_title || "",
            username: c.username || "",
            by: c.monitored_by || "",
            at: c.first_seen || "",
            readers: readers.length,
          });
        }
      }
      recent.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
      g.__fleetCache = {
        ts: now,
        monitored: {
          total: chats.length,
          awake: true,
          perPhone,
          recentGroups: recent.slice(0, 40),
          fetchedAt: new Date().toISOString(),
        },
      };
    } else if (g.__fleetCache?.monitored) {
      // البوت نائم/غير متاح — احتفظ بآخر لقطة معروفة
      g.__fleetCache = {
        ts: now - 9000, // أعد المحاولة بعد ~10ث لا كل طلب
        monitored: { ...g.__fleetCache.monitored, awake: false },
      };
    } else {
      g.__fleetCache = { ts: now - 9000, monitored: null };
    }
  }
  out.monitored = g.__fleetCache?.monitored || null;

  // ---------- (4) البوت الحي: stats (متصل الآن) ----------
  const sd = await jget(`${SERVICE_URL}/api/stats`, 12000);
  if (sd && sd.status === 200) {
    const sj = sd.json as Record<string, unknown> | null;
    out.stats = {
      connectedAccounts: (sj?.connected_accounts as number) ?? null,
      activeWatchers: (sj?.active_watchers as number) ?? null,
      totalLinks: (sj?.total_links as number) ?? null,
      botConnected: (sj?.bot_connected as boolean) ?? null,
    };
    out.serviceAwake = true;
  } else {
    out.stats = null;
    out.serviceAwake = false;
  }

  return NextResponse.json(out);
}
