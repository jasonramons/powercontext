export interface Chunk {
  index: number;
  text: string;
  start: number;
  end: number;
}

const TARGET_CHARS = 500;
const OVERLAP_CHARS = 80;

/**
 * Paragraph-aware chunking: keep paragraphs together while under the target size,
 * split oversized paragraphs on sentence boundaries, and overlap neighbouring
 * chunks so a fact split across the boundary is still retrievable.
 */
export function chunkText(raw: string, target = TARGET_CHARS, overlap = OVERLAP_CHARS): Chunk[] {
  const text = raw.replace(/\r\n/g, '\n').trim();
  if (!text) return [];

  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const pieces: string[] = [];
  let buffer = '';
  for (const paragraph of paragraphs) {
    if (paragraph.length > target) {
      if (buffer) {
        pieces.push(buffer);
        buffer = '';
      }
      pieces.push(...splitLongParagraph(paragraph, target));
    } else if ((buffer + '\n\n' + paragraph).length > target) {
      pieces.push(buffer);
      buffer = paragraph;
    } else {
      buffer = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
    }
  }
  if (buffer) pieces.push(buffer);

  const chunks: Chunk[] = [];
  let cursor = 0;
  for (let i = 0; i < pieces.length; i += 1) {
    const piece = pieces[i];
    const start = text.indexOf(piece, cursor);
    const safeStart = start >= 0 ? start : cursor;
    const end = safeStart + piece.length;
    chunks.push({ index: i, text: piece, start: safeStart, end });
    cursor = Math.max(cursor, end - overlap);
  }
  return chunks;
}

function splitLongParagraph(paragraph: string, target: number): string[] {
  const sentences = paragraph.split(/(?<=[。！？!?\.])\s*/).filter(Boolean);
  const out: string[] = [];
  let buffer = '';
  for (const sentence of sentences) {
    if ((buffer + sentence).length > target && buffer) {
      out.push(buffer.trim());
      buffer = sentence;
    } else {
      buffer += sentence;
    }
  }
  if (buffer.trim()) out.push(buffer.trim());
  return out;
}
