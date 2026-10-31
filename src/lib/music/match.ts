export interface TrackInfo {
  title: string;
  artists: string[];
}

export interface MatchCandidate {
  id: string;
  title: string;
  uploader: string | null;
}

/**
 * How a candidate is tied to the track's artists:
 * - uploader: uploaded by one of them, on a "<Artist> - Topic" art track channel or their own channel
 * - title: the title names one of them, as re-uploads and lyric videos do
 * - none: neither, or uploaded to another artist's Topic channel, which makes it their recording
 */
type ArtistMatch = "uploader" | "title" | "none";

interface Match {
  candidate: MatchCandidate;
  artistMatch: ArtistMatch;
  /** Every word of the song name is in the candidate's title. */
  hasSongName: boolean;
  /** Sørensen-Dice between the song name and the candidate's title: how much of the title it is. */
  songNameScore: number;
  /** Sørensen-Dice on title words, so the exact version ranks above edits and live takes. */
  titleScore: number;
}

const ARTIST_MATCH_RANK: Record<ArtistMatch, number> = { uploader: 2, title: 1, none: 0 };

/**
 * Below this, the song is only a mention in a longer title, such as a tour video ("Lemon(檸檬) -
 * 米津玄師 2023 TOUR 空想【中日字幕】" scores 0.29 for "Lemon"). The song with a version note stays
 * at or above it ("Levels (Radio Edit)" scores 0.5 for "Levels", "Hotel California (Live)" 0.8).
 */
const MIN_SONG_NAME_SCORE = 0.5;

/** Search results with this in the title are skipped (they often have intros, skits or long outros). */
export const SKIP_TITLE_PATTERN = /music\s*video/i;

/** YouTube Music art tracks are uploaded to auto-generated "<Artist> - Topic" channels. */
const TOPIC_CHANNEL_SUFFIX = /\s+-\s+Topic$/i;

/**
 * Spotify's "- 2003 Remaster" and the "(2008 Remaster)" on YouTube name the same song, but
 * their years rarely agree, so the whole note is dropped rather than just the word.
 */
const REMASTER_NOTE = /\b(?:\d{4}\s+)?remaster(?:ed)?(?:\s+\d{4})?(?:\s+version)?\b/gi;

/** "(feat. Horace Andy)", "(with Justin Bieber)": singers who are often missing from the artist list. */
const CREDIT_NOTE = /[([]\s*(?:feat\.?|ft\.?|featuring|with)\s[^)\]]*[)\]]/gi;

/** Spotify puts version notes after this: "Jolene - Single Version", "Hotel California - Live On MTV, 1994". */
const SPOTIFY_VERSION_SEPARATOR = " - ";

/** Words that label an upload or credit rather than name the song. */
const IGNORED_TITLE_WORDS = new Set(["feat", "ft", "featuring", "official", "audio", "lyrics", "lyric"]);

/**
 * Pick the candidate that best matches a Spotify track (see rankKey). Ties go to the earlier
 * candidate.
 */
export function pickBestMatch(track: TrackInfo, candidates: MatchCandidate[]): Match | null {
  const artistWords = new Set(track.artists.flatMap((artist) => [...toWords(artist)]));
  const dropped = droppedTitleWords(track.title, artistWords);
  const songName = songNameOf(track.title);
  const songNameWords = titleWords(songName, dropped);
  const trackTitle = titleWords(track.title, dropped);
  let best: Match | null = null;
  let bestKey: number[] = [];

  for (const candidate of candidates) {
    const candidateTitle = titleWords(candidate.title, dropped);
    const match: Match = {
      candidate,
      artistMatch: matchArtist(track.artists, songName, candidate),
      hasSongName: [...songNameWords].every((word) => candidateTitle.has(word)),
      songNameScore: diceCoefficient(songNameWords, candidateTitle),
      titleScore: diceCoefficient(trackTitle, candidateTitle),
    };
    const key = rankKey(match);
    if (!best || isGreater(key, bestKey)) {
      best = match;
      bestKey = key;
    }
  }

  return best;
}

export function isConfidentMatch(match: Match | null): boolean {
  return (
    match !== null && match.artistMatch !== "none" && match.hasSongName && match.songNameScore >= MIN_SONG_NAME_SCORE
  );
}

export function formatTrack(track: TrackInfo): string {
  return `${track.artists.join(", ")} - ${track.title}`;
}

/**
 * Confident matches come first. Among them, music videos lose (intros and skits), then the
 * artist's own uploads beat re-uploads, then the closest title wins. Without a confident
 * match, the closest title wins first: a different song by the right artist is wrong for
 * sure, while the right title may be the artist under a name we can't match (米津玄師 is
 * "Kenshi Yonezu - Topic").
 */
function rankKey(match: Match): number[] {
  const artistRank = ARTIST_MATCH_RANK[match.artistMatch];
  if (!isConfidentMatch(match)) {
    return [0, match.titleScore, artistRank];
  }

  const notMusicVideo = SKIP_TITLE_PATTERN.test(match.candidate.title) ? 0 : 1;
  return [1, notMusicVideo, artistRank, match.titleScore];
}

function isGreater(a: number[], b: number[]): boolean {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      return a[i] > b[i];
    }
  }
  return false;
}

function matchArtist(artists: string[], songName: string, candidate: MatchCandidate): ArtistMatch {
  if (candidate.uploader !== null) {
    const uploaderKey = compactKey(candidate.uploader.replace(TOPIC_CHANNEL_SUFFIX, ""));
    if (artists.some((artist) => compactKey(artist) === uploaderKey)) {
      return "uploader";
    }
    if (TOPIC_CHANNEL_SUFFIX.test(candidate.uploader)) {
      return "none";
    }
  }

  // "Killer Queen" by a cover band names no artist: the song name's own words don't count.
  const leftover = toWordList(candidate.title);
  for (const word of toWordList(songName)) {
    const index = leftover.indexOf(word);
    if (index !== -1) {
      leftover.splice(index, 1);
    }
  }

  const namedInTitle = artists.some((artist) => {
    const words = toWordList(artist);
    return words.length > 0 && words.every((word) => leftover.includes(word));
  });
  return namedInTitle ? "title" : "none";
}

/**
 * Words dropped from both titles before comparing them: artist names and labels, unless that
 * leaves nothing of the Spotify title, as for "Bad Company" by Bad Company.
 */
function droppedTitleWords(title: string, artistWords: Set<string>): Set<string> {
  const words = [...toWords(cleanTitle(title))];
  const choices = [new Set([...artistWords, ...IGNORED_TITLE_WORDS]), IGNORED_TITLE_WORDS];
  return choices.find((dropped) => words.some((word) => !dropped.has(word))) ?? new Set();
}

function songNameOf(spotifyTitle: string): string {
  return spotifyTitle.split(SPOTIFY_VERSION_SEPARATOR)[0].replace(CREDIT_NOTE, " ");
}

function titleWords(title: string, dropped: Set<string>): Set<string> {
  return new Set([...toWords(cleanTitle(title))].filter((word) => !dropped.has(word)));
}

function cleanTitle(title: string): string {
  return title.replace(REMASTER_NOTE, " ").replace(CREDIT_NOTE, " ");
}

/**
 * "SAM SMITH" and "Sam Smith" compare equal, as do "Live My Last" and "LiveMyLast". A name
 * without letters or digits, such as "¥$", is compared as written.
 */
function compactKey(name: string): string {
  const words = toWordList(name);
  return words.length > 0 ? words.join("") : name.trim().toLowerCase();
}

function toWords(text: string): Set<string> {
  return new Set(toWordList(text));
}

function toWordList(text: string): string[] {
  const plain = text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
  return plain.split(/[^\p{L}\p{N}]+/u).filter((word) => word);
}

function diceCoefficient(a: Set<string>, b: Set<string>): number {
  if (a.size + b.size === 0) {
    return 0;
  }

  let shared = 0;
  for (const word of a) {
    if (b.has(word)) {
      shared++;
    }
  }

  return (2 * shared) / (a.size + b.size);
}
