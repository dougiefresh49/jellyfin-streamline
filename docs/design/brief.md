# Task: redesign two Jellyfin screens to look like a modern streaming app

You are a senior mobile UI/UX designer. Produce a visual redesign CONCEPT as a self-contained HTML mockup for a self-hosted **Jellyfin** media server's web UI. It is viewed inside the Jellyfin mobile app (an Android/iOS web wrapper) by young kids. Today it looks generic and dated ("like Fandango / a database"). Make it feel like a **modern streaming app — Netflix / Disney+**: cinematic, poster-forward, minimal chrome, fast to the content.

## Deliverable (write these exact files)
1. A SINGLE self-contained HTML file at the path given as OUTPUT_HTML below. All CSS inline in one `<style>`; no external network requests (no CDN, no web fonts, no remote images — use CSS gradients / solid color blocks / inline SVG as placeholder art). Minimal inline JS is allowed ONLY for tab switching or expand/collapse if it makes the concept clearer. Mobile-first, ~412px wide phone frame(s), dark.
2. A short markdown file at OUTPUT_NOTES: 6-10 bullets of design rationale + a "feasibility flags" list — your best guess at which changes are a pure-CSS reskin of Jellyfin vs. which would need HTML/JS changes.

The HTML must mock up TWO screens, stacked vertically with a labeled divider between them, each inside a ~412px dark phone frame:
- **Screen A — TV Show detail page.** Sample: "Batman Beyond", TV-Y7, 1999–2001, ★8.2, 3 seasons. Must include a Play affordance, a "Continue / Next Up" episode, and a Seasons row.
- **Screen B — Season / episode list page.** Sample: "Batman Beyond — Season 1" with episodes: "1. Rebirth (1)", "2. Rebirth (2)", "3. Black Out", each with a thumbnail, runtime (~21m), and a 2-line description.

## Hard requirements — the owner's specific complaints, FIX ALL of these
1. **Remove the shuffle and checkmark buttons** from the action row. Keep Play as a prominent PRIMARY button (Netflix/Disney+ pill style), plus at most a Favorite (heart) and an overflow (⋯). No row of five equal tiny icons.
2. **Kill the hero+poster redundancy.** Today it shows a big backdrop AND a separate overlapping poster card — wasted space. Choose ONE cinematic treatment (single hero/backdrop with title/logo overlaid, OR a poster-forward layout), not both.
3. **Cut the wasted vertical space** before real content. The owner must reach Next Up / Seasons fast. Tighten header + metadata + buttons.
4. **Clamp episode descriptions to ~2 lines** on the season page (Disney+ style), not full paragraphs.
5. **The synopsis "Show more" must actually expand/collapse**, or be removed. (Today the label toggles but nothing happens.)
6. **Remove the per-episode heart button** on each episode row (confusing for kids). Keep a play affordance, maybe a subtle "watched" tick, and overflow.

## Aesthetic direction
Dark near-black, high contrast, big readable type. Cinematic hero; minimal metadata (title, content-rating badge, year — DROP tags/genres/studios/cast). Prominent Play/Resume. Content rows (Next Up, Seasons) as clean rounded cards. Episode list like Disney+/Netflix: thumbnail + title + runtime + 2-line clamped description + minimal controls. Disney+-style tabs (Episodes / Suggested / Extras) optional.

## Visual references
Image files are in the same folder as this brief under `design-refs/` (gpt: they are also attached to this message). If you cannot view images, rely on these descriptions:

CURRENT JELLYFIN (what to REPLACE):
- `jellyfin-current-show-1.png`: Show page. Big blue Batman backdrop, THEN a poster card overlapping its bottom-left (redundant), title "Batman Beyond", a row of tiny metadata (1999-2001, TV-Y7 pill, ★8.2), then FIVE equal ghost-white icon buttons (play, shuffle, check, heart, ⋯), then a 3-line clamped synopsis with a non-working "Show more", and only far below: "Next Up". Tons of dead space.
- `jellyfin-current-show-2.png`: Same page scrolled: "Next Up" (single episode thumbnail), "Seasons" (3 tall poster cards with episode-count badges), "Special Features" row.
- `jellyfin-current-season-1.png`: Season page — same wasteful hero+poster+title("Season 1")+five-icon-row, then episode row "1. Rebirth (1)" with a heart + ⋯ on the right, then a FULL unclamped multi-line description.
- `jellyfin-current-season-2.png`: Episode list — each row is a thumbnail + "N. Title" + heart + ⋯, then a full paragraph description below; a small check overlay marks watched episodes. Descriptions are way too long.

TARGET AESTHETIC (what to emulate):
- `ref-disneyplus-episodes.png`: Disney+ episode list. Clean top bar (back, title, share, cast). Tabs: EPISODES / SUGGESTED / EXTRAS / DETAILS with underline on active. "Season 1" + a Season download control. Each episode: left thumbnail (with a round play button + tiny Disney+ badge), right side "N. Chapter title" + runtime + download icon, then a TIGHT 2-line description. Very legible, minimal, no hearts.
- `ref-netflix-show-detail.png`: Netflix show page. Full-bleed video/backdrop hero (NO separate poster), big bold title, one line of metadata (year, rating, seasons, HD), a full-width white "Play" button + a secondary "Download" button, a 2-3 line synopsis, "Starring… more" (clamped), then a small row of My List / Rate / Download icons with labels, then Episodes.
- `ref-netflix-episodes.png`: Netflix episode list — "Season 1 ▾" dropdown, each episode: thumbnail with play + red progress bar + "N. Title" + runtime + download, then a 2-line description. Clean.
- `ref-netflix-kids-home-1.png` / `ref-netflix-kids-home-2.png`: Netflix KIDS home — big colorful rounded cards in horizontal rows ("Favorites", "Only on Netflix", "Continue Watching for Emma & Eli"), playful, bottom nav (Home / Search / My Netflix). Good reference for kid-friendly warmth.
- `ref-netflix-movie.png`: Netflix movie page — hero, title, year/PG/runtime, "#10 in Movies Today" badge, big white Resume + Download, progress bar "38m remaining", 2-3 line synopsis, My List / Rate.
- `ref-appletv-detail.png`: Apple TV — big full-bleed poster hero with title overlaid, "TV Show · Sci-Fi · Thriller", a Play pill with progress, a clamped "S1,E1 · … MORE" description line, metadata badges, "Season 1 ▾" then episode thumbnails.

## Constraints
- This is YOUR independent concept — assume no other design exists; do not collaborate.
- Placeholder art only (CSS gradients / colored blocks / inline SVG). Do NOT fetch remote images or fonts. Use system font stack.
- Make it look real and polished, not a wireframe. Aim for something the owner looks at and says "yes, that's a streaming app."
