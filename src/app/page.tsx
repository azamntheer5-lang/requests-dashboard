"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  Activity,
  ArrowLeft,
  BadgeCheck,
  CheckCircle2,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  GitBranch,
  Globe2,
  Hash,
  HelpCircle,
  KeyRound,
  Link2,
  Loader2,
  Lock,
  LockOpen,
  MessageCircle,
  Phone,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  Users,
  Wifi,
  WifiOff,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

// ============================================================
// الأنواع — عقود واجهات الـAPI
// ============================================================

type FleetWatcher = {
  phone: string;
  role: string;
  isActive: boolean;
  displayName: string | null;
  healthScore: number | null;
};

type RecentLink = {
  id: number;
  link: string;
  type: string;
  group: string;
  sender: string;
  country: string;
  isAd: boolean | null;
  at: string;
};

type FleetData = {
  fetchedAt: string;
  supabase?: string;
  watchers?: FleetWatcher[];
  recentLinks?: RecentLink[];
  linksTotal?: number;
  filter?: { seen: number | null; accepted: number | null; rejected: number | null };
  monitored?: {
    total: number;
    awake: boolean;
    perPhone: Record<string, { reader: number; discovered: number }>;
    recentGroups: { chatId: number; title: string; username: string; by: string; at: string; readers: number }[];
    fetchedAt: string;
  } | null;
  stats?: {
    connectedAccounts: number | null;
    activeWatchers: number | null;
    totalLinks: number | null;
    botConnected: boolean | null;
  } | null;
  serviceAwake?: boolean;
  userClients?: Record<string, { connected: boolean | null; exact: boolean }>;
  clientsInfo?: { total: number; connected: number; collisions: number };
  gitCommit?: string | null;
  python?: string | null;
};

type JoinStatus = {
  ok: boolean;
  serviceReachable: boolean;
  totals?: { code_requests: number; instant_joins: number; otp_joins: number; groups_added: number };
};

type JoinStartResult = {
  ok: boolean;
  status: string;
  instant?: boolean;
  name?: string;
  channel_link?: string;
  channel_note?: string;
  wait?: number;
  error?: string;
};

type JoinVerifyResult = {
  ok: boolean;
  status: string;
  instant?: boolean;
  name?: string;
  groups_added?: number;
  channel_link?: string;
  wait?: number;
  error?: string;
};

// ============================================================
// أدوات مساعدة
// ============================================================

const UNLOCK_KEY = "wabot_dash_unlocked_v1";
const UNLOCK_EVENT = "wabot_unlock_change";

// حالة القفل من sessionStorage عبر useSyncExternalStore — النمط الصحيح
// لمزامنة مصدر خارجي (بلا setState داخل effect وبلا عدم تطابق Hydration).
function subscribeUnlock(cb: () => void) {
  window.addEventListener(UNLOCK_EVENT, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(UNLOCK_EVENT, cb);
    window.removeEventListener("storage", cb);
  };
}
function getUnlockSnapshot(): boolean {
  try {
    return sessionStorage.getItem(UNLOCK_KEY) === "1";
  } catch {
    return false;
  }
}
function setUnlockStore(v: boolean) {
  try {
    if (v) sessionStorage.setItem(UNLOCK_KEY, "1");
    else sessionStorage.removeItem(UNLOCK_KEY);
  } catch {
    /* خصوصية المتصفح */
  }
  window.dispatchEvent(new Event(UNLOCK_EVENT));
}

function timeAgo(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return "قبل لحظات";
  const m = Math.floor(s / 60);
  if (m < 60) return `قبل ${m} دقيقة`;
  const h = Math.floor(m / 60);
  if (h < 24) return `قبل ${h} ساعة`;
  return `قبل ${Math.floor(h / 24)} يوم`;
}

function fmt(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US");
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// ============================================================
// عرض التسجيل العام — ما يراه أي أحد يفتح الرابط
// ============================================================

const COUNTRIES = [
  { code: "YE", label: "اليمن", flag: "🇾🇪", dial: "+967", len: 9, ph: "7XXXXXXXX" },
  { code: "SA", label: "السعودية", flag: "🇸🇦", dial: "+966", len: 9, ph: "5XXXXXXXX" },
] as const;

function PublicRegistration({ onOpenLock }: { onOpenLock: () => void }) {
  const [country, setCountry] = useState<(typeof COUNTRIES)[number]["code"]>("YE");
  const [phoneTail, setPhoneTail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [step, setStep] = useState<"phone" | "code" | "password" | "done">("phone");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ kind: "err" | "info"; text: string } | null>(null);
  const [doneInfo, setDoneInfo] = useState<{ groups: number; instant: boolean; name: string; channel: string } | null>(null);

  const c = COUNTRIES.find((x) => x.code === country)!;
  const fullPhone = c.dial + phoneTail.replace(/\D/g, "");

  const mapStartError = (r: JoinStartResult): string => {
    switch (r.status) {
      case "bad_phone":
        return "الرقم غير صحيح — تأكد من كتابته كاملًا بدون رمز الدولة";
      case "ip_limited":
        return "محاولات كثيرة من نفس الجهاز — انتظر قليلًا ثم أعد المحاولة";
      case "phone_limited":
        return "طلبت كودًا لهذا الرقم عدة مرات — انتظر قبل طلب كود جديد";
      case "busy":
        return "يوجد عدد كبير من طلبات الانضمام الآن — جرّب بعد دقائق";
      case "flood":
        return `تيليجرام طلب الانتظار ${r.wait ?? 60} ثانية قبل طلب كود جديد`;
      case "send_failed":
        return `تعذر إرسال الكود: ${r.error || "خطأ من تيليجرام"}`;
      case "unreachable":
        return r.error || "الخدمة نائمة الآن — جرّب بعد لحظات";
      default:
        return "حدث خطأ غير متوقع — أعد المحاولة";
    }
  };

  const submitPhone = async () => {
    if (phoneTail.replace(/\D/g, "").length < 8) {
      setNote({ kind: "err", text: `اكتب رقم الجوال كاملًا (${c.len} أرقام بدون ${c.dial})` });
      return;
    }
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch("/api/join/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: fullPhone }),
      });
      const r = (await res.json()) as JoinStartResult;
      if (r.ok && r.status === "joined") {
        setDoneInfo({ groups: 0, instant: true, name: r.name || "", channel: r.channel_link || "" });
        setStep("done");
        toast.success("تم ضمك للقناة فورًا — أهلًا بك!");
      } else if (r.ok && r.status === "code_sent") {
        setStep("code");
        setNote({ kind: "info", text: "أرسلنا كود تيليجرام إلى تطبيق تيليجرام على جوالك — افتحه وانسخ الكود" });
      } else {
        setNote({ kind: "err", text: mapStartError(r) });
      }
    } catch {
      setNote({ kind: "err", text: "تعذر الاتصال — تحقق من الشبكة وأعد المحاولة" });
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async (withPassword = false) => {
    if (!withPassword && code.replace(/\D/g, "").length < 4) {
      setNote({ kind: "err", text: "اكتب كود تيليجرام الذي وصلك" });
      return;
    }
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch("/api/join/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: fullPhone, code, password: withPassword ? password : "" }),
      });
      const r = (await res.json()) as JoinVerifyResult;
      if (r.ok && r.status === "joined") {
        setDoneInfo({ groups: r.groups_added ?? 0, instant: false, name: r.name || "", channel: r.channel_link || "" });
        setStep("done");
        toast.success(`تم ضمك للقناة! ${r.groups_added ? `ووصلت ${r.groups_added} مجموعة للمراقبة` : ""}`);
      } else if (r.status === "need_password") {
        setStep("password");
        setNote({ kind: "info", text: "حسابك محمي بكلمة سر تيليجرام (2FA) — اكتبها لإكمال الدخول" });
      } else if (r.status === "bad_code") {
        setNote({ kind: "err", text: "الكود غير صحيح — تأكد من نسخه من تطبيق تيليجرام" });
      } else if (r.status === "bad_password") {
        setNote({ kind: "err", text: "كلمة السر غير صحيحة" });
      } else if (r.status === "expired") {
        setStep("phone");
        setCode("");
        setNote({ kind: "err", text: "انتهت صلاحية الكود — اطلب كودًا جديدًا" });
      } else if (r.status === "flood") {
        setNote({ kind: "err", text: `تيليجرام طلب الانتظار ${r.wait ?? 60} ثانية` });
      } else if (r.status === "no_session") {
        setStep("phone");
        setNote({ kind: "err", text: "انتهت الجلسة — اطلب كودًا جديدًا" });
      } else if (r.status === "too_many_tries") {
        setStep("phone");
        setNote({ kind: "err", text: "محاولات خاطئة كثيرة — ابدأ من جديد بطلب كود جديد" });
      } else {
        setNote({ kind: "err", text: r.error || "تعذر إكمال الانضمام — أعد المحاولة" });
      }
    } catch {
      setNote({ kind: "err", text: "تعذر الاتصال — تحقق من الشبكة وأعد المحاولة" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col bg-zinc-950 text-zinc-100">
      {/* ترويسة خفيفة */}
      <header className="border-b border-zinc-800/60 bg-zinc-950/90 backdrop-blur">
        <div className="mx-auto flex max-w-lg items-center justify-between px-4 py-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-950 text-emerald-400 ring-1 ring-emerald-900">
              <Send className="h-5 w-5" />
            </div>
            <div>
              <p className="text-base font-extrabold leading-tight">قناة الطلبات</p>
              <p className="text-xs text-zinc-500">كل طلبات الطلبة في مكان واحد</p>
            </div>
          </div>
          <Badge variant="outline" className="border-emerald-900 bg-emerald-950 text-emerald-400">
            <ShieldCheck className="ml-1 h-3.5 w-3.5" />
            رسمي
          </Badge>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-lg flex-1 flex-col justify-center px-4 py-8">
        {step !== "done" && (
          <div className="mb-5 text-center">
            <h1 className="text-2xl font-extrabold tracking-tight sm:text-3xl">انضم إلى قناة الطلبات</h1>
            <p className="mt-2 text-sm leading-6 text-zinc-400">
              سجّل رقمك — الحسابات المراقبة تنضم فورًا بلا كود، والرقم الجديد يستقبل كود تيليجرام
              ثم يتحول للقناة مباشرة وتُضم مجموعاته للمراقبة.
            </p>
          </div>
        )}

        <Card className="border-zinc-800 bg-zinc-900/50 shadow-xl shadow-black/20">
          <CardContent className="p-5 sm:p-6">
            {step === "phone" && (
              <div className="space-y-4">
                <div>
                  <Label className="mb-2 block text-sm font-bold">اختر الدولة</Label>
                  <div className="grid grid-cols-2 gap-2">
                    {COUNTRIES.map((x) => (
                      <button
                        key={x.code}
                        type="button"
                        onClick={() => {
                          setCountry(x.code);
                          setPhoneTail("");
                          setNote(null);
                        }}
                        className={cn(
                          "flex items-center justify-center gap-2 rounded-xl border px-3 py-3 text-sm font-bold transition",
                          country === x.code
                            ? "border-emerald-700 bg-emerald-950/60 text-emerald-300 ring-1 ring-emerald-800"
                            : "border-zinc-800 bg-black/30 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200",
                        )}
                        aria-pressed={country === x.code}
                      >
                        <span className="text-lg" aria-hidden>
                          {x.flag}
                        </span>
                        {x.label}
                        <span dir="ltr" className="font-mono text-xs opacity-70">
                          {x.dial}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <Label htmlFor="phone" className="mb-2 block text-sm font-bold">
                    رقم الجوال (تيليجرام)
                  </Label>
                  <div className="flex items-stretch gap-2" dir="ltr">
                    <span className="flex min-w-16 items-center justify-center rounded-lg border border-zinc-800 bg-black/40 px-3 font-mono text-sm text-emerald-300">
                      {c.dial}
                    </span>
                    <Input
                      id="phone"
                      inputMode="numeric"
                      autoComplete="tel-national"
                      dir="ltr"
                      placeholder={c.ph}
                      value={phoneTail}
                      onChange={(e) => setPhoneTail(e.target.value.replace(/\D/g, "").slice(0, c.len))}
                      onKeyDown={(e) => e.key === "Enter" && !busy && submitPhone()}
                      className="h-12 border-zinc-800 bg-black/40 text-left font-mono text-base tracking-wider"
                    />
                  </div>
                </div>

                {note && (
                  <p
                    role="status"
                    className={cn(
                      "rounded-lg border px-3 py-2 text-sm leading-6",
                      note.kind === "err"
                        ? "border-red-900/70 bg-red-950/40 text-red-300"
                        : "border-emerald-900/60 bg-emerald-950/30 text-emerald-300",
                    )}
                  >
                    {note.text}
                  </p>
                )}

                <Button
                  onClick={submitPhone}
                  disabled={busy}
                  className="h-12 w-full gap-2 bg-emerald-700 text-base font-bold text-white hover:bg-emerald-600"
                >
                  {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <Zap className="h-5 w-5" />}
                  {busy ? "جارٍ المعالجة…" : "انضم الآن"}
                </Button>

                <p className="text-center text-xs leading-5 text-zinc-600">
                  بالتسجيل أنت توافق على ضم مجموعاتك الدراسية لقائمة المراقبة لالتقاط الطلبات
                  ونشرها في القناة.
                </p>
              </div>
            )}

            {step === "code" && (
              <div className="space-y-4">
                <div className="text-center">
                  <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-emerald-950 text-emerald-400 ring-1 ring-emerald-900">
                    <KeyRound className="h-6 w-6" />
                  </div>
                  <p className="text-base font-extrabold">أدخل كود تيليجرام</p>
                  <p dir="ltr" className="mt-1 font-mono text-sm text-zinc-400">
                    {fullPhone}
                  </p>
                </div>
                <div className="flex justify-center" dir="ltr">
                  <InputOTP maxLength={5} value={code} onChange={setCode} autoFocus>
                    <InputOTPGroup>
                      {[0, 1, 2, 3, 4].map((i) => (
                        <InputOTPSlot key={i} index={i} className="h-12 w-10 border-zinc-700 bg-black/40 text-lg" />
                      ))}
                    </InputOTPGroup>
                  </InputOTP>
                </div>
                {note && (
                  <p
                    role="status"
                    className={cn(
                      "rounded-lg border px-3 py-2 text-center text-sm leading-6",
                      note.kind === "err"
                        ? "border-red-900/70 bg-red-950/40 text-red-300"
                        : "border-emerald-900/60 bg-emerald-950/30 text-emerald-300",
                    )}
                  >
                    {note.text}
                  </p>
                )}
                <Button
                  onClick={() => submitCode(false)}
                  disabled={busy}
                  className="h-12 w-full gap-2 bg-emerald-700 text-base font-bold text-white hover:bg-emerald-600"
                >
                  {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <BadgeCheck className="h-5 w-5" />}
                  {busy ? "جارٍ التحقق…" : "تحقق وانضم"}
                </Button>
                <button
                  type="button"
                  onClick={() => {
                    setStep("phone");
                    setCode("");
                    setNote(null);
                  }}
                  className="mx-auto flex items-center gap-1 text-sm text-zinc-500 transition hover:text-zinc-300"
                >
                  <ArrowLeft className="h-4 w-4" />
                  تغيير الرقم
                </button>
              </div>
            )}

            {step === "password" && (
              <div className="space-y-4">
                <div className="text-center">
                  <p className="text-base font-extrabold">كلمة سر تيليجرام (2FA)</p>
                  <p className="mt-1 text-sm text-zinc-400">حسابك محمي بالتحقق بخطوتين — اكتب كلمة السر</p>
                </div>
                <div className="relative">
                  <Input
                    type={showPw ? "text" : "password"}
                    dir="ltr"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && !busy && submitCode(true)}
                    placeholder="••••••••"
                    autoFocus
                    className="h-12 border-zinc-800 bg-black/40 text-left"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPw((v) => !v)}
                    className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
                    aria-label={showPw ? "إخفاء كلمة السر" : "إظهار كلمة السر"}
                  >
                    {showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                {note && (
                  <p
                    role="status"
                    className={cn(
                      "rounded-lg border px-3 py-2 text-sm leading-6",
                      note.kind === "err"
                        ? "border-red-900/70 bg-red-950/40 text-red-300"
                        : "border-emerald-900/60 bg-emerald-950/30 text-emerald-300",
                    )}
                  >
                    {note.text}
                  </p>
                )}
                <Button
                  onClick={() => submitCode(true)}
                  disabled={busy}
                  className="h-12 w-full gap-2 bg-emerald-700 text-base font-bold text-white hover:bg-emerald-600"
                >
                  {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <ShieldCheck className="h-5 w-5" />}
                  {busy ? "جارٍ التحقق…" : "إكمال الانضمام"}
                </Button>
              </div>
            )}

            {step === "done" && doneInfo && (
              <div className="space-y-4 text-center">
                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-emerald-950 text-emerald-400 ring-2 ring-emerald-800">
                  <CheckCircle2 className="h-9 w-9" />
                </div>
                <div>
                  <p className="text-xl font-extrabold">تم ضمك للقناة!</p>
                  {doneInfo.name && <p className="mt-1 text-sm text-zinc-400">أهلًا {doneInfo.name} 🌹</p>}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-xl border border-emerald-900/60 bg-emerald-950/20 p-3">
                    <p className="text-2xl font-extrabold text-emerald-400">{doneInfo.instant ? "فوري" : "بالكود"}</p>
                    <p className="mt-0.5 text-xs text-zinc-400">طريقة الانضمام</p>
                  </div>
                  <div className="rounded-xl border border-zinc-800 bg-black/30 p-3">
                    <p className="text-2xl font-extrabold text-emerald-400">{doneInfo.groups}</p>
                    <p className="mt-0.5 text-xs text-zinc-400">مجموعة وصلت للمراقبة</p>
                  </div>
                </div>
                {doneInfo.channel ? (
                  <Button
                    asChild
                    className="h-12 w-full gap-2 bg-emerald-700 text-base font-bold text-white hover:bg-emerald-600"
                  >
                    <a href={doneInfo.channel} target="_blank" rel="noreferrer">
                      <Send className="h-5 w-5" />
                      افتح تيليجرام — ادخل القناة
                    </a>
                  </Button>
                ) : (
                  <div className="rounded-xl border border-amber-900/60 bg-amber-950/20 p-3 text-center text-xs leading-5 text-amber-300">
                    تم تجهيز حسابك — سيصلك رابط القناة في تيليجرام تلقائيًا، أو تواصل مع الإدارة ليرسله لك مباشرة.
                  </div>
                )}
                <p className="text-xs leading-5 text-zinc-500">
                  {doneInfo.channel
                    ? "اضغط الزر ليفتح تيليجرام صفحة القناة — اضغط انضمام وستجد كل طلب جديد يصلك فورًا مع زر مراسلة صاحب الطلب."
                    : "افتح تطبيق تيليجرام — ستجد القناة في قنواتك، وكل طلب جديد يصلك فورًا مع زر مراسلة صاحب الطلب."}
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* شرح مبسط */}
        {step !== "done" && (
          <div className="mt-6 grid grid-cols-1 gap-2 sm:grid-cols-3">
            {[
              { icon: Zap, t: "انضمام فوري", d: "الحسابات المراقبة تدخل بلا كود" },
              { icon: MessageCircle, t: "كود تيليجرام", d: "الرقم الجديد يتحقق بكود واحد" },
              { icon: Hash, t: "مجموعاتك تُراقب", d: "تُضم تلقائيًا لالتقاط الطلبات" },
            ].map((f) => (
              <div key={f.t} className="rounded-xl border border-zinc-800/70 bg-zinc-900/30 p-3 text-center">
                <f.icon className="mx-auto mb-1.5 h-5 w-5 text-emerald-500" />
                <p className="text-sm font-bold text-zinc-200">{f.t}</p>
                <p className="mt-0.5 text-xs leading-5 text-zinc-500">{f.d}</p>
              </div>
            ))}
          </div>
        )}
      </main>

      {/* التذييل — فيه القفل */}
      <footer className="mt-auto border-t border-zinc-800/60 bg-zinc-950/90 backdrop-blur">
        <div className="mx-auto flex max-w-lg items-center justify-between px-4 py-4 text-xs text-zinc-600">
          <span className="flex items-center gap-1.5">
            <Send className="h-3.5 w-3.5 text-emerald-700" />
            قناة الطلبات — التسجيل العام
          </span>
          <button
            type="button"
            onClick={onOpenLock}
            className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-zinc-600 transition hover:bg-zinc-900 hover:text-zinc-300"
            aria-label="لوحة التحكم — للمشرف"
            title="لوحة التحكم"
          >
            <Lock className="h-3.5 w-3.5" />
            الواجهة
          </button>
        </div>
      </footer>
    </div>
  );
}

// ============================================================
// حوار القفل — رمز 8 خانات
// ============================================================

function LockDialog({
  open,
  onOpenChange,
  onUnlocked,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onUnlocked: () => void;
}) {
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(false);

  useEffect(() => {
    if (open) {
      setPin("");
      setErr(false);
      setBusy(false);
    }
  }, [open]);

  const verify = async (value?: string) => {
    const p = (value ?? pin).trim();
    if (p.length < 8 || busy) return;
    setBusy(true);
    setErr(false);
    try {
      const res = await fetch("/api/unlock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: p }),
      });
      const r = (await res.json()) as { ok: boolean };
      if (r.ok) {
        setUnlockStore(true);
        onOpenChange(false);
        toast.success("مرحبًا بك في لوحة التحكم");
      } else {
        setErr(true);
        setPin("");
      }
    } catch {
      setErr(true);
      setPin("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm border-zinc-800 bg-zinc-950 sm:max-w-md" dir="rtl">
        <DialogHeader className="items-center text-center">
          <div className="mx-auto mb-1 flex h-14 w-14 items-center justify-center rounded-2xl bg-zinc-900 text-emerald-400 ring-1 ring-zinc-800">
            <Lock className="h-7 w-7" />
          </div>
          <DialogTitle className="text-lg font-extrabold">منطقة المشرف</DialogTitle>
          <DialogDescription>أدخل رمز الوصول المكوّن من 8 أرقام لفتح لوحة التحكم</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col items-center gap-3 py-2">
          <div dir="ltr" className={cn("transition", err && "animate-in shake duration-300")}>
            <InputOTP
              maxLength={8}
              value={pin}
              onChange={(v) => {
                setPin(v);
                setErr(false);
                if (v.length === 8) verify(v);
              }}
              autoFocus
            >
              <InputOTPGroup>
                {[0, 1, 2, 3].map((i) => (
                  <InputOTPSlot
                    key={i}
                    index={i}
                    className={cn("h-12 w-10 border-zinc-700 bg-black/50 text-lg", err && "border-red-800")}
                  />
                ))}
              </InputOTPGroup>
              <span className="px-1 text-zinc-700">·</span>
              <InputOTPGroup>
                {[4, 5, 6, 7].map((i) => (
                  <InputOTPSlot
                    key={i}
                    index={i}
                    className={cn("h-12 w-10 border-zinc-700 bg-black/50 text-lg", err && "border-red-800")}
                  />
                ))}
              </InputOTPGroup>
            </InputOTP>
          </div>
          {err && <p className="text-sm font-bold text-red-400">الرمز غير صحيح — حاول مرة أخرى</p>}
          <Button
            onClick={() => verify()}
            disabled={busy || pin.length < 8}
            className="h-11 w-full max-w-64 gap-2 bg-emerald-700 font-bold text-white hover:bg-emerald-600"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <LockOpen className="h-4 w-4" />}
            {busy ? "جارٍ التحقق…" : "فتح اللوحة"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================
// مكونات فاخرة صغيرة
// ============================================================

// حلقة تقدم SVG — نسبة الحسابات المتصلة
function Ring({ value, max, label }: { value: number; max: number; label: string }) {
  const size = 74;
  const r = (size - 10) / 2;
  const c = 2 * Math.PI * r;
  const pct = max > 0 ? Math.min(1, value / max) : 0;
  return (
    <div className="relative shrink-0" role="img" aria-label={label}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="6.5" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="url(#ringGrad)"
          strokeWidth="6.5"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - pct)}
          className="transition-all duration-1000 ease-out"
        />
        <defs>
          <linearGradient id="ringGrad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#6ee7b7" />
            <stop offset="100%" stopColor="#34d399" />
          </linearGradient>
        </defs>
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-base font-extrabold leading-none text-emerald-300">{value}</span>
        <span className="text-[10px] font-bold text-zinc-500">/ {max}</span>
      </div>
    </div>
  );
}

// شريط بياني مصغّر — اكتشافات آخر 24 ساعة (12 دلو × ساعتين)
function MiniHisto({ buckets }: { buckets: number[] }) {
  const max = Math.max(1, ...buckets);
  return (
    <div className="flex h-10 items-end gap-[3px]" dir="rtl" aria-label="مواليد المجموعات خلال 24 ساعة">
      {buckets.map((n, i) => (
        <div
          key={i}
          title={`قبل ${24 - i * 2}-${24 - i * 2 - 2} ساعة: ${n} مجموعة`}
          className={cn(
            "flex-1 rounded-sm transition-all duration-700",
            i === 0 ? "bg-gradient-to-t from-emerald-700 to-emerald-400" : "bg-emerald-800/60",
          )}
          style={{ height: `${Math.max(8, (n / max) * 100)}%` }}
        />
      ))}
    </div>
  );
}

// بطاقة إحصاء فاخرة
function LuxStat({
  icon,
  title,
  value,
  sub,
  delay,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  value: React.ReactNode;
  sub: React.ReactNode;
  delay: string;
  children?: React.ReactNode;
}) {
  return (
    <div className={cn("lux-card lux-in p-4", delay)}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-bold text-zinc-400">{title}</p>
          <p className="mt-1 truncate text-3xl font-black tracking-tight text-emerald-300">{value}</p>
        </div>
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-emerald-950/70 text-emerald-400 ring-1 ring-emerald-900/70">
          {icon}
        </div>
      </div>
      <div className="mt-1.5 text-xs leading-5 text-zinc-500">{sub}</div>
      {children}
    </div>
  );
}

// ============================================================
// لوحة التحكم — غرفة العمليات الفاخرة
// ============================================================

function FleetDashboard({ onRelock }: { onRelock: () => void }) {
  const [data, setData] = useState<FleetData | null>(null);
  const [join, setJoin] = useState<JoinStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [bumped, setBumped] = useState<Record<string, number>>({});
  const [query, setQuery] = useState("");
  const prevRef = useRef<{ perPhone?: Record<string, { reader: number }>; total?: number }>({});

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [r1, r2] = await Promise.all([
        fetch("/api/fleet-data", { cache: "no-store" }),
        fetch("/api/join-status", { cache: "no-store" }).catch(() => null),
      ]);
      if (r1.ok) {
        const d = (await r1.json()) as FleetData;
        // كشف التغييرات اللحظية: مقارنة مع اللقطة السابقة
        const prev = prevRef.current;
        const per = d.monitored?.perPhone;
        if (per && prev.perPhone) {
          const bumps: Record<string, number> = {};
          let anyNewGroup = false;
          for (const [phone, c] of Object.entries(per)) {
            const old = prev.perPhone[phone]?.reader;
            if (old !== undefined && c.reader > old) {
              bumps[phone] = c.reader - old;
              anyNewGroup = true;
            }
          }
          if (d.monitored && prev.total !== undefined && d.monitored.total > prev.total) {
            toast.success(`مجموعة جديدة تحت المراقبة! (+${d.monitored.total - prev.total})`, {
              description: "اكتشفها أحد الحسابات المراقبة للتو",
            });
          } else if (anyNewGroup) {
            const names = Object.entries(bumps).map(([p, n]) => `${p}: +${n}`).join(" · ");
            toast.info("توسّعت تغطية المراقبة", { description: names });
          }
          if (Object.keys(bumps).length) {
            setBumped(bumps);
            setTimeout(() => setBumped({}), 7000);
          }
        }
        prevRef.current = {
          perPhone: per ? Object.fromEntries(Object.entries(per).map(([k, v]) => [k, { reader: v.reader }])) : undefined,
          total: d.monitored?.total,
        };
        setData(d);
      }
      if (r2 && r2.ok) setJoin((await r2.json()) as JoinStatus);
    } catch {
      /* يُعاد تلقائيًا */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
    const t = setInterval(fetchAll, 12000);
    return () => clearInterval(t);
  }, [fetchAll]);

  // ── المشتقات ──
  const watchers = useMemo(() => data?.watchers ?? [], [data]);
  const perPhone = data?.monitored?.perPhone ?? {};
  const userClients = data?.userClients ?? null;
  const monitors = useMemo(() => watchers.filter((w) => w.role === "monitor"), [watchers]);
  const joiners = useMemo(() => watchers.filter((w) => w.role === "joiner"), [watchers]);
  const awake = !!data?.serviceAwake;

  // حالة الاتصال الحقيقية لكل حساب (من deploy_check عبر الرقم المقنّع)
  const connOf = useCallback(
    (phone: string): { connected: boolean | null; exact: boolean } | null => {
      if (!userClients) return null;
      return userClients[phone] ?? { connected: null, exact: false };
    },
    [userClients],
  );

  const connectedCount = monitors.filter((w) => connOf(w.phone)?.connected === true).length;
  const offlineCount = monitors.filter((w) => connOf(w.phone)?.connected === false).length;
  const unknownConn = monitors.length - connectedCount - offlineCount;
  const newToday = data?.monitored?.recentGroups?.length ?? 0;
  const joinTotal = (join?.totals?.instant_joins ?? 0) + (join?.totals?.otp_joins ?? 0);

  // هيستوغرام الاكتشافات: 12 دلو × ساعتين (الفهرس 0 = الأحدث)
  const histo = useMemo(() => {
    const buckets = new Array(12).fill(0);
    const now = Date.now();
    for (const g of data?.monitored?.recentGroups ?? []) {
      const t = Date.parse(g.at);
      if (!Number.isFinite(t)) continue;
      const hoursAgo = (now - t) / 3600000;
      if (hoursAgo >= 0 && hoursAgo < 24) buckets[Math.min(11, Math.floor(hoursAgo / 2))] += 1;
    }
    return buckets;
  }, [data?.monitored?.recentGroups]);

  // الترتيب: المتصل أولًا ثم الأكثر قراءة
  const sorted = useMemo(
    () =>
      monitors
        .slice()
        .sort((a, b) => {
          const ca = connOf(a.phone)?.connected;
          const cb = connOf(b.phone)?.connected;
          const sa = ca === true ? 2 : ca === false ? 0 : 1;
          const sb = cb === true ? 2 : cb === false ? 0 : 1;
          if (sa !== sb) return sb - sa;
          return (perPhone[b.phone]?.reader ?? 0) - (perPhone[a.phone]?.reader ?? 0) || Number(b.isActive) - Number(a.isActive);
        }),
    [monitors, perPhone, connOf],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter(
      (w) => (w.displayName || "").toLowerCase().includes(q) || w.phone.replace(/\D/g, "").includes(q.replace(/\D/g, "")),
    );
  }, [sorted, query]);

  return (
    <div className="flex min-h-screen flex-col bg-zinc-950 text-zinc-100">
      {/* الترويسة اللاصقة */}
      <header className="sticky top-0 z-30 border-b border-white/5 bg-zinc-950/85 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="relative flex h-11 w-11 items-center justify-center rounded-2xl bg-emerald-950/80 text-emerald-400 ring-1 ring-emerald-800/70 lux-glow">
              <Activity className="h-5 w-5" />
              {awake && <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-emerald-400 lux-pulse" />}
            </div>
            <div>
              <h1 className="text-lg font-black tracking-tight sm:text-xl">
                غرفة <span className="lux-grad-text">عمليات المراقبة</span>
              </h1>
              <p className="flex items-center gap-1.5 text-xs text-zinc-500">
                <span className="inline-block h-1 w-1 rounded-full bg-emerald-500" />
                بيانات حية من البوت وسوبابس · تحديث كل 12 ثانية
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {data?.gitCommit && (
              <Badge variant="outline" className="gap-1 border-zinc-800 bg-black/40 font-mono text-[11px] text-zinc-400">
                <GitBranch className="h-3 w-3 text-emerald-600" />
                {data.gitCommit.slice(0, 7)}
              </Badge>
            )}
            <Badge
              variant="outline"
              className={cn(
                "gap-1",
                awake
                  ? "border-emerald-800 bg-emerald-950 text-emerald-400"
                  : "border-amber-800 bg-amber-950 text-amber-400",
              )}
            >
              <span className={cn("h-2 w-2 rounded-full", awake ? "animate-pulse bg-emerald-500" : "bg-amber-500")} />
              {awake ? "البوت متصل" : "البوت نائم"}
            </Badge>
            <Button variant="outline" size="sm" onClick={fetchAll} disabled={loading} className="gap-1.5">
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              تحديث
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={onRelock}
              className="gap-1.5 border-zinc-800 text-zinc-400 hover:text-zinc-200"
            >
              <Lock className="h-4 w-4" />
              قفل
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 space-y-6 px-4 py-6">
        {/* شريط الأرقام الرئيسي */}
        <section className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="الإحصاءات الرئيسية">
          <LuxStat
            icon={<Hash className="h-4 w-4" />}
            title="مجموعات تحت المراقبة"
            value={data?.monitored?.total != null ? fmt(data.monitored.total) : "—"}
            sub={
              newToday > 0 ? (
                <span className="font-bold text-emerald-400">+{newToday} جديدة خلال 24 ساعة</span>
              ) : (
                <span>{data?.monitored?.awake ? "تحديث لحظي من البوت" : "آخر لقطة (البوت نائم)"}</span>
              )
            }
            delay="lux-in-1"
          >
            <div className="mt-3">
              <MiniHisto buckets={histo} />
              <p className="mt-1 text-[10px] text-zinc-600">مواليد المجموعات — آخر 24 ساعة (الأحدث يمينًا)</p>
            </div>
          </LuxStat>

          <LuxStat
            icon={<Users className="h-4 w-4" />}
            title="حسابات الأسطول"
            value={
              userClients ? (
                <span className={cn(connectedCount >= Math.ceil(monitors.length / 2) ? "text-emerald-300" : "text-amber-300")}>
                  {connectedCount}
                </span>
              ) : (
                fmt(data?.stats?.connectedAccounts)
              )
            }
            sub={
              userClients ? (
                <span>
                  متصل الآن من {monitors.length}
                  {offlineCount > 0 && <span className="text-amber-400/90"> · {offlineCount} غير متصل</span>}
                </span>
              ) : (
                <span>متصل من {monitors.length} مراقب</span>
              )
            }
            delay="lux-in-2"
          >
            <div className="mt-3 flex items-center gap-3">
              <Ring value={connectedCount || (data?.stats?.connectedAccounts ?? 0)} max={monitors.length} label="الحسابات المتصلة" />
              <div className="space-y-1 text-[11px] leading-4 text-zinc-500">
                <p className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> متصل {connectedCount}
                </p>
                <p className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-zinc-600" /> غير متصل {offlineCount}
                </p>
                <p className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-500" /> غير محدد {unknownConn}
                </p>
              </div>
            </div>
          </LuxStat>

          <LuxStat
            icon={<CheckCircle2 className="h-4 w-4" />}
            title="طلبات منشورة للقناة"
            value={fmt(data?.filter?.accepted)}
            sub={
              <span>
                من {fmt(data?.filter?.seen)} رسالة مفحوصة · {fmt(data?.filter?.rejected)} مرفوضة
              </span>
            }
            delay="lux-in-3"
          >
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-zinc-800">
              <div
                className="h-full rounded-full bg-gradient-to-l from-emerald-400 to-emerald-600 transition-all duration-1000"
                style={{
                  width: `${
                    data?.filter?.seen && data.filter.accepted != null && data.filter.seen > 0
                      ? Math.max(0.5, (data.filter.accepted / data.filter.seen) * 100)
                      : 0
                  }%`,
                }}
              />
            </div>
            <p className="mt-1 text-[10px] text-zinc-600">نسبة القبول من إجمالي الفحص</p>
          </LuxStat>

          <LuxStat
            icon={<Zap className="h-4 w-4" />}
            title="انضمامات عبر الرابط"
            value={fmt(joinTotal || null)}
            sub={
              <span>
                فوري {fmt(join?.totals?.instant_joins ?? 0)} · بالكود {fmt(join?.totals?.otp_joins ?? 0)}
              </span>
            }
            delay="lux-in-4"
          >
            <div className="mt-3 rounded-lg border border-emerald-900/40 bg-emerald-950/20 px-2.5 py-1.5 text-center">
              <p className="text-sm font-extrabold text-emerald-300">{fmt(join?.totals?.groups_added ?? 0)}</p>
              <p className="text-[10px] text-zinc-500">مجموعة دخلت المراقبة عبر المنضمين</p>
            </div>
          </LuxStat>
        </section>

        {/* تنبيه الحسابات غير المتصلة — الحقيقة كاملة */}
        {userClients && offlineCount > 0 && (
          <div className="lux-in flex items-start gap-3 rounded-2xl border border-amber-900/50 bg-gradient-to-l from-amber-950/25 to-transparent p-4">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-amber-950/70 text-amber-400 ring-1 ring-amber-900/60">
              <WifiOff className="h-4 w-4" />
            </div>
            <p className="text-sm leading-6 text-zinc-300">
              <span className="font-extrabold text-amber-300">{offlineCount} حساب نشط غير متصل حاليًا</span> — مجموعاتها
              لا تُقرأ منها الآن، لكن بقية الأسطول المتصلة تقرأ نفس المجموعات (نظام القراء المتعدد)، فالتغطية مستمرة.
              الحسابات المعروفة بمشاكل اتصال دائمة تحتاج إعادة ربط عبر رابط الانضمام.
            </p>
          </div>
        )}

        {/* جدول الأسطول — الحالة الحقيقية */}
        <section className="lux-card lux-in-2 overflow-hidden" aria-label="جدول الحسابات">
          <div className="flex flex-col gap-3 border-b border-white/5 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="flex items-center gap-2 text-base font-extrabold">
                <Users className="h-4 w-4 text-emerald-400" />
                أسطول المراقبة
                <span className="rounded-full bg-emerald-950/70 px-2 py-0.5 text-[11px] font-bold text-emerald-400 ring-1 ring-emerald-900/60">
                  {monitors.length} مراقب · {joiners.length} فدائي
                </span>
              </h2>
              <p className="mt-1 text-xs leading-5 text-zinc-500">
                حالة الاتصال حقيقية من البوت مباشرة — «يـراقب الآن» عدد المجموعات التي يقرأها فعليًا، و«اكتشف» مجموعات
                دخلت النظام عن طريقه.
              </p>
            </div>
            <div className="relative w-full sm:w-64">
              <Search className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-600" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="ابحث باسم الحساب أو رقمه…"
                className="h-10 border-white/10 bg-black/30 pr-9 text-sm"
                aria-label="بحث في الحسابات"
              />
            </div>
          </div>

          <div className="max-h-[28rem] overflow-auto rashq-scroll">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="sticky top-0 z-10 bg-zinc-950/95 backdrop-blur">
                <tr className="border-b border-white/5 text-xs text-zinc-500">
                  <th className="px-4 py-3 text-right font-medium">الحساب</th>
                  <th className="px-3 py-3 text-center font-medium">الاتصال</th>
                  <th className="px-3 py-3 text-center font-medium">يـراقب الآن</th>
                  <th className="px-3 py-3 text-center font-medium">اكتشف</th>
                  <th className="px-3 py-3 text-center font-medium">الصحة</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-10 text-center text-zinc-500">
                      {loading ? "جارٍ التحميل…" : "لا نتائج مطابقة للبحث"}
                    </td>
                  </tr>
                )}
                {filtered.map((w) => {
                  const counts = perPhone[w.phone];
                  const bump = bumped[w.phone];
                  const conn = connOf(w.phone);
                  const offline = conn?.connected === false;
                  return (
                    <tr
                      key={w.phone}
                      className={cn(
                        "border-b border-white/[0.04] transition-colors last:border-0 hover:bg-white/[0.03]",
                        offline && "opacity-60",
                        bump && "bg-emerald-950/40",
                      )}
                    >
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2.5">
                          <div
                            className={cn(
                              "flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-black ring-1",
                              conn?.connected === true
                                ? "bg-emerald-950 text-emerald-400 ring-emerald-800/80"
                                : conn?.connected === false
                                  ? "bg-zinc-900 text-zinc-500 ring-zinc-800"
                                  : "bg-zinc-900 text-zinc-400 ring-zinc-700",
                            )}
                          >
                            {(w.displayName || "").replace(/[^\p{L}\p{N}]/gu, "").slice(0, 2) ||
                              w.phone.replace(/\D/g, "").slice(-2)}
                          </div>
                          <div className="min-w-0">
                            <p className="truncate font-bold text-zinc-100">{w.displayName || "بدون اسم"}</p>
                            <p dir="ltr" className="font-mono text-xs text-zinc-500">
                              {w.phone}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-3 text-center">
                        {conn?.connected === true ? (
                          <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-800/70 bg-emerald-950/70 px-2.5 py-1 text-[11px] font-bold text-emerald-400">
                            <Wifi className="h-3 w-3" />
                            متصل الآن
                          </span>
                        ) : conn?.connected === false ? (
                          <span className="inline-flex items-center gap-1.5 rounded-full border border-zinc-700/70 bg-zinc-900/70 px-2.5 py-1 text-[11px] font-bold text-zinc-400">
                            <WifiOff className="h-3 w-3" />
                            غير متصل
                          </span>
                        ) : (
                          <span
                            className="inline-flex items-center gap-1.5 rounded-full border border-amber-800/60 bg-amber-950/50 px-2.5 py-1 text-[11px] font-bold text-amber-400"
                            title={userClients ? "تعذر تحديد حالة هذا الحساب من البوت" : "فحص حالة الاتصال غير متاح الآن"}
                          >
                            <HelpCircle className="h-3 w-3" />
                            غير محدد
                          </span>
                        )}
                        {conn && !conn.exact && conn.connected !== null && (
                          <span className="mt-1 block text-[10px] text-zinc-600" title="رقمان متشابهان — الحالة غير قطعية">
                            مطابقة تقريبية
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-3 text-center">
                        <span
                          className={cn(
                            "text-xl font-black",
                            bump ? "text-emerald-300" : counts?.reader ? "text-emerald-400" : "text-zinc-600",
                          )}
                        >
                          {counts?.reader ?? 0}
                        </span>
                        {bump ? (
                          <span className="mr-1 animate-bounce text-xs font-black text-emerald-300">+{bump}</span>
                        ) : null}
                      </td>
                      <td className="px-3 py-3 text-center font-bold text-zinc-400">{counts?.discovered ?? 0}</td>
                      <td className="px-3 py-3">
                        <div className="mx-auto w-16">
                          <div className="h-1.5 overflow-hidden rounded-full bg-zinc-800">
                            <div
                              className={cn(
                                "h-full rounded-full transition-all duration-700",
                                (w.healthScore ?? 100) >= 70
                                  ? "bg-emerald-500"
                                  : (w.healthScore ?? 100) >= 40
                                    ? "bg-amber-500"
                                    : "bg-red-500",
                              )}
                              style={{ width: `${Math.max(3, w.healthScore ?? 100)}%` }}
                            />
                          </div>
                          <p className="mt-1 text-[10px] font-bold text-zinc-500">{w.healthScore ?? "—"}</p>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        {/* عمودان: الاكتشافات الحية + الأرشيف */}
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <section className="lux-card lux-in-3 p-4" aria-label="أحدث المجموعات">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="flex items-center gap-2 text-base font-extrabold">
                <Globe2 className="h-4 w-4 text-emerald-400" />
                مجموعات اكتُشفت خلال 24 ساعة
              </h2>
              <span className="rounded-full bg-emerald-950/70 px-2 py-0.5 text-[11px] font-bold text-emerald-400 ring-1 ring-emerald-900/60">
                {newToday} جديدة
              </span>
            </div>
            {(data?.monitored?.recentGroups?.length ?? 0) === 0 ? (
              <p className="rounded-xl border border-dashed border-zinc-800 px-3 py-10 text-center text-sm text-zinc-500">
                {loading ? "جارٍ التحميل…" : "لا مجموعات جديدة في آخر 24 ساعة"}
              </p>
            ) : (
              <ul className="max-h-96 space-y-1.5 overflow-y-auto rashq-scroll pl-1" dir="rtl">
                {data?.monitored?.recentGroups.map((r) => (
                  <li
                    key={r.chatId}
                    className="group flex items-center justify-between gap-2 rounded-xl border border-white/[0.05] bg-black/25 px-3 py-2 transition-colors hover:border-emerald-900/50 hover:bg-emerald-950/20"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-bold text-zinc-200">{r.title || `مجموعة ${r.chatId}`}</p>
                      <p className="mt-0.5 text-xs text-zinc-500">
                        عبر <span dir="ltr" className="font-mono">{r.by || "؟"}</span>
                        {r.readers > 0 && <> · يقرأها {r.readers} حساب</>}
                        {r.username && (
                          <>
                            {" · "}
                            <span dir="ltr" className="font-mono text-zinc-600">
                              @{r.username}
                            </span>
                          </>
                        )}
                      </p>
                    </div>
                    <span className="shrink-0 text-xs text-zinc-500">{timeAgo(r.at)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="lux-card lux-in-4 p-4" aria-label="أرشيف الروابط">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="flex items-center gap-2 text-base font-extrabold">
                <Link2 className="h-4 w-4 text-emerald-400" />
                أرشيف الروابط التاريخي
              </h2>
              {data?.linksTotal != null && (
                <span className="rounded-full bg-zinc-900 px-2 py-0.5 text-[11px] font-bold text-zinc-400 ring-1 ring-zinc-800">
                  {fmt(data.linksTotal)} رابط
                </span>
              )}
            </div>
            <p className="mb-2 text-[11px] leading-4 text-zinc-600">
              إرث النسخة السابقة (قبل إيقاف مسار الروابط) — يُعرض للمرجع فقط.
            </p>
            {(data?.recentLinks?.length ?? 0) === 0 ? (
              <p className="rounded-xl border border-dashed border-zinc-800 px-3 py-10 text-center text-sm text-zinc-500">
                {loading ? "جارٍ التحميل…" : "لا روابط"}
              </p>
            ) : (
              <div className="max-h-96 overflow-y-auto rashq-scroll rounded-xl border border-white/[0.05]">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-zinc-950/95 backdrop-blur">
                    <tr className="border-b border-white/5 text-xs text-zinc-500">
                      <th className="px-3 py-2 text-right font-medium">المجموعة</th>
                      <th className="px-3 py-2 text-right font-medium">النوع</th>
                      <th className="px-3 py-2 text-left font-medium">الوقت</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data?.recentLinks?.map((l) => (
                      <tr key={l.id} className="border-b border-white/[0.04] last:border-0 hover:bg-white/[0.03]">
                        <td className="max-w-40 px-3 py-2">
                          <p className="truncate text-zinc-200" title={l.group}>
                            {l.group || "—"}
                          </p>
                          <p className="truncate text-xs text-zinc-600" title={l.link} dir="ltr">
                            {l.link.length > 34 ? l.link.slice(0, 34) + "…" : l.link}
                          </p>
                        </td>
                        <td className="px-3 py-2">
                          <Badge
                            variant="outline"
                            className={cn(
                              l.type === "whatsapp"
                                ? "border-emerald-900 bg-emerald-950 text-emerald-400"
                                : "border-teal-900 bg-teal-950/60 text-teal-300",
                            )}
                          >
                            {l.type === "whatsapp" ? "واتساب" : l.type === "telegram" ? "تيليجرام" : l.type || "؟"}
                          </Badge>
                        </td>
                        <td className="px-3 py-2 text-xs text-zinc-500">{timeAgo(l.at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>

        {/* فلسفة التغطية */}
        <section className="lux-card lux-in-5 flex flex-col gap-3 p-4 sm:flex-row sm:items-start" aria-label="كيف تعمل التغطية">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-950/70 text-emerald-400 ring-1 ring-emerald-900/70">
            <Sparkles className="h-5 w-5" />
          </div>
          <div className="space-y-1.5 text-sm leading-7">
            <p className="font-extrabold text-emerald-300">كيف تبقى التغطية شاملة حتى مع انقطاع حسابات؟</p>
            <p className="text-zinc-300">
              كل حساب مراقب متصل يُضم تدريجيًا إلى{" "}
              <span className="font-bold text-emerald-300">جميع المجموعات المراقبة العامة</span> بسقف يومي آمن — فيغطي
              أي حساب متصل أي مجموعة حتى لو انقطع حسابها الأصلي، والمجموعات الجديدة تُضم فور اكتشافها بلا تكرار
              (معرّف فريد لكل مجموعة). لهذا انقطاع حساب لا يعني فقدان مجموعاته.
            </p>
          </div>
        </section>

        {/* رابط الانضمام */}
        <section className="lux-card lux-in-5 p-4" aria-label="رابط التسجيل العام">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="flex items-center gap-2 text-base font-extrabold">
              <Phone className="h-4 w-4 text-emerald-400" />
              رابط التسجيل العام للمشاركة
            </h2>
            <span className="rounded-full bg-emerald-950/70 px-2 py-0.5 text-[11px] font-bold text-emerald-400 ring-1 ring-emerald-900/60">
              {joinTotal} منضم حتى الآن
            </span>
          </div>
          <p className="mb-3 text-xs leading-5 text-zinc-500">
            شاركه مع أي أحد: الحسابات المراقبة تنضم فورًا، والجدد يتحققون بكود تيليجرام وتُضم مجموعاتهم للمراقبة
            تلقائيًا.
          </p>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="flex min-w-0 flex-1 items-center rounded-xl border border-emerald-900/40 bg-black/40 px-3 py-2.5 lux-shimmer">
              <span dir="ltr" className="truncate font-mono text-xs text-emerald-300 sm:text-sm">
                https://whatsapp-userbot-e3fy2.onrender.com/join
              </span>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={async () => {
                  if (await copyText("https://whatsapp-userbot-e3fy2.onrender.com/join")) {
                    toast.success("تم نسخ رابط الانضمام");
                  }
                }}
              >
                <Copy className="h-4 w-4" />
                نسخ
              </Button>
              <a
                href="https://whatsapp-userbot-e3fy2.onrender.com/join"
                target="_blank"
                rel="noreferrer"
                className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg bg-emerald-700 px-4 py-2 text-sm font-bold text-white transition hover:bg-emerald-600"
              >
                <ExternalLink className="h-4 w-4" />
                معاينة
              </a>
            </div>
          </div>
        </section>
      </main>

      {/* التذييل اللاصق */}
      <footer className="mt-auto border-t border-white/5 bg-zinc-950/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-2 px-4 py-4 text-xs text-zinc-500 sm:flex-row">
          <span className="flex items-center gap-1.5">
            <Activity className="h-3.5 w-3.5 text-emerald-500" />
            غرفة عمليات المراقبة · آخر تحديث {data ? timeAgo(data.fetchedAt) : "…"}
            {data?.gitCommit && (
              <span dir="ltr" className="font-mono text-zinc-700">
                {data.gitCommit.slice(0, 7)}
              </span>
            )}
          </span>
          <button
            type="button"
            onClick={onRelock}
            className="flex items-center gap-1.5 rounded-lg px-2 py-1 transition hover:bg-zinc-900 hover:text-zinc-300"
          >
            <Lock className="h-3.5 w-3.5" />
            إقفال اللوحة
          </button>
        </div>
      </footer>
    </div>
  );
}

// ============================================================
// الصفحة — تدير القفل والعرض
// ============================================================

export default function Home() {
  const unlocked = useSyncExternalStore(subscribeUnlock, getUnlockSnapshot, () => false);
  const [lockOpen, setLockOpen] = useState(false);

  const relock = () => {
    setUnlockStore(false);
    toast.info("تم إقفال اللوحة — أعد إدخال الرمز للعودة");
  };

  return (
    <>
      {unlocked ? (
        <FleetDashboard onRelock={relock} />
      ) : (
        <PublicRegistration onOpenLock={() => setLockOpen(true)} />
      )}
      <LockDialog open={lockOpen} onOpenChange={setLockOpen} onUnlocked={() => setUnlockStore(true)} />
    </>
  );
}
