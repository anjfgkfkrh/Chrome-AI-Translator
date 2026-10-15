import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  // 테스트마다 확장 프로그램을 새로 설치한 브라우저를 띄우므로 하나씩 실행한다.
  workers: 1,
  reporter: "list",
  // headless shell은 설치하지 않았으므로 전체 Chromium을 쓴다.
  use: { channel: "chromium" },
});
