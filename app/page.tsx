"use client";

import { useRouter } from "next/navigation";

export default function HomePage() {
  const router = useRouter();

  return (
    <main className="min-h-screen flex items-center justify-center px-6 bg-black text-white">
      {/* ↑ 기본 배경을 블랙으로 고정 */}

      <div className="w-full max-w-4xl text-center">
        <h1 className="text-5xl sm:text-6xl font-bold tracking-tight">
          Pixeling
        </h1>

        <p className="mt-4 text-sm sm:text-base text-white/70">
          등록한 채널에서 최신 인기 영상만 모아봅니다.
        </p>

        <div className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-4 flex-wrap">
          {/* 1) 채널 관리 */}
          <button
            type="button"
            onClick={() => router.push("/channels")}
            className="w-40 h-12 rounded-xl bg-blue-600 hover:bg-blue-500 active:bg-blue-700 text-white font-semibold shadow-lg shadow-blue-600/20 transition"
          >
            채널 관리
          </button>

          {/* 2) 인기영상 (videos 폴더) */}
          <button
            type="button"
            onClick={() => router.push("/videos")}
            className="w-40 h-12 rounded-xl bg-white/10 hover:bg-white/15 active:bg-white/20 text-white font-semibold border border-white/15 transition"
          >
            인기영상
          </button>

          {/* 3) 유튜브 검색 */}
          <button
            type="button"
            onClick={() => router.push("/search")}
            className="w-40 h-12 rounded-xl bg-white/10 hover:bg-white/15 active:bg-white/20 text-white font-semibold border border-white/15 transition"
          >
            유튜브 검색
          </button>

          {/* 4) 소재 발굴 (신규 추가!) */}
          <button
            type="button"
            onClick={() => router.push("/discovery")}
            className="w-40 h-12 rounded-xl bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 text-white font-semibold shadow-lg shadow-emerald-600/20 transition flex items-center justify-center gap-1.5"
          >
            <span>🔍</span> 소재 발굴
          </button>
        </div>
      </div>
    </main>
  );
}