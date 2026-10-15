// 확장 프로그램 빌드: src → dist (압축해제된 확장 프로그램)
// 사용법: node scripts/build.mjs [--watch] [--test]
//   --test: E2E 테스트용 빌드를 dist-test에 만든다. manifest에 TEST_HOSTS 접근 권한만 더한다.
import * as esbuild from "esbuild";
import { watch as watchFs } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const watching = process.argv.includes("--watch");
const testBuild = process.argv.includes("--test");
const outdir = path.join(root, testBuild ? "dist-test" : "dist");

// 테스트용 빌드에만 넣는 접근 권한 (SPEC 13장): Playwright가 응답하는 픽스처 주소, 실제 페이지 번역 테스트
const TEST_HOSTS = ["http://aitranslator.test/*", "https://docs.langchain.com/*"];

// 엔트리마다 파일 하나로 묶는다. 콘텐츠 스크립트는 import를 쓸 수 없으므로 IIFE로 묶는다.
const builds = [
  {
    format: "esm",
    entryPoints: [
      { in: "src/background/index.ts", out: "background" },
      { in: "src/options/options.ts", out: "options/options" },
      { in: "src/popup/popup.ts", out: "popup/popup" },
    ],
  },
  {
    format: "iife",
    entryPoints: [{ in: "src/content/index.ts", out: "content" }],
  },
];

// 번들하지 않고 그대로 복사하는 파일: [원본, dist 안의 경로]
const staticFiles = [
  ["manifest.json", "manifest.json"],
  ["src/options/options.html", "options/options.html"],
  ["src/options/options.css", "options/options.css"],
  ["src/popup/popup.html", "popup/popup.html"],
  ["src/popup/popup.css", "popup/popup.css"],
];

const common = {
  absWorkingDir: root,
  outdir,
  bundle: true,
  target: "es2022",
  sourcemap: true,
  logLevel: "info",
};

async function copyStatic() {
  for (const [from, to] of staticFiles) {
    const dest = path.join(outdir, to);
    await mkdir(path.dirname(dest), { recursive: true });
    if (testBuild && to === "manifest.json") await writeFile(dest, await testManifest());
    else await cp(path.join(root, from), dest);
  }
}

async function testManifest() {
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  manifest.host_permissions = [...manifest.host_permissions, ...TEST_HOSTS];
  return JSON.stringify(manifest, null, 2);
}

await rm(outdir, { recursive: true, force: true });
await copyStatic();

if (watching) {
  for (const build of builds) {
    const ctx = await esbuild.context({ ...common, ...build });
    await ctx.watch();
  }
  // HTML·CSS·manifest는 esbuild가 감시하지 않으므로 폴더를 직접 감시한다.
  const watched = new Set(staticFiles.map(([from]) => path.join(root, from)));
  for (const dir of new Set([...watched].map((file) => path.dirname(file)))) {
    watchFs(dir, (_event, name) => {
      if (name && watched.has(path.join(dir, name))) copyStatic().catch(console.error);
    });
  }
} else {
  await Promise.all(builds.map((build) => esbuild.build({ ...common, ...build })));
}
