// 사이트별 자동 번역으로 등록한 콘텐츠 스크립트에서만 content.js보다 먼저 돈다 (SPEC 4.8).
// content.js는 이 표시를 보고, API 키가 없으면 알림 없이 건너뛴다 (SPEC 13장).
(globalThis as { __aitranslatorAutoRun?: boolean }).__aitranslatorAutoRun = true;
