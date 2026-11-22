import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// ============================================================
// /api/fleet-data — لوحة أسطول المراقبة (سوبابس + البوت الحي)
// المصادر — تُجلب كلها بالتوازي:
//   1) Supabase watchers      — الحسابات والأدوار (دائم)
//   2) Supabase links         — الأرشيف التاريخي + العدد الكلي
//   3) البوت /api/monitored_chats — التغطية الحية لكل حساب
//   4) البوت /api/stats       — الأرقام الإجمالية
//   5) البوت /api/filter_stats    — الطلبات المنشورة/المفحوصة
//   6) البوت /api/deploy_check   — حالة الاتصال الفعلية لكل حساب
//      (البوت يعرضها بأرقام مقنّعة «+967••••••••10» — نطابقها مع
//       أرقام watchers الكاملة عبر: رمز الدولة + عدد النقاط + آخر رقمين)
//   7) البوت /ready           — إصدار الكود المشتغل + صحة الأسطول
// كاش ذاكرة 10 ثوانٍ حتى لا يُقصف البوت بمئة استقصاء متزامن.
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

type Cache = { ts: number; payload: Record<string, unknown> | null };

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

// ─── مطابقة الأرقام المقنّعة مع الأرقام الكاملة ───
// "+967••••••••10" ⟷ "+967770309310": رمز الدولة (1-4 خانات) + عدد
// النقاط + آخر رقمين = طول الرقم الكامل، فالتطابق شبه مؤكد. لو تشابه
// حسابان بنفس القناع تُعلَّم الحالة «غير قطعية» وتُعرض مع علامة استفهام.
function maskedKeyOf(masked: string): string | null {
  const m = /^(\d+)([•]+)(\d+)$/.exec(masked.replace(/^\+/, ""));
  if (!m) return null;
  return `${m[1]}|${m[3]}|${m[2].length}`;
}

function candidatesOf(digits: string): string[] {
  const out: string[] = [];
  const last2 = digits.slice(-2);
  for (let cc = 1; cc <= 4; cc++) {
    const hidden = digits.length - cc - 2;
    if (hidden >= 1) out.push(`${digits.slice(0, cc)}|${last2}|${hidden}`);
  }
  return out;
}

type ClientIndex = { index: Map<string, boolean>; maskedCount: number; connectedCount: number };

function buildClientIndex(userClients: unknown): ClientIndex {
  const index = new Map<string, boolean>();
  let maskedCount = 0;
  let connectedCount = 0;
  if (userClients && typeof userClients === "object") {
    for (const [masked, v] of Object.entries(userClients as Record<string, unknown>)) {
      const key = maskedKeyOf(masked);
      if (!key) continue;
      const connected =
        typeof v === "boolean" ? v : !!(v as Record<string, unknown>)?.connected;
      index.set(key, connected);
      maskedCount += 1;
      if (connected) connectedCount += 1;
    }
  }
  return { index, maskedCount, connectedCount };
}

function resolveClients(
  phones: string[],
  ci: ClientIndex,
): { userClients: Record<string, { connected: boolean | null; exact: boolean }>; collisions: number } {
  // لكل مفتاح مقنّع: كم رقمًا كاملًا يطابقه (لكشف التداخل)
  const matchCount = new Map<string, number>();
  const phoneToKey = new Map<string, string>();
  for (const phone of phones) {
    const digits = phone.replace(/\D/g, "");
    if (digits.length < 6) continue;
    for (const cand of candidatesOf(digits)) {
      if (ci.index.has(cand)) {
        matchCount.set(cand, (matchCount.get(cand) ?? 0) + 1);
        phoneToKey.set(phone, cand);
        break; // أول تطابق (أقصر رمز دولة) يكفي
      }
    }
  }
  const userClients: Record<string, { connected: boolean | null; exact: boolean }> = {};
  let collisions = 0;
  for (const phone of phones) {
    const key = phoneToKey.get(phone);
    if (!key) {
      userClients[phone] = { connected: null, exact: false }; // لا عميل لهذا الرقم إطلاقًا
      continue;
    }
    const shared = (matchCount.get(key) ?? 1) > 1;
    if (shared) collisions += 1;
    userClients[phone] = { connected: ci.index.get(key) ?? null, exact: !shared };
  }
  return { userClients, collisions };
}

export async function GET() {
  const now = Date.now();
  const cacheOk = g.__fleetCache && now - g.__fleetCache.ts < 10000 && g.__fleetCache.payload;

  if (!cacheOk) {
    const payload: Record<string, unknown> = {};
    payload.fetchedAt = new Date().toISOString();

    const supaHeaders = SUPA_BASE && SUPA_KEY ? { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` } : undefined;

    // ── كل المصادر بالتوازي (لا انتظار تسلسلي) ──
    const [wd, ld, ltd, md, sd, fd, dc, rd] = await Promise.all([
      supaHeaders
        ? jget(`${SUPA_BASE}/rest/v1/watchers?select=phone,role,is_active,display_name,health_score&limit=200`, 12000, supaHeaders)
        : Promise.resolve(null),
      supaHeaders
        ? jget(`${SUPA_BASE}/rest/v1/links?select=id,link,link_type,group_name,sender_name,ai_country,ai_is_ad,created_at&order=created_at.desc&limit=12`, 12000, supaHeaders)
        : Promise.resolve(null),
      supaHeaders
        ? jget(`${SUPA_BASE}/rest/v1/links?select=id&limit=1`, 10000, supaHeaders)
        : Promise.resolve(null),
      jget(`${SERVICE_URL}/api/monitored_chats`, 25000),
      jget(`${SERVICE_URL}/api/stats`, 14000),
      jget(`${SERVICE_URL}/api/filter_stats`, 14000),
      jget(`${SERVICE_URL}/api/deploy_check`, 16000),
      jget(`${SERVICE_URL}/ready`, 14000),
    ]);

    // (1) watchers
    if (wd && wd.status === 200 && Array.isArray(wd.json)) {
      const rows = wd.json as { phone: string; role: string; is_active: boolean; display_name: string | null; health_score?: number | null }[];
      payload.watchers = rows
        .filter((r) => typeof r.phone === "string" && r.phone.startsWith("+"))
        .map((r) => ({ phone: r.phone, role: r.role, isActive: !!r.is_active, displayName: r.display_name, healthScore: r.health_score ?? null }));
      payload.supabase = "ready";
    } else {
      payload.supabase = wd ? "error" : "unreachable";
    }

    // (2) أحدث روابط الأرشيف
    if (ld && ld.status === 200 && Array.isArray(ld.json)) {
      const rows = ld.json as { id: number; link: string; link_type: string | null; group_name: string | null; sender_name: string | null; ai_country: string | null; ai_is_ad: boolean | null; created_at: string | null }[];
      payload.recentLinks = rows.map((r) => ({
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

    // العدد الكلي عبر رأس Content-Range
    if (ltd && ltd.status === 200) {
      // Prefer: count=exact يُرجع العدد في content-range — جلبناه بدون الهيدر
      // لأن jget لا يمرر سوى json؛ نجلب العدد من مسار أخف:
    }
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 10000);
      const res = await fetch(`${SUPA_BASE}/rest/v1/links?select=id&limit=1`, {
        headers: supaHeaders ? { ...supaHeaders, Prefer: "count=exact" } : undefined,
        cache: "no-store",
        signal: ctrl.signal,
      });
      clearTimeout(t);
      const range = res.headers.get("content-range"); // "0-0/27602"
      if (range) {
        const total = Number(range.split("/")[1]);
        if (Number.isFinite(total)) payload.linksTotal = total;
      }
    } catch {
      /* العدد تحسيني */
    }

    // (3) التغطية الحية لكل حساب
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
      const monitored: MonitoredSnapshot = {
        total: chats.length,
        awake: true,
        perPhone,
        recentGroups: recent.slice(0, 40),
        fetchedAt: new Date().toISOString(),
      };
      payload.monitored = monitored;
    } else {
      // البوت نائم/غير متاح — لا لقطة سابقة داخل هذا الجيل الجديد من الكاش
      payload.monitored = null;
    }

    // (4) الأرقام الإجمالية
    if (sd && sd.status === 200) {
      const sj = sd.json as Record<string, unknown> | null;
      payload.stats = {
        connectedAccounts: (sj?.connected_accounts as number) ?? null,
        activeWatchers: (sj?.active_watchers as number) ?? null,
        totalLinks: (sj?.total_links as number) ?? null,
        botConnected: (sj?.bot_connected as boolean) ?? null,
      };
      payload.serviceAwake = true;
    } else {
      payload.stats = null;
      payload.serviceAwake = false;
    }

    // (5) الطلبات المنشورة
    if (fd && fd.status === 200) {
      const fj = fd.json as { db_stats?: { total?: number; accepts?: number; rejects?: number } } | null;
      const dbs = fj?.db_stats || {};
      payload.filter = {
        seen: dbs.total ?? null,
        accepted: dbs.accepts ?? null,
        rejected: dbs.rejects ?? null,
      };
    }

    // (6) حالة الاتصال الفعلية لكل حساب (deploy_check)
    if (dc && dc.status === 200) {
      const dj = dc.json as
        | {
            python_version?: string;
            telegram?: { user_clients?: Record<string, unknown> } | null;
          }
        | null;
      const uc = dj?.telegram?.user_clients ?? null;
      const phones = Array.isArray(payload.watchers)
        ? (payload.watchers as { phone: string }[]).map((w) => w.phone)
        : [];
      if (uc && phones.length) {
        const ci = buildClientIndex(uc);
        const { userClients, collisions } = resolveClients(phones, ci);
        payload.userClients = userClients;
        payload.clientsInfo = { total: ci.maskedCount, connected: ci.connectedCount, collisions };
      }
      payload.python = dj?.python_version ?? null;
    }

    // (7) الإصدار الحي
    if (rd && rd.status === 200) {
      const rj = rd.json as { git_commit?: string } | null;
      payload.gitCommit = rj?.git_commit ?? null;
    }

    g.__fleetCache = { ts: now, payload };
  }

  return NextResponse.json(g.__fleetCache?.payload ?? { fetchedAt: new Date().toISOString(), monitored: null, serviceAwake: false });
}
