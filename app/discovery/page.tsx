"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function DiscoveryPage() {
  const router = useRouter();
  const [topic, setTopic] = useState("");
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<any[]>([]);

  const handleSearch = async () => {
    if (!topic.trim()) return alert("주제를 입력해주세요!");
    setLoading(true);
    setResults([]);

    try {
      const response = await fetch("/api/discovery", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic }),
      });

      const data = await response.json();
      if (data.success) {
        setResults(data.items);
      } else {
        alert("소재를 찾아오는데 실패했습니다.");
      }
    } catch (error) {
      console.error(error);
      alert("오류가 발생했습니다.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="min-h-screen bg-black text-white px-6 py-12">
      <div className="max-w-4xl mx-auto">
        {/* 상단 헤더 & 뒤로가기 */}
        <div className="flex items-center justify-between mb-8">
          <button
            onClick={() => router.push("/")}
            className="text-sm text-white/60 hover:text-white transition"
          >
            ← 메인으로 돌아가기
          </button>
          <span className="text-xs font-semibold px-3 py-1 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
            Discovery Engine v1.0
          </span>
        </div>

        <h1 className="text-3xl sm:text-4xl font-bold tracking-tight">
          🔍 AI 소재 발굴 엔진
        </h1>
        <p className="mt-2 text-white/60 text-sm sm:text-base">
          주제를 입력하면 Tavily 실시간 검색과 GPT-4o가 흥미로운 숏폼 알짜 소재를 발굴합니다.
        </p>

        {/* 검색 입력창 */}
        <div className="mt-8 flex flex-col sm:flex-row gap-3">
          <input
            type="text"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            placeholder="예: 건축, 의학, 조선 역사..."
            className="flex-1 h-12 px-4 rounded-xl bg-white/5 border border-white/10 text-white placeholder-white/30 focus:outline-none focus:border-emerald-500 transition"
          />
          <button
            type="button"
            onClick={handleSearch}
            disabled={loading}
            className="h-12 px-8 rounded-xl bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 disabled:bg-white/10 text-white font-semibold shadow-lg shadow-emerald-600/20 transition flex items-center justify-center min-w-[130px]"
          >
            {loading ? "발굴 중..." : "소재 찾기"}
          </button>
        </div>

        {/* 결과 영역 */}
        <div className="mt-12">
          {results.length > 0 && (
            <h2 className="text-xl font-bold mb-6 flex items-center gap-2">
              <span className="text-emerald-400">TOP {results.length}</span> 발굴 소재 리스트
            </h2>
          )}

          <div className="flex flex-col gap-4">
            {results.map((item, index) => (
              <div
                key={index}
                className="p-6 rounded-2xl bg-white/5 border border-white/10 hover:border-white/20 transition"
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-bold text-emerald-400 bg-emerald-500/10 px-2.5 py-1 rounded-md border border-emerald-500/20">
                    SCORE: {item.score}점
                  </span>
                </div>
                <h3 className="text-lg font-bold text-white mb-2">
                  {item.title}
                </h3>
                <p className="text-sm text-white/70 leading-relaxed">
                  {item.summary}
                </p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </main>
  );
}