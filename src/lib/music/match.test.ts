import { test } from "node:test";
import assert from "node:assert/strict";
import { isConfidentMatch, pickBestMatch } from "./match";

// Candidates are real search results unless the test name says "made-up": titles as yt-dlp lists
// them, uploaders as the bot sees them (oEmbed author for YouTube Music results, yt-dlp's channel
// for regular search results), in the order YouTube returned them unless the test name says
// otherwise. YouTube's ranking changes from call to call.

const blindingLights = { title: "Blinding Lights", artists: ["The Weeknd"] };
const stayWithMe = { title: "Stay With Me", artists: ["Sam Smith"] };
const hereWeGo = { title: "Here We Go", artists: ["Live My Last"] };
const oneDance = { title: "One Dance", artists: ["Drake", "Wizkid", "Kyla"] };

void test("picks the artist's own track over same-title songs by other uploaders", () => {
  const match = pickBestMatch(blindingLights, [
    { id: "-KGxQNAnnTg", title: "Blinding Lights", uploader: "Bongo Cat - Topic" },
    { id: "tEeK40cjmkw", title: "Save Your Tears", uploader: "The Weeknd - Topic" },
    { id: "H64a2ggVIWc", title: "Blinding Lights", uploader: "The Weeknd - Topic" },
    { id: "tDSf2zL8Res", title: "Blinding Lights (Metal Version)", uploader: "Leo - Topic" },
  ]);

  assert.equal(match?.candidate.id, "H64a2ggVIWc");
  assert.ok(isConfidentMatch(match));
});

void test("a cover on another artist's Topic channel is not confident, even when it names the artist", () => {
  const match = pickBestMatch(blindingLights, [
    { id: "A6xjfv1hHUs", title: "Blinding Lights (The Weeknd)", uploader: "All Artists - Topic" },
    {
      id: "gkNd_ZLX5nQ",
      title: "Blinding Lights (made popular by The Weeknd) [vocal version]",
      uploader: "Party Tyme - Topic",
    },
  ]);

  assert.ok(!isConfidentMatch(match));
});

void test("the artist's own upload beats a re-upload that names the artist (order swapped)", () => {
  const match = pickBestMatch(blindingLights, [
    { id: "BwX8OS4cegU", title: "The Weeknd - Blinding Lights (Lyrics)", uploader: "7clouds Indie" },
    { id: "H64a2ggVIWc", title: "Blinding Lights", uploader: "The Weeknd - Topic" },
  ]);

  assert.equal(match?.candidate.id, "H64a2ggVIWc");
  assert.equal(match?.artistMatch, "uploader");
});

void test("a same-title song by another artist with a similar name is not confident", () => {
  const match = pickBestMatch(stayWithMe, [
    { id: "XERvAFaX5hk", title: "Stay With Me", uploader: "Sam Harris - Topic" },
    { id: "Z3A3fAejb_U", title: "Stay With Me", uploader: "Lacy J. Dalton - Topic" },
    { id: "_pnlR6oXem8", title: "Stay with Me", uploader: "Rod Stewart - Topic" },
  ]);

  assert.ok(!isConfidentMatch(match));
});

void test("a title naming only part of the artist's name does not count as the artist (made-up)", () => {
  const match = pickBestMatch(stayWithMe, [
    { id: "a", title: "Sam Harris - Stay With Me (Lyrics)", uploader: "Lyrics Hub" },
  ]);

  assert.equal(match?.artistMatch, "none");
});

void test("prefers the original over an edit of the same song", () => {
  const match = pickBestMatch(stayWithMe, [
    { id: "nLQFBq9ykjI", title: "Stay With Me (Radio Edit)", uploader: "Sam Smith - Topic" },
    { id: "xQmfvh54uL4", title: "Stay With Me", uploader: "Sam Smith - Topic" },
  ]);

  assert.equal(match?.candidate.id, "xQmfvh54uL4");
});

void test("an artist channel that is not a Topic channel counts as the artist", () => {
  const match = pickBestMatch(stayWithMe, [
    { id: "pB-5XG-DbAA", title: "Sam Smith - Stay With Me (Official Music Video)", uploader: "SAM SMITH" },
  ]);

  assert.equal(match?.artistMatch, "uploader");
  assert.ok(isConfidentMatch(match));
});

void test("the artist's own edit beats a re-upload with a closer title (mixed from two searches)", () => {
  const match = pickBestMatch(stayWithMe, [
    { id: "-hJgdaAO28Q", title: "Sam Smith - Stay With Me (Lyrics)", uploader: "Taj Tracks" },
    { id: "nLQFBq9ykjI", title: "Stay With Me (Radio Edit)", uploader: "Sam Smith - Topic" },
  ]);

  assert.equal(match?.candidate.id, "nLQFBq9ykjI");
});

void test("an official music video loses to another confident upload", () => {
  const match = pickBestMatch(stayWithMe, [
    { id: "pB-5XG-DbAA", title: "Sam Smith - Stay With Me (Official Music Video)", uploader: "SAM SMITH" },
    { id: "-hJgdaAO28Q", title: "Sam Smith - Stay With Me (Lyrics)", uploader: "Taj Tracks" },
  ]);

  assert.equal(match?.candidate.id, "-hJgdaAO28Q");
});

void test("the artist's remaster is a confident match when the original is missing", () => {
  const match = pickBestMatch({ title: "Let Go", artists: ["RED"] }, [
    { id: "-6gDnuO2S0M", title: "Let Go (2016 Remastered)", uploader: "RED - Topic" },
    { id: "Q0CRRoDYqOc", title: "Breathe Into Me", uploader: "RED - Topic" },
    { id: "6o5VDm27qSo", title: "Let Go", uploader: "Ark Patrol - Topic" },
  ]);

  assert.equal(match?.candidate.id, "-6gDnuO2S0M");
  assert.ok(isConfidentMatch(match));
});

void test("remaster notes don't count, even when their years differ", () => {
  const match = pickBestMatch({ title: "Roundabout - 2003 Remaster", artists: ["Yes"] }, [
    { id: "cPCLFtxpadE", title: "Roundabout (2008 Remaster)", uploader: "Yes - Topic" },
    { id: "jXHZR0_9smw", title: "Roundabout (US Single Edit) [2024 Remaster]", uploader: "Yes - Topic" },
    { id: "bOSzXLjU4jk", title: "YES - Roundabout (2003 Remaster)", uploader: "KickItJane" },
  ]);

  assert.equal(match?.candidate.id, "cPCLFtxpadE");
  assert.equal(match?.titleScore, 1);
});

void test("Spotify's remaster note with the year last doesn't count either", () => {
  const match = pickBestMatch({ title: "Under Pressure - Remastered 2011", artists: ["Queen", "David Bowie"] }, [
    { id: "BaxnrepwXck", title: "Under Pressure (feat. David Bowie)", uploader: "Queen - Topic" },
  ]);

  assert.ok(isConfidentMatch(match));
  assert.equal(match?.titleScore, 1);
});

void test("featured artists in the Spotify title don't count against the art track", () => {
  const match = pickBestMatch({ title: "Unholy (feat. Kim Petras)", artists: ["Sam Smith", "Kim Petras"] }, [
    { id: "8VKD-IlvibI", title: "Unholy", uploader: "Sam Smith - Topic" },
    { id: "Gp11LHXYB3Y", title: "Unholy (feat. Siadou)", uploader: "TRFN - Topic" },
  ]);

  assert.equal(match?.candidate.id, "8VKD-IlvibI");
  assert.ok(isConfidentMatch(match));
});

void test("credits for singers missing from the artist list don't block a match (made-up)", () => {
  const angel = pickBestMatch({ title: "Angel (feat. Horace Andy)", artists: ["Massive Attack"] }, [
    { id: "a", title: "Angel", uploader: "Massive Attack - Topic" },
  ]);
  const stay = pickBestMatch({ title: "Stay (with Justin Bieber)", artists: ["The Kid LAROI", "Justin Bieber"] }, [
    { id: "b", title: "Stay", uploader: "The Kid LAROI - Topic" },
  ]);

  assert.ok(isConfidentMatch(angel));
  assert.ok(isConfidentMatch(stay));
});

void test("a short title with a version note on either side is a confident match (made-up)", () => {
  const levels = pickBestMatch({ title: "Levels", artists: ["Avicii"] }, [
    { id: "a", title: "Levels (Radio Edit)", uploader: "Avicii - Topic" },
  ]);
  const jolene = pickBestMatch({ title: "Jolene - Single Version", artists: ["Dolly Parton"] }, [
    { id: "b", title: "Jolene", uploader: "Dolly Parton - Topic" },
  ]);

  assert.ok(isConfidentMatch(levels));
  assert.ok(isConfidentMatch(jolene));
});

void test("a song named after its artist still matches (made-up)", () => {
  const match = pickBestMatch({ title: "Bad Company", artists: ["Bad Company"] }, [
    { id: "a", title: "Bad Company (Radio Edit)", uploader: "Bad Company - Topic" },
    { id: "b", title: "Bad Company (Official Audio)", uploader: "Bad Company - Topic" },
  ]);

  assert.equal(match?.candidate.id, "b");
  assert.equal(match?.titleScore, 1);
});

void test("an artist name inside the song title does not make a cover count as the artist (made-up)", () => {
  const cover = pickBestMatch({ title: "Killer Queen", artists: ["Queen"] }, [
    { id: "a", title: "Killer Queen", uploader: "Some Cover Band" },
  ]);
  const upload = pickBestMatch({ title: "Killer Queen", artists: ["Queen"] }, [
    { id: "b", title: "Queen - Killer Queen (Live at Wembley)", uploader: "Classic Rock Vault" },
  ]);

  assert.equal(cover?.artistMatch, "none");
  assert.equal(upload?.artistMatch, "title");
});

void test("an artist name without letters or digits matches only its own channel (made-up)", () => {
  const carnival = { title: "Carnival", artists: ["¥$"] };

  assert.equal(
    pickBestMatch(carnival, [{ id: "a", title: "Carnival", uploader: "¥$ - Topic" }])?.artistMatch,
    "uploader",
  );
  assert.equal(
    pickBestMatch(carnival, [{ id: "b", title: "Carnival", uploader: "Random Uploader" }])?.artistMatch,
    "none",
  );
  assert.equal(pickBestMatch(carnival, [{ id: "c", title: "Carnival", uploader: null }])?.artistMatch, "none");
});

void test("the right artist with the wrong song is not confident", () => {
  const match = pickBestMatch(oneDance, [
    { id: "AZw6kYpv42c", title: "One Dance", uploader: "Vibe2Vibe - Topic" },
    { id: "eqMj9DTQcAQ", title: "Toosie Slide", uploader: "Drake - Topic" },
    { id: "KVipgUl9p3w", title: "One Dance (Cover)", uploader: "GORGEOUS PARTY MUSIC - Topic" },
  ]);

  assert.ok(!isConfidentMatch(match));
});

void test("without a confident match, the best guess has the right title rather than the right artist", () => {
  const match = pickBestMatch(oneDance, [
    { id: "eqMj9DTQcAQ", title: "Toosie Slide", uploader: "Drake - Topic" },
    { id: "AZw6kYpv42c", title: "One Dance", uploader: "Vibe2Vibe - Topic" },
  ]);

  assert.equal(match?.candidate.id, "AZw6kYpv42c");
});

void test("a long upload that only mentions the song is not confident (mixed from two searches)", () => {
  const match = pickBestMatch({ title: "Lemon", artists: ["米津玄師"] }, [
    { id: "3NNhrqHZqlI", title: "Lemon", uploader: "Kenshi Yonezu - Topic" },
    { id: "qA3VpPRlkVA", title: "Lemon (cover)", uploader: "Release - Topic" },
    { id: "if3sdCLhS1A", title: "Lemon(檸檬) - 米津玄師 2023 TOUR 空想【中日字幕】", uploader: "米津玄師" },
  ]);

  assert.ok(!isConfidentMatch(match));
  assert.equal(match?.candidate.id, "3NNhrqHZqlI");
});

void test("a confident video from the regular search beats the right artist with the wrong song", () => {
  const match = pickBestMatch(oneDance, [
    { id: "AZw6kYpv42c", title: "One Dance", uploader: "Vibe2Vibe - Topic" },
    { id: "eqMj9DTQcAQ", title: "Toosie Slide", uploader: "Drake - Topic" },
    { id: "ki0Ocze98U8", title: "Drake - One Dance (Lyrics) ft. Wizkid & Kyla", uploader: "Billion Stars" },
    { id: "mym4sKoAnKs", title: "One Dance (feat. WizKid & Kyla) - Drake (Official Audio)", uploader: "Dymnd" },
  ]);

  assert.equal(match?.candidate.id, "ki0Ocze98U8");
  assert.equal(match?.artistMatch, "title");
  assert.ok(isConfidentMatch(match));
});

void test("picks the matching artist when another artist has a song with the same title", () => {
  const match = pickBestMatch(hereWeGo, [
    { id: "dnT6JDLrp3o", title: "Here We Go", uploader: "Stakka Bo - Topic" },
    { id: "tVMq7HbRLYE", title: "Here We Go", uploader: "Live My Last - Topic" },
  ]);

  assert.equal(match?.candidate.id, "tVMq7HbRLYE");
  assert.ok(isConfidentMatch(match));
});

void test("a different song by the artist sharing most title words is not confident (uploader swapped)", () => {
  const match = pickBestMatch(hereWeGo, [
    { id: "Rvac29Bz5to", title: "Here We Come", uploader: "Live My Last - Topic" },
  ]);

  assert.ok(!isConfidentMatch(match));
});

void test("a same-title song with an unknown uploader is not confident", () => {
  const match = pickBestMatch(hereWeGo, [{ id: "dnT6JDLrp3o", title: "Here We Go", uploader: null }]);

  assert.ok(!isConfidentMatch(match));
});

void test("ignores case, accents and the Topic channel suffix", () => {
  const match = pickBestMatch({ title: "senorita", artists: ["SHAWN MENDES", "Camila Cabello"] }, [
    { id: "VKC_hzJ3jzg", title: "Señorita", uploader: "Shawn Mendes - Topic" },
  ]);

  assert.equal(match?.artistMatch, "uploader");
  assert.equal(match?.titleScore, 1);
});

void test("a tie goes to the earlier candidate", () => {
  const match = pickBestMatch({ title: "Senorita", artists: ["Shawn Mendes"] }, [
    { id: "gumX9Uq4q-c", title: "Senorita", uploader: "Release - Topic" },
    { id: "fPpzU3LeUMk", title: "Senorita", uploader: "Release - Topic" },
  ]);

  assert.equal(match?.candidate.id, "gumX9Uq4q-c");
});

void test("returns null when there are no candidates", () => {
  assert.equal(pickBestMatch(hereWeGo, []), null);
  assert.ok(!isConfidentMatch(null));
});
