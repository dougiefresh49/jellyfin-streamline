# Task: check MakeMKV state and act if it's on the "Make" screen

You are doing a local macOS computer-use check on the app **MakeMKV**. Make NO paid API calls. Do not close or quit any app. Only interact with MakeMKV.

Context: a disc ("Batman vs TMNT") is being ripped. I need MakeMKV's current screen state, and IF (and only if) it has reached the title-list / Make screen, you will set the output folder and start the rip.

## Steps

1. Bring MakeMKV to the foreground: run `open -a MakeMKV`, wait 2s. Take a screenshot and save it to `/private/tmp/claude-501/-Users-dougiefresh49-projects-cursor-read-aloud/1f089a46-d800-4aca-b445-7b9453ff17f3/scratchpad/makemkv-watch/latest.png` (create that dir if needed; overwrite each run).

2. Classify the current state into ONE of:
   - **A = DISC ANALYSIS IN PROGRESS**: a progress bar (e.g. "Opening disc", "Analyzing", "Saving all files to MKV" is NOT this — that's ripping) is reading the disc BEFORE any title list appears.
   - **B = TITLE / MAKE SCREEN**: a list of titles with checkboxes is displayed; there is an **output folder field** near the top-right and a large **"Make MKV"** button (hard-drive icon with a green arrow) on the right. This is the actionable screen.
   - **C = RIPPING IN PROGRESS**: two progress bars ("Current progress" / "Total progress") with elapsed time and an estimated time remaining.
   - **D = DONE / IDLE**: ripping finished (success dialog) or app idle with no disc loaded.

3. ACTION:
   - **Only if state B**:
     a. Set the output/destination folder to EXACTLY `/Users/dougiefresh49/Movies/_staging`. The folder selector is a path field near the top-right with a browse ("...") button. Click browse; in the macOS folder chooser press **Cmd+Shift+G**, type `/Users/dougiefresh49/Movies/_staging`, press Return, then confirm/choose that folder.
     b. Do NOT change any title checkboxes — leave MakeMKV's default selection as-is.
     c. Click the **"Make MKV"** button to start ripping.
     d. Wait ~20 seconds for ripping to begin, take another screenshot (`.../makemkv-watch/after-make.png`), and read the estimated time remaining from the "Total progress" area.
   - **For states A, C, D: take NO action** (do not click anything). Just observe and report.

4. Report back EXACTLY in this format (one field per line):
```
STATE: <A|B|C|D>
ACTION_TAKEN: <none | set folder to _staging and clicked Make MKV>
OUTPUT_FOLDER: <folder shown, or unknown>
ESTIMATED_TIME_REMAINING: <e.g. 0:42:15, or n/a>
PROGRESS: <any % or "title x of y" visible, or n/a>
SCREENSHOT: <path to the screenshot>
NOTES: <errors, dialogs, multiple discs, or anything unexpected>
```

Be precise and literal about what is on screen. If you cannot see the screen or MakeMKV won't focus, say so plainly in NOTES.
