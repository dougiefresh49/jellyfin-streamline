/**
 * Mighty Morphin Power Rangers (Shout! Factory box) — Season 1 so far.
 * Entry order = on-disc play order from the case insert (photographed
 * 2026-08-16); codes = TMDb tv/695 broadcast numbering, which matches the
 * insert's continuous 1-60 numbering exactly. All entries are single-episode
 * titles (~20 min) — the two-parters are separate broadcast episodes, so no
 * split step ever runs. Seasons 2-3 + Alien Rangers discs get appended when
 * their inserts go under the camera (discs 7+).
 */

export const SHOW_NAME = 'Mighty Morphin Power Rangers (1993)';
export const AVG_EP_S = 20 * 60;

const S1_TITLES = [
  ['Day of the Dumpster', 'High Five', 'Teamwork', 'A Pressing Engagement', 'Different Drum',
    'Food Fight', 'Big Sisters', 'I, Eye Guy', 'For Whom the Bell Trolls', 'Happy Birthday, Zack'],
  ['No Clowning Around', 'Power Ranger Punks', 'Peace, Love and Woe', 'Foul Play in the Sky', 'Dark Warrior',
    'Switching Places', 'Green with Evil (1) Out of Control', 'Green with Evil (2) Jasons Battle',
    'Green with Evil (3) The Rescue', 'Green with Evil (4) Eclipsing Megazord'],
  ['Green with Evil (5) Breaking the Spell', 'The Trouble with Shellshock', 'Itsy Bitsy Spider', 'The Spit Flower',
    'Lifes a Masquerade', 'Gung Ho!', 'Wheel of Misfortune', 'Island of Illusion (1)', 'Island of Illusion (2)',
    'The Rockstar'],
  ['Calamity Kimberly', 'A Star Is Born', 'The Yolks on You', 'The Green Candle (1)', 'The Green Candle (2)',
    'Birds of a Feather', 'Clean-Up Club', 'A Bad Reflection on You', 'Doomsday (1)', 'Doomsday (2)'],
  ['Ritas Seed of Evil', 'A Pig Surprise', 'Something Fishy', 'Lions and Blizzards', 'Crystal of Nightmares',
    'To Flea or Not to Flee', 'Reign of the Jellyfish', 'Plague of the Mantis', 'Return of an Old Friend (1)',
    'Return of an Old Friend (2)'],
  ['Grumble Bee', 'Two Heads Are Better Than One', 'Fowl Play', 'Trick or Treat', 'Second Chance',
    'On Fins and Needles', 'Enter... The Lizzinator', 'Football Season', 'Mighty Morphin Mutants', 'An Oyster Stew'],
];

// Season 2 (insert photographed 2026-08-16): 52 episodes, UNEVEN disc sizes
// (9/9/8/9/9/8) unlike S1's flat 10s. Insert bottom edge cut off D2 #16-18 and
// D4 #33-35 — filled from the broadcast list the visible numbering follows
// exactly; a count/duration mismatch still fails loudly at scan time.
const S2_TITLES = [
  ['The Mutiny, Part 1', 'The Mutiny, Part 2', 'The Mutiny, Part 3', 'The Wanna-Be Ranger', 'Putty on the Brain',
    'Bloom of Doom', 'The Green Dream', 'The Power Stealer', 'The Beetle Invasion'],
  ['Welcome to Venus Island', 'The Song of Guitardo', 'Green No More, Part 1', 'Green No More, Part 2',
    'Missing Green', 'Orchestral Maneuvers in the Park', 'The Beauty and the Beast', 'White Light, Part 1',
    'White Light, Part 2'],
  ['Two for One', 'Opposites Attract', 'Zedds Monster Mash', 'The Ninja Encounter, Part 1',
    'The Ninja Encounter, Part 2', 'The Ninja Encounter, Part 3', 'A Monster of Global Proportions', 'Zedd Waves'],
  ['The Power Transfer, Part 1', 'The Power Transfer, Part 2', 'Goldars Vice-Versa', 'Mirror of Regret',
    'When Is a Ranger Not a Ranger', 'Rocky Just Wants to Have Fun', 'Lights, Camera, Action',
    'Where Theres Smoke, Theres Fire', 'Scavenger Hunt'],
  ['The Great Bookala Escape', 'Forever Friends', 'A Reel Fish Story', 'Rangers Back in Time, Part 1',
    'Rangers Back in Time, Part 2', 'The Wedding, Part 1', 'The Wedding, Part 2', 'The Wedding, Part 3',
    'The Return of the Green Ranger, Part 1'],
  ['The Return of the Green Ranger, Part 2', 'The Return of the Green Ranger, Part 3', 'Best Man for the Job',
    'Storybook Rangers, Part 1', 'Storybook Rangers, Part 2', 'Wild West Rangers, Part 1',
    'Wild West Rangers, Part 2', 'Blue Ranger Gone Bad'],
];

// Season 3 (insert photographed 2026-08-16, fully legible): 33 episodes,
// disc sizes 9/8/8/8. Alien Rangers disc still pending its own insert.
const S3_TITLES = [
  ['A Friend in Need, Part 1', 'A Friend in Need, Part 2', 'A Friend in Need, Part 3', 'Ninja Quest, Part 1',
    'Ninja Quest, Part 2', 'Ninja Quest, Part 3', 'Ninja Quest, Part 4', 'A Brush with Destiny',
    'Passing the Lantern'],
  ['Wizard for a Day', 'Fourth Down and Long', 'Stop the Hate Master, Part 1', 'Stop the Hate Master, Part 2',
    'Final Face-Off', 'The Potion Notion', 'Im Dreaming of a White Ranger', 'A Ranger Catastrophe, Part 1'],
  ['A Ranger Catastrophe, Part 2', 'Changing of the Zords, Part 1', 'Changing of the Zords, Part 2',
    'Changing of the Zords, Part 3', 'Follow That Cab', 'A Different Shade of Pink, Part 1',
    'A Different Shade of Pink, Part 2', 'A Different Shade of Pink, Part 3'],
  ['Ritas Pita', 'Another Brick in the Wall', 'A Chimp in Charge', 'Master Vile and the Metallic Armor, Part 1',
    'Master Vile and the Metallic Armor, Part 2', 'Master Vile and the Metallic Armor, Part 3',
    'The Sound of Dischordia', 'Rangers in Reverse'],
];

function seasonDiscs(seasonTitles, { season, firstDisc, labelPrefix }) {
  let ep = 0;
  return seasonTitles.map((titles, d) => {
    const first = ep;
    ep += titles.length;
    return {
      disc: firstDisc + d,
      // Every disc in this set shares the same shape (~20min singles), so
      // identity MUST come from the label pin — shape matching alone named
      // disc 4's content as disc 3 when the discs went into the drives
      // swapped. S1 labels verified as MMPR_S1_D<n>; S2 pattern assumed
      // (a wrong pin fails loudly, never silently).
      label: `${labelPrefix}${d + 1}`,
      entries: titles.map((title, i) => ({
        codes: [`S${String(season).padStart(2, '0')}E${String(first + i + 1).padStart(2, '0')}`],
        titles: [title],
      })),
    };
  });
}

// Alien Rangers miniseries (10 eps, one disc). Observed label MMAR_S3_D5 —
// Shout! styles it as S3 disc 5 of the Alien Rangers set despite the S4 D1
// disc face. Officially tracked as Season 3 E34-43 (TMDb tv/695 agrees).
const ALIEN_TITLES = [
  ['Alien Rangers of Aquitar, Part 1', 'Alien Rangers of Aquitar, Part 2', 'Climb Every Fountain',
    'The Alien Trap', 'Attack of the 60 Foot Bulk', 'Water You Thinking', 'Along Came a Spider',
    'Sowing the Seas of Evil', 'Hogday Afternoon, Part 1', 'Hogday Afternoon, Part 2'],
];

export const DISCS = [
  ...seasonDiscs(S1_TITLES, { season: 1, firstDisc: 1, labelPrefix: 'MMPR_S1_D' }),
  ...seasonDiscs(S2_TITLES, { season: 2, firstDisc: 7, labelPrefix: 'MMPR_S2_D' }),
  // S3 drops the second underscore: observed label on disc 1 is MMPR_S3D1.
  ...seasonDiscs(S3_TITLES, { season: 3, firstDisc: 13, labelPrefix: 'MMPR_S3D' }),
  {
    disc: 17,
    label: 'MMAR_S3_D5',
    entries: ALIEN_TITLES[0].map((title, i) => ({
      codes: [`S03E${34 + i}`],
      titles: [title],
    })),
  },
];

export function episodeCount(disc) {
  return disc.entries.reduce((n, e) => n + e.codes.length, 0);
}

const total = DISCS.reduce((n, d) => n + episodeCount(d), 0);
if (total !== 155) {
  throw new Error(`manifest episode total ${total} !== 155`);
}
