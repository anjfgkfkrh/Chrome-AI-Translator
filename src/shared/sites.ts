// 사이트별 자동 번역의 사이트 = 출처(origin) 그대로 (SPEC 13장 "자동 번역 사이트 범위").

/** http·https 페이지의 출처. 그 밖의 주소(chrome://, file:// 등)는 자동 번역 대상이 아니므로 undefined */
export function pageOrigin(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}

/** 출처의 모든 페이지에 맞는 권한·등록 패턴. 포트를 적으면 그 포트만 맞는다 (Chrome 일치 패턴). */
export function originPattern(origin: string): string {
  return `${origin}/*`;
}
