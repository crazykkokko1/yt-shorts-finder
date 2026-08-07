import fs from "fs";
import path from "path";
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

if (!process.env.OPENAI_API_KEY) {
  console.error("❌ OPENAI_API_KEY가 .env.local에 설정되어 있지 않습니다.");
  process.exit(1);
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const RAW_DIR = path.join(process.cwd(), "app/data/raw");
const DB_FILE = path.join(process.cwd(), "app/data/knowledge.json");

// 팩트 3요소 자동 정밀 추출기 (Fact Extractor)
async function extractFactFromRawText(text: string, filename: string) {
  console.log(`\n📄 [${filename}] 원천 문서 분석 중...`);

  const prompt = `당신은 숏폼 지식 채널 '신비한건축사전'의 전문 데이터 파서(Data Parser)입니다.
제공된 원천 문서(논문/기술백서/보고서)에서 300만 뷰급 숏폼 소재가 될 수 있는 정교한 공학적/역사적 팩트만 추출하세요.

[엄격한 팩트 추출 3대 필수 조건]:
1. [고유명사/지명]: 반드시 실제 존재하거나 역사적인 장소, 도시, 건물명이 존재할 것. (예: 난지도, 세빛섬, 스카이트리, 세이칸 터널 등)
2. [구체적 수치]: 반드시 시각화 가능한 숫자와 단위가 포함될 것. (예: 9200만 톤, 하루 18만 톤, 59개 기둥, 240m 등)
3. [상식 파괴 Paradox]: 시청자의 일반적 상식과 반대되는 공학적 딜레마나 해결 원리가 명확할 것.

[타이틀(title_hook) 작성 정밀 규칙 - 100만 뷰급 훅 강제]:
1. 지루한 보도자료/뉴스 헤드라인 금지 ("~의 비밀", "~의 현황", "~의 중요성" 사용 시 즉시 탈락).
2. 거대한 숫자는 시청자가 직관적으로 상상할 수 있는 일상 수치로 비유 전환할 것 (예: 18만 톤 -> "매일 수영장 70개 분량", 9200만 톤 -> "쓰레기 9200만 톤").
3. 반드시 [눈앞의 현상/상식] + [반전 팩트] + [~한 이유 / ~한 방법] 형태로 작성할 것.
   - 올바른 예시: "서울 지하철이 매일 수영장 70개 분량의 물을 퍼내는 이유"
   - 잘못된 예시: "지하수 18만 톤의 비밀", "서울 지하철 지하수 유출 현황"

[추출 탈락 기준 (-100점)]:
- 단순 이론 설명문("콘크리트의 강도 원리", "배수로 설치 규정" 등)
- 고유명사나 구체적 숫자가 없는 모호한 글
- 가짜 사실이나 뜬구름 잡는 감성적 미사여구

JSON Response Format:
{
  "valid": true/false,
  "items": [
    {
      "id": "arch_auto_001",
      "category": "건축/토목",
      "location": "지명 또는 건물명",
      "title_hook": "서울 지하철이 매일 수영장 70개 분량의 물을 퍼내는 이유",
      "raw_fact": "구체적 숫자와 명확한 공학 원리가 담긴 2줄 요약",
      "paradox": "눈에 보이는 상식과 실제 공학적 원리의 대립점 설명"
    }
  ]
}`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: `원천 문서 내용:\n${text}` }
      ],
      response_format: { type: "json_object" }
    });

    const result = JSON.parse(response.choices[0].message.content || "{}");
    return result.valid ? result.items || [] : [];
  } catch (error) {
    console.error(`❌ 파싱 오류 (${filename}):`, error);
    return [];
  }
}

async function main() {
  console.log("🚀 [방안 A] Raw Data 파이프라인 구축 및 DB 인덱싱 시작...");

  if (!fs.existsSync(RAW_DIR)) {
    fs.mkdirSync(RAW_DIR, { recursive: true });
  }

  const rawFiles = fs.readdirSync(RAW_DIR).filter(file => file.endsWith(".txt") || file.endsWith(".json"));

  if (rawFiles.length === 0) {
    console.log("⚠️ app/data/raw 폴더에 수집된 원천 파일(.txt)이 없습니다.");
    console.log("💡 논문, 백서, 보고서 텍스트 파일을 app/data/raw/ 폴더에 넣고 스크립트를 재실행해 주세요.");
    return;
  }

  let existingDb: any[] = [];
  if (fs.existsSync(DB_FILE)) {
    try {
      existingDb = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    } catch (e) {
      existingDb = [];
    }
  }

  let newItemsCount = 0;

  for (const file of rawFiles) {
    const filePath = path.join(RAW_DIR, file);
    const content = fs.readFileSync(filePath, "utf8");

    const extractedItems = await extractFactFromRawText(content, file);

    for (const item of extractedItems) {
      const isDuplicate = existingDb.some(dbItem => dbItem.title_hook === item.title_hook);
      if (!isDuplicate) {
        item.id = `arch_extracted_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
        existingDb.push(item);
        newItemsCount++;
        console.log(`   ✅ DB 추가 완료: "${item.title_hook}"`);
      } else {
        console.log(`   ⏭️ 중복 소재 스킵: "${item.title_hook}"`);
      }
    }
  }

  fs.writeFileSync(DB_FILE, JSON.stringify(existingDb, null, 2), "utf8");
  console.log(`\n🎉 파이프라인 처리 완료! 총 ${newItemsCount}개의 정밀 파싱 팩트가 DB(knowledge.json)에 저장되었습니다.`);
  console.log(`📊 현재 DB 총 소재 수: ${existingDb.length}개`);
}

main();