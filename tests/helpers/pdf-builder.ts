// 테스트용 PDF를 코드로 만든다. Helvetica(라틴 문자)만 쓰며 쪽은 모두 US Letter(612×792)다.

export interface PdfRun {
  text: string;
  x: number;
  /** PDF 좌표: 아래에서 위로 */
  y: number;
  size: number;
}

export function buildPdf(pages: readonly (readonly PdfRun[])[]): Buffer {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  const add = (body: string) => objects.push(body);
  const kids: number[] = [];
  for (const runs of pages) {
    const content = runs
      .map(({ text, x, y, size }) => `BT /F1 ${size} Tf ${x} ${y} Td (${text.replace(/[\\()]/g, "\\$&")}) Tj ET`)
      .join("\n");
    const contents = add(`<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`);
    kids.push(
      add(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contents} 0 R >>`,
      ),
    );
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.map((kid) => `${kid} 0 R`).join(" ")}] /Count ${kids.length} >>`;

  let output = "%PDF-1.4\n";
  const offsets = objects.map((body, index) => {
    const offset = output.length;
    output += `${index + 1} 0 obj\n${body}\nendobj\n`;
    return offset;
  });
  const xref = output.length;
  const entries = offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${entries}`;
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output, "latin1");
}

/** 쪽마다 제목 없이 "Page {n} paragraph …" 문단 하나가 있는 PDF */
export function paragraphPages(count: number): Buffer {
  return buildPdf(
    Array.from({ length: count }, (_, index) => [
      { text: `Page ${index + 1} paragraph line one goes on for a while here.`, x: 72, y: 700, size: 10 },
      { text: `Page ${index + 1} paragraph line two goes on for a while here.`, x: 72, y: 688, size: 10 },
    ]),
  );
}
