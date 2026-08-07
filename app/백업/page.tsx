"use client";

import { useEffect, useMemo, useState } from "react";

type Platform = "youtube" | "instagram" | "tiktok";
type Country = "KR" | "US" | "JP";

// ✅ 채널 관리 등급과 동일
type Grade = "S" | "A" | "B";

type Channel = {
  id: string;
  platform: Platform;
  category: string;
  country: Country;
  url: string;
  createdAt: string;

  // 가져온 채널 정보(있으면 사용)
  youtubeChannelId?: string;
  title?: string;
  thumbnail?: string;

  // ✅ 채널 관리에서 저장된 등급
  grade?: Grade;
};

type Video = {
  id: string;
  title: string;
  channelTitle: string;
  channelId: string;
  publishedAt: string;
  thumbnail: string;
  viewCount: number;
  likeCount?: number;
  commentCount?: number;
  videoUrl: string;

  // ✅ 60초 미만 필터용
  durationSec?: number;

  // ✅ 카드에 표시할 채널 등급
  grade?: Grade;
};

const CHANNELS_KEY = "pixeling_channels";
const YT_KEY_STORAGE = "pixeling_youtube_api_key";

// ✅ 결과 유지(페이지 나갔다 와도 유지)
const POPULAR_CACHE_KEY = "pixeling_popular_videos_cache_v1";

function formatNumber(n?: number) {
  if (n === undefined || n === null || Number.isNaN(n)) return "-";
  return n.toLocaleString();
}

function toISODateDaysAgo(days: number) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

/** ISO8601 duration(PT#H#M#S) -> seconds */
function isoDurationToSeconds(iso?: string) {
  if (!iso) return 0;
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  const h = Number(m[1] || 0);
  const mm = Number(m[2] || 0);
  const s = Number(m[3] || 0);
  return h * 3600 + mm * 60 + s;
}

function gradeLabel(g?: Grade) {
  const v = (g || "B") as Grade;
  if (v === "S") return "S급";
  if (v === "A") return "A급";
  return "B급";
}

function gradeBadgeClass(g?: Grade) {
  const v = (g || "B") as Grade;
  if (v === "S") return "bg-yellow-500/20 border-yellow-400/30 text-yellow-200";
  if (v === "A") return "bg-emerald-500/20 border-emerald-400/30 text-emerald-200";
  return "bg-sky-500/20 border-sky-400/30 text-sky-200";
}

/**
 * ✅ URL/텍스트에서 /shorts /videos /featured ... suffix 제거하고,
 * channelId(UC...) 또는 handle(@)만 최대한 추출 (search 없이)
 */
function parseYouTubeInputNoSearch(input: string): { channelId?: string; handle?: string } {
  const raw = (input || "").trim();
  if (!raw) return {};

  // ✅ /shorts, /videos, /featured 등 suffix 제거 (URL/텍스트 모두)
  const cleaned = raw
    .replace(/\/(shorts|videos|featured|streams|live)(\/)?(\?.*)?$/i, "")
    .trim();

  // direct UC channel id typed
  if (/^UC[a-zA-Z0-9_-]{10,}$/.test(cleaned)) return { channelId: cleaned };

  // @handle typed
  if (cleaned.startsWith("@")) {
    const h = cleaned.slice(1).trim();
    if (h) return { handle: h };
  }

  // URL
  if (cleaned.includes("youtube.com") || cleaned.startsWith("http")) {
    try {
      const u = new URL(cleaned);
      const path = decodeURIComponent(u.pathname || "");

      // /channel/UCxxxx
      const m1 = path.match(/\/channel\/(UC[a-zA-Z0-9_-]{10,})/);
      if (m1?.[1]) return { channelId: m1[1] };

      // /@handle (뒤에 /shorts 같은 게 붙어도 위에서 제거됨)
      const m2 = path.match(/\/@([^\/\?\#]+)/);
      if (m2?.[1]) return { handle: m2[1].trim() };

      // NOTE: /c/ , /user/ 는 search 없이 안정적으로 channelId로 해석 불가
      return {};
    } catch {
      return {};
    }
  }

  return {};
}

async function ytFetchJson(url: string) {
  const res = await fetch(url);
  const json = await res.json();
  if (!res.ok) {
    const msg = (json?.error?.message || `요청 실패 (HTTP ${res.status})`) as string;
    throw new Error(msg);
  }
  return json;
}

/**
 * ✅ search 없이 채널ID 확보:
 * 1) 이미 저장된 youtubeChannelId 사용
 * 2) URL에서 /channel/UC... 파싱
 * 3) @handle이면 channels.list?forHandle 로 해결
 */
async function resolveYoutubeChannelIdNoSearch(apiKey: string, ch: Channel) {
  const key = apiKey.trim();
  if (!key) throw new Error("YouTube API Key를 입력해줘!");

  if (ch.youtubeChannelId) return ch.youtubeChannelId;

  const parsed = parseYouTubeInputNoSearch(ch.url);
  if (parsed.channelId) return parsed.channelId;

  if (parsed.handle) {
    const url = `https://www.googleapis.com/youtube/v3/channels?part=id&forHandle=${encodeURIComponent(
      parsed.handle
    )}&key=${encodeURIComponent(key)}`;
    const data = await ytFetchJson(url);
    const id = data?.items?.[0]?.id;
    if (id) return id as string;
  }

  throw new Error(
    `채널 ID를 확인할 수 없습니다 (search 없이 처리 중).\n\n` +
      `채널 관리에서 해당 채널을 한 번 "새로고침(유튜브 채널 정보 조회)" 해서 youtubeChannelId를 저장한 뒤 다시 시도해줘!\n\n` +
      `- 채널: ${ch.title || "채널"}\n` +
      `- URL: ${ch.url}`
  );
}

/** ✅ channelId -> uploads playlistId (channels.list) */
async function getUploadsPlaylistId(apiKey: string, channelId: string, chTitle?: string) {
  const key = apiKey.trim();
  if (!key) throw new Error("YouTube API Key를 입력해줘!");

  const url = `https://www.googleapis.com/youtube/v3/channels?part=contentDetails&id=${encodeURIComponent(
    channelId
  )}&key=${encodeURIComponent(key)}`;
  const data = await ytFetchJson(url);

  const uploads = data?.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) {
    throw new Error(
      `업로드 플레이리스트 ID를 가져오지 못했습니다.\n` +
        `- 채널: ${chTitle || "-"}\n` +
        `- channelId: ${channelId}\n\n` +
        `대부분 /c/ 또는 /user/ URL이거나, youtubeChannelId가 저장되지 않은 경우입니다.`
    );
  }
  return uploads as string;
}

/**
 * ✅ uploads playlist에서 최근 업로드 가져오기 (playlistItems.list)
 * - publishedAfter는 없어서: publishedAt으로 직접 필터
 */
async function fetchRecentUploadsNoSearch(
  apiKey: string,
  uploadsPlaylistId: string,
  publishedAfterISO: string,
  maxResults: number
) {
  const key = apiKey.trim();
  const publishedAfterMs = new Date(publishedAfterISO).getTime();

  const out: Array<{
    id: string;
    title: string;
    channelTitle: string;
    channelId: string;
    publishedAt: string;
    thumbnail: string;
    videoUrl: string;
  }> = [];

  let pageToken: string | undefined = undefined;

  // 안전장치: 최대 5페이지(=250개)까지만
  for (let page = 0; page < 5; page++) {
    const url =
      `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails` +
      `&playlistId=${encodeURIComponent(uploadsPlaylistId)}` +
      `&maxResults=50` +
      (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ``) +
      `&key=${encodeURIComponent(key)}`;

    const data = await ytFetchJson(url);
    const items = (data?.items ?? []) as any[];

    for (const it of items) {
      const videoId = (it?.contentDetails?.videoId || "") as string;
      const sn = it?.snippet ?? {};
      const publishedAt = (sn?.publishedAt || "") as string;
      const pMs = publishedAt ? new Date(publishedAt).getTime() : 0;

      if (!videoId || !publishedAt) continue;
      if (pMs < publishedAfterMs) continue;

      out.push({
        id: videoId,
        title: (sn?.title ?? "") as string,
        channelTitle: (sn?.channelTitle ?? "") as string,
        channelId: (sn?.channelId ?? "") as string,
        publishedAt,
        thumbnail: (sn?.thumbnails?.medium?.url || sn?.thumbnails?.default?.url || "") as string,
        videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
      });

      if (out.length >= maxResults) break;
    }

    if (out.length >= maxResults) break;

    pageToken = data?.nextPageToken;
    if (!pageToken) break;
  }

  return out.filter((v) => !!v.id);
}

/**
 * ✅ videos.list로 통계 + 길이(60초 미만 필터용) 같이 가져오기
 */
async function fetchVideoStatsAndDuration(apiKey: string, videoIds: string[]) {
  const chunks: string[][] = [];
  for (let i = 0; i < videoIds.length; i += 50) chunks.push(videoIds.slice(i, i + 50));

  const map = new Map<
    string,
    { viewCount: number; likeCount?: number; commentCount?: number; durationSec: number }
  >();

  for (const chunk of chunks) {
    const res = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=statistics,contentDetails&id=${encodeURIComponent(
        chunk.join(",")
      )}&key=${encodeURIComponent(apiKey)}`
    );
    const data = await res.json();
    if (data?.error?.message) throw new Error(data.error.message);

    const items = (data?.items ?? []) as any[];
    for (const it of items) {
      const id = it?.id as string;
      const st = it?.statistics ?? {};
      const cd = it?.contentDetails ?? {};
      map.set(id, {
        viewCount: Number(st?.viewCount ?? 0),
        likeCount: st?.likeCount !== undefined ? Number(st.likeCount) : undefined,
        commentCount: st?.commentCount !== undefined ? Number(st.commentCount) : undefined,
        durationSec: isoDurationToSeconds(cd?.duration || ""),
      });
    }
  }

  return map;
}

type PopularCachePayload = {
  version: 1;
  savedAt: string;
  params: {
    recentDays: number;
    minViewsMan: string;
  };
  videos: Video[];
};

export default function VideosPage() {
  const [apiKey, setApiKey] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    return localStorage.getItem(YT_KEY_STORAGE) || "";
  });

  const [recentDays, setRecentDays] = useState<number>(7);
  const [minViewsMan, setMinViewsMan] = useState<string>("10");

  const minViews = useMemo(() => {
    const v = Number(minViewsMan);
    if (!Number.isFinite(v) || v < 0) return 0;
    return Math.floor(v * 10000);
  }, [minViewsMan]);

  const [isLoading, setIsLoading] = useState(false);
  const [videos, setVideos] = useState<Video[]>([]);
  const [errorMsg, setErrorMsg] = useState<string>("");

  const channels = useMemo<Channel[]>(() => {
    if (typeof window === "undefined") return [];
    const saved = localStorage.getItem(CHANNELS_KEY);
    return saved ? (JSON.parse(saved) as Channel[]) : [];
  }, []);

  // ✅ 결과 유지: 페이지 들어오면 캐시 복원
  useEffect(() => {
    try {
      const raw = localStorage.getItem(POPULAR_CACHE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as PopularCachePayload;
      if (!parsed || parsed.version !== 1) return;

      if (typeof parsed?.params?.recentDays === "number") setRecentDays(parsed.params.recentDays);
      if (typeof parsed?.params?.minViewsMan === "string") setMinViewsMan(parsed.params.minViewsMan);

      if (Array.isArray(parsed.videos)) setVideos(parsed.videos);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    localStorage.setItem(YT_KEY_STORAGE, apiKey);
  }, [apiKey]);

  const youtubeChannels = useMemo(
    () => channels.filter((c) => c.platform === "youtube"),
    [channels]
  );

  const fetchVideos = async () => {
    setErrorMsg("");
    setVideos([]);

    if (!apiKey.trim()) {
      setErrorMsg("YouTube API Key를 입력해줘!");
      return;
    }
    if (youtubeChannels.length === 0) {
      setErrorMsg("등록된 유튜브 채널이 없습니다. 먼저 채널을 등록해줘!");
      return;
    }

    const publishedAfterISO = toISODateDaysAgo(recentDays);

    setIsLoading(true);
    try {
      // 1) 채널ID 확보 (search 없이)
      const channelIdMap = new Map<string, string>(); // channel.id -> youtubeChannelId
      const failedChannelId: string[] = [];

      for (const ch of youtubeChannels) {
        try {
          const resolved = await resolveYoutubeChannelIdNoSearch(apiKey, ch);
          channelIdMap.set(ch.id, resolved);
        } catch (e: any) {
          failedChannelId.push(`${ch.title || ch.url}\n${e?.message || "채널ID 실패"}`);
        }
      }

      if (channelIdMap.size === 0) {
        throw new Error("모든 채널의 채널ID를 확보하지 못했습니다.\n\n" + failedChannelId.join("\n\n"));
      }

      // ✅ 채널ID -> grade 매핑(카드 표시용)
      const gradeByChannelId = new Map<string, Grade>();
      for (const ch of youtubeChannels) {
        const cid = channelIdMap.get(ch.id);
        if (!cid) continue;
        const g = (ch.grade || "B") as Grade;
        gradeByChannelId.set(cid, g);
      }

      // 2) uploads playlistId 확보 (실패 채널은 스킵)
      const uploadsMap = new Map<string, string>(); // channel.id -> uploadsPlaylistId
      const failedUploads: string[] = [];

      for (const ch of youtubeChannels) {
        const channelId = channelIdMap.get(ch.id);
        if (!channelId) continue;

        try {
          const uploadsId = await getUploadsPlaylistId(apiKey, channelId, ch.title);
          uploadsMap.set(ch.id, uploadsId);
        } catch (e: any) {
          failedUploads.push(`${ch.title || ch.url}\n${e?.message || "uploads 실패"}`);
        }
      }

      if (uploadsMap.size === 0) {
        throw new Error("모든 채널에서 업로드 플레이리스트를 가져오지 못했습니다.\n\n" + failedUploads.join("\n\n"));
      }

      // 3) 각 채널 recent 업로드 가져오기 (playlistItems)
      const rawVideos: Omit<Video, "viewCount">[] = [];
      const failedRecent: string[] = [];

      for (const ch of youtubeChannels) {
        const uploadsId = uploadsMap.get(ch.id);
        if (!uploadsId) continue;

        try {
          const recent = await fetchRecentUploadsNoSearch(apiKey, uploadsId, publishedAfterISO, 15);
          rawVideos.push(...recent);
        } catch (e: any) {
          failedRecent.push(`${ch.title || ch.url}\n${e?.message || "recent 실패"}`);
        }
      }

      // 중복 제거
      const uniq = new Map<string, Omit<Video, "viewCount">>();
      for (const v of rawVideos) uniq.set(v.id, v);
      const uniqueVideos = Array.from(uniq.values());

      if (uniqueVideos.length === 0) {
        const warnings = [...failedChannelId, ...failedUploads, ...failedRecent]
          .filter(Boolean)
          .slice(0, 30);
        const warnText = warnings.length ? `\n\n(참고) 실패한 채널/요청:\n\n${warnings.join("\n\n")}` : "";
        setVideos([]);

        // 조건 자체가 빡세서 0개일 수도 있으니 에러로 막지 않고 안내만
        setErrorMsg(
          "가져올 영상이 없습니다. (최근일/최소조회수 조건을 낮춰보세요.)" + warnText
        );
        return;
      }

      // 4) 통계 + 길이 조회
      const stats = await fetchVideoStatsAndDuration(
        apiKey,
        uniqueVideos.map((v) => v.id)
      );

      // 5) 합치고 필터링 + 정렬
      const merged: Video[] = uniqueVideos
        .map((v) => {
          const st = stats.get(v.id);
          const durationSec = st?.durationSec ?? 0;
          const grade = gradeByChannelId.get(v.channelId);
          return {
            ...v,
            viewCount: st?.viewCount ?? 0,
            likeCount: st?.likeCount,
            commentCount: st?.commentCount,
            durationSec,
            grade,
          };
        })
        // ✅ 60초 미만만(쇼츠 기준: 60초 미만)
        .filter((v) => (v.durationSec ?? 0) > 0 && (v.durationSec ?? 0) < 60)
        .filter((v) => v.viewCount >= minViews)
        .sort((a, b) => b.viewCount - a.viewCount);

      setVideos(merged);

      // ✅ 경고(일부 실패) 있으면 상단에 안내만 띄우기
      const warnings = [...failedChannelId, ...failedUploads, ...failedRecent].filter(Boolean);
      if (warnings.length > 0) {
        setErrorMsg(
          `일부 채널은 건너뛰었습니다:\n\n${warnings.slice(0, 30).join("\n\n")}${
            warnings.length > 30 ? `\n\n...외 ${warnings.length - 30}개` : ""
          }`
        );
      }

      // ✅ 결과 유지: 조건+결과 저장
      const payload: PopularCachePayload = {
        version: 1,
        savedAt: new Date().toISOString(),
        params: { recentDays, minViewsMan },
        videos: merged,
      };
      localStorage.setItem(POPULAR_CACHE_KEY, JSON.stringify(payload));
    } catch (e: any) {
      setErrorMsg(e?.message || "가져오기 중 오류가 발생했어요.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <h1 className="text-2xl font-bold">인기 영상</h1>

        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={() => history.back()}
            className="h-10 px-4 rounded-lg bg-white/10 hover:bg-white/15 border border-white/10 text-white"
          >
            ← 뒤로
          </button>

          <div className="text-xs text-zinc-400">등록 채널: 유튜브 {youtubeChannels.length}개</div>
        </div>
      </div>

      {/* 필터 바 */}
      <div className="mt-6 bg-zinc-900 border border-zinc-800 rounded-xl p-4">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
          {/* API KEY */}
          <div className="md:col-span-2">
            <label className="text-xs text-zinc-400">YouTube API Key (조회용)</label>
            <input
              className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2"
              placeholder="AIzaSy..."
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </div>

          {/* 최근 N일 */}
          <div>
            <label className="text-xs text-zinc-400">최근 N일</label>
            <select
              className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2"
              value={recentDays}
              onChange={(e) => setRecentDays(Number(e.target.value))}
            >
              <option value={1}>1일</option>
              <option value={3}>3일</option>
              <option value={5}>5일</option> 
              <option value={7}>7일</option>
              <option value={14}>14일</option>
              <option value={30}>30일</option>
            </select>
          </div>

          {/* 최소 조회수 (만 단위) */}
          <div>
            <label className="text-xs text-zinc-400">최소 조회수 (만 회)</label>
            <div className="mt-1 flex gap-2">
              <input
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2"
                placeholder="예: 10 (10만 이상)"
                value={minViewsMan}
                onChange={(e) => setMinViewsMan(e.target.value)}
                inputMode="decimal"
              />
            </div>
            <div className="mt-1 text-[11px] text-zinc-500">
              현재 기준: {formatNumber(minViews)}회 이상
            </div>
          </div>
        </div>

        <div className="mt-4 flex justify-end">
          <button
            onClick={fetchVideos}
            disabled={isLoading}
            className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-semibold hover:bg-blue-500 disabled:opacity-60"
          >
            {isLoading ? "가져오는 중..." : "가져오기"}
          </button>
        </div>

        {errorMsg && (
          <div className="mt-3 text-sm text-red-300 whitespace-pre-wrap">{errorMsg}</div>
        )}
      </div>

      {/* 결과 */}
      <div className="mt-6">
        <div className="flex items-center justify-between mb-3">
          <div className="text-sm text-zinc-300">
            결과: <span className="font-semibold">{videos.length}</span>개
          </div>
          <div className="text-xs text-zinc-500">기본 정렬: 조회수 높은 순</div>
        </div>

        {videos.length === 0 && !isLoading && !errorMsg && (
          <div className="text-zinc-500">
            조건에 맞는 영상이 아직 없어요. (최근일/최소조회수 조건을 낮춰봐!)
          </div>
        )}

        {/* 카드 그리드 */}
        <div
          className="gap-4"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 260px))",
            alignItems: "start",
          }}
        >
          {videos.map((v) => (
            <a
              key={v.id}
              href={v.videoUrl}
              target="_blank"
              rel="noreferrer"
              className="block rounded-2xl border border-zinc-800 bg-zinc-950 overflow-hidden hover:border-zinc-600"
            >
              {/* ✅ 썸네일 영역: 등급 배지 오버레이 */}
              <div className="relative aspect-video bg-zinc-800 overflow-hidden">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={v.thumbnail} alt={v.title} className="w-full h-full object-cover" />

                {/* ✅ 등급 배지 (채널 관리에서 지정한 등급) */}
                <div className="absolute left-2 top-2">
                  <span
                    className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] ${gradeBadgeClass(
                      v.grade
                    )}`}
                  >
                    {gradeLabel(v.grade)}
                  </span>
                </div>
              </div>

              <div className="p-3">
                <div className="text-sm font-semibold line-clamp-2">{v.title}</div>
                <div className="mt-2 text-xs text-zinc-400">{v.channelTitle}</div>

                <div className="mt-2 flex items-center justify-between text-xs">
                  <span className="text-zinc-400">
                    {new Date(v.publishedAt).toLocaleDateString()}
                  </span>
                  <span className="font-semibold">{formatNumber(v.viewCount)}회</span>
                </div>
              </div>
            </a>
          ))}
        </div>
      </div>
    </main>
  );
}
