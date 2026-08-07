import { NextResponse } from "next/server";
import OpenAI from "openai";
import fs from "fs";
import path from "path";

export async function POST(req: Request) {
  try {
    const { topic } = await req.json();

    if (!process.env.OPENAI_API_KEY) {
      return NextResponse.json({ success: false, error: "API Key가 설정되지 않았습니다." }, { status: 500 });
    }

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const DB_FILE = path.join(process.cwd(), "app/data/knowledge.json");

    // 1. 검증된 로컬 DB 로드
    if (!fs.existsSync(DB_FILE)) {
      return NextResponse.json({ success: false, error: "Knowledge DB 파일이 없습니다." }, { status: 404 });
    }

    const fileData = fs.readFileSync(DB_FILE, "utf8");
    const knowledgeDb: any[] = JSON.parse(fileData);

    if (knowledgeDb.length === 0) {
      return NextResponse.json({ success: true, items: [] });
    }

    // 2. 외부 검색을 끄고, 검증된 DB 내부에서만 매칭 및 정렬
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: `당신은 숏폼 지식 채널 '신비한건축사전'의 Discovery Engine입니다.
제공된 [100% 검증된 Knowledge DB] 내부의 항목들 중에서, 사용자의 검색어 [${topic}]와 가장 잘 어울리고 흥미로운 TOP 5 소재를 선별하세요.

[100% 검증된 Knowledge DB]:
${JSON.stringify(knowledgeDb, null, 2)}

[절대 규칙]:
1. 절대 DB에 없는 새로운 사실이나 수치(숫자)를 지어내거나 변경하지 말 것 (할루시네이션 엄금).
2. DB에 기록된 title_hook, raw_fact, paradox의 정밀 팩트 수치만 그대로 활용할 것.
3. 사용자가 입력한 [${topic}] 키워드와 가장 관련성이 높은 항목을 우선 배치하고, 키워드가 광범위하면 가장 흥미로운 소재 5개를 선별할 것.

JSON Response Format:
{
  "items": [
    {
      "title": "DB의 title_hook 그대로 사용",
      "summary": "DB의 raw_fact와 paradox를 결합한 2줄 요약",
      "score": 98
    }
  ]
}`,
        },
        {
          role: "user",
          content: `검색 키워드: [${topic || "전체"}]`
        },
      ],
      response_format: { type: "json_object" },
    });

    const result = JSON.parse(completion.choices[0].message.content || "{}");

    return NextResponse.json({ success: true, items: result.items || [] });
  } catch (error: any) {
    console.error("❌ Discovery API Error:", error);
    return NextResponse.json({ success: false, error: error?.message || "Failed" }, { status: 500 });
  }
}