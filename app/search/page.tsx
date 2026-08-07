"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type Region = "KR" | "US" | "JP" | "ALL";
type VideoType = "shorts" | "normal" | "all";

type VideoItem = {
  id: string;
  title: string;
  channelTitle: string;
  channelId: string;
  publishedAt: string;
  thumbnail: string;
  viewCount: number;
  durationSec: number;
};

const PAGE_SIZE = 40;

// ✅ 쿼터 세이프: 미리 확보량 / 스캔 스텝 상한을 낮춤
const PREFETCH_TARGET = 160;

// ✅ seed 풀(너무 많으면 쿼터 급증) — 24개 정도로 절제
const SEEDS: string[] = [
  "shorts",
  "#shorts",
  "viral",
  "trend",
  "meme",
  "edit",
  "funny",
  "wow",
  "lol",
  "music",
  "dance",
  "game",
  "minecraft",
  "roblox",
  "prank",
  "reaction",
  "facts",
  "science",
  "news",
  "movie",
  "sports",
  "how",
  "why",
  "best",
];

// ✅ localStorage
const LS_KEY_API = "pixeling_youtube_api_key";
const LS_KEY_DAYS = "pixeling_discovery_days";
const LS_KEY_MIN = "pixeling_discovery_minViewsMan";
const LS_KEY_REGION = "pixeling_discovery_region";
const LS_KEY_TYPE = "pixeling_discovery_videoType";
const LS_KEY_EXCL_IN = "pixeling_discovery_excludeIndia";
// ✅ 강화 토글 저장
const LS_KEY_EXCL_IN_STRONG = "pixeling_discovery_excludeIndiaStrong";
const LS_KEY_EXCLUDE_HANDLES = "pixeling_discovery_exclude_handles_v2";
const LS_KEY_HANDLE_ID_CACHE = "pixeling_handle_to_channelId_v1";
// ✅ country 캐시(쿼터 세이브 핵심)
const LS_KEY_CHANNEL_COUNTRY_CACHE = "pixeling_channel_country_cache_v1";

// ✅ ✅ 결과 유지용 localStorage (페이지 나갔다 와도 결과 유지)
const LS_KEY_RESULTS_SNAPSHOT = "pixeling_discovery_results_snapshot_v1";

function toISODateDaysAgo(days: number) {
  const d = new Date();
  d.setDate(d.getDate() - Math.max(0, days));
  return d.toISOString();
}

function isoDurationToSeconds(iso: string): number {
  if (!iso || typeof iso !== "string") return 0;
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  const h = Number(m[1] || 0);
  const min = Number(m[2] || 0);
  const s = Number(m[3] || 0);
  return h * 3600 + min * 60 + s;
}

function formatNumber(n: number) {
  if (!Number.isFinite(n)) return "-";
  return n.toLocaleString();
}

function formatKoreanCompact(n: number) {
  if (!Number.isFinite(n)) return "-";
  if (n >= 100_000_000) return `${Math.round(n / 100_000_000)}억`;
  if (n >= 10_000) return `${Math.round(n / 10_000)}만`;
  return n.toLocaleString();
}

function getRegionCodeForApi(r: Region): string | null {
  if (r === "ALL") return null;
  return r;
}

async function ytFetch<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const json = await res.json();
  if (!res.ok) {
    const msg = json?.error?.message || `요청 실패 (HTTP ${res.status})`;
    throw new Error(msg);
  }
  return json as T;
}

function isYouTubeChannelId(s: string) {
  return /^UC[a-zA-Z0-9_-]{10,}$/.test(s);
}

/**
 * excludeHandles는 이제 "handle" 또는 "채널ID(UC...)" 둘 다 저장 가능
 * - @handle, youtube.com/@handle, handle → handle로 저장
 * - /channel/UC... 또는 UC... → UC...로 저장
 */
function parseHandles(text: string): string[] {
  const tokens = text
    .split(/\r?\n|,|\s+/)
    .map((t) => t.trim())
    .filter(Boolean);

  const out: string[] = [];
  for (const raw of tokens) {
    let s = raw;
    try {
      s = decodeURIComponent(s);
    } catch {}

    // youtube.com/channel/UCxxxx
    const ch = s.match(/youtube\.com\/channel\/(UC[a-zA-Z0-9_-]{10,})/i);
    if (ch?.[1]) {
      out.push(ch[1]);
      continue;
    }

    // raw channelId UC...
    if (isYouTubeChannelId(s)) {
      out.push(s);
      continue;
    }

    // @handle
    if (s.startsWith("@") && s.length > 1) {
      out.push(s.slice(1));
      continue;
    }

    // youtube.com/@handle
    const m = s.match(/youtube\.com\/@([^\/\?\#]+)/i);
    if (m?.[1]) {
      out.push(m[1]);
      continue;
    }

    // 그냥 handle
    const m2 = s.match(/^([A-Za-z0-9._-]+)$/);
    if (m2?.[1]) out.push(m2[1]);
  }

  // unique (case-insensitive)
  const seen = new Set<string>();
  const uniq: string[] = [];
  for (const h of out.map((h) => h.trim()).filter(Boolean)) {
    const k = h.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(h);
  }
  return uniq;
}

/**
 * ✅ 추가: 영상 URL(쇼츠/워치/yt.be)에서 videoId 추출
 * - 예: https://www.youtube.com/shorts/CmnrrjOvWAs
 */
function parseVideoIds(text: string): string[] {
  const tokens = text
    .split(/\r?\n|,|\s+/)
    .map((t) => t.trim())
    .filter(Boolean);

  const out: string[] = [];
  for (const raw of tokens) {
    let s = raw;
    try {
      s = decodeURIComponent(s);
    } catch {}

    // youtube.com/shorts/VIDEOID
    const m1 = s.match(/youtube\.com\/shorts\/([a-zA-Z0-9_-]{6,})/i);
    if (m1?.[1]) {
      out.push(m1[1]);
      continue;
    }

    // youtube.com/watch?v=VIDEOID
    const m2 = s.match(/[?&]v=([a-zA-Z0-9_-]{6,})/i);
    if (m2?.[1] && s.includes("youtube.com/watch")) {
      out.push(m2[1]);
      continue;
    }

    // youtu.be/VIDEOID
    const m3 = s.match(/youtu\.be\/([a-zA-Z0-9_-]{6,})/i);
    if (m3?.[1]) {
      out.push(m3[1]);
      continue;
    }
  }

  // unique
  return Array.from(new Set(out));
}

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function saveJson(key: string, value: any) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

function loadHandleIdCache(): Record<string, string> {
  return loadJson<Record<string, string>>(LS_KEY_HANDLE_ID_CACHE, {});
}
function saveHandleIdCache(cache: Record<string, string>) {
  saveJson(LS_KEY_HANDLE_ID_CACHE, cache);
}

function loadCountryCache(): Record<string, string> {
  return loadJson<Record<string, string>>(LS_KEY_CHANNEL_COUNTRY_CACHE, {});
}
function saveCountryCache(cache: Record<string, string>) {
  saveJson(LS_KEY_CHANNEL_COUNTRY_CACHE, cache);
}

function isQuotaError(msg: string) {
  const m = (msg || "").toLowerCase();
  return m.includes("quota") || m.includes("exceeded");
}

/**
 * ✅ IN 제외 강화(보조 필터)
 * - 채널 country가 없는 경우가 매우 많아서 IN이 계속 통과할 수 있음
 * - 이때 "제목/채널명"에 인도권 문자(데바나가리/벵골어/타밀/텔루구/칸나다/말라얄람 등)가 있으면 제외
 */
function looksIndianByScript(text: string) {
  if (!text) return false;
  const re =
    /[\u0900-\u097F\u0980-\u09FF\u0A00-\u0A7F\u0A80-\u0AFF\u0B00-\u0B7F\u0B80-\u0BFF\u0C00-\u0C7F\u0C80-\u0CFF\u0D00-\u0D7F]/;
  return re.test(text);
}

/** ---------------------------
 * JSON 내보내기/가져오기 유틸
 * --------------------------- */
async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * ✅ "어디에 저장할지 지정"은 웹 브라우저 표준으로는
 * - 보통: 다운로드 폴더/브라우저 다운로드 설정을 따름
 * - Chrome/Edge 설정에서 "다운로드 전에 각 파일의 저장 위치 확인"을 켜면
 * 버튼 클릭 시마다 저장 위치 선택 창이 뜸
 *
 * ✅ 코드에서 최대한 "저장 위치 선택"을 직접 띄우려면:
 * - File System Access API(showSaveFilePicker)를 지원하는 브라우저에서만 가능
 * - 이걸 우선 사용하고, 지원 안하면 일반 다운로드로 fallback 함
 */
async function saveJsonWithPickerOrDownload(filename: string, obj: any) {
  const jsonText = JSON.stringify(obj, null, 2);

  // @ts-ignore - showSaveFilePicker는 TS lib에 없을 수 있음
  const picker =
    typeof window !== "undefined" && (window as any).showSaveFilePicker;

  if (picker) {
    try {
      // @ts-ignore
      const handle = await (window as any).showSaveFilePicker({
        suggestedName: filename,
        types: [
          {
            description: "JSON",
            accept: { "application/json": [".json"] },
          },
        ],
      });
      const writable = await handle.createWritable();
      await writable.write(jsonText);
      await writable.close();
      return { ok: true, mode: "picker" as const };
    } catch (e) {
      // 사용자가 취소한 경우 포함 → fallback
    }
  }

  // fallback: 일반 다운로드
  const blob = new Blob([jsonText], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);

  return { ok: true, mode: "download" as const };
}

export default function Page() {
  // ===== settings =====
  const [apiKey, setApiKey] = useState("");
  const [days, setDays] = useState<number>(7);
  const [minViewsMan, setMinViewsMan] = useState<number>(10);
  const [region, setRegion] = useState<Region>("ALL");
  const [videoType, setVideoType] = useState<VideoType>("shorts");
  const [excludeIndia, setExcludeIndia] = useState(true);
  const [excludeIndiaStrong, setExcludeIndiaStrong] = useState(true);

  // exclude channels (handle 또는 channelId 저장)
  const [excludeHandles, setExcludeHandles] = useState<string[]>([]);
  const [excludeInput, setExcludeInput] = useState("");

  // ✅ UI: 제외 채널 칩 숨기기(기본 숨김)
  const [showExcludeList, setShowExcludeList] = useState(false);

  // toast
  const [toast, setToast] = useState<string>("");

  // ===== results =====
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [errMsg, setErrMsg] = useState<string>("");
  const [items, setItems] = useState<VideoItem[]>([]);
  const [visibleCount, setVisibleCount] = useState<number>(PAGE_SIZE);
  const [scanInfo, setScanInfo] = useState<{
    steps: number;
    fetchedIds: number;
    passed: number;
    seedIndex: number;
    seed: string;
  } | null>(null);

  // scan state
  const seedIndexRef = useRef<number>(0);
  const pageTokenRef = useRef<string | null>(null);

  // dedup
  const seenVideoIdsRef = useRef<Set<string>>(new Set());

  // exclude channel ids
  const excludedChannelIdsRef = useRef<Set<string>>(new Set());

  // ✅ “초기 로딩 끝나기 전 저장 금지” (재접속 시 사라짐 버그 원인 제거)
  const hydratedRef = useRef(false);

  // ✅ 결과 스냅샷 복원/저장 제어
  const hydratedResultsRef = useRef(false);

  // 파일 입력 ref
  const importFileRef = useRef<HTMLInputElement | null>(null);

  const publishedAfter = useMemo(() => toISODateDaysAgo(days), [days]);
  const minViews = useMemo(() => (minViewsMan || 0) * 10_000, [minViewsMan]);

  // ---------- load saved settings ----------
  useEffect(() => {
    try {
      const savedKey = localStorage.getItem(LS_KEY_API) || "";
      const savedDays = localStorage.getItem(LS_KEY_DAYS);
      const savedMin = localStorage.getItem(LS_KEY_MIN);
      const savedRegion = localStorage.getItem(LS_KEY_REGION) as Region | null;
      const savedType = localStorage.getItem(LS_KEY_TYPE) as VideoType | null;
      const savedExclIN = localStorage.getItem(LS_KEY_EXCL_IN);
      const savedExclINStrong = localStorage.getItem(LS_KEY_EXCL_IN_STRONG);
      const savedExHandles = localStorage.getItem(LS_KEY_EXCLUDE_HANDLES);

      if (savedKey) setApiKey(savedKey);
      if (savedDays) setDays(Number(savedDays));
      if (savedMin) setMinViewsMan(Number(savedMin));
      if (savedRegion) setRegion(savedRegion);
      if (savedType) setVideoType(savedType);
      if (savedExclIN != null) setExcludeIndia(savedExclIN === "1");
      if (savedExclINStrong != null)
        setExcludeIndiaStrong(savedExclINStrong === "1");
      if (savedExHandles) {
        const arr = JSON.parse(savedExHandles);
        if (Array.isArray(arr))
          setExcludeHandles(arr.map((x) => String(x)).filter(Boolean));
      }

      // ✅ 이제부터 persist 허용
      hydratedRef.current = true;
    } catch {
      hydratedRef.current = true;
    }
  }, []);

  // ---------- persist settings ----------
  useEffect(() => {
    if (!hydratedRef.current) return;
    try {
      localStorage.setItem(LS_KEY_API, apiKey);
      localStorage.setItem(LS_KEY_DAYS, String(days));
      localStorage.setItem(LS_KEY_MIN, String(minViewsMan));
      localStorage.setItem(LS_KEY_REGION, region);
      localStorage.setItem(LS_KEY_TYPE, videoType);
      localStorage.setItem(LS_KEY_EXCL_IN, excludeIndia ? "1" : "0");
      localStorage.setItem(
        LS_KEY_EXCL_IN_STRONG,
        excludeIndiaStrong ? "1" : "0"
      );
      localStorage.setItem(LS_KEY_EXCLUDE_HANDLES, JSON.stringify(excludeHandles));
    } catch {}
  }, [
    apiKey,
    days,
    minViewsMan,
    region,
    videoType,
    excludeIndia,
    excludeIndiaStrong,
    excludeHandles,
  ]);

  // ✅ ---------- restore results snapshot (페이지 나갔다 와도 유지) ----------
  useEffect(() => {
    try {
      const snap = loadJson<any>(LS_KEY_RESULTS_SNAPSHOT, null);
      if (!snap || typeof snap !== "object") {
        hydratedResultsRef.current = true;
        return;
      }

      // settings가 같을 때만 복원 (다르면 혼선 방지)
      const sameSettings =
        snap?.settings?.days === days &&
        snap?.settings?.minViewsMan === minViewsMan &&
        snap?.settings?.region === region &&
        snap?.settings?.videoType === videoType &&
        snap?.settings?.excludeIndia === excludeIndia &&
        snap?.settings?.excludeIndiaStrong === excludeIndiaStrong;

      if (!sameSettings) {
        hydratedResultsRef.current = true;
        return;
      }

      const savedItems = Array.isArray(snap?.items) ? (snap.items as VideoItem[]) : [];
      const savedVisible = Number(snap?.visibleCount || PAGE_SIZE);

      setItems(savedItems);
      setVisibleCount(
        Number.isFinite(savedVisible)
          ? Math.max(PAGE_SIZE, Math.min(savedVisible, savedItems.length || savedVisible))
          : PAGE_SIZE
      );

      const savedScanInfo = snap?.scanInfo ?? null;
      if (savedScanInfo) setScanInfo(savedScanInfo);

      const savedSeedIndex = Number(snap?.seedIndexRef ?? 0);
      const savedPageToken =
        typeof snap?.pageTokenRef === "string" ? (snap.pageTokenRef as string) : null;

      seedIndexRef.current = Number.isFinite(savedSeedIndex) ? savedSeedIndex : 0;
      pageTokenRef.current = savedPageToken;

      const savedSeen = Array.isArray(snap?.seenVideoIds) ? snap.seenVideoIds : [];
      seenVideoIdsRef.current = new Set<string>(
        savedSeen.map((x: any) => String(x)).filter(Boolean)
      );

      hydratedResultsRef.current = true;
    } catch {
      hydratedResultsRef.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    // ✅ settings가 모두 로드된 뒤(= state 반영) 복원되도록 의존성에 둠
    days,
    minViewsMan,
    region,
    videoType,
    excludeIndia,
    excludeIndiaStrong,
  ]);

  // ✅ ---------- persist results snapshot ----------
  useEffect(() => {
    if (!hydratedRef.current) return;
    if (!hydratedResultsRef.current) return;

    try {
      const payload = {
        version: 1,
        savedAt: new Date().toISOString(),
        settings: {
          days,
          minViewsMan,
          region,
          videoType,
          excludeIndia,
          excludeIndiaStrong,
        },
        items,
        visibleCount,
        scanInfo,
        seedIndexRef: seedIndexRef.current,
        pageTokenRef: pageTokenRef.current,
        seenVideoIds: Array.from(seenVideoIdsRef.current),
      };
      saveJson(LS_KEY_RESULTS_SNAPSHOT, payload);
    } catch {}
  }, [
    days,
    minViewsMan,
    region,
    videoType,
    excludeIndia,
    excludeIndiaStrong,
    items,
    visibleCount,
    scanInfo,
  ]);

  // ---------- API ----------
  async function fetchSearchWithSeed(seed: string, pageToken: string | null) {
    const key = apiKey.trim();
    if (!key) throw new Error("YouTube API Key를 입력해주세요.");

    const params = new URLSearchParams();
    params.set("part", "snippet");
    params.set("type", "video");
    params.set("order", "viewCount");
    params.set("maxResults", "50");
    params.set("publishedAfter", publishedAfter);
    params.set("safeSearch", "none");
    params.set("key", key);
    params.set("q", seed);

    const regionCode = getRegionCodeForApi(region);
    if (regionCode) params.set("regionCode", regionCode);
    if (pageToken) params.set("pageToken", pageToken);

    const url = `https://www.googleapis.com/youtube/v3/search?${params.toString()}`;
    return ytFetch<{
      nextPageToken?: string;
      items?: Array<{ id?: { videoId?: string } }>;
    }>(url);
  }

  async function fetchVideosByIds(videoIds: string[]) {
    const key = apiKey.trim();
    if (!key) throw new Error("API Key가 필요합니다.");
    if (videoIds.length === 0) return { items: [] as any[] };

    const params = new URLSearchParams();
    params.set("part", "snippet,statistics,contentDetails");
    params.set("id", videoIds.join(","));
    params.set("maxResults", "50");
    params.set("key", key);

    const url = `https://www.googleapis.com/youtube/v3/videos?${params.toString()}`;
    return ytFetch<{ items?: any[] }>(url);
  }

  // ✅ 추가: videoId → channelId 조회 (exclude 입력에서 쇼츠/워치 URL 지원)
  async function fetchChannelIdsByVideoIds(videoIds: string[]): Promise<string[]> {
    const key = apiKey.trim();
    if (!key) throw new Error("영상 URL로 제외 채널을 추가하려면 API Key가 필요합니다.");

    const out: string[] = [];
    for (let i = 0; i < videoIds.length; i += 50) {
      const chunk = videoIds.slice(i, i + 50);

      const params = new URLSearchParams();
      params.set("part", "snippet");
      params.set("id", chunk.join(","));
      params.set("maxResults", "50");
      params.set("key", key);

      const url = `https://www.googleapis.com/youtube/v3/videos?${params.toString()}`;
      const json = await ytFetch<{ items?: any[] }>(url);

      for (const v of json.items || []) {
        const cid = v?.snippet?.channelId as string | undefined;
        if (cid && isYouTubeChannelId(cid)) out.push(cid);
      }
    }
    return Array.from(new Set(out));
  }

  // ✅ country는 캐시에 없는 것만 조회
  async function fetchCountriesWithCache(
    channelIds: string[]
  ): Promise<Record<string, string | undefined>> {
    const key = apiKey.trim();
    if (!key) return {};

    const cache = loadCountryCache();
    const unique = Array.from(new Set(channelIds)).filter(Boolean);
    const need = unique.filter((id) => cache[id] === undefined);

    const out: Record<string, string | undefined> = {};
    for (const id of unique) {
      const v = cache[id];
      out[id] = v === "" ? undefined : v;
    }
    if (need.length === 0) return out;

    for (let i = 0; i < need.length; i += 50) {
      const chunk = need.slice(i, i + 50);

      const params = new URLSearchParams();
      params.set("part", "snippet");
      params.set("id", chunk.join(","));
      params.set("key", key);

      const url = `https://www.googleapis.com/youtube/v3/channels?${params.toString()}`;
      const json = await ytFetch<{ items?: any[] }>(url);

      for (const ch of json.items || []) {
        const id = ch?.id as string;
        const country = ch?.snippet?.country as string | undefined;
        cache[id] = country ?? "";
        out[id] = country;
      }

      for (const id of chunk) {
        if (cache[id] === undefined) cache[id] = "";
        if (out[id] === undefined) out[id] = undefined;
      }
    }

    saveCountryCache(cache);
    return out;
  }

  async function resolveExcludedChannelIdsFromHandles() {
    const key = apiKey.trim();
    if (!key) throw new Error("API Key가 필요합니다.");

    if (excludeHandles.length === 0) {
      excludedChannelIdsRef.current = new Set();
      return;
    }

    const cache = loadHandleIdCache();
    const out = new Set<string>();

    // ✅ 1) UC... 형태면 API 없이 바로 제외
    const unknownHandles: string[] = [];
    for (const h of excludeHandles) {
      if (isYouTubeChannelId(h)) {
        out.add(h);
        continue;
      }
      const hit = cache[h];
      if (hit) out.add(hit);
      else unknownHandles.push(h);
    }

    // ✅ 2) 나머지는 handle → channelId 변환
    for (const h of unknownHandles) {
      const params = new URLSearchParams();
      params.set("part", "id");
      params.set("forHandle", h);
      params.set("key", key);

      const url = `https://www.googleapis.com/youtube/v3/channels?${params.toString()}`;
      const json = await ytFetch<{ items?: Array<{ id: string }> }>(url);

      const id = json.items?.[0]?.id;
      if (id) {
        cache[h] = id;
        out.add(id);
      }
    }

    saveHandleIdCache(cache);
    excludedChannelIdsRef.current = out;
  }

  function mapAndFilter(videos: any[], countryMap: Record<string, string | undefined>) {
    const excluded = excludedChannelIdsRef.current;

    const mapped: VideoItem[] = (videos || [])
      .map((v: any) => {
        const id = v?.id as string;
        const title = v?.snippet?.title || "(제목 없음)";
        const channelTitle = v?.snippet?.channelTitle || "";
        const channelId = v?.snippet?.channelId || "";
        const publishedAt = v?.snippet?.publishedAt || "";
        const thumbnail =
          v?.snippet?.thumbnails?.medium?.url ||
          v?.snippet?.thumbnails?.default?.url ||
          "";
        const viewCount = Number(v?.statistics?.viewCount || 0);
        const durationSec = isoDurationToSeconds(v?.contentDetails?.duration || "");
        return {
          id,
          title,
          channelTitle,
          channelId,
          publishedAt,
          thumbnail,
          viewCount,
          durationSec,
        };
      })
      .filter((x) => (excluded.size ? !excluded.has(x.channelId) : true))
      .filter((x) => (minViews ? x.viewCount >= minViews : true))
      .filter((x) => {
        const isShort = x.durationSec > 0 && x.durationSec <= 60;
        if (videoType === "shorts") return isShort;
        if (videoType === "normal") return x.durationSec > 60;
        return true;
      })
      .filter((x) => {
        if (!excludeIndia) return true;

        const c = countryMap[x.channelId];
        if (c === "IN") return false;

        if (excludeIndiaStrong) {
          const text = `${x.title} ${x.channelTitle}`.trim();
          if (looksIndianByScript(text)) return false;
        }
        return true;
      })
      .sort((a, b) => b.viewCount - a.viewCount);

    return mapped;
  }

  async function fetchOneScanStep() {
    const seedIndex = seedIndexRef.current;
    const seed = SEEDS[seedIndex] ?? SEEDS[0];
    const token = pageTokenRef.current;

    const search = await fetchSearchWithSeed(seed, token);

    const ids = (search.items || [])
      .map((it) => it?.id?.videoId)
      .filter((x): x is string => Boolean(x))
      .filter((id) => !seenVideoIdsRef.current.has(id));

    for (const id of ids) seenVideoIdsRef.current.add(id);

    const videosJson = await fetchVideosByIds(ids);
    const videos = videosJson.items || [];

    const channelIds = videos.map((v: any) => v?.snippet?.channelId).filter(Boolean);
    const countryMap = excludeIndia ? await fetchCountriesWithCache(channelIds) : {};
    const passed = mapAndFilter(videos, countryMap);

    const nextToken = search.nextPageToken ?? null;
    if (nextToken) pageTokenRef.current = nextToken;
    else {
      seedIndexRef.current = (seedIndexRef.current + 1) % SEEDS.length;
      pageTokenRef.current = null;
    }

    return { seedIndex, seed, fetchedCount: ids.length, passed };
  }

  async function scanUntil(targetTotal: number, maxSteps: number, base: VideoItem[]) {
    let steps = 0;
    let fetchedSum = 0;
    let collected = [...base];

    while (steps < maxSteps && collected.length < targetTotal) {
      const r = await fetchOneScanStep();
      fetchedSum += r.fetchedCount;

      const merged = [...collected, ...r.passed];
      const dedup = new Map<string, VideoItem>();
      for (const it of merged) dedup.set(it.id, it);
      collected = Array.from(dedup.values()).sort((a, b) => b.viewCount - a.viewCount);

      steps += 1;

      setScanInfo((prev) => ({
        steps: (prev?.steps ?? 0) + 1,
        fetchedIds: (prev?.fetchedIds ?? 0) + r.fetchedCount,
        passed: collected.length,
        seedIndex: seedIndexRef.current,
        seed: SEEDS[seedIndexRef.current] ?? "",
      }));
    }

    return collected;
  }

  async function runInitial() {
    setErrMsg("");
    setItems([]);
    setVisibleCount(PAGE_SIZE);
    setScanInfo(null);

    seenVideoIdsRef.current = new Set();
    seedIndexRef.current = 0;
    pageTokenRef.current = null;

    // ✅ 결과 스냅샷도 초기화 (새로 "가져오기" 누르면 이전 결과 덮어쓰기)
    try {
      localStorage.removeItem(LS_KEY_RESULTS_SNAPSHOT);
    } catch {}

    setLoading(true);
    try {
      await resolveExcludedChannelIdsFromHandles();
      const collected = await scanUntil(PREFETCH_TARGET, 25, []);
      setItems(collected);

      if (collected.length === 0) {
        setErrMsg(
          `조건을 만족하는 영상을 못 찾았어요.\n👉 (1) 최근 N일↑ (2) 최소 조회수↓ (3) 유형 '전체'로 바꿔보세요.\n\n※ 그리고 지금 에러가 quota라면: 내일(쿼터 리셋) 또는 새 프로젝트/키가 필요할 수 있어요.`
        );
      }
    } catch (e: any) {
      const msg = e?.message || "알 수 없는 오류가 발생했습니다.";
      setErrMsg(
        isQuotaError(msg)
          ? `쿼터(Quota)를 초과했어요.\n\n해결:\n- (가장 효과) '인도 채널 제외'를 잠시 끄고 수집\n- seed 개수/스캔을 줄여서 천천히 수집\n- 내일(쿼터 리셋) 다시 시도\n\n원문: ${msg}`
          : msg
      );
    } finally {
      setLoading(false);
    }
  }

  async function loadMore() {
    setErrMsg("");

    const nextVisible = visibleCount + PAGE_SIZE;
    if (items.length >= nextVisible) {
      setVisibleCount(nextVisible);
      return;
    }

    setLoadingMore(true);
    try {
      await resolveExcludedChannelIdsFromHandles();
      const targetTotal = Math.max(nextVisible, items.length + 80);
      const collected = await scanUntil(targetTotal, 15, items);
      setItems(collected);
      setVisibleCount(Math.min(nextVisible, collected.length));
    } catch (e: any) {
      const msg = e?.message || "추가 로딩 중 오류가 발생했습니다.";
      setErrMsg(
        isQuotaError(msg)
          ? `쿼터(Quota)를 초과했어요.\n\n해결:\n- '인도 채널 제외' OFF(채널 country 조회가 쿼터를 큼)\n- 내일(쿼터 리셋) 재시도\n\n원문: ${msg}`
          : msg
      );
    } finally {
      setLoadingMore(false);
    }
  }

  // ✅ 2번 수정: 영상 URL도 입력하면 “채널”을 찾아서 제외 목록에 추가
  async function addExcludeFromInput() {
    const text = excludeInput;

    const direct = parseHandles(text); // handle + channelId(UC...) 추출
    const videoIds = parseVideoIds(text); // shorts/watch URL 지원
    const mergedTokens: string[] = [...direct];

    try {
      if (videoIds.length > 0) {
        const chIds = await fetchChannelIdsByVideoIds(videoIds);
        mergedTokens.push(...chIds);
      }

      if (mergedTokens.length === 0) {
        setToast(
          "추가할 값이 없어요. (@handle / UC채널ID / 채널URL / 영상URL) 형태로 넣어주세요."
        );
        setTimeout(() => setToast(""), 1800);
        return;
      }

      setExcludeHandles((prev) => {
        const all = [...prev, ...mergedTokens].filter(Boolean);

        // unique (case-insensitive)
        const seen = new Set<string>();
        const uniq: string[] = [];
        for (const v of all) {
          const k = v.toLowerCase();
          if (seen.has(k)) continue;
          seen.add(k);
          uniq.push(v);
        }
        return uniq;
      });

      setExcludeInput("");
      setToast(
        `제외 채널 추가 완료! (+${
          new Set(mergedTokens.map((x) => x.toLowerCase())).size
        }개)`
      );
      setTimeout(() => setToast(""), 1400);
    } catch (e: any) {
      setToast(e?.message || "제외 채널 추가에 실패했어요.");
      setTimeout(() => setToast(""), 2000);
    }
  }

  function removeExclude(handleOrId: string) {
    setExcludeHandles((prev) => prev.filter((h) => h !== handleOrId));
  }

  // ✅ 1번 수정: 결과 카드에서 바로 “제외 채널 추가” 버튼
  function quickExcludeChannel(channelId: string, channelTitle?: string) {
    if (!channelId) return;

    setExcludeHandles((prev) => {
      const all = [...prev, channelId].filter(Boolean);
      const seen = new Set<string>();
      const uniq: string[] = [];
      for (const v of all) {
        const k = v.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        uniq.push(v);
      }
      return uniq;
    });

    // 즉시 필터가 먹도록 현재 excluded set에도 반영(다음 렌더부터 제외)
    excludedChannelIdsRef.current = new Set([
      ...Array.from(excludedChannelIdsRef.current),
      channelId,
    ]);

    setToast(`제외 채널에 추가됨: ${channelTitle || channelId}`);
    setTimeout(() => setToast(""), 1400);
  }

  const visibleItems = items.slice(0, visibleCount);
  const canShowMore = items.length > visibleCount;

  // ---------------------------
  // 내보내기/가져오기 핸들러 (공유 링크 제거)
  // ---------------------------
  async function handleExportJson() {
    const payload = {
      version: 2,
      type: "pixeling_discovery_exclude_handles",
      createdAt: new Date().toISOString(),
      excludeHandles,
    };
    const r = await saveJsonWithPickerOrDownload("exclude-handles.json", payload);
    if (r.mode === "picker") setToast("내보내기 완료! (저장 위치 선택)");
    else setToast("내보내기 완료! (다운로드 폴더로 저장)");
    setTimeout(() => setToast(""), 1600);
  }

  function triggerImportJson() {
    importFileRef.current?.click();
  }

  async function handleImportFile(file: File | null) {
    if (!file) return;
    try {
      const text = await file.text();
      const json = JSON.parse(text);

      // 1) { excludeHandles: [...] } 형태
      let list: any = json?.excludeHandles;
      // 2) 그냥 배열: [...]
      if (!list && Array.isArray(json)) list = json;

      if (!Array.isArray(list))
        throw new Error("JSON 형식이 올바르지 않아요. excludeHandles 배열이 필요합니다.");

      const parsed = parseHandles(list.map((x) => String(x || "")).join("\n"));

      // ✅ 가져오기 = 덮어쓰기(요청상 유지가 목적이므로 깔끔하게)
      setExcludeHandles(parsed);

      setToast(`가져오기 완료! (${parsed.length}개)`);
      setTimeout(() => setToast(""), 1600);
    } catch (e: any) {
      setToast(e?.message || "가져오기에 실패했어요.");
      setTimeout(() => setToast(""), 2000);
    } finally {
      if (importFileRef.current) importFileRef.current.value = "";
    }
  }

  // ✅ (선택) 제외 리스트 관리용: 현재 목록을 클립보드로 복사
  async function copyExcludeAsText() {
    // handle은 @로, channelId는 그대로
    const text = excludeHandles
      .map((h) => (isYouTubeChannelId(h) ? h : `@${h}`))
      .join("\n");
    const ok = await copyToClipboard(text);
    setToast(ok ? "제외 채널 목록을 복사했어요." : "복사 실패");
    setTimeout(() => setToast(""), 1400);
  }

  return (
    <main className="min-h-screen bg-black text-white px-6 py-10">
      <div className="mx-auto w-full max-w-6xl">
        <div className="flex items-start justify-between gap-6">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold">
              📈 유튜브 쇼츠/일반 인기 영상 발굴
            </h1>
            <p className="mt-2 text-sm text-white/60">
              최근 N일 + 조회수(order=viewCount) 기반으로 <b>seed 다중 스캔</b>하며,{" "}
              {PAGE_SIZE}개씩 계속 보여줍니다. (쿼터 세이프 모드)
            </p>
          </div>

          <button
            type="button"
            onClick={() => history.back()}
            className="h-10 px-4 rounded-lg bg-white/10 hover:bg-white/15 border border-white/10 text-white"
          >
            ← 뒤로
          </button>
        </div>

        <div className="mt-8 grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* ✅ 왼쪽 패널: 스크롤 따라오게 (sticky) */}
          <section className="lg:col-span-1">
            <div className="rounded-2xl bg-white/5 border border-white/10 p-5 lg:sticky lg:top-6">
              <div className="space-y-4">
                <div>
                  <label className="block text-sm text-white/70 mb-2">
                    YouTube API Key (조회용)
                  </label>
                  <input
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="AIza..."
                    className="w-full h-11 px-3 rounded-lg bg-black/40 border border-white/10 outline-none focus:border-white/25"
                  />
                  <p className="mt-2 text-xs text-white/50">
                    * 로컬 저장(localStorage)됩니다. 공유 PC에서는 비우고 사용하세요.
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm text-white/70 mb-2">최근 N일</label>
                    <select
                      value={days}
                      onChange={(e) => setDays(Number(e.target.value))}
                      className="w-full h-11 px-3 rounded-lg bg-black/40 border border-white/10 outline-none focus:border-white/25"
                    >
                      {[1, 3, 7, 14, 30, 90, 180].map((d) => (
                        <option key={d} value={d}>
                          {d}일
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-sm text-white/70 mb-2">최소 조회수</label>
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        min={0}
                        value={minViewsMan}
                        onChange={(e) => setMinViewsMan(Number(e.target.value))}
                        className="w-full h-11 px-3 rounded-lg bg-black/40 border border-white/10 outline-none focus:border-white/25"
                      />
                      <span className="text-sm text-white/60 whitespace-nowrap">
                        만회 이상
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-white/50">예) 10 입력 → 10만회 이상</p>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm text-white/70 mb-2">유형</label>
                    <select
                      value={videoType}
                      onChange={(e) => setVideoType(e.target.value as VideoType)}
                      className="w-full h-11 px-3 rounded-lg bg-black/40 border border-white/10 outline-none focus:border-white/25"
                    >
                      <option value="shorts">쇼츠</option>
                      <option value="normal">일반</option>
                      <option value="all">전체</option>
                    </select>
                    <p className="mt-1 text-xs text-white/50">쇼츠는 “60초 이하”로 판정</p>
                  </div>

                  <div>
                    <label className="block text-sm text-white/70 mb-2">국가/지역</label>
                    <select
                      value={region}
                      onChange={(e) => setRegion(e.target.value as Region)}
                      className="w-full h-11 px-3 rounded-lg bg-black/40 border border-white/10 outline-none focus:border-white/25"
                    >
                      <option value="ALL">제한 없음(기본)</option>
                      <option value="KR">한국 (KR)</option>
                      <option value="US">미국 (US)</option>
                      <option value="JP">일본 (JP)</option>
                    </select>
                    <p className="mt-1 text-xs text-white/50">regionCode는 “편향” 정도로만 동작</p>
                  </div>
                </div>

                <label className="flex items-center gap-2 text-sm text-white/70 select-none">
                  <input
                    type="checkbox"
                    checked={excludeIndia}
                    onChange={(e) => setExcludeIndia(e.target.checked)}
                    className="h-4 w-4 accent-blue-600"
                  />
                  인도 채널 제외 (country=IN)
                </label>

                <label className="flex items-center gap-2 text-sm text-white/70 select-none">
                  <input
                    type="checkbox"
                    checked={excludeIndiaStrong}
                    onChange={(e) => setExcludeIndiaStrong(e.target.checked)}
                    className="h-4 w-4 accent-blue-600"
                    disabled={!excludeIndia}
                    title={!excludeIndia ? "먼저 '인도 채널 제외'를 켜세요" : ""}
                  />
                  IN 제외 강화(제목/채널명 인도권 문자 감지)
                </label>

                <p className="text-xs text-white/45">
                  * IN 제외는 채널 country 조회가 필요해서 쿼터를 더 사용합니다. (캐시로 완화)
                  <br />
                  * 강화 ON이면 country가 없을 때도 인도권 문자가 보이면 추가로 제외합니다.
                </p>

                <button
                  type="button"
                  onClick={runInitial}
                  disabled={loading}
                  className="w-full h-12 rounded-xl bg-blue-600 hover:bg-blue-500 active:bg-blue-700 disabled:opacity-60 text-white font-semibold shadow-lg shadow-blue-600/20 transition"
                >
                  {loading ? "가져오는 중..." : "가져오기"}
                </button>

                {errMsg && (
                  <div className="whitespace-pre-wrap text-sm text-red-300 bg-red-500/10 border border-red-500/20 rounded-xl p-3">
                    {errMsg}
                  </div>
                )}

                {scanInfo && (
                  <div className="text-xs text-white/55 bg-white/5 border border-white/10 rounded-xl p-3">
                    스캔: {scanInfo.steps}스텝 · videoId {scanInfo.fetchedIds}개 · 통과{" "}
                    {scanInfo.passed}개
                    <br />
                    seed: [{scanInfo.seedIndex}] <code>{scanInfo.seed}</code>
                  </div>
                )}

                {/* Exclude channels */}
                <div className="pt-2 border-t border-white/10">
                  <label className="block text-sm text-white/70 mb-2">
                    검색 제외 채널 (무제한)
                  </label>

                  <div className="mb-2 grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={handleExportJson}
                      className="h-10 px-4 rounded-lg bg-white/10 hover:bg-white/15 border border-white/10 text-white"
                    >
                      내보내기(JSON)
                    </button>

                    <button
                      type="button"
                      onClick={triggerImportJson}
                      className="h-10 px-4 rounded-lg bg-white/10 hover:bg-white/15 border border-white/10 text-white"
                    >
                      가져오기(JSON)
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        setExcludeHandles([]);
                        setToast("제외 채널 목록을 비웠어요.");
                        setTimeout(() => setToast(""), 1200);
                      }}
                      className="h-10 px-4 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-white/80"
                    >
                      전체 삭제
                    </button>

                    <button
                      type="button"
                      onClick={copyExcludeAsText}
                      className="h-10 px-4 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-white/80"
                      title="현재 제외 목록(@handle 또는 UC채널ID)을 텍스트로 복사"
                    >
                      목록 복사
                    </button>

                    <input
                      ref={importFileRef}
                      type="file"
                      accept="application/json"
                      className="hidden"
                      onChange={(e) => handleImportFile(e.target.files?.[0] ?? null)}
                    />
                  </div>

                  <textarea
                    value={excludeInput}
                    onChange={(e) => setExcludeInput(e.target.value)}
                    rows={4}
                    placeholder={`@WonderVaultYT
https://www.youtube.com/@Morphine.shorts/shorts
https://www.youtube.com/shorts/CmnrrjOvWAs
UCxxxxxxxxxxxx
...`}
                    className="w-full rounded-lg bg-black/40 border border-white/10 px-3 py-2 outline-none focus:border-white/25 text-sm"
                  />

                  <div className="mt-2 flex gap-2">
                    <button
                      type="button"
                      onClick={addExcludeFromInput}
                      className="h-10 px-4 rounded-lg bg-white/10 hover:bg-white/15 border border-white/10 text-white"
                    >
                      제외 채널 추가
                    </button>

                    <button
                      type="button"
                      onClick={() => setShowExcludeList((v) => !v)}
                      className="h-10 px-4 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-white/80"
                      title="제외된 채널 목록 표시/숨김"
                    >
                      {showExcludeList
                        ? "목록 숨기기"
                        : `목록 보기 (${excludeHandles.length})`}
                    </button>
                  </div>

                  {showExcludeList && excludeHandles.length > 0 && (
                    <div className="mt-3 max-h-40 overflow-auto rounded-lg bg-black/25 border border-white/10 p-2">
                      <div className="flex flex-wrap gap-2">
                        {excludeHandles.map((h) => (
                          <span
                            key={h}
                            className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-black/30 border border-white/10 text-sm"
                          >
                            {isYouTubeChannelId(h) ? h : `@${h}`}
                            <button
                              type="button"
                              onClick={() => removeExclude(h)}
                              className="text-white/60 hover:text-white"
                              aria-label="remove"
                            >
                              ✕
                            </button>
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  <p className="mt-2 text-xs text-white/50">
                    * 재접속해도 localStorage에 유지됩니다.
                    <br />* 다른 PC에서 유지하려면 <b>내보내기(JSON) → 가져오기(JSON)</b>를
                    사용하세요.
                  </p>
                </div>

                <div className="text-xs text-white/45 leading-relaxed">
                  * 쿼터 초과가 뜨면 seed를 더 늘리기 전에, <b>IN 제외 OFF</b>로 먼저 넓게 수집 후
                  필요하면 켜는 게 안전합니다.
                </div>
              </div>
            </div>
          </section>

          {/* Results */}
          <section className="lg:col-span-2 rounded-2xl bg-white/5 border border-white/10 p-5">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">
                결과 ({visibleItems.length} / {items.length})
              </h2>

              <div className="text-xs text-white/50">
                조건: 최근 {days}일 · {minViewsMan}만회↑ ·{" "}
                {videoType === "shorts"
                  ? "쇼츠"
                  : videoType === "normal"
                  ? "일반"
                  : "전체"}
                {excludeIndia ? ` · IN 제외${excludeIndiaStrong ? "(강화)" : ""}` : ""}
                {excludeHandles.length ? ` · 제외 ${excludeHandles.length}` : ""}
              </div>
            </div>

            {visibleItems.length === 0 && !loading && !errMsg && (
              <div className="mt-10 text-center text-white/55 text-sm">
                왼쪽에서 설정 후 <b>가져오기</b>를 눌러주세요.
              </div>
            )}

            <div className="mt-5 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
              {visibleItems.map((v) => {
                const url =
                  v.durationSec > 0 && v.durationSec <= 60
                    ? `https://www.youtube.com/shorts/${v.id}`
                    : `https://www.youtube.com/watch?v=${v.id}`;

                return (
                  <a
                    key={v.id}
                    href={url}
                    target="_blank"
                    rel="noreferrer"
                    className="group rounded-2xl bg-black/35 border border-white/10 hover:border-white/20 hover:bg-black/45 transition overflow-hidden"
                    title="새 창으로 열기"
                  >
                    <div className="aspect-video bg-black/40 overflow-hidden">
                      {v.thumbnail ? (
                        <img
                          src={v.thumbnail}
                          alt={v.title}
                          className="w-full h-full object-cover group-hover:scale-[1.02] transition"
                          loading="lazy"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-white/40 text-sm">
                          No Image
                        </div>
                      )}
                    </div>

                    <div className="p-3">
                      <div className="text-sm font-semibold line-clamp-2">{v.title}</div>

                      <div className="mt-2 flex items-center justify-between gap-2">
                        <div className="text-xs text-white/60 line-clamp-1">
                          {v.channelTitle}
                        </div>

                        {/* ✅ 1번 수정: 카드마다 “제외 채널 추가” 버튼 */}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.preventDefault(); // 링크 이동 방지
                            e.stopPropagation();
                            quickExcludeChannel(v.channelId, v.channelTitle);
                          }}
                          className="shrink-0 h-7 px-2 rounded-md bg-white/10 hover:bg-white/15 border border-white/10 text-[11px] text-white/85"
                          title="이 채널을 제외 목록에 추가"
                        >
                          제외 추가
                        </button>
                      </div>

                      <div className="mt-2 flex items-center justify-between text-[11px] text-white/55">
                        <span>
                          조회수 {formatKoreanCompact(v.viewCount)} ({formatNumber(v.viewCount)})
                        </span>
                        <span>{v.durationSec > 0 && v.durationSec <= 60 ? "쇼츠" : "일반"}</span>
                      </div>

                      <div className="mt-1 text-[11px] text-white/45">
                        {v.publishedAt ? new Date(v.publishedAt).toLocaleString() : ""}
                      </div>
                    </div>
                  </a>
                );
              })}
            </div>

            {/* Load more */}
            <div className="mt-6 flex items-center justify-center">
              {items.length > 0 ? (
                canShowMore ? (
                  <button
                    type="button"
                    onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
                    className="h-11 px-5 rounded-xl bg-white/10 hover:bg-white/15 border border-white/10 text-white"
                  >
                    더 보기 (+{PAGE_SIZE})
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={loadMore}
                    disabled={loadingMore}
                    className="h-11 px-5 rounded-xl bg-white/10 hover:bg-white/15 border border-white/10 text-white disabled:opacity-60"
                  >
                    {loadingMore ? "추가 스캔 중..." : `더 가져오기 (+${PAGE_SIZE})`}
                  </button>
                )
              ) : null}
            </div>

            <div className="mt-4 text-xs text-white/45 leading-relaxed">
              * 지금 에러는 코드 문제가 아니라 <b>API 쿼터 초과</b>일 수 있습니다. seed 스캔은
              쿼터를 많이 쓰므로, 먼저 <b>IN 제외 OFF</b>로 넓게 수집 후 필요하면 켜는 걸
              추천합니다.
            </div>
          </section>
        </div>

        {/* Toast */}
        {toast && (
          <div className="fixed bottom-6 left-1/2 -translate-x-1/2 px-4 py-2 rounded-full bg-black/70 border border-white/15 text-white text-sm shadow-lg">
            {toast}
          </div>
        )}
      </div>
    </main>
  );
}
