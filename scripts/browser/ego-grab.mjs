// 웹 페이지 본문을 근거 파일(txt)로 저장한다. Ego Lite(ego-browser nodejs) 안에서 쓰는 공용 도구다.
// 조사 업무에서 연 페이지를 그대로 남겨 두면, 검증 에이전트가 보고서 주장을 원문과 대조하기 쉽다.
//
// 예: 작업 폴더에 아래 같은 파일을 만들고 ego-browser nodejs -e "await import('file:///<그 파일>')"로 실행한다.
//   import { grab } from "file:///<비서 폴더>/scripts/browser/ego-grab.mjs";
//   await grab([{ name: "remotion-license", url: "https://..." }], { out: "<업무 폴더>/pages", space: "<업무이름>" });
// 파일 머리에 URL·최종 URL·제목·받은 시각(FETCHED, KST)이 붙는다. max는 저장할 글자 수(기본 20000).
//
// 페이지마다 about:blank를 거친다: goto가 실패했을 때 앞 페이지 본문이 다음 이름으로 저장되지 않게 한다.
// load 시간 초과라도 오류 글에 "navigation committed"가 있으면 문서는 이미 떠 있으므로 본문을 읽어 저장한다
// (광고가 많은 언론 페이지가 load까지 가지 않아 FAIL로 빠지던 것을 막는다).
// 본문 상자(article·main 등)의 글이 300자 이하이면 페이지 전체 글을 저장한다.

export async function grab(items, { out, space = "ego-grab" }) {
  const fs = await import("node:fs/promises");
  await fs.mkdir(out, { recursive: true });
  const task = await taskSpace(space);
  const page = task.page("p1");
  console.log({ spaceId: task.spaceId });
  for (const { name, url, max = 20000 } of items) {
    try {
      await page.goto("about:blank").catch(() => {});
      let committedOnly = false;
      try {
        await page.goto(url);
      } catch (e) {
        if (!String(e?.message ?? e).includes("navigation committed")) throw e;
        committedOnly = true; // load를 이미 기다렸다 넘쳤으니 다시 기다리지 않고 조금 더 쉬었다 읽는다
      }
      if (!committedOnly) await page.waitForLoadState("load").catch(() => {});
      await page.waitForTimeout(committedOnly ? 2500 : 1500);
      const text = await page.evaluate(() => {
        const main = document.querySelector("article, main, #readme, .markdown-body") || document.body;
        const t = main.innerText || "";
        return t.length > 300 ? t : document.body.innerText || t;
      });
      const fetched = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Seoul" });
      const head = `URL: ${url}\nFINAL: ${await page.url()}\nTITLE: ${await page.title()}\nFETCHED: ${fetched} KST\n\n`;
      await fs.writeFile(`${out}/${name}.txt`, head + text.slice(0, max), "utf8");
      console.log(`ok ${name} ${text.length} chars`);
    } catch (e) {
      console.log(`FAIL ${name}: ${e.message}`);
    }
  }
}
