import { execSync } from "child_process";

async function runAutoPipeline() {
  console.log("=========================================");
  console.log("🚀 [자동화 파이프라인] 전문 원천 수집 및 DB 인덱싱 시작");
  console.log("=========================================\n");

  try {
    // 1단계: 외부 전문 학회/백서 데이터 자동 수집
    console.log("Step 1. 전문 원천 보고서 자동 수집 중...");
    execSync("npx tsx scripts/scrape-reports.ts", { stdio: "inherit" });

    console.log("\n-----------------------------------------");

    // 2단계: 팩트 3요소 정밀 추출 및 DB 인덱싱
    console.log("Step 2. Raw Data 정밀 파싱 및 knowledge.json DB 누적 중...");
    execSync("npx tsx scripts/build-db.ts", { stdio: "inherit" });

    console.log("\n=========================================");
    console.log("🎉 [파이프라인 완료] DB가 성공적으로 업데이트되었습니다.");
    console.log("=========================================");
  } catch (error) {
    console.error("❌ 파이프라인 실행 중 에러 발생:", error);
  }
}

runAutoPipeline();