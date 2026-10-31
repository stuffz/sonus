// Wake word: "Jarvis" — a hard-onset, uncommon name that STT transcribes reliably. Only utterances
// addressing the bot by name get answered/remembered (no silent follow-up window — in a live VC
// people keep talking about other things). Explicit spellings + a light "j…" fuzzy fallback.
const WAKE_RE = /\b(hey\s+)?(jarvis|jarviss|jervis|jarvus|jarvish|jarvic|jarvi)\b[.,!?]*/gi;

export function addressesBot(text: string): { addressed: boolean; cleaned: string } {
  const norm = text.replace(/\s+/g, " ").trim();
  // 1) explicit "Jarvis"/spellings anywhere in the utterance
  const stripped = norm.replace(WAKE_RE, " ").replace(/\s+/g, " ").trim();
  if (stripped !== norm) return { addressed: true, cleaned: stripped };
  // 2) fuzzy: an early "j…" word within edit distance 2 of "jarvis" (guards against non-j false hits)
  const words = norm.split(" ");
  for (let i = 0; i < Math.min(words.length, 3); i++) {
    const w = words[i].toLowerCase().replace(/[^a-z]/g, "");
    if (w.length >= 5 && w.startsWith("j") && levenshtein(w, "jarvis") <= 2) {
      words.splice(i, 1);
      return { addressed: true, cleaned: words.join(" ").trim() };
    }
  }
  return { addressed: false, cleaned: norm };
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}
