// Discord hard-caps message content at 2000 characters.
export const DISCORD_MAX_LENGTH = 2000;

// Headroom reserved so the code-fence lines we may re-add can't push a chunk
// over Discord's hard limit (open ```lang\n + closing \n``` ≈ 20 chars worst case).
const FENCE_RESERVE = 24;

/**
 * Split text into Discord-sized pieces, breaking as gracefully as possible:
 *   1. on blank lines (keep whole paragraphs together),
 *   2. then on line breaks if a single paragraph is too big,
 *   3. then a hard character cut only if a single line is still too big.
 * Any fenced code block that gets split across a boundary is closed and reopened
 * so each piece still renders as code in Discord.
 */
export function chunkText(text: string, max = DISCORD_MAX_LENGTH): string[] {
  const limit = max - FENCE_RESERVE;
  const chunks: string[] = [];
  let buf = "";
  const flush = () => {
    if (buf) {
      chunks.push(buf);
      buf = "";
    }
  };

  // Pack a single line, hard-splitting it only as a last resort.
  const addLine = (line: string) => {
    const candidate = buf ? `${buf}\n${line}` : line;
    if (candidate.length <= limit) {
      buf = candidate;
      return;
    }
    flush();
    if (line.length <= limit) {
      buf = line;
      return;
    }
    for (let i = 0; i < line.length; i += limit) chunks.push(line.slice(i, i + limit));
  };

  // Prefer paragraph boundaries (a blank line between blocks).
  for (const para of text.split(/\n\s*\n/)) {
    const candidate = buf ? `${buf}\n\n${para}` : para;
    if (candidate.length <= limit) {
      buf = candidate;
      continue;
    }
    flush();
    if (para.length <= limit) {
      buf = para;
      continue;
    }
    for (const line of para.split("\n")) addLine(line); // paragraph too big — pack by line
  }
  flush();

  return balanceCodeFences(chunks.length ? chunks : [text]);
}

/** Close an unterminated ``` block at a chunk's end and reopen it in the next chunk. */
function balanceCodeFences(chunks: string[]): string[] {
  const out: string[] = [];
  let openLang: string | null = null; // language of a fence carried over from the previous chunk
  for (let piece of chunks) {
    if (openLang !== null) piece = `\`\`\`${openLang}\n${piece}`;
    const fenceCount = (piece.match(/```/g) || []).length;
    if (fenceCount % 2 === 1) {
      // This piece leaves a code block open — remember its language and close it here.
      const opens = [...piece.matchAll(/```([^\n`]*)/g)];
      openLang = opens.length ? opens[opens.length - 1][1] : "";
      piece = `${piece}\n\`\`\``;
    } else {
      openLang = null;
    }
    out.push(piece);
  }
  return out;
}
