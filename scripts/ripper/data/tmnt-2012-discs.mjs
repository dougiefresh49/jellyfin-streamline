/**
 * TMNT (2012) Complete Series — 20-disc manifest.
 * Entry order = on-disc play order (insert sheet, photographed 2026-08-15);
 * codes = TMDb numbering (tv/51817), which is what Jellyfin matches.
 * The set is sequenced in production order, so codes are non-monotonic in
 * spots (e.g. E14 ships on disc 2, E13 on disc 3).
 * Multi-part entries (codes.length > 1) are single double/triple-length
 * titles on disc and get chapter-split into TMDb episodes.
 *
 * VERIFIED_AT_RIP: discs 3, 6, 15, 16, 20 were partially cut off in the
 * sheet photo — entries inferred from TMDb + episode-count arithmetic and
 * confirmed against on-disc title counts/durations at rip time.
 */

export const SHOW_NAME = 'Teenage Mutant Ninja Turtles (2012)';
export const AVG_EP_S = 23.2 * 60;

/** @type {{disc:number, entries:{codes:string[], titles:string[]}[]}[]} */
export const DISCS = [
  {
    disc: 1,
    label: 'TMNT_RISE_OF_THE_TURTLES',
    entries: [
      { codes: ['S01E01', 'S01E02'], titles: ['Rise of the Turtles (1)', 'Rise of the Turtles (2)'] },
      { codes: ['S01E03'], titles: ['Turtle Temper'] },
      { codes: ['S01E04'], titles: ['New Friend, Old Enemy'] },
      { codes: ['S01E05'], titles: ['I Think His Name Is Baxter Stockman'] },
      { codes: ['S01E06'], titles: ['Metalhead'] },
    ],
  },
  {
    disc: 2,
    label: 'TMNT_ENTER_SHREDDER',
    entries: [
      { codes: ['S01E07'], titles: ['Monkey Brains'] },
      { codes: ['S01E08'], titles: ['Never Say Xever'] },
      { codes: ['S01E09'], titles: ['The Gauntlet'] },
      { codes: ['S01E10'], titles: ['Panic in the Sewers'] },
      { codes: ['S01E11'], titles: ['Mousers Attack!'] },
      { codes: ['S01E12'], titles: ['It Came From the Depths'] },
      { codes: ['S01E14'], titles: ['New Girl in Town'] },
    ],
  },
  {
    disc: 3,
    label: 'TMNT_ULTIMATE_SHOWDOWN_D1',
    entries: [
      { codes: ['S01E13'], titles: ['I, Monster'] },
      { codes: ['S01E15'], titles: ['The Alien Agenda'] },
      { codes: ['S01E16'], titles: ['The Pulverizer'] },
      { codes: ['S01E17'], titles: ['TCRI'] },
      { codes: ['S01E18'], titles: ['Cockroach Terminator'] },
      { codes: ['S01E19'], titles: ["Baxter's Gambit"] },
    ],
  },
  {
    disc: 4,
    entries: [
      { codes: ['S01E20'], titles: ['Enemy of My Enemy'] },
      { codes: ['S01E21'], titles: ["Karai's Vendetta"] },
      { codes: ['S01E22'], titles: ['The Pulverizer Returns!'] },
      { codes: ['S01E23'], titles: ['Parasitica'] },
      { codes: ['S01E24'], titles: ['Operation: Break Out'] },
      { codes: ['S01E25', 'S01E26'], titles: ['Showdown (1)', 'Showdown (2)'] },
    ],
  },
  {
    disc: 5,
    label: 'TNMT_Mutagen_Mayhem_NA',
    entries: [
      { codes: ['S02E01'], titles: ['The Mutation Situation'] },
      { codes: ['S02E03'], titles: ['Follow the Leader'] },
      { codes: ['S02E02'], titles: ['Invasion of the Squirrelanoids'] },
      { codes: ['S02E04'], titles: ['Mutagen Man Unleashed'] },
      { codes: ['S02E05'], titles: ['Mikey Gets Shellacne'] },
      { codes: ['S02E06'], titles: ["Target: April O'Neil"] },
    ],
  },
  {
    disc: 6,
    entries: [
      { codes: ['S02E07'], titles: ['Slash and Destroy'] },
      { codes: ['S02E09'], titles: ['The Kraang Conspiracy'] },
      { codes: ['S02E08'], titles: ['The Good, The Bad, and Casey Jones'] },
      { codes: ['S02E10'], titles: ['Fungus Humungous'] },
      { codes: ['S02E11'], titles: ['Metalhead Rewired'] },
      { codes: ['S02E12'], titles: ['Of Rats and Men'] },
    ],
  },
  {
    disc: 7,
    entries: [
      { codes: ['S02E13'], titles: ['The Manhattan Project (1)'] },
      { codes: ['S02E14'], titles: ['The Manhattan Project (2)'] },
      { codes: ['S02E15'], titles: ['Mazes & Mutants'] },
      { codes: ['S02E16'], titles: ['The Lonely Mutation of Baxter Stockman'] },
      { codes: ['S02E17'], titles: ['Newtralized!'] },
      { codes: ['S02E19'], titles: ['The Wrath of Tiger Claw'] },
      { codes: ['S02E18'], titles: ['Pizza Face'] },
    ],
  },
  {
    disc: 8,
    // Exact title durations recovered from the first (overwritten) rip's
    // surviving demucs stems — disambiguates disc 8 from same-shape discs.
    sig: [1338, 1357, 1357, 1357, 1357, 1360, 1422],
    entries: [
      { codes: ['S02E20'], titles: ['The Legend of the Kuro Kabuto'] },
      { codes: ['S02E21'], titles: ['Plan 10'] },
      { codes: ['S02E22'], titles: ['Vengeance is Mine'] },
      { codes: ['S02E23'], titles: ['A Chinatown Ghost Story'] },
      { codes: ['S02E24'], titles: ['Into Dimension X!'] },
      { codes: ['S02E25'], titles: ['The Invasion (1)'] },
      { codes: ['S02E26'], titles: ['The Invasion (2)'] },
    ],
  },
  {
    disc: 9,
    entries: [
      { codes: ['S03E01'], titles: ['Within the Woods'] },
      { codes: ['S03E02'], titles: ['A Foot Too Big'] },
      { codes: ['S03E03'], titles: ['Buried Secrets'] },
      { codes: ['S03E04'], titles: ['The Croaking'] },
      { codes: ['S03E05'], titles: ['In Dreams'] },
      { codes: ['S03E06'], titles: ['Race with the Demon!'] },
      { codes: ['S03E07'], titles: ['Eyes of the Chimera'] },
    ],
  },
  {
    disc: 10,
    entries: [
      { codes: ['S03E08'], titles: ['Vision Quest'] },
      { codes: ['S03E09'], titles: ['Return to New York'] },
      { codes: ['S03E10'], titles: ['Serpent Hunt'] },
      { codes: ['S03E11'], titles: ['The Pig and the Rhino'] },
      { codes: ['S03E12'], titles: ['Battle for New York (1)'] },
      { codes: ['S03E13'], titles: ['Battle for New York (2)'] },
      { codes: ['S03E14'], titles: ['Casey Jones vs the Underworld'] },
    ],
  },
  {
    disc: 11,
    entries: [
      { codes: ['S03E15'], titles: ['The Noxious Avenger'] },
      { codes: ['S03E16'], titles: ['Clash of the Mutanimals'] },
      { codes: ['S03E17'], titles: ['Meet Mondo Gecko'] },
      { codes: ['S03E18'], titles: ['The Deadly Venom'] },
      { codes: ['S03E19'], titles: ['Turtles in Time'] },
      { codes: ['S03E20'], titles: ['Tale of the Yokai'] },
    ],
  },
  {
    disc: 12,
    entries: [
      { codes: ['S03E21'], titles: ['Attack of the Mega Shredder!'] },
      { codes: ['S03E22'], titles: ['The Creeping Doom'] },
      { codes: ['S03E23'], titles: ['The Fourfold Trap'] },
      { codes: ['S03E24'], titles: ['Dinosaur Seen in Sewers!'] },
      { codes: ['S03E25'], titles: ['Annihilation: Earth! (1)'] },
      { codes: ['S03E26'], titles: ['Annihilation: Earth! (2)'] },
    ],
  },
  {
    disc: 13,
    entries: [
      { codes: ['S04E01'], titles: ['Beyond the Known Universe'] },
      { codes: ['S04E02'], titles: ['The Moons of Thalos 3'] },
      { codes: ['S04E03'], titles: ['The Weird World of Wyrm'] },
      { codes: ['S04E04'], titles: ['The Outlaw Armaggon!'] },
      { codes: ['S04E05'], titles: ['Riddle of the Ancient Aeons'] },
      { codes: ['S04E06'], titles: ["Journey to the Center of Mikey's Mind"] },
      { codes: ['S04E07'], titles: ['The Arena of Carnage'] },
    ],
  },
  {
    disc: 14,
    entries: [
      { codes: ['S04E08'], titles: ['The War for Dimension X'] },
      { codes: ['S04E09'], titles: ['The Cosmic Ocean'] },
      { codes: ['S04E10'], titles: ['Trans-Dimensional Turtles'] },
      { codes: ['S04E11'], titles: ['Revenge of the Triceratons'] },
      { codes: ['S04E12'], titles: ['The Evil of Dregg'] },
    ],
  },
  {
    disc: 15,
    entries: [
      { codes: ['S04E13'], titles: ['The Ever-Burning Fire'] },
      { codes: ['S04E14'], titles: ["Earth's Last Stand"] },
      { codes: ['S04E15'], titles: ['City at War'] },
      { codes: ['S04E16'], titles: ['Broken Foot'] },
      { codes: ['S04E17'], titles: ['The Insecta Trifecta'] },
      { codes: ['S04E18'], titles: ['Mutant Gangland'] },
      { codes: ['S04E19'], titles: ['Bat in the Belfry'] },
    ],
  },
  {
    disc: 16,
    entries: [
      { codes: ['S04E20'], titles: ['The Super Shredder'] },
      { codes: ['S04E21'], titles: ['Darkest Plight'] },
      { codes: ['S04E22'], titles: ['The Power Inside Her'] },
      { codes: ['S04E23'], titles: ['Tokka vs. the World'] },
      { codes: ['S04E24'], titles: ['Tale of Tiger Claw'] },
      { codes: ['S04E25'], titles: ['Requiem'] },
    ],
  },
  {
    disc: 17,
    entries: [
      { codes: ['S04E26'], titles: ['Owari'] },
      { codes: ['S05E01'], titles: ['Scroll of the Demodragon'] },
      { codes: ['S05E02'], titles: ['The Forgotten Swordsman'] },
      { codes: ['S05E03'], titles: ['Heart of Evil'] },
      { codes: ['S05E04'], titles: ['End Times'] },
    ],
  },
  {
    disc: 18,
    // Real label read at insert 2026-08-16 (presumed FINAL_CHAPTERS_D2 first;
    // the loud-fail did its job). Sig from raw IFO read: 67:29 triple + 22:34.
    label: 'TofTMNT_WANTED_BEBOP&ROCKSTEADY',
    sig: [4049, 1354],
    entries: [
      {
        codes: ['S05E18', 'S05E19', 'S05E20'],
        titles: ['Wanted: Bebop and Rocksteady', 'The Foot Walks Again!', 'The Big Blow Out'],
      },
      { codes: ['S05E10'], titles: ['Lone Rat and Cubs'] },
    ],
  },
  {
    disc: 19,
    // Verified 2026-08-16 by raw IFO read: triple (64:13) + four 22:34
    // singles. Without this pin the subsequence matcher hands this disc to
    // disc 18 (triple + one single is a subset of this shape).
    label: 'TALES_OF_TMNT_FINAL_CHAPTERS_D1',
    sig: [3853, 1353, 1354, 1354, 1354],
    entries: [
      {
        codes: ['S05E11', 'S05E12', 'S05E13'],
        titles: [
          'Raphael Mutant Apocalypse, Part 1 The Wasteland Warrior',
          'Raphael Mutant Apocalypse, Part 2 The Impossible Desert',
          'Raphael Mutant Apocalypse, Part 3 Carmageddon',
        ],
      },
      { codes: ['S05E14'], titles: ['The Curse of Savanti Romero'] },
      { codes: ['S05E15'], titles: ['The Crypt of Dracula'] },
      { codes: ['S05E16'], titles: ['The Frankenstein Experiment'] },
      { codes: ['S05E17'], titles: ['Monsters Among Us'] },
    ],
  },
  {
    disc: 20,
    entries: [
      { codes: ['S05E05'], titles: ['When Worlds Collide (1)'] },
      { codes: ['S05E06'], titles: ['When Worlds Collide (2)'] },
      { codes: ['S05E07'], titles: ['Yojimbo'] },
      { codes: ['S05E08'], titles: ['Osoroshi no Tabi'] },
      { codes: ['S05E09'], titles: ['Kagayake! Kintaro'] },
    ],
  },
];

export function episodeCount(disc) {
  return disc.entries.reduce((n, e) => n + e.codes.length, 0);
}

const total = DISCS.reduce((n, d) => n + episodeCount(d), 0);
if (total !== 124) {
  throw new Error(`manifest episode total ${total} !== 124`);
}
