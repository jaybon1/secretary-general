// 웹 페이지 본문을 근거 파일(txt)로 저장한다. Ego Lite(ego-browser nodejs) 안에서 쓰는 선택 도구다(Ego Lite가 설치돼 있을 때만).
// 조사 업무에서 연 페이지를 그대로 남겨 두면, 검증 에이전트가 보고서 주장을 원문과 대조하기 쉽다.
//
// 예: 작업 폴더에 아래 같은 파일을 만들고 ego-browser nodejs -e "await import('file:///<그 파일>')"로 실행한다.
//   import { grab } from "file:///<비서 폴더>/scripts/ego-grab.mjs";
//   await grab([{ name: "remotion-license", url: "https://..." }], { out: "C:/.../work/pages", space: "<업무이름>" });
// 파일 머리에 URL·최종 URL·제목이 붙는다. max는 저장할 글자 수(기본 20000).

export async function grab(items, { out, space = "ego-grab" }) {
  const fs = await import("node:fs/promises");
  await fs.mkdir(out, { recursive: true });
  const task = await taskSpace(space);
  const page = task.page("p1");
  console.log({ spaceId: task.spaceId });
  for (const { name, url, max = 20000 } of items) {
    try {
      await page.goto(url);
      await page.waitForLoadState("load").catch(() => {});
      await page.waitForTimeout(1500);
      const text = await page.evaluate(() => {
        const main = document.querySelector("article, main, #readme, .markdown-body") || document.body;
        return main.innerText;
      });
      const head = `URL: ${url}\nFINAL: ${await page.url()}\nTITLE: ${await page.title()}\n\n`;
      await fs.writeFile(`${out}/${name}.txt`, head + text.slice(0, max), "utf8");
      console.log(`ok ${name} ${text.length} chars`);
    } catch (e) {
      console.log(`FAIL ${name}: ${e.message}`);
    }
  }
}
