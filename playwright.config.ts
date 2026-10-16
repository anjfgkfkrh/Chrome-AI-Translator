import { defineConfig } from "@playwright/test";

export default defineConfig({
  // 테스트마다 확장 프로그램을 새로 설치한 브라우저를 띄우므로 하나씩 실행한다.
  workers: 1,
  reporter: "list",
  // headless shell은 설치하지 않았으므로 전체 Chromium을 쓴다.
  use: { channel: "chromium" },
  projects: [
    // 픽스처와 목 API만 쓴다. 인터넷 없이 돈다 (npm run test:e2e).
    { name: "e2e", testDir: "tests/e2e" },
    // SPEC 10.3: 실제 사이트 + 목 API. 인터넷이 필요하다 (npm run test:live, SPEC 13장).
    { name: "live", testDir: "tests/live" },
  ],
});
