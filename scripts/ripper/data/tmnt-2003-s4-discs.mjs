/**
 * Teenage Mutant Ninja Turtles (2003) — Season 4 two-disc set
 * (insert photographed 2026-08-17). The set covers S04E12–E25 only; the
 * earlier S4 episodes shipped from other volumes and E26 is not in this box.
 * Entry order = on-disc play order (the insert's 1–14 numbering), which for
 * disc 2 puts both Savanti Romero parts BEFORE "Tale of Master Yoshi" even
 * though TMDb numbers Yoshi as E20. Codes are TMDb tv/2284 numbering, which
 * is what Jellyfin matches (see data/tmnt-2003-episodes.txt).
 * Observed on scan (2026-08-17): disc 1 exposes a SINGLE ~170m play-all title
 * (8 x ~21.25m), no per-episode titles — so each disc is one multi-code entry
 * that gets chapter/fade-split (same machinery as the He-Man Mill Creek discs).
 * Real disc-1 label from the failed scan: "TMNT_s4 DISC 1" (space, lowercase
 * s4); disc 2's label is the obvious sibling guess and it matched.
 * VERIFIED_AT_RIP (2026-08-17): both discs split cleanly (8 + 6 x ~21m) and
 * all 14 on-screen title cards were OCR'd against these codes — unlike the
 * He-Man discs, on-disc play order matches the insert exactly, including the
 * Savanti-two-parter-before-Yoshi ordering on disc 2.
 */

export const SHOW_NAME = 'Teenage Mutant Ninja Turtles (2003)';
export const AVG_EP_S = 21.5 * 60;

const D1 = [
  ['Still Nobody', 'S04E12'],
  ['Samurai Tourist', 'S04E13'],
  ['The Ancient One', 'S04E14'],
  ['Scion of the Shredder', 'S04E15'],
  ['Prodigal Son', 'S04E16'],
  ['Outbreak', 'S04E17'],
  ['Trouble with Augie', 'S04E18'],
  ['Insane in the Membrane', 'S04E19'],
];

const D2 = [
  ['Return of Savanti, Part 1', 'S04E21'],
  ['Return of Savanti, Part 2', 'S04E22'],
  ['Tale of Master Yoshi', 'S04E20'],
  ['Adventures in Turtle Sitting', 'S04E23'],
  ['Good Genes, Part 1', 'S04E24'],
  ['Good Genes, Part 2', 'S04E25'],
];

/** @type {{disc:number, label:string, entries:{codes:string[], titles:string[]}[]}[]} */
export const DISCS = [
  { disc: 1, label: 'TMNT_s4 DISC 1', list: D1 },
  { disc: 2, label: 'TMNT_s4 DISC 2', list: D2 },
].map(({ disc, label, list }) => ({
  disc,
  label,
  entries: [{
    codes: list.map(([, code]) => code),
    titles: list.map(([title]) => title),
  }],
}));

export function episodeCount(disc) {
  return disc.entries.reduce((n, e) => n + e.codes.length, 0);
}

const total = DISCS.reduce((n, d) => n + episodeCount(d), 0);
if (total !== 14) {
  throw new Error(`manifest episode total ${total} !== 14`);
}
