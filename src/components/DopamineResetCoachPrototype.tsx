"use client";

import React, { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid
} from "recharts";
import {
  Sparkles,
  CheckCircle2,
  Flame,
  CalendarDays,
  BarChart3,
  Settings,
  ClipboardList,
  Zap,
  Plus,
  X
} from "lucide-react";

/* ---------------- Helpers ---------------- */

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function yyyyMmDd(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDays(dateStr: string, days: number) {
  const dt = new Date(dateStr + "T00:00:00");
  dt.setDate(dt.getDate() + days);
  return yyyyMmDd(dt);
}

type ToggleItem = { label: string; value: boolean };

function getToggle(list: ToggleItem[], label: string) {
  return list.find((x) => x.label.toLowerCase() === label.toLowerCase());
}

function upsertToggle(list: ToggleItem[], label: string, value: boolean) {
  const idx = list.findIndex((x) => x.label.toLowerCase() === label.toLowerCase());
  if (idx === -1) return [...list, { label, value }];
  const next = [...list];
  next[idx] = { ...next[idx], value };
  return next;
}

function removeToggle(list: ToggleItem[], label: string) {
  return list.filter((x) => x.label.toLowerCase() !== label.toLowerCase());
}

function titleCase(s: string) {
  return s
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

const STORAGE_KEY = "drc_v1";

type PersistedState = {
  history: Checkin[];
  planDays: number;
  strictness: Strictness;
  trackedMacros: Record<MacroKey, boolean>;
};

function safeParse<T>(s: string | null): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

/* ---------------- Types ---------------- */

type Strictness = "Light" | "Standard" | "Hard";

type MacroKey = "calories" | "protein" | "carbs" | "fat";

type Checkin = {
  date: string; // YYYY-MM-DD

  // User-defined “load items” (NOT core; add/remove freely)
  loadItems: ToggleItem[];

  // Core virtues (ONLY these three)
  virtues: {
    study: boolean;
    gym: boolean;
    meditate: boolean;
  };

  // Core metrics
  sleepHours: number;
  sleepQuality: number;
  caffeineMg: number;
  socialMinutes: number;
  workout: boolean;
  mood: number;
  energy: number;
  junkFood: boolean;
  notes: string;

  // Nutrition (toggle visible fields via settings)
  calories: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
};

const CORE_VIRTUE_KEYS = ["study", "gym", "meditate"] as const;

function makeDefaultCheckin(date: string): Checkin {
  return {
    date,
    loadItems: [],
    virtues: { study: false, gym: false, meditate: false },
    sleepHours: 7.5,
    sleepQuality: 7,
    caffeineMg: 0,
    socialMinutes: 0,
    workout: false,
    mood: 7,
    energy: 7,
    junkFood: false,
    notes: "",
    calories: 0,
    proteinG: 0,
    carbsG: 0,
    fatG: 0
  };
}

/* ---------------- Scoring ---------------- */

function virtuesCount(v: Checkin["virtues"]) {
  return (v.study ? 1 : 0) + (v.gym ? 1 : 0) + (v.meditate ? 1 : 0);
}

function computeDLS(d: Checkin) {
  // Dopamine Load Score (0–100): higher = more stimulus load
  const social = clamp((d.socialMinutes / 10) * 3, 0, 30);
  const caffeine = clamp((d.caffeineMg / 50) * 2.5, 0, 20);
  const junk = d.junkFood ? 10 : 0;

  // User-added load items contribute (NOT core vices)
  const loadOn = (d.loadItems || []).filter((x) => x.value).length;
  const extraLoad = clamp(loadOn * 6, 0, 30);

  // Virtues reduce load a bit (capped)
  const virtues = clamp(virtuesCount(d.virtues) * 3, 0, 12);

  const workout = d.workout ? -10 : 0;
  const goodSleep = d.sleepHours >= 7.5 ? -10 : 0;

  const raw = social + caffeine + junk + extraLoad + workout + goodSleep - virtues;
  return clamp(Math.round(raw), 0, 100);
}

function computeNEI(history: Checkin[]) {
  // Natural Energy Index (0–100): higher = better baseline trend
  const last7 = history.slice(-7);
  if (last7.length === 0) return 50;

  const avgEnergy = last7.reduce((a, x) => a + x.energy, 0) / last7.length;
  const avgSleep = last7.reduce((a, x) => a + x.sleepHours, 0) / last7.length;

  const loadDays = last7.filter((x) => (x.loadItems || []).some((i) => i.value)).length;
  const virtueDays = last7.filter((x) => virtuesCount(x.virtues) >= 1).length;

  let score = avgEnergy * 10;
  if (avgSleep >= 7.5) score += 5;
  if (loadDays >= 3) score -= 8;
  if (virtueDays >= 4) score += 6;

  return clamp(Math.round(score), 0, 100);
}

type CoachTask = { level: "Easy" | "Medium" | "Hard"; text: string; why: string };

function coachTasks(today: Checkin, dayNumber: number, strictness: Strictness): CoachTask[] {
  const tasks: CoachTask[] = [];

  const dls = computeDLS(today);
  const early = dayNumber <= 10;
  const late = dayNumber > 40;

  // EASY
  if (early) {
    tasks.push({
      level: "Easy",
      text: "5-minute grounding walk (no phone).",
      why: "Early resets succeed through tiny stable habits, not intensity."
    });
  } else if (!late) {
    tasks.push({
      level: "Easy",
      text: "Set a 60-minute stimulus-free focus block.",
      why: "Mid-phase: extend clarity windows gradually."
    });
  } else {
    tasks.push({
      level: "Easy",
      text: "Plan tomorrow’s top 3 in 90 seconds.",
      why: "Late-phase: optimize momentum, not restriction."
    });
  }

  // MEDIUM
  if (today.sleepHours < 7) {
    tasks.push({
      level: "Medium",
      text: "Lights-out time tonight + 20-minute wind-down.",
      why: "Sleep debt amplifies cravings and worsens baseline stability."
    });
  } else if (today.caffeineMg > 200) {
    tasks.push({
      level: "Medium",
      text: "Cap caffeine by 2PM; swap one dose for water.",
      why: "Caffeine can mask fatigue and distort natural calibration."
    });
  } else {
    tasks.push({
      level: "Medium",
      text: "2–3 sets of light movement (push-ups or squats).",
      why: "Light training boosts dopamine tone without spiking it."
    });
  }

  // HARD
  const anyLoad = (today.loadItems || []).some((x) => x.value);
  if (dls > 70) {
    tasks.push({
      level: "Hard",
      text: "Full evening detox: no social media after 8PM.",
      why: "High-load days benefit most from removing high-density stimuli."
    });
  } else if (anyLoad) {
    tasks.push({
      level: "Hard",
      text: "Recovery protocol: 20-min walk + protein + early bed.",
      why: "A structured rebound stabilizes the next 48 hours."
    });
  } else if (strictness === "Hard") {
    tasks.push({
      level: "Hard",
      text: "Phone out of bedroom + no screens final 45 minutes.",
      why: "Hard mode uses environment control to maximize consistency."
    });
  } else if (late) {
    tasks.push({
      level: "Hard",
      text: "24-hour low-stimulus cycle (no shortform content).",
      why: "Late-phase: deepen discipline with bigger resets."
    });
  } else {
    tasks.push({
      level: "Hard",
      text: "No phone in bed tonight.",
      why: "Prevents unconscious dopamine loops at night."
    });
  }

  return tasks.slice(0, 3);
}

/* ---------------- UI Pieces ---------------- */

function ToggleListEditor(props: {
  title: string;
  subtitle: string;
  items: ToggleItem[];
  setItems: (next: ToggleItem[]) => void;
  addPlaceholder: string;
}) {
  const { title, subtitle, items, setItems, addPlaceholder } = props;
  const [draftLabel, setDraftLabel] = useState("");

  const addItem = () => {
    const label = draftLabel.trim();
    if (!label) return;
    if (items.some((x) => x.label.toLowerCase() === label.toLowerCase())) {
      setDraftLabel("");
      return;
    }
    setItems([...items, { label: titleCase(label), value: false }]);
    setDraftLabel("");
  };

  return (
    <div className="rounded-2xl border p-3 space-y-3">
      <div>
        <div className="text-sm font-medium">{title}</div>
        <div className="text-xs text-muted-foreground">{subtitle}</div>
      </div>

      <div className="space-y-2">
        {items.length === 0 ? (
          <div className="rounded-xl border p-3 text-xs text-muted-foreground">
            None yet — add whatever you want to track.
          </div>
        ) : null}

        {items.map((it) => (
          <div key={it.label} className="flex items-center justify-between rounded-xl border p-3">
            <div className="min-w-0">
              <div className="text-sm font-medium truncate">{it.label}</div>
              <div className="text-xs text-muted-foreground">Toggle for this day</div>
            </div>

            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                className="rounded-xl px-2"
                onClick={() => setItems(removeToggle(items, it.label))}
                aria-label={`Remove ${it.label}`}
                title="Remove"
              >
                <X className="h-4 w-4" />
              </Button>

              <Switch checked={it.value} onCheckedChange={(val) => setItems(upsertToggle(items, it.label, val))} />
            </div>
          </div>
        ))}
      </div>

      <div className="flex gap-2">
        <Input
          value={draftLabel}
          onChange={(e) => setDraftLabel(e.target.value)}
          placeholder={addPlaceholder}
          className="rounded-xl flex-1"
          onKeyDown={(e) => {
            if (e.key === "Enter") addItem();
          }}
        />
        <Button type="button" className="rounded-xl" variant="outline" onClick={addItem} title="Add">
          <Plus className="h-4 w-4" />
        </Button>
      </div>

      <div className="text-[11px] text-muted-foreground">
        Tip: add anything you want (e.g., “TikTok”, “Sugar”, “Nicotine”, “Late-night scrolling”).
      </div>
    </div>
  );
}

/* ---------------- Main Component ---------------- */

export default function DopamineResetCoachPrototype() {


 const DEFAULT_MACROS: Record<MacroKey, boolean> = {
  calories: true,
  protein: true,
  carbs: false,
  fat: false
};

const initial = useMemo(() => {
  // guard for SSR (even though this is "use client", safe anyway)
  if (typeof window === "undefined") {
    return {
      history: [] as Checkin[],
      planDays: 100,
      strictness: "Standard" as Strictness,
      trackedMacros: DEFAULT_MACROS
    };
  }

  const saved = safeParse<PersistedState>(localStorage.getItem(STORAGE_KEY));
  return {
    history: saved?.history ?? [],
    planDays: saved?.planDays ?? 100,
    strictness: saved?.strictness ?? ("Standard" as Strictness),
    trackedMacros: saved?.trackedMacros ?? DEFAULT_MACROS
  };
}, []);

const [history, setHistory] = useState<Checkin[]>(initial.history);
const [planDays, setPlanDays] = useState<number>(initial.planDays);
const [strictness, setStrictness] = useState<Strictness>(initial.strictness);
const [trackedMacros, setTrackedMacros] = useState<Record<MacroKey, boolean>>(initial.trackedMacros);

// start blank draft
const [draft, setDraft] = useState<Checkin | null>(null);


  // RESET EVERYTHING
const resetAll = () => {
  localStorage.removeItem(STORAGE_KEY);
  setHistory([]);
  setDraft(null);
  setPlanDays(100);
  setStrictness("Standard");
};

// SAVE data every time you change anything important
useEffect(() => {
  const payload: PersistedState = { history, planDays, strictness, trackedMacros };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}, [history, planDays, strictness, trackedMacros]);

  // dayNumber is literally: how many days you’ve added/logged
  const dayNumber = history.length;

  const progressPct = useMemo(() => {
    if (planDays <= 0) return 0;
    return clamp(Math.round((dayNumber / planDays) * 100), 0, 100);
  }, [dayNumber, planDays]);

  // “Today” view is the current draft (or the latest history entry if draft is null)
  const active = useMemo<Checkin | null>(() => {
    if (draft) return draft;
    if (history.length === 0) return null;
    return history[history.length - 1];
  }, [draft, history]);

  // Scores
  const dls = useMemo(() => (active ? computeDLS(active) : 0), [active]);
  const nei = useMemo(() => computeNEI(history), [history]);
  const tasks = useMemo(() => (active ? coachTasks(active, dayNumber || 1, strictness) : []), [active, dayNumber, strictness]);

  const chartData = useMemo(() => {
    return history.slice(-14).map((x) => ({
      day: x.date.slice(5),
      DLS: computeDLS(x),
      Energy: x.energy,
      Sleep: Number(x.sleepHours.toFixed(1))
    }));
  }, [history]);

  // Add day (little + button behavior)
  const addDay = () => {
    const nextDate = (() => {
      if (history.length === 0) return yyyyMmDd(new Date());
      const last = history[history.length - 1].date;
      return addDays(last, 1);
    })();

    const next = makeDefaultCheckin(nextDate);
    setHistory((prev) => [...prev, next]);
    setDraft(next);
  };

  // Remove last day (minus button behavior)
const removeDay = () => {
  setHistory((prev) => {
    if (prev.length === 0) return prev;

    const next = prev.slice(0, -1); // drop last day
    return next;
  });

  // also clear the draft so you don't edit a day that no longer exists
  setDraft(null);
};


  const saveCheckin = () => {
    if (!draft) return;
    setHistory((prev) => {
      const exists = prev.some((x) => x.date === draft.date);
      const next = exists ? prev.map((x) => (x.date === draft.date ? draft : x)) : [...prev, draft];
      return next.sort((a, b) => (a.date < b.date ? -1 : 1));
    });
  };

  const resetDraftToActive = () => {
    if (!active) return;
    setDraft({ ...active });
  };

  // Keep draft linked to the current “active” day entry after save/add
  useEffect(() => {
    if (!draft) return;
    const inHistory = history.find((x) => x.date === draft.date);
    if (!inHistory) return;
    // don’t auto-overwrite user edits
  }, [history, draft]);

  // Helpers to edit draft safely
  const requireDraft = (fn: (d: Checkin) => Checkin) => {
    setDraft((prev) => {
      if (!prev) return prev;
      return fn(prev);
    });
  };

  return (
    <div className="min-h-screen w-full bg-background text-foreground">
      <div className="mx-auto max-w-5xl p-4 md:p-8">
        {/* Header */}
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <div className="inline-flex h-9 w-9 items-center justify-center rounded-2xl border">
                <Sparkles className="h-5 w-5" />
              </div>
              <h1 className="text-2xl font-semibold tracking-tight">Dopamine Reset Coach</h1>
              <Badge variant="secondary" className="rounded-xl">
                Prototype
              </Badge>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Core virtues only (Study/Gym/Meditate). Load items are user-added only. Starts blank.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Badge className="rounded-xl" variant="outline">
              Days: {dayNumber}
            </Badge>
            <Button
              variant="outline"
              className="rounded-2xl"
              onClick={addDay}
              title="Add day"
              aria-label="Add day"
            >
              <Plus className="h-4 w-4 mr-2" />
              Add Day
            </Button>

            <Button
  variant="outline"
  className="h-8 w-8 p-0 rounded-full"
  onClick={removeDay}
  disabled={history.length === 0}
  aria-label="Remove day"
  title="Remove day"
>
  <span className="text-lg leading-none">−</span>
</Button>


            <Button
  variant="outline"
  className="rounded-2xl"
  onClick={removeDay}
  disabled={history.length === 0}
  title="Remove last day"
  aria-label="Remove last day"
>
  − Remove Day
</Button>

            <Badge className="rounded-xl" variant={strictness === "Hard" ? "destructive" : "secondary"}>
              {strictness}
            </Badge>
          </div>
        </div>

        {/* Top Cards */}
        <div className="mt-6 grid gap-4 md:grid-cols-3">
          <Card className="rounded-2xl">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <Flame className="h-4 w-4" /> Reset Progress
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-baseline justify-between">
                <div>
                  <div className="text-3xl font-semibold flex items-center gap-2">
                    Day {dayNumber}
                    {/* ✅ little plus button */}
                    <Button
                      variant="outline"
                      className="h-8 w-8 p-0 rounded-full"
                      onClick={addDay}
                      aria-label="Add day"
                      title="Add day"
                    >
                      <Plus className="h-4 w-4" />
                    </Button>
                  </div>
                  <div className="text-xs text-muted-foreground">of {planDays} days</div>
                </div>
                <div className="text-right">
                  <div className="text-sm font-medium">{progressPct}%</div>
                  <div className="text-xs text-muted-foreground">completion</div>
                </div>
              </div>
              <Progress value={progressPct} />
              <div className="grid grid-cols-2 gap-2">
                <Button variant="outline" className="rounded-2xl" onClick={() => setPlanDays(30)}>
                  30
                </Button>
                <Button variant="outline" className="rounded-2xl" onClick={() => setPlanDays(100)}>
                  100
                </Button>
              </div>
              {history.length === 0 ? (
                <div className="rounded-2xl border p-3 text-xs text-muted-foreground">
                  Start blank: click the <span className="font-semibold">+</span> to add Day 1.
                </div>
              ) : null}
            </CardContent>
          </Card>

          <Card className="rounded-2xl">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <Zap className="h-4 w-4" /> Active Day Scores
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {!active ? (
                <div className="rounded-2xl border p-4 text-sm text-muted-foreground">
                  No active day yet. Add Day 1 to start.
                </div>
              ) : (
                <>
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="text-sm font-medium">Dopamine Load</div>
                      <div className="text-sm tabular-nums">{dls}/100</div>
                    </div>
                    <Progress value={dls} />
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="text-sm font-medium">Natural Energy Index</div>
                      <div className="text-sm tabular-nums">{nei}/100</div>
                    </div>
                    <Progress value={nei} />
                  </div>

                  <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                    <div className="rounded-2xl border p-2">
                      Energy: <span className="font-medium text-foreground">{active.energy}/10</span>
                    </div>
                    <div className="rounded-2xl border p-2">
                      Sleep: <span className="font-medium text-foreground">{active.sleepHours.toFixed(1)}h</span>
                    </div>
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          <Card className="rounded-2xl">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <ClipboardList className="h-4 w-4" /> Coach Tasks
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {!active ? (
                <div className="rounded-2xl border p-4 text-sm text-muted-foreground">
                  Add a day first — tasks are generated per day.
                </div>
              ) : (
                tasks.map((t) => (
                  <div key={t.level} className="rounded-2xl border p-3">
                    <div className="flex items-center justify-between">
                      <Badge
                        className="rounded-xl"
                        variant={t.level === "Hard" ? "destructive" : t.level === "Medium" ? "default" : "secondary"}
                      >
                        {t.level}
                      </Badge>
                      <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div className="mt-2 text-sm font-medium">{t.text}</div>
                    <div className="mt-1 text-xs text-muted-foreground">{t.why}</div>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </div>

        {/* Tabs */}
        <div className="mt-6">
          <Tabs defaultValue="checkin" className="w-full">
            <TabsList className="grid w-full grid-cols-4 rounded-2xl">
              <TabsTrigger value="today" className="rounded-2xl">
                <CalendarDays className="mr-2 h-4 w-4" />
                Active
              </TabsTrigger>
              <TabsTrigger value="checkin" className="rounded-2xl">
                <ClipboardList className="mr-2 h-4 w-4" />
                Check-In
              </TabsTrigger>
              <TabsTrigger value="progress" className="rounded-2xl">
                <BarChart3 className="mr-2 h-4 w-4" />
                Progress
              </TabsTrigger>
              <TabsTrigger value="settings" className="rounded-2xl">
                <Settings className="mr-2 h-4 w-4" />
                Settings
              </TabsTrigger>
            </TabsList>

            {/* Active */}
            <TabsContent value="today" className="mt-4">
              <div className="grid gap-4 md:grid-cols-2">
                <Card className="rounded-2xl">
                  <CardHeader>
                    <CardTitle className="text-base">Active Day Snapshot</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3 text-sm">
                    {!active ? (
                      <div className="rounded-2xl border p-4 text-muted-foreground">
                        No active day. Click <span className="font-semibold">Add Day</span>.
                      </div>
                    ) : (
                      <>
                        <Badge className="rounded-xl" variant="outline">
                          Date: {active.date}
                        </Badge>

                        <div className="grid grid-cols-2 gap-2">
                          <div className="rounded-2xl border p-3">
                            Caffeine <div className="text-lg font-semibold tabular-nums">{active.caffeineMg}mg</div>
                          </div>
                          <div className="rounded-2xl border p-3">
                            Social <div className="text-lg font-semibold tabular-nums">{active.socialMinutes}m</div>
                          </div>
                          <div className="rounded-2xl border p-3">
                            Workout <div className="text-lg font-semibold">{active.workout ? "Yes" : "No"}</div>
                          </div>
                          <div className="rounded-2xl border p-3">
                            Virtues On{" "}
                            <div className="text-lg font-semibold tabular-nums">{virtuesCount(active.virtues)}</div>
                          </div>
                        </div>

                        <Separator />

                        <div className="flex flex-wrap gap-2">
                          <Badge className="rounded-xl" variant="secondary">
                            Load items on: {active.loadItems.filter((x) => x.value).length}
                          </Badge>
                          <Badge className="rounded-xl" variant={active.junkFood ? "destructive" : "secondary"}>
                            Junk: {active.junkFood ? "Yes" : "No"}
                          </Badge>
                        </div>

                        <div className="rounded-2xl border p-3">
                          <div className="text-xs text-muted-foreground">Notes</div>
                          <div className="mt-1 text-sm text-muted-foreground">{active.notes || "—"}</div>
                        </div>
                      </>
                    )}
                  </CardContent>
                </Card>

                <Card className="rounded-2xl">
                  <CardHeader>
                    <CardTitle className="text-base">Micro-Prescription</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="rounded-2xl border p-3">
                      <div className="text-sm font-medium">If cravings spike:</div>
                      <ul className="mt-2 list-disc pl-5 text-sm text-muted-foreground space-y-1">
                        <li>10-minute walk (no phone)</li>
                        <li>Water + protein (hunger masquerades as craving)</li>
                        <li>Push-ups to mild fatigue</li>
                        <li>Phone out of bedroom</li>
                      </ul>
                    </div>
                    <Button
                      className="w-full rounded-2xl"
                      variant="default"
                      onClick={() => alert("Prototype: would start a 10-minute urge timer.")}
                    >
                      Start 10-minute Urge Timer
                    </Button>
                  </CardContent>
                </Card>
              </div>
            </TabsContent>

            {/* Check-In */}
            <TabsContent value="checkin" className="mt-4">
              <Card className="rounded-2xl">
                <CardHeader>
                  <CardTitle className="text-base">Daily Check-In (fast)</CardTitle>
                </CardHeader>

                <CardContent>
                  {!draft ? (
                    <div className="rounded-2xl border p-6 text-sm text-muted-foreground">
                      You’re starting blank. Click <span className="font-semibold">Add Day</span> to create Day 1.
                    </div>
                  ) : (
                    <div className="grid gap-4 md:grid-cols-2">
                      {/* Date */}
                      <div className="space-y-2">
                        <Label>Date</Label>
                        <Input
                          value={draft.date}
                          onChange={(e) => requireDraft((d) => ({ ...d, date: e.target.value }))}
                          className="rounded-2xl"
                        />
                      </div>

                      {/* Sleep hours */}
                      <div className="space-y-2">
                        <Label>
                          Sleep Hours: <span className="tabular-nums">{draft.sleepHours.toFixed(1)}</span>
                        </Label>
                        <Slider
                          value={[draft.sleepHours]}
                          min={3}
                          max={10}
                          step={0.1}
                          onValueChange={([v]) => requireDraft((d) => ({ ...d, sleepHours: v }))}
                        />
                      </div>

                      {/* Sleep quality */}
                      <div className="space-y-2">
                        <Label>
                          Sleep Quality: <span className="tabular-nums">{draft.sleepQuality}/10</span>
                        </Label>
                        <Slider
                          value={[draft.sleepQuality]}
                          min={1}
                          max={10}
                          step={1}
                          onValueChange={([v]) => requireDraft((d) => ({ ...d, sleepQuality: v }))}
                        />
                      </div>

                      {/* Caffeine */}
                      <div className="space-y-2">
                        <Label>Caffeine (mg)</Label>
                        <Input
                          type="number"
                          value={draft.caffeineMg}
                          onChange={(e) => requireDraft((d) => ({ ...d, caffeineMg: Number(e.target.value || 0) }))}
                          className="rounded-2xl"
                        />
                      </div>

                      {/* Social */}
                      <div className="space-y-2">
                        <Label>Social Minutes</Label>
                        <Input
                          type="number"
                          value={draft.socialMinutes}
                          onChange={(e) => requireDraft((d) => ({ ...d, socialMinutes: Number(e.target.value || 0) }))}
                          className="rounded-2xl"
                        />
                      </div>

                      {/* Mood */}
                      <div className="space-y-2">
                        <Label>
                          Mood: <span className="tabular-nums">{draft.mood}/10</span>
                        </Label>
                        <Slider
                          value={[draft.mood]}
                          min={1}
                          max={10}
                          step={1}
                          onValueChange={([v]) => requireDraft((d) => ({ ...d, mood: v }))}
                        />
                      </div>

                      {/* Energy */}
                      <div className="space-y-2">
                        <Label>
                          Energy: <span className="tabular-nums">{draft.energy}/10</span>
                        </Label>
                        <Slider
                          value={[draft.energy]}
                          min={1}
                          max={10}
                          step={1}
                          onValueChange={([v]) => requireDraft((d) => ({ ...d, energy: v }))}
                        />
                      </div>

                      {/* Core virtues ONLY */}
                      <div className="rounded-2xl border p-3 space-y-3">
                        <div>
                          <div className="text-sm font-medium">Core Virtues</div>
                          <div className="text-xs text-muted-foreground">Only these three. Toggle on/off.</div>
                        </div>

                        <div className="space-y-2">
                          {CORE_VIRTUE_KEYS.map((k) => (
                            <div key={k} className="flex items-center justify-between rounded-xl border p-3">
                              <div>
                                <div className="text-sm font-medium">{titleCase(k)}</div>
                                <div className="text-xs text-muted-foreground">Toggle for this day</div>
                              </div>
                              <Switch
                                checked={draft.virtues[k]}
                                onCheckedChange={(val) =>
                                  requireDraft((d) => ({
                                    ...d,
                                    virtues: { ...d.virtues, [k]: val }
                                  }))
                                }
                              />
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Custom load items (user-defined only) */}
                      <ToggleListEditor
                        title="Load Items"
                        subtitle="Anything you want to reduce (user-added only; no core vices)."
                        items={draft.loadItems}
                        setItems={(next) => requireDraft((d) => ({ ...d, loadItems: next }))}
                        addPlaceholder="Add a load item (e.g., TikTok, Sugar)"
                      />

                      {/* Workout */}
                      <div className="flex items-center justify-between rounded-2xl border p-3">
                        <div>
                          <div className="text-sm font-medium">Workout</div>
                          <div className="text-xs text-muted-foreground">Strength/cardio</div>
                        </div>
                        <Switch checked={draft.workout} onCheckedChange={(v) => requireDraft((d) => ({ ...d, workout: v }))} />
                      </div>

                      {/* Junk food */}
                      <div className="flex items-center justify-between rounded-2xl border p-3">
                        <div>
                          <div className="text-sm font-medium">Junk Food</div>
                          <div className="text-xs text-muted-foreground">Processed/sugary</div>
                        </div>
                        <Switch checked={draft.junkFood} onCheckedChange={(v) => requireDraft((d) => ({ ...d, junkFood: v }))} />
                      </div>

                      {/* Nutrition (macro toggle-controlled) */}
                      <div className="space-y-2 md:col-span-2">
                        <div className="text-sm font-medium">Nutrition</div>
                        <div className="grid gap-3 md:grid-cols-2">
                          {trackedMacros.calories && (
                            <div className="space-y-2">
                              <Label>Calories</Label>
                              <Input
                                type="number"
                                value={draft.calories}
                                onChange={(e) => requireDraft((d) => ({ ...d, calories: Number(e.target.value || 0) }))}
                                className="rounded-2xl"
                              />
                            </div>
                          )}

                          {trackedMacros.protein && (
                            <div className="space-y-2">
                              <Label>Protein (g)</Label>
                              <Input
                                type="number"
                                value={draft.proteinG}
                                onChange={(e) => requireDraft((d) => ({ ...d, proteinG: Number(e.target.value || 0) }))}
                                className="rounded-2xl"
                              />
                            </div>
                          )}

                          {trackedMacros.carbs && (
                            <div className="space-y-2">
                              <Label>Carbs (g)</Label>
                              <Input
                                type="number"
                                value={draft.carbsG}
                                onChange={(e) => requireDraft((d) => ({ ...d, carbsG: Number(e.target.value || 0) }))}
                                className="rounded-2xl"
                              />
                            </div>
                          )}

                          {trackedMacros.fat && (
                            <div className="space-y-2">
                              <Label>Fat (g)</Label>
                              <Input
                                type="number"
                                value={draft.fatG}
                                onChange={(e) => requireDraft((d) => ({ ...d, fatG: Number(e.target.value || 0) }))}
                                className="rounded-2xl"
                              />
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Notes */}
                      <div className="space-y-2 md:col-span-2">
                        <Label>Notes (optional)</Label>
                        <Input
                          value={draft.notes}
                          onChange={(e) => requireDraft((d) => ({ ...d, notes: e.target.value }))}
                          className="rounded-2xl"
                          placeholder="Trigger, win, or quick reflection…"
                        />
                      </div>

                      {/* Buttons */}
                      <div className="md:col-span-2 flex flex-col gap-2 md:flex-row">
                        <Button className="rounded-2xl flex-1" onClick={saveCheckin}>
                          Save Check-In
                        </Button>
                        <Button className="rounded-2xl" variant="outline" onClick={resetDraftToActive}>
                          Reset
                        </Button>
                      </div>

                      {/* Preview Score */}
                      <div className="md:col-span-2 rounded-2xl border p-3 text-sm">
                        <div className="flex items-center justify-between">
                          <div className="font-medium">Preview Score</div>
                          <Badge className="rounded-xl" variant="secondary">
                            DLS {computeDLS(draft)}/100
                          </Badge>
                        </div>
                        <div className="mt-2 text-xs text-muted-foreground">
                          Behavioral feedback metric — not medical advice.
                        </div>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            {/* Progress */}
            <TabsContent value="progress" className="mt-4">
              {history.length === 0 ? (
                <Card className="rounded-2xl">
                  <CardHeader>
                    <CardTitle className="text-base">Progress</CardTitle>
                  </CardHeader>
                  <CardContent className="text-sm text-muted-foreground">
                    No data yet. Add Day 1 and save a check-in to see charts.
                  </CardContent>
                </Card>
              ) : (
                <div className="grid gap-4 md:grid-cols-2">
                  <Card className="rounded-2xl">
                    <CardHeader>
                      <CardTitle className="text-base">Last 14 Days — Dopamine Load</CardTitle>
                    </CardHeader>
                    <CardContent className="h-72">
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={chartData}>
                          <CartesianGrid strokeDasharray="3 3" />
                          <XAxis dataKey="day" />
                          <YAxis domain={[0, 100]} />
                          <Tooltip />
                          <Line type="monotone" dataKey="DLS" strokeWidth={2} dot={false} />
                        </LineChart>
                      </ResponsiveContainer>
                    </CardContent>
                  </Card>

                  <Card className="rounded-2xl">
                    <CardHeader>
                      <CardTitle className="text-base">Energy & Sleep (context)</CardTitle>
                    </CardHeader>
                    <CardContent className="h-72">
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={chartData}>
                          <CartesianGrid strokeDasharray="3 3" />
                          <XAxis dataKey="day" />
                          <YAxis yAxisId="left" domain={[0, 10]} />
                          <YAxis yAxisId="right" orientation="right" domain={[3, 10]} />
                          <Tooltip />
                          <Line yAxisId="left" type="monotone" dataKey="Energy" strokeWidth={2} dot={false} />
                          <Line yAxisId="right" type="monotone" dataKey="Sleep" strokeWidth={2} dot={false} />
                        </LineChart>
                      </ResponsiveContainer>
                    </CardContent>
                  </Card>
                </div>
              )}
            </TabsContent>

            {/* Settings */}
            <TabsContent value="settings" className="mt-4">
              <Card className="rounded-2xl">
                <CardHeader>
                  <CardTitle className="text-base">Settings</CardTitle>
                </CardHeader>
                <CardContent className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label>Strictness</Label>
                    <div className="flex gap-2">
                      <Button
                        className="rounded-2xl flex-1"
                        variant={strictness === "Light" ? "default" : "outline"}
                        onClick={() => setStrictness("Light")}
                      >
                        Light
                      </Button>
                      <Button
                        className="rounded-2xl flex-1"
                        variant={strictness === "Standard" ? "default" : "outline"}
                        onClick={() => setStrictness("Standard")}
                      >
                        Standard
                      </Button>
                      <Button
                        className="rounded-2xl flex-1"
                        variant={strictness === "Hard" ? "default" : "outline"}
                        onClick={() => setStrictness("Hard")}
                      >
                        Hard
                      </Button>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Hard mode raises expectations (tighter windows, stricter bedtime, etc.).
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label>Plan length</Label>
                    <div className="flex gap-2">
                      <Button
                        className="rounded-2xl flex-1"
                        variant={planDays === 30 ? "default" : "outline"}
                        onClick={() => setPlanDays(30)}
                      >
                        30
                      </Button>
                      <Button
                        className="rounded-2xl flex-1"
                        variant={planDays === 100 ? "default" : "outline"}
                        onClick={() => setPlanDays(100)}
                      >
                        100
                      </Button>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Progress is based on how many days you add (manual + button).
                    </div>
                  </div>

                  {/* Nutrition macro toggles */}
                  <div className="md:col-span-2 rounded-2xl border p-3">
                    <div className="font-medium">Nutrition tracker</div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {(["calories", "protein", "carbs", "fat"] as const).map((m) => (
                        <Button
                          key={m}
                          variant={trackedMacros[m] ? "default" : "outline"}
                          className="rounded-2xl"
                          onClick={() => setTrackedMacros((prev) => ({ ...prev, [m]: !prev[m] }))}
                        >
                          {m}
                        </Button>
                      ))}
                    </div>
                    <div className="mt-2 text-xs text-muted-foreground">
                      Toggle which macros appear in your daily check-in.
                    </div>
                  </div>

                  <div className="md:col-span-2 rounded-2xl border p-3 text-sm">
                    <div className="font-medium">Next build steps</div>
                    <ol className="mt-2 list-decimal pl-5 text-sm text-muted-foreground space-y-1">
                      <li>Persistence (localStorage or Supabase)</li>
                      <li>Streaks for Study/Gym/Meditate</li>
                      <li>Export to CSV</li>
                      <li>Notifications</li>
                    </ol>
                  </div>

                  <Button
  variant="destructive"
  className="rounded-2xl md:col-span-2"
  onClick={resetAll}
>
  Reset All Data
</Button>


                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </div>

        <div className="mt-8 text-xs text-muted-foreground">
Prototype note: data is saved locally in this browser (localStorage).
        </div>
      </div>
    </div>
  );
}
