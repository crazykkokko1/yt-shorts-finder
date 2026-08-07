"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type Platform = "youtube" | "instagram" | "tiktok";

// ✅ 이제 Country/Category는 고정 enum이 아니라 string (직접 입력 가능)
type Country = string;
type Category = string;

// ✅ 등급
type Grade = "S" | "A" | "B";
const GRADE_ORDER: Grade[] = ["S", "A", "B"];

const DEFAULT_COUNTRY_OPTIONS: Country[] = ["KR", "US", "JP"];
const DEFAULT_CATEGORY_OPTIONS: Category[] = [
  "지식, 정보",
  "지도, 지형",
  "동물",
  "과학, 교육",
  "자기계발, 운동",
  "음식",
  "유머",
  "여행",
  "미분류",
];

type Channel = {
  id: string;
  platform: Platform;
  category: Category;
  country: Country;

  // ✅ 등급
  grade: Grade;

  url: string;

  createdAt: string;

  // ✅ YouTube는 "채널ID(UC...)" 기반으로만 최적화
  youtubeChannelId?: string;

  title?: string;
  thumbnail?: string;
  subscribers?: number;
  views?: number;
  videos?: number;

  // ✅ 내가 조회한 시간(유지해둠: 정렬/디버그용)
  lastFetchedAt?: string;

  // ✅ 추가: 채널에서 실제로 "최근 업로드"한 시간(표시에 사용)
  lastUploadAt?: string;
};

type SortKey = "created_desc" | "subscribers_desc" | "views_desc" | "updated_desc";

// ✅ 분류 모드: 기본(카테고리 기준) / 등급 기준
type GroupMode = "category" | "grade";
const GROUP_MODE_STORAGE = "pixeling_channels_group_mode";

const CHANNELS_KEY = "pixeling_channels";
const YT_KEY_STORAGE = "pixeling_youtube_api_key";
const SORT_KEY_STORAGE = "pixeling_channels_sort";
const CATEGORY_FILTER_STORAGE = "pixeling_channels_category_filter";

const CUSTOM_VALUE = "__custom__";

// ✅ 내보내기 파일 포맷
type ExportPayload = {
  version: 1;
  exportedAt: string;
  channels: Channel[];
  settings?: {
    apiKey?: string;
    sortKey?: SortKey;
    categoryFilter?: Category | "ALL";
    groupMode?: GroupMode;
  };
};

/* -------------------------
   ✅ 공용 유틸(중복 정의 금지)
-------------------------- */

function formatNumber(n?: number) {
  if (n === undefined || n === null || Number.isNaN(n)) return "-";
  return n.toLocaleString();
}

function stripHtml(s: string) {
  return (s || "").replace(/<[^>]*>/g, "");
}

function countryLabel(c: Country) {
  return (c || "").toUpperCase();
}

function gradeLabel(g?: Grade) {
  const v = g || "B";
  if (v === "S") return "S급";
  if (v === "A") return "A급";
  return "B급";
}

function gradeBadgeClass(g?: Grade) {
  const v = g || "B";
  if (v === "S") return "bg-yellow-500/20 border-yellow-400/30 text-yellow-200";
  if (v === "A") return "bg-emerald-500/20 border-emerald-400/30 text-emerald-200";
  return "bg-sky-500/20 border-sky-400/30 text-sky-200";
}

/** ✅ URL 정규화: host/path 소문자, query/hash 제거, trailing slash 제거 */
function normalizeUrlBasic(input: string) {
  const raw = (input || "").trim();
  if (!raw) return "";

  try {
    const u = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
    const host = u.hostname.toLowerCase();
    let path = decodeURIComponent(u.pathname || "").replace(/\/+$/, "");
    path = path.toLowerCase();
    return `${host}${path}`;
  } catch {
    return raw.replace(/\/+$/, "").toLowerCase();
  }
}

/** ✅ YouTube 채널ID(UC...)만 추출: 입력이 UC... 또는 /channel/UC... URL이면 OK */
function extractYouTubeChannelIdOnly(input: string): string | null {
  const raw = (input || "").trim();
  if (!raw) return null;

  // 1) UC... 자체
  const direct = raw.match(/^(UC[a-zA-Z0-9_-]{10,})$/);
  if (direct?.[1]) return direct[1];

  // 2) URL에서 /channel/UC...
  try {
    const u = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
    const path = decodeURIComponent(u.pathname || "");
    const m = path.match(/\/channel\/(UC[a-zA-Z0-9_-]{10,})/);
    if (m?.[1]) return m[1];
  } catch {
    // ignore
  }

  // 3) 텍스트 안에 UC... 포함한 경우(복붙 대응)
  const anywhere = raw.match(/(UC[a-zA-Z0-9_-]{10,})/);
  if (anywhere?.[1]) return anywhere[1];

  return null;
}

/** ✅ @handle 추출: "@abc", "youtube.com/@abc/shorts" 등에서 abc만 반환 */
function extractYouTubeHandle(input: string): string | null {
  const raw = (input || "").trim();
  if (!raw) return null;

  // 1) "@handle" 형태
  const m0 = raw.match(/^@([A-Za-z0-9._-]{1,})$/);
  if (m0?.[1]) return m0[1];

  // 2) URL 형태에서 "/@handle"
  try {
    const u = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
    const path = decodeURIComponent(u.pathname || "");
    const m = path.match(/\/@([^\/\?\#]+)/);
    if (m?.[1]) return m[1];
  } catch {
    // ignore
  }

  // 3) 텍스트 어딘가에 "@handle" 포함
  const m2 = raw.match(/@([A-Za-z0-9._-]{1,})/);
  if (m2?.[1]) return m2[1];

  return null;
}

/** ✅ 플랫폼별 중복 판정 키 생성 (YouTube는 channelId 기준) */
function getChannelUniqueKey(channel: Channel) {
  if (channel.platform === "youtube") {
    const cid = channel.youtubeChannelId || extractYouTubeChannelIdOnly(channel.url) || "";
    return cid ? `youtube:channel:${cid}` : `youtube:url:${normalizeUrlBasic(channel.url)}`;
  }
  return `${channel.platform}:url:${normalizeUrlBasic(channel.url)}`;
}

async function ytFetchJson(url: string) {
  const res = await fetch(url);
  const json = await res.json();
  if (!res.ok) {
    const msg = stripHtml(json?.error?.message || `요청 실패 (HTTP ${res.status})`);
    throw new Error(msg);
  }
  return json;
}

/** ✅ (추가) handle -> channelId 조회 (channels.list forHandle) */
async function fetchYoutubeChannelIdByHandle(apiKey: string, handle: string): Promise<string | null> {
  const key = apiKey.trim();
  if (!key) throw new Error("YouTube API Key를 입력해줘!");

  const url =
    `https://www.googleapis.com/youtube/v3/channels?part=id&forHandle=${encodeURIComponent(
      handle
    )}&key=${encodeURIComponent(key)}`;

  const data = await ytFetchJson(url);
  const id = data?.items?.[0]?.id as string | undefined;
  return id || null;
}

/** ✅ (추가) 유튜브 입력(UC/채널URL/@handle URL)을 channelId로 통일 */
async function resolveYouTubeChannelId(apiKey: string, input: string): Promise<string | null> {
  // 1) UC... /channel/UC... 먼저
  const cid = extractYouTubeChannelIdOnly(input);
  if (cid) return cid;

  // 2) @handle
  const handle = extractYouTubeHandle(input);
  if (handle) {
    const id = await fetchYoutubeChannelIdByHandle(apiKey, handle);
    if (id) return id;
  }

  return null;
}

/** ✅ (최적화) 채널ID로만 채널 정보 조회 (channels.list) */
async function fetchYoutubeChannelInfoById(apiKey: string, channelId: string) {
  const key = apiKey.trim();
  if (!key) throw new Error("YouTube API Key를 입력해줘!");

  const url =
    `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&id=${encodeURIComponent(
      channelId
    )}&key=${encodeURIComponent(key)}`;

  const data = await ytFetchJson(url);
  const item = data?.items?.[0];
  if (!item) throw new Error(`채널 정보를 가져오지 못했습니다. (ID: ${channelId})`);

  return {
    youtubeChannelId: item.id as string,
    title: (item.snippet?.title ?? "") as string,
    thumbnail:
      (item.snippet?.thumbnails?.high?.url || item.snippet?.thumbnails?.default?.url || "") as string,
    subscribers: Number(item.statistics?.subscriberCount ?? 0),
    views: Number(item.statistics?.viewCount ?? 0),
    videos: Number(item.statistics?.videoCount ?? 0),
  };
}

/** ✅ (최적화) 여러 채널ID를 50개씩 묶어서 한 번에 조회 */
async function fetchYoutubeChannelInfoBatch(apiKey: string, channelIds: string[]) {
  const key = apiKey.trim();
  if (!key) throw new Error("YouTube API Key를 입력해줘!");

  const out = new Map<string, Awaited<ReturnType<typeof fetchYoutubeChannelInfoById>>>();

  const uniq = Array.from(new Set(channelIds.filter(Boolean)));
  for (let i = 0; i < uniq.length; i += 50) {
    const chunk = uniq.slice(i, i + 50);
    const url =
      `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&id=${encodeURIComponent(
        chunk.join(",")
      )}&key=${encodeURIComponent(key)}`;

    const data = await ytFetchJson(url);
    const items = (data?.items ?? []) as any[];
    for (const item of items) {
      const id = item?.id as string;
      if (!id) continue;
      out.set(id, {
        youtubeChannelId: id,
        title: (item.snippet?.title ?? "") as string,
        thumbnail:
          (item.snippet?.thumbnails?.high?.url || item.snippet?.thumbnails?.default?.url || "") as string,
        subscribers: Number(item.statistics?.subscriberCount ?? 0),
        views: Number(item.statistics?.viewCount ?? 0),
        videos: Number(item.statistics?.videoCount ?? 0),
      });
    }
  }

  return out;
}

/* -------------------------
   ✅ 최근 업로드 시간 가져오기(activities.list)
-------------------------- */

/** ✅ 최근 업로드 1개만 가져오기(채널별 1콜) */
async function fetchYoutubeLastUploadAt(apiKey: string, channelId: string): Promise<string | undefined> {
  const key = apiKey.trim();
  if (!key) throw new Error("YouTube API Key를 입력해줘!");

  const url =
    `https://www.googleapis.com/youtube/v3/activities?` +
    `part=snippet,contentDetails&channelId=${encodeURIComponent(channelId)}` +
    `&maxResults=5&key=${encodeURIComponent(key)}`;

  const data = await ytFetchJson(url);
  const items = (data?.items ?? []) as any[];

  // upload 활동을 우선 찾고, 없으면 첫 아이템으로 fallback
  const upload = items.find((x) => x?.contentDetails?.upload?.videoId);
  const picked = upload ?? items[0];

  const publishedAt = picked?.snippet?.publishedAt as string | undefined;
  return publishedAt || undefined;
}

/** ✅ 동시성 제한으로 여러 채널 lastUploadAt 가져오기 */
async function fetchLastUploadMapWithLimit(apiKey: string, channelIds: string[], concurrency = 5) {
  const uniq = Array.from(new Set(channelIds.filter(Boolean)));
  const out = new Map<string, string | undefined>();

  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, uniq.length) }).map(async () => {
    while (i < uniq.length) {
      const idx = i++;
      const cid = uniq[idx];
      try {
        const at = await fetchYoutubeLastUploadAt(apiKey, cid);
        out.set(cid, at);
      } catch {
        out.set(cid, undefined);
      }
    }
  });

  await Promise.all(workers);
  return out;
}

/* -------------------------
   ✅ 카드 그리드(중복 제거)
-------------------------- */

function ChannelGrid(props: {
  list: Channel[];
  isFetching: boolean;
  selectedIds: Set<string>;
  toggleSelected: (id: string) => void;
  onEdit: (id: string) => void;
  onRefreshOne: (id: string) => void;
}) {
  const { list, isFetching, selectedIds, toggleSelected, onEdit, onRefreshOne } = props;

  return (
    <div
      className="gap-4"
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(260px, 280px))",
        alignItems: "start",
      }}
    >
      {list.map((c) => (
        <div key={c.id} className="relative rounded-2xl border border-zinc-800 bg-zinc-950 p-4">
          <label className="absolute left-3 top-3 flex items-center gap-2 text-xs text-zinc-400">
            <input
              type="checkbox"
              checked={selectedIds.has(c.id)}
              onChange={() => toggleSelected(c.id)}
              className="h-4 w-4 accent-blue-600"
            />
          </label>

          {/* 등급 배지 */}
          <div className="absolute left-12 top-3">
            <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs ${gradeBadgeClass(c.grade)}`}>
              {gradeLabel(c.grade)}
            </span>
          </div>

          <div className="absolute right-3 top-3 flex items-center gap-2">
            <button onClick={() => onEdit(c.id)} className="text-xs rounded-lg border border-zinc-700 px-2 py-1 hover:bg-zinc-900">
              수정
            </button>

            {c.platform === "youtube" && (
              <button
                onClick={() => onRefreshOne(c.id)}
                disabled={isFetching}
                className="text-xs rounded-lg border border-zinc-700 px-2 py-1 hover:bg-zinc-900 disabled:opacity-60"
              >
                새로고침
              </button>
            )}
          </div>

          <a href={c.url} target="_blank" rel="noreferrer" className="mt-6 flex flex-col items-center cursor-pointer">
            <div className="h-16 w-16 rounded-full bg-zinc-800 overflow-hidden">
              {c.thumbnail ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={c.thumbnail} alt="thumb" className="h-full w-full object-cover" />
              ) : (
                <div className="h-full w-full" />
              )}
            </div>

            <div className="mt-3 text-center">
              <div className="font-semibold truncate max-w-[220px] hover:underline">{c.title || "채널"}</div>
              <div className="mt-1 text-xs text-zinc-400">
                {c.platform === "youtube" ? "YouTube" : c.platform} · {countryLabel(c.country)} · {c.category || "미분류"} ·{" "}
                {gradeLabel(c.grade)}
              </div>
            </div>
          </a>

          {c.platform === "youtube" ? (
            <div className="mt-4 w-full space-y-2 text-sm">
              <div className="flex justify-between text-zinc-400">
                <span>구독자</span>
                <span className="text-white font-semibold">{formatNumber(c.subscribers)}</span>
              </div>
              <div className="flex justify-between text-zinc-400">
                <span>총 조회수</span>
                <span className="text-white font-semibold">{formatNumber(c.views)}</span>
              </div>
              <div className="flex justify-between text-zinc-400">
                <span>영상 수</span>
                <span className="text-white font-semibold">{formatNumber(c.videos)}</span>
              </div>

              <div className="pt-2 text-[11px] text-zinc-500 text-center">
                최근 업로드: {c.lastUploadAt ? new Date(c.lastUploadAt).toLocaleString() : "-"}
              </div>
            </div>
          ) : (
            <div className="mt-4 text-xs text-zinc-500 text-center">※ 현재는 유튜브만 통계를 조회합니다.</div>
          )}
        </div>
      ))}
    </div>
  );
}

/* -------------------------
   ✅ Page
-------------------------- */

export default function ChannelsPage() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [apiKey, setApiKey] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    return localStorage.getItem(YT_KEY_STORAGE) || "";
  });

  const [platform, setPlatform] = useState<Platform>("youtube");

  // ✅ 등록: 카테고리/국가 - 기본 선택 + 직접입력 모드
  const [categoryPick, setCategoryPick] = useState<string>("미분류");
  const [categoryCustom, setCategoryCustom] = useState<string>("");
  const [countryPick, setCountryPick] = useState<string>("KR");
  const [countryCustom, setCountryCustom] = useState<string>("");

  // ✅ 등록: 등급
  const [gradePick, setGradePick] = useState<Grade>("B");

  const [url, setUrl] = useState("");

  const [channels, setChannels] = useState<Channel[]>(() => {
    if (typeof window === "undefined") return [];
    const saved = localStorage.getItem(CHANNELS_KEY);
    const parsed = saved ? (JSON.parse(saved) as any[]) : [];
    return parsed.map((c) => ({
      ...c,
      createdAt: c.createdAt || new Date().toISOString(),
      category: (c.category as string) || "미분류",
      country: (c.country as string) || "KR",
      grade: (c.grade as Grade) || "B", // ✅ 기존 데이터 호환
      youtubeChannelId:
        (c.youtubeChannelId as string) ||
        (c.platform === "youtube" ? extractYouTubeChannelIdOnly(c.url || "") || undefined : undefined),
      lastUploadAt: (c.lastUploadAt as string) || undefined,
    })) as Channel[];
  });

  const [isFetching, setIsFetching] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());

  const [sortKey, setSortKey] = useState<SortKey>(() => {
    if (typeof window === "undefined") return "created_desc";
    return (localStorage.getItem(SORT_KEY_STORAGE) as SortKey) || "created_desc";
  });

  const [categoryFilter, setCategoryFilter] = useState<Category | "ALL">(() => {
    if (typeof window === "undefined") return "ALL";
    return (localStorage.getItem(CATEGORY_FILTER_STORAGE) as any) || "ALL";
  });

  const [searchText, setSearchText] = useState("");

  // ✅ “원할 때만” 등급별 분류
  const [groupMode, setGroupMode] = useState<GroupMode>(() => {
    if (typeof window === "undefined") return "category";
    return (localStorage.getItem(GROUP_MODE_STORAGE) as GroupMode) || "category";
  });

  // ✅ 편집 모달
  const [editingId, setEditingId] = useState<string | null>(null);
  const editingChannel = useMemo(() => (editingId ? channels.find((c) => c.id === editingId) : null), [editingId, channels]);

  const [editPlatform, setEditPlatform] = useState<Platform>("youtube");
  const [editGradePick, setEditGradePick] = useState<Grade>("B");

  const [editCategoryPick, setEditCategoryPick] = useState<string>("미분류");
  const [editCategoryCustom, setEditCategoryCustom] = useState<string>("");
  const [editCountryPick, setEditCountryPick] = useState<string>("KR");
  const [editCountryCustom, setEditCountryCustom] = useState<string>("");

  const [editUrl, setEditUrl] = useState("");

  useEffect(() => {
    localStorage.setItem(CHANNELS_KEY, JSON.stringify(channels));
  }, [channels]);

  useEffect(() => {
    localStorage.setItem(YT_KEY_STORAGE, apiKey);
  }, [apiKey]);

  useEffect(() => {
    localStorage.setItem(SORT_KEY_STORAGE, sortKey);
  }, [sortKey]);

  useEffect(() => {
    localStorage.setItem(CATEGORY_FILTER_STORAGE, String(categoryFilter));
  }, [categoryFilter]);

  useEffect(() => {
    localStorage.setItem(GROUP_MODE_STORAGE, groupMode);
  }, [groupMode]);

  useEffect(() => {
    setSelectedIds((prev) => {
      const next = new Set<string>();
      const ids = new Set(channels.map((c) => c.id));
      for (const id of prev) if (ids.has(id)) next.add(id);
      return next;
    });
  }, [channels]);

  // ✅ 현재 저장된 값 기반으로 카테고리/국가 옵션 확장
  const categoryOptions = useMemo(() => {
    const set = new Set<string>(DEFAULT_CATEGORY_OPTIONS);
    for (const c of channels) if (c.category?.trim()) set.add(c.category.trim());
    return Array.from(set);
  }, [channels]);

  const countryOptions = useMemo(() => {
    const set = new Set<string>(DEFAULT_COUNTRY_OPTIONS);
    for (const c of channels) if (c.country?.trim()) set.add(c.country.trim().toUpperCase());
    return Array.from(set);
  }, [channels]);

  // 편집 모달 열릴 때 값 세팅
  useEffect(() => {
    if (!editingChannel) return;

    setEditPlatform(editingChannel.platform);
    setEditUrl(editingChannel.url);
    setEditGradePick((editingChannel.grade || "B") as Grade);

    const cat = (editingChannel.category || "미분류").trim();
    if (categoryOptions.includes(cat)) {
      setEditCategoryPick(cat);
      setEditCategoryCustom("");
    } else {
      setEditCategoryPick(CUSTOM_VALUE);
      setEditCategoryCustom(cat);
    }

    const co = (editingChannel.country || "KR").trim().toUpperCase();
    if (countryOptions.includes(co)) {
      setEditCountryPick(co);
      setEditCountryCustom("");
    } else {
      setEditCountryPick(CUSTOM_VALUE);
      setEditCountryCustom(co);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingChannel]);

  const youtubeCount = useMemo(() => channels.filter((c) => c.platform === "youtube").length, [channels]);

  const selectedCount = selectedIds.size;

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => setSelectedIds(new Set(channels.map((c) => c.id)));
  const clearSelection = () => setSelectedIds(new Set());

  const deleteSelected = () => {
    if (selectedIds.size === 0) return;
    if (!confirm(`선택한 채널 ${selectedIds.size}개를 삭제할까요?`)) return;
    setChannels((prev) => prev.filter((c) => !selectedIds.has(c.id)));
    setSelectedIds(new Set());
  };

  // ✅ 등록 시 최종 값 계산
  const finalCategory = useMemo(() => {
    if (categoryPick === CUSTOM_VALUE) return categoryCustom.trim() || "미분류";
    return (categoryPick || "미분류").trim();
  }, [categoryPick, categoryCustom]);

  const finalCountry = useMemo(() => {
    const v = countryPick === CUSTOM_VALUE ? countryCustom.trim() : countryPick;
    return (v || "KR").trim().toUpperCase();
  }, [countryPick, countryCustom]);

  // ✅ (수정) @handle/shorts URL도 등록 가능하게: 필요 시 API 키로 handle->channelId 변환
  const addChannel = async () => {
    if (!url.trim()) {
      alert("채널 주소(URL)를 입력해줘!");
      return;
    }

    let youtubeChannelId: string | undefined = undefined;

    if (platform === "youtube") {
      // 1) UC... /channel/UC... 먼저
      let cid = extractYouTubeChannelIdOnly(url);

      // 2) 없으면 @handle/shorts 등 handle로 시도 (API 키 필요)
      if (!cid) {
        const handle = extractYouTubeHandle(url);
        if (handle) {
          if (!apiKey.trim()) {
            alert(
              "이 주소는 @handle 형식이라 채널ID로 변환이 필요합니다.\n\nYouTube API Key를 입력한 뒤 다시 등록해줘!\n(예: https://www.youtube.com/@sigongstory/shorts)"
            );
            return;
          }
          try {
            cid = await resolveYouTubeChannelId(apiKey, url);
          } catch (e: any) {
            alert(e?.message || "채널ID 변환 중 오류가 발생했어요.");
            return;
          }
        }
      }

      if (!cid) {
        alert(
          "유튜브는 채널ID(UC...)로 등록합니다.\n\n가능한 입력:\n- UC... 형태의 채널ID\n- https://www.youtube.com/channel/UC... 형태의 URL\n- https://www.youtube.com/@handle/shorts (※ API Key 필요)"
        );
        return;
      }
      youtubeChannelId = cid;
    }

    const newChannel: Channel = {
      id: crypto.randomUUID(),
      platform,
      category: finalCategory,
      country: finalCountry,
      grade: gradePick,
      url: platform === "youtube" && youtubeChannelId ? `https://www.youtube.com/channel/${youtubeChannelId}` : url.trim(),
      youtubeChannelId,
      createdAt: new Date().toISOString(),
    };

    // ✅ 중복 채널 등록 방지
    const newKey = getChannelUniqueKey(newChannel);
    const dup = channels.find((c) => getChannelUniqueKey(c) === newKey);
    if (dup) {
      alert(`이미 등록된 채널입니다.\n\n- 기존 채널: ${dup.title || "채널"}\n- URL: ${dup.url}`);
      return;
    }

    setChannels((prev) => [newChannel, ...prev]);
    setUrl("");

    // 입력 UI 리셋
    setCategoryPick("미분류");
    setCategoryCustom("");
    setCountryPick("KR");
    setCountryCustom("");
    setGradePick("B");
  };

  // ✅ 전체 새로고침(유튜브만) — (최적화) 50개씩 배치 호출 + setChannels 1번
  // ✅ + 최근 업로드 시간(lastUploadAt)도 같이 갱신
  const refreshYoutubeInfo = async () => {
    const ytChannels = channels.filter((c) => c.platform === "youtube");
    if (ytChannels.length === 0) {
      alert("유튜브 채널이 없습니다.");
      return;
    }
    if (!apiKey.trim()) {
      alert("YouTube API Key를 먼저 입력해줘!");
      return;
    }

    const missing = ytChannels.filter((c) => !c.youtubeChannelId);
    if (missing.length > 0) {
      alert(
        `채널ID가 없는 유튜브 채널이 ${missing.length}개 있습니다.\n유튜브는 채널ID(UC...) 기반으로만 최적화되어 조회합니다.\n\n(해당 채널들은 건너뜁니다)`
      );
    }

    const ids = ytChannels.map((c) => c.youtubeChannelId).filter(Boolean) as string[];
    if (ids.length === 0) {
      alert("조회할 유튜브 채널ID가 없습니다.");
      return;
    }

    setIsFetching(true);
    try {
      const infoMap = await fetchYoutubeChannelInfoBatch(apiKey, ids);

      // ✅ 추가: 최근 업로드 시간도 가져오기(채널당 1콜, 동시성 제한)
      const uploadMap = await fetchLastUploadMapWithLimit(apiKey, ids, 5);

      const stamp = new Date().toISOString();

      setChannels((prev) =>
        prev.map((c) => {
          if (c.platform !== "youtube") return c;
          const cid = c.youtubeChannelId;
          if (!cid) return c;

          const info = infoMap.get(cid);
          if (!info) return c;

          return {
            ...c,
            ...info,
            lastFetchedAt: stamp,
            lastUploadAt: uploadMap.get(cid) ?? c.lastUploadAt,
          };
        })
      );
    } catch (e: any) {
      alert(e?.message || "조회 중 오류가 발생했어요.");
    } finally {
      setIsFetching(false);
    }
  };

  // ✅ 개별 새로고침(유튜브만) — (최적화) channelId로 바로 channels.list
  // ✅ + 최근 업로드 시간(lastUploadAt)도 같이 갱신
  const refreshOne = async (id: string) => {
    const ch = channels.find((c) => c.id === id);
    if (!ch) return;
    if (ch.platform !== "youtube") return;

    if (!apiKey.trim()) {
      alert("YouTube API Key를 먼저 입력해줘!");
      return;
    }

    const cid = ch.youtubeChannelId;
    if (!cid) {
      alert("이 채널은 채널ID(UC...)가 없습니다. 유튜브는 채널ID로만 조회합니다.");
      return;
    }

    setIsFetching(true);
    try {
      const info = await fetchYoutubeChannelInfoById(apiKey, cid);
      const lastUploadAt = await fetchYoutubeLastUploadAt(apiKey, cid);

      setChannels((prev) =>
        prev.map((c) =>
          c.id === id
            ? {
                ...c,
                ...info,
                lastFetchedAt: new Date().toISOString(),
                lastUploadAt: lastUploadAt ?? c.lastUploadAt,
              }
            : c
        )
      );
    } catch (e: any) {
      alert(e?.message || "조회 중 오류가 발생했어요.");
    } finally {
      setIsFetching(false);
    }
  };

  // ✅ 편집 저장 시 최종 값 계산
  const finalEditCategory = useMemo(() => {
    if (editCategoryPick === CUSTOM_VALUE) return editCategoryCustom.trim() || "미분류";
    return (editCategoryPick || "미분류").trim();
  }, [editCategoryPick, editCategoryCustom]);

  const finalEditCountry = useMemo(() => {
    const v = editCountryPick === CUSTOM_VALUE ? editCountryCustom.trim() : editCountryPick;
    return (v || "KR").trim().toUpperCase();
  }, [editCountryPick, editCountryCustom]);

  // ✅ (수정) 편집에서도 @handle/shorts URL 허용
  const saveEdit = async () => {
    if (!editingId) return;
    if (!editUrl.trim()) {
      alert("URL은 비울 수 없습니다.");
      return;
    }

    // ✅ 유튜브는 채널ID(UC...) 기반으로만 저장/조회
    let nextYoutubeChannelId: string | undefined = undefined;
    let nextUrl = editUrl.trim();

    if (editPlatform === "youtube") {
      let cid = extractYouTubeChannelIdOnly(editUrl);

      if (!cid) {
        const handle = extractYouTubeHandle(editUrl);
        if (handle) {
          if (!apiKey.trim()) {
            alert(
              "이 주소는 @handle 형식이라 채널ID로 변환이 필요합니다.\n\nYouTube API Key를 입력한 뒤 다시 저장해줘!"
            );
            return;
          }
          try {
            cid = await resolveYouTubeChannelId(apiKey, editUrl);
          } catch (e: any) {
            alert(e?.message || "채널ID 변환 중 오류가 발생했어요.");
            return;
          }
        }
      }

      if (!cid) {
        alert(
          "유튜브는 채널ID(UC...)로 수정합니다.\n\n가능한 입력:\n- UC... 형태의 채널ID\n- https://www.youtube.com/channel/UC... 형태의 URL\n- https://www.youtube.com/@handle/shorts (※ API Key 필요)"
        );
        return;
      }

      nextYoutubeChannelId = cid;
      nextUrl = `https://www.youtube.com/channel/${cid}`;
    }

    setChannels((prev) =>
      prev.map((c) => {
        if (c.id !== editingId) return c;

        // ✅ URL/플랫폼이 바뀌면 기존 캐시 정보는 초기화(꼬임 방지 + 불필요 호출 방지)
        const shouldClearYoutubeCache =
          c.platform !== editPlatform ||
          (editPlatform === "youtube" && c.youtubeChannelId !== nextYoutubeChannelId) ||
          c.url.trim() !== nextUrl;

        const cleared = shouldClearYoutubeCache
          ? {
              youtubeChannelId: nextYoutubeChannelId,
              title: undefined,
              thumbnail: undefined,
              subscribers: undefined,
              views: undefined,
              videos: undefined,
              lastFetchedAt: undefined,
              lastUploadAt: undefined,
            }
          : { youtubeChannelId: nextYoutubeChannelId };

        const next: Channel = {
          ...c,
          platform: editPlatform,
          category: finalEditCategory,
          country: finalEditCountry,
          grade: editGradePick,
          url: nextUrl,
          ...cleared,
        };

        return next;
      })
    );

    setEditingId(null);
  };

  const cancelEdit = () => setEditingId(null);

  const filteredAndSortedChannels = useMemo(() => {
    let arr = [...channels];

    if (categoryFilter !== "ALL") {
      arr = arr.filter((c) => (c.category || "미분류") === categoryFilter);
    }

    if (searchText.trim()) {
  const keyword = searchText.toLowerCase();

  arr = arr.filter(
    (c) =>
      (c.title || "").toLowerCase().includes(keyword) ||
      (c.url || "").toLowerCase().includes(keyword)
  );
}

    const byDateDesc = (a: string, b: string) => new Date(b).getTime() - new Date(a).getTime();

    arr.sort((a, b) => {
      if (sortKey === "created_desc") return byDateDesc(a.createdAt, b.createdAt);
      if (sortKey === "updated_desc") {
        const ad = a.lastFetchedAt ? new Date(a.lastFetchedAt).getTime() : -1;
        const bd = b.lastFetchedAt ? new Date(b.lastFetchedAt).getTime() : -1;
        return bd - ad;
      }
      if (sortKey === "subscribers_desc") return (b.subscribers ?? -1) - (a.subscribers ?? -1);
      if (sortKey === "views_desc") return (b.views ?? -1) - (a.views ?? -1);
      return 0;
    });

    return arr;
 }, [channels, sortKey, categoryFilter, searchText]);

  // ✅ (기본) 카테고리별 그룹
  const groupsByCategory = useMemo(() => {
    const map = new Map<string, Channel[]>();
    for (const c of filteredAndSortedChannels) {
      const key = (c.category || "미분류").trim();
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(c);
    }

    const ordered: Array<[string, Channel[]]> = [];
    for (const cat of DEFAULT_CATEGORY_OPTIONS) {
      const list = map.get(cat);
      if (list && list.length) ordered.push([cat, list]);
    }
    for (const [k, v] of map.entries()) {
      if (!DEFAULT_CATEGORY_OPTIONS.includes(k)) ordered.push([k, v]);
    }
    return ordered;
  }, [filteredAndSortedChannels]);

  // ✅ (토글 시) 등급별 그룹
  const groupsByGrade = useMemo(() => {
    const map: Record<Grade, Channel[]> = { S: [], A: [], B: [] };
    for (const c of filteredAndSortedChannels) {
      const g = (c.grade || "B") as Grade;
      map[g].push(c);
    }
    return GRADE_ORDER.map((g) => [g, map[g]] as const).filter(([, list]) => list.length);
  }, [filteredAndSortedChannels]);

  // ✅ JSON 내보내기
  const exportToFile = async () => {
    const payload: ExportPayload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      channels,
      settings: {
        apiKey,
        sortKey,
        categoryFilter,
        groupMode,
      },
    };

    const jsonText = JSON.stringify(payload, null, 2);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `pixeling-channels-${stamp}.json`;

    try {
      const anyWin = window as any;
      if (anyWin?.showSaveFilePicker) {
        const handle = await anyWin.showSaveFilePicker({
          suggestedName: filename,
          types: [{ description: "JSON", accept: { "application/json": [".json"] } }],
        });

        const writable = await handle.createWritable();
        await writable.write(new Blob([jsonText], { type: "application/json;charset=utf-8" }));
        await writable.close();
        return;
      }
    } catch {
      // fallback
    }

    const blob = new Blob([jsonText], { type: "application/json;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  };

  // ✅ JSON 가져오기
  const importFromFile = async (file: File) => {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);

      const incomingChannels: Channel[] = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.channels) ? parsed.channels : [];

      if (!incomingChannels.length) {
        alert("가져올 채널 데이터가 없습니다. (파일 형식을 확인해줘)");
        return;
      }

      const normalizedIncoming = incomingChannels.map((c: any) => {
        const p = ((c.platform as Platform) || "youtube") as Platform;
        const rawUrl = (c.url || "").trim();

        let cid: string | undefined = c.youtubeChannelId as string | undefined;

        if (p === "youtube") {
          cid = cid || extractYouTubeChannelIdOnly(rawUrl) || undefined;
        }

        return {
          ...c,
          id: c.id || crypto.randomUUID(),
          platform: p,
          category: (c.category as string) || "미분류",
          country: ((c.country as string) || "KR").toUpperCase(),
          grade: (c.grade as Grade) || "B",
          url: p === "youtube" && cid ? `https://www.youtube.com/channel/${cid}` : rawUrl,
          youtubeChannelId: cid,
          createdAt: c.createdAt || new Date().toISOString(),
          lastUploadAt: (c.lastUploadAt as string) || undefined,
        } as Channel;
      });

      const existingKeySet = new Set(channels.map((c) => getChannelUniqueKey(c)));

      let added = 0;
      const merged: Channel[] = [...channels];

      for (const c of normalizedIncoming) {
        if (!c.url) continue;
        const key = getChannelUniqueKey(c);
        if (!key) continue;
        if (existingKeySet.has(key)) continue;
        existingKeySet.add(key);
        merged.unshift(c);
        added += 1;
      }

      setChannels(merged);

      const settings = parsed?.settings;
      if (settings) {
        if (typeof settings.apiKey === "string") setApiKey(settings.apiKey);
        if (settings.sortKey) setSortKey(settings.sortKey);
        if (settings.categoryFilter) setCategoryFilter(settings.categoryFilter);
        if (settings.groupMode) setGroupMode(settings.groupMode);
      }

      alert(`가져오기 완료!\n추가된 채널: ${added}개\n(중복은 자동으로 제외됨)`);
    } catch (e: any) {
      alert(e?.message || "가져오기 중 오류가 발생했습니다. 파일을 확인해줘!");
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const openImportPicker = () => fileInputRef.current?.click();

  return (
    <main className="min-h-screen bg-black text-white p-8">
      {/* 상단 바 */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <h1 className="text-2xl font-bold">채널 관리</h1>

        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={() => history.back()}
            className="h-10 px-4 rounded-lg bg-white/10 hover:bg-white/15 border border-white/10 text-white"
          >
            ← 뒤로
          </button>

          <button onClick={exportToFile} className="h-10 px-4 rounded-lg border border-zinc-700 text-sm hover:bg-zinc-900">
            내보내기(JSON)
          </button>

          <button onClick={openImportPicker} className="h-10 px-4 rounded-lg border border-zinc-700 text-sm hover:bg-zinc-900">
            가져오기(JSON)
          </button>

          <input
            ref={fileInputRef}
            type="file"
            accept="application/json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) importFromFile(f);
            }}
          />

          <button
            onClick={refreshYoutubeInfo}
            disabled={isFetching || youtubeCount === 0}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold hover:bg-blue-500 disabled:opacity-60"
          >
            {isFetching ? "조회중..." : "유튜브 채널 정보 조회(전체)"}
          </button>

          <button
            onClick={deleteSelected}
            disabled={selectedIds.size === 0}
            className="rounded-lg border border-zinc-700 px-4 py-2 text-sm hover:bg-zinc-900 disabled:opacity-60"
          >
            선택 삭제 ({selectedCount})
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-6">
        {/* ✅ (수정 1) 왼쪽 '채널 등록' 패널: 스크롤 따라오는 sticky */}
        <div className="md:sticky md:top-6 h-fit self-start">
          <div className="bg-zinc-900 p-5 rounded-xl">
            <h2 className="font-semibold mb-4">채널 등록</h2>

            <label className="text-xs text-zinc-400">YouTube API Key (조회용)</label>
            <input
              className="w-full mt-1 mb-3 bg-zinc-950 p-2 rounded"
              placeholder="AIzaSy..."
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
            <p className="mb-4 text-xs text-zinc-500">
              ※ 등록과 무관합니다. “유튜브 채널 정보 조회(전체)” 버튼을 눌렀을 때만 사용됩니다.
              <br />
              ※ 단, <b>@handle URL 등록</b>은 채널ID 변환에 API Key가 필요합니다.
            </p>

            <label className="text-xs text-zinc-400">플랫폼</label>
            <select
              className="w-full mt-1 mb-3 bg-zinc-950 p-2 rounded"
              value={platform}
              onChange={(e) => setPlatform(e.target.value as Platform)}
            >
              <option value="youtube">유튜브</option>
              <option value="instagram">인스타그램</option>
              <option value="tiktok">틱톡</option>
            </select>

            {/* ✅ 등급 */}
            <label className="text-xs text-zinc-400">등급</label>
            <select
              className="w-full mt-1 mb-3 bg-zinc-950 p-2 rounded"
              value={gradePick}
              onChange={(e) => setGradePick(e.target.value as Grade)}
            >
              <option value="S">S급</option>
              <option value="A">A급</option>
              <option value="B">B급</option>
            </select>

            {/* ✅ 카테고리 */}
            <label className="text-xs text-zinc-400">카테고리</label>
            <select
              className="w-full mt-1 mb-2 bg-zinc-950 p-2 rounded"
              value={categoryPick}
              onChange={(e) => setCategoryPick(e.target.value)}
            >
              {categoryOptions.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
              <option value={CUSTOM_VALUE}>직접 입력...</option>
            </select>

            {categoryPick === CUSTOM_VALUE && (
              <input
                className="w-full mb-3 bg-zinc-950 p-2 rounded"
                placeholder="새 카테고리 입력"
                value={categoryCustom}
                onChange={(e) => setCategoryCustom(e.target.value)}
              />
            )}
            {categoryPick !== CUSTOM_VALUE && <div className="mb-3" />}

            {/* ✅ 국가 */}
            <label className="text-xs text-zinc-400">국가</label>
            <select
              className="w-full mt-1 mb-2 bg-zinc-950 p-2 rounded"
              value={countryPick}
              onChange={(e) => setCountryPick(e.target.value)}
            >
              {countryOptions.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
              <option value={CUSTOM_VALUE}>직접 입력...</option>
            </select>

            {countryPick === CUSTOM_VALUE && (
              <input
                className="w-full mb-3 bg-zinc-950 p-2 rounded"
                placeholder="예: TH, VN, ID..."
                value={countryCustom}
                onChange={(e) => setCountryCustom(e.target.value)}
              />
            )}
            {countryPick !== CUSTOM_VALUE && <div className="mb-3" />}

            <label className="text-xs text-zinc-400">채널 주소(URL)</label>
            <input
              className="w-full mt-1 mb-3 bg-zinc-950 p-2 rounded"
              placeholder="유튜브: UC... /channel/UC... / @handle(/shorts)"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />

            <button onClick={addChannel} className="w-full bg-blue-600 py-2 rounded mt-2 hover:bg-blue-500">
              채널 등록
            </button>
          </div>
        </div>

        {/* 등록된 채널 */}
        <div className="md:col-span-2 bg-zinc-900 p-5 rounded-xl">
          <div className="flex items-start justify-between gap-3 mb-4 flex-wrap">
            <div className="flex items-center gap-3">
              <h2 className="font-semibold">등록된 채널 ({filteredAndSortedChannels.length})</h2>
              <span className="text-xs text-zinc-400">유튜브 {youtubeCount}개</span>
            </div>

            <div className="flex items-center gap-2 flex-wrap justify-end">

  <input
    type="text"
    value={searchText}
    onChange={(e) => setSearchText(e.target.value)}
    placeholder="채널명 검색..."
    className="text-sm rounded-lg bg-zinc-950 border border-zinc-800 px-3 py-2 w-48"
  />

  {/* ✅ "원할 때만" 등급별 분류 */}
  <select
    className="text-sm rounded-lg bg-zinc-950 border border-zinc-800 px-3 py-2"
    value={groupMode}
    onChange={(e) => setGroupMode(e.target.value as GroupMode)}
    title="표시 분류"
  >
              >
                <option value="category">분류: 카테고리</option>
                <option value="grade">분류: 등급(S/A/B)</option>
              </select>

              {/* ✅ 카테고리 필터 */}
              <select
                className="text-sm rounded-lg bg-zinc-950 border border-zinc-800 px-3 py-2"
                value={categoryFilter}
                onChange={(e) => setCategoryFilter(e.target.value as any)}
              >
                <option value="ALL">카테고리: 전체</option>
                {Array.from(new Set(categoryOptions)).map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>

              <select
                className="text-sm rounded-lg bg-zinc-950 border border-zinc-800 px-3 py-2"
                value={sortKey}
                onChange={(e) => setSortKey(e.target.value as SortKey)}
              >
                <option value="created_desc">최신순(등록)</option>
                <option value="updated_desc">최신순(업데이트/조회)</option>
                <option value="subscribers_desc">구독자 순</option>
                <option value="views_desc">조회수 순</option>
              </select>

              {filteredAndSortedChannels.length > 0 && (
                <>
                  <button onClick={selectAll} className="text-xs rounded-lg border border-zinc-700 px-3 py-2 hover:bg-zinc-900">
                    전체 선택
                  </button>
                  <button onClick={clearSelection} className="text-xs rounded-lg border border-zinc-700 px-3 py-2 hover:bg-zinc-900">
                    선택 해제
                  </button>
                </>
              )}
            </div>
          </div>

          {filteredAndSortedChannels.length === 0 && <p className="text-zinc-500">아직 등록된 채널이 없습니다.</p>}

          <div className="space-y-6">
            {groupMode === "category" &&
              groupsByCategory.map(([cat, list]) => (
                <div key={cat}>
                  <div className="mb-3 flex items-center justify-between">
                    <div className="text-sm font-semibold text-white/90">
                      {cat} <span className="text-xs text-zinc-400">({list.length})</span>
                    </div>
                  </div>

                  <ChannelGrid
                    list={list}
                    isFetching={isFetching}
                    selectedIds={selectedIds}
                    toggleSelected={toggleSelected}
                    onEdit={(id) => setEditingId(id)}
                    onRefreshOne={refreshOne}
                  />
                </div>
              ))}

            {groupMode === "grade" &&
              groupsByGrade.map(([g, list]) => (
                <div key={g}>
                  <div className="mb-3 flex items-center gap-2">
                    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs ${gradeBadgeClass(g)}`}>
                      {gradeLabel(g)}
                    </span>
                    <span className="text-xs text-zinc-400">({list.length})</span>
                  </div>

                  <ChannelGrid
                    list={list}
                    isFetching={isFetching}
                    selectedIds={selectedIds}
                    toggleSelected={toggleSelected}
                    onEdit={(id) => setEditingId(id)}
                    onRefreshOne={refreshOne}
                  />
                </div>
              ))}
          </div>
        </div>
      </div>

      {/* ✅ 수정 모달 */}
      {editingId && editingChannel && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
          <div className="w-full max-w-xl rounded-2xl bg-zinc-950 border border-zinc-800 p-5">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold">채널 수정</h3>
              <button onClick={cancelEdit} className="text-sm text-zinc-300 hover:text-white">
                ✕
              </button>
            </div>

            <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-zinc-400">플랫폼</label>
                <select
                  className="w-full mt-1 bg-zinc-900 border border-zinc-800 p-2 rounded"
                  value={editPlatform}
                  onChange={(e) => setEditPlatform(e.target.value as Platform)}
                >
                  <option value="youtube">유튜브</option>
                  <option value="instagram">인스타그램</option>
                  <option value="tiktok">틱톡</option>
                </select>
              </div>

              {/* ✅ 등급 */}
              <div>
                <label className="text-xs text-zinc-400">등급</label>
                <select
                  className="w-full mt-1 bg-zinc-900 border border-zinc-800 p-2 rounded"
                  value={editGradePick}
                  onChange={(e) => setEditGradePick(e.target.value as Grade)}
                >
                  <option value="S">S급</option>
                  <option value="A">A급</option>
                  <option value="B">B급</option>
                </select>
              </div>

              {/* ✅ 국가 */}
              <div>
                <label className="text-xs text-zinc-400">국가</label>
                <select
                  className="w-full mt-1 bg-zinc-900 border border-zinc-800 p-2 rounded"
                  value={editCountryPick}
                  onChange={(e) => setEditCountryPick(e.target.value)}
                >
                  {countryOptions.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                  <option value={CUSTOM_VALUE}>직접 입력...</option>
                </select>
                {editCountryPick === CUSTOM_VALUE && (
                  <input
                    className="w-full mt-2 bg-zinc-900 border border-zinc-800 p-2 rounded"
                    value={editCountryCustom}
                    onChange={(e) => setEditCountryCustom(e.target.value)}
                    placeholder="예: TH, VN, ID..."
                  />
                )}
              </div>

              {/* ✅ 카테고리 */}
              <div className="sm:col-span-2">
                <label className="text-xs text-zinc-400">카테고리</label>
                <select
                  className="w-full mt-1 bg-zinc-900 border border-zinc-800 p-2 rounded"
                  value={editCategoryPick}
                  onChange={(e) => setEditCategoryPick(e.target.value)}
                >
                  {categoryOptions.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                  <option value={CUSTOM_VALUE}>직접 입력...</option>
                </select>
                {editCategoryPick === CUSTOM_VALUE && (
                  <input
                    className="w-full mt-2 bg-zinc-900 border border-zinc-800 p-2 rounded"
                    value={editCategoryCustom}
                    onChange={(e) => setEditCategoryCustom(e.target.value)}
                    placeholder="새 카테고리 입력"
                  />
                )}
              </div>

              <div className="sm:col-span-2">
                <label className="text-xs text-zinc-400">채널 주소(URL)</label>
                <input
                  className="w-full mt-1 bg-zinc-900 border border-zinc-800 p-2 rounded"
                  value={editUrl}
                  onChange={(e) => setEditUrl(e.target.value)}
                  placeholder="유튜브: UC... /channel/UC... / @handle(/shorts)"
                />
                <p className="mt-2 text-xs text-zinc-500">
                  * 유튜브는 채널ID(UC...) 기준으로 저장/조회합니다. URL을 바꾸면 기존 캐시 정보는 초기화됩니다.
                  <br />
                  * <b>@handle URL</b>은 채널ID 변환에 API Key가 필요합니다.
                </p>
              </div>
            </div>

            <div className="mt-5 flex items-center justify-end gap-2">
              <button onClick={cancelEdit} className="rounded-lg border border-zinc-700 px-4 py-2 text-sm hover:bg-zinc-900">
                취소
              </button>
              <button onClick={saveEdit} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold hover:bg-blue-500">
                저장
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
