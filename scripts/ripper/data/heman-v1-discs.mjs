/**
 * He-Man and the Masters of the Universe (1983) — Mill Creek "Volume 1"
 * (first 20 episodes, 2 discs, box photographed 2026-08-17). The box lists
 * episodes in PRODUCTION order; codes below are TMDb tv/931 season-1 numbers
 * looked up per title (TMDb uses a different broadcast order), so filenames
 * land on the right metadata. Entry order = box/on-disc play order.
 * Labels unknown until first scan — placeholder pins fail loudly and get
 * corrected from the disc-fail event (same drill as MMPR S3/Alien Rangers).
 */

export const SHOW_NAME = 'He-Man and the Masters of the Universe (1983)';
export const AVG_EP_S = 20 * 60;

const D1 = [
  ['Diamond Ray of Disappearance', 'S01E01'],
  ['The Cosmic Comet', 'S01E20'],
  ['The Shaping Staff', 'S01E19'],
  ['Disappearing Act', 'S01E12'],
  ['She-Demon of Phantos', 'S01E09'],
  ['Teelas Quest', 'S01E02'],
  ['The Curse of the Spellstone', 'S01E05'],
  ['The Time Corridor', 'S01E06'],
  ['The Dragon Invasion', 'S01E04'],
  ['A Friend in Need', 'S01E16'],
];

const D2 = [
  ['Masks of Power', 'S01E34'],
  ['Evil-Lyns Plot', 'S01E13'],
  ['Like Father, Like Daughter', 'S01E11'],
  ['Colossor Awakes', 'S01E03'],
  ['A Beastly Sideshow', 'S01E26'],
  ['Reign of the Monster', 'S01E10'],
  ['Daimar the Demon', 'S01E17'],
  ['Creatures from the Tar Swamp', 'S01E07'],
  ['Quest for He-Man', 'S01E23'],
  ['Dawn of Dragoon', 'S01E14'],
];

// Observed on scan (2026-08-17): these Mill Creek discs do NOT carry ten
// separate episode titles. They expose one ~216m play-all title plus
// cumulative play-from-episode-N variants (195m, 173m, ... 22m). So each disc
// is ONE 10-code entry: rip the play-all title, chapter/fade-split into
// episodes (same machinery as the TMNT triple titles). Both discs report the
// volume label HE_MAN — disambiguation rests on the unripped-first rule plus
// the content-verified reinsert guard.
export const DISCS = [D1, D2].map((list, d) => ({
  disc: d + 1,
  label: 'HE_MAN',
  // sig lesson (2026-08-17): pinning disc 1 with the raw-IFO play-all seconds
  // (12943) FAILED — makemkv's scanned duration differs by >5s, the sig
  // rejected disc 1 and the disc dispatched under disc 2's codes. With shared
  // labels AND shapes, disambiguation is procedural: disc 2 wore a placeholder
  // label until disc 1 was ripped+recorded (2026-08-17, done). Now both carry
  // HE_MAN; the content-verified reinsert guard tells them apart.
  entries: [{
    codes: list.map(([, code]) => code),
    titles: list.map(([title]) => title),
  }],
}));

export function episodeCount(disc) {
  return disc.entries.reduce((n, e) => n + e.codes.length, 0);
}

const total = DISCS.reduce((n, d) => n + episodeCount(d), 0);
if (total !== 20) {
  throw new Error(`manifest episode total ${total} !== 20`);
}
