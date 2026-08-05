import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  EPISODES_LIST_PATH,
  LIBRARY_SHOW_ROOT,
  SHOW_NAME,
  STAGING_ROOT,
} from '../config.mjs';

/**
 * Normalize episode title for fuzzy match:
 * lowercase, strip punctuation/quotes, normalize "Part N".
 */
export function normalizeTitle(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/["'`]/g, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\bpart\s+(\d+)\b/g, 'part $1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {string} [listPath]
 * @returns {Promise<{code:string, title:string, norm:string}[]>}
 */
export async function loadCanonicalEpisodes(listPath = EPISODES_LIST_PATH) {
  const text = await fsp.readFile(listPath, 'utf8');
  const eps = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const bar = t.indexOf('|');
    if (bar < 0) continue;
    const code = t.slice(0, bar).trim();
    const title = t.slice(bar + 1).trim();
    eps.push({ code, title, norm: normalizeTitle(title) });
  }
  return eps;
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = i;
    for (let j = 1; j <= b.length; j++) {
      const cur =
        a[i - 1] === b[j - 1]
          ? row[j - 1]
          : 1 + Math.min(row[j - 1], prev, row[j]);
      row[j - 1] = prev;
      prev = cur;
    }
    row[b.length] = prev;
  }
  return row[b.length];
}

/**
 * Fuzzy-match one OCR title against canonical list.
 * @returns {{match: object|null, ambiguous: boolean, candidates: object[]}}
 */
export function fuzzyMatchTitle(ocrTitle, canonical, usedCodes = new Set()) {
  const norm = normalizeTitle(ocrTitle);
  if (!norm) return { match: null, ambiguous: false, candidates: [] };

  const scored = [];
  for (const ep of canonical) {
    if (usedCodes.has(ep.code)) continue;
    let score;
    if (ep.norm === norm) score = 0;
    else if (ep.norm.includes(norm) || norm.includes(ep.norm)) {
      score = Math.abs(ep.norm.length - norm.length) + 0.5;
    } else {
      score = levenshtein(norm, ep.norm);
    }
    const maxLen = Math.max(ep.norm.length, norm.length) || 1;
    const ratio = score / maxLen;
    if (ratio <= 0.35 || score <= 3) {
      scored.push({ ep, score, ratio });
    }
  }
  scored.sort((a, b) => a.score - b.score || a.ratio - b.ratio);

  if (scored.length === 0) return { match: null, ambiguous: false, candidates: [] };

  const best = scored[0];
  const ties = scored.filter(
    (s) => s.score === best.score || Math.abs(s.ratio - best.ratio) < 0.02,
  );
  // Ambiguous if two different codes tie for best
  const uniqueCodes = new Set(ties.map((t) => t.ep.code));
  if (uniqueCodes.size > 1 && ties[0].score === ties[1]?.score) {
    return {
      match: null,
      ambiguous: true,
      candidates: ties.map((t) => t.ep),
    };
  }
  return { match: best.ep, ambiguous: false, candidates: [best.ep] };
}

function safeFilenameTitle(title) {
  return String(title)
    .replace(/[|"$:<>?*\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function seasonDir(code) {
  const m = /^S(\d{2})E\d{2}$/i.exec(code);
  const n = m ? m[1] : '01';
  return `Season ${n}`;
}

function destRelPath(code, title) {
  const safe = safeFilenameTitle(title);
  const file = `${SHOW_NAME} ${code} - ${safe}.mkv`;
  return path.join(seasonDir(code), file);
}

async function readEpisodesMd(folder) {
  const p = path.join(folder, 'episodes.md');
  try {
    const text = await fsp.readFile(p, 'utf8');
    return parseEpisodesMd(text);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export function parseEpisodesMd(text) {
  const episodes = [];
  let volume_number = null;
  let volume_title = '';
  let verified = false;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (/^verified:\s*true\b/i.test(t)) verified = true;
    const vn = t.match(/^volume_number:\s*(\d+)\s*$/i);
    if (vn) volume_number = Number(vn[1]);
    const vt = t.match(/^volume_title:\s*(.*)$/i);
    if (vt) volume_title = vt[1].trim();
    const numbered = t.match(/^\d+[.)]\s+(.+)$/);
    const bullet = t.match(/^[-*]\s+(.+)$/);
    if (numbered) episodes.push(numbered[1].trim());
    else if (bullet && !t.includes(':')) episodes.push(bullet[1].trim());
  }
  return { episodes, volume_number, volume_title, verified, raw: text };
}

async function readManifest(folder) {
  const p = path.join(folder, 'manifest.json');
  try {
    return JSON.parse(await fsp.readFile(p, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function listEpisodeFiles(folder, manifest) {
  if (Array.isArray(manifest?.outputs) && manifest.outputs.length) {
    return manifest.outputs.map((f) =>
      path.isAbsolute(f) ? f : path.join(folder, f),
    );
  }
  // Prefer ep-NN.mkv at folder root or latest attempt-*
  const names = await fsp.readdir(folder).catch(() => []);
  const eps = names
    .filter((n) => /^ep-\d+\.mkv$/i.test(n))
    .sort();
  if (eps.length) return eps.map((n) => path.join(folder, n));

  const attempts = names
    .filter((n) => /^attempt-\d+$/i.test(n))
    .sort()
    .reverse();
  for (const a of attempts) {
    const sub = path.join(folder, a);
    const subNames = await fsp.readdir(sub).catch(() => []);
    const subEps = subNames
      .filter((n) => /^ep-\d+\.mkv$/i.test(n))
      .sort();
    if (subEps.length) return subEps.map((n) => path.join(sub, n));
  }
  return [];
}

/**
 * Build finalize plan for staging vol folders.
 * Fail-closed gates (Review-resolutions 4 & 11).
 *
 * @param {{
 *   stagingRoot?: string,
 *   libraryRoot?: string,
 *   episodesPath?: string,
 *   trustTitleOrder?: boolean,
 *   apply?: boolean,
 * }} [opts]
 */
export async function buildFinalizePlan(opts = {}) {
  const stagingRoot = opts.stagingRoot || STAGING_ROOT;
  const libraryRoot = opts.libraryRoot || LIBRARY_SHOW_ROOT;
  const episodesPath = opts.episodesPath || EPISODES_LIST_PATH;
  const trustTitleOrder = Boolean(opts.trustTitleOrder);

  const canonical = await loadCanonicalEpisodes(episodesPath);
  const entries = await fsp.readdir(stagingRoot, { withFileTypes: true }).catch((err) => {
    if (err.code === 'ENOENT') return [];
    throw err;
  });

  const volDirs = entries
    .filter((d) => d.isDirectory() && /^(vol|vol-unknown)/i.test(d.name))
    .map((d) => path.join(stagingRoot, d.name))
    .sort();

  const volumes = [];
  const mapLines = [];
  const reasons = [];
  let ok = true;
  const usedCodes = new Set();

  for (const folder of volDirs) {
    const name = path.basename(folder);
    const manifest = await readManifest(folder);
    const epMeta = await readEpisodesMd(folder);
    const files = await listEpisodeFiles(folder, manifest);

    const volResult = {
      folder,
      name,
      mode: manifest?.mode || 'playall',
      refused: false,
      refuseReasons: [],
      mappings: [],
    };

    const ocrVerified =
      (manifest?.ocr?.verified === true || epMeta?.verified === true) &&
      epMeta &&
      Array.isArray(epMeta.episodes) &&
      epMeta.episodes.length > 0;

    if (!ocrVerified) {
      volResult.refused = true;
      volResult.refuseReasons.push('OCR missing or unverified');
    }

    if (/^vol-unknown/i.test(name)) {
      volResult.refused = true;
      volResult.refuseReasons.push('neutral/unknown folder (OCR never verified)');
    }

    const ocrEps =
      epMeta?.episodes ||
      manifest?.ocr?.episodes ||
      [];

    if (ocrVerified && files.length !== ocrEps.length) {
      volResult.refused = true;
      volResult.refuseReasons.push(
        `episode count mismatch: OCR=${ocrEps.length} files=${files.length}`,
      );
    }

    if (volResult.mode === 'per-title' && !trustTitleOrder) {
      volResult.refused = true;
      volResult.refuseReasons.push(
        'per-title layout requires --trust-title-order',
      );
    }

    if (!volResult.refused) {
      const localUsed = new Set(usedCodes);
      for (let i = 0; i < ocrEps.length; i++) {
        const ocrTitle = ocrEps[i];
        const file = files[i];
        const { match, ambiguous, candidates } = fuzzyMatchTitle(
          ocrTitle,
          canonical,
          localUsed,
        );
        if (ambiguous) {
          volResult.refused = true;
          volResult.refuseReasons.push(
            `ambiguous match for "${ocrTitle}": ${candidates.map((c) => c.code).join(', ')}`,
          );
          break;
        }
        if (!match) {
          volResult.refused = true;
          volResult.refuseReasons.push(`no canonical match for "${ocrTitle}"`);
          break;
        }
        if (localUsed.has(match.code) || usedCodes.has(match.code)) {
          volResult.refused = true;
          volResult.refuseReasons.push(`duplicated canonical code ${match.code}`);
          break;
        }
        localUsed.add(match.code);

        const dstRel = destRelPath(match.code, match.title);
        const dstAbs = path.join(libraryRoot, dstRel);
        try {
          await fsp.access(dstAbs);
          volResult.refused = true;
          volResult.refuseReasons.push(`destination exists: ${dstAbs}`);
          break;
        } catch {
          /* ok — does not exist */
        }

        const srcRel = path.relative(stagingRoot, file);
        volResult.mappings.push({
          src: file,
          srcRel,
          srcBase: path.basename(file),
          dst: dstAbs,
          dstRel: path.join(path.basename(libraryRoot) === path.basename(LIBRARY_SHOW_ROOT)
            ? path.relative(path.dirname(libraryRoot), dstAbs)
            : dstRel),
          code: match.code,
          title: match.title,
          ocrTitle,
        });
      }

      if (!volResult.refused) {
        for (const m of volResult.mappings) usedCodes.add(m.code);
      }
    }

    if (volResult.refused) {
      ok = false;
      reasons.push(`${name}: ${volResult.refuseReasons.join('; ')}`);
      volResult.mappings = [];
    } else {
      for (const m of volResult.mappings) {
        // rename_show map: source relative to a chosen ROOT.
        // Emit staging-relative source | library-relative dest under media root when possible.
        mapLines.push(`${m.srcRel}|${path.relative(path.dirname(stagingRoot), m.dst).replace(/^\.\.\//, '') || m.dst}`);
      }
    }

    volumes.push(volResult);
  }

  // Cleaner map: paths relative to media parent if both under same tree
  const cleanMap = [];
  for (const vol of volumes) {
    if (vol.refused) continue;
    for (const m of vol.mappings) {
      cleanMap.push(`${m.src}|${m.dst}`);
    }
  }

  const table = formatPlanTable(volumes);

  return {
    ok,
    reasons,
    volumes,
    mapLines: cleanMap.length ? cleanMap : mapLines,
    table,
    stagingRoot,
    libraryRoot,
  };
}

function formatPlanTable(volumes) {
  const lines = [
    'volume                  | file       | code   | title',
    '------------------------+------------+--------+------------------------------',
  ];
  for (const vol of volumes) {
    if (vol.refused) {
      lines.push(
        `${vol.name.padEnd(24)} | (REFUSED)  |        | ${vol.refuseReasons.join('; ')}`,
      );
      continue;
    }
    for (const m of vol.mappings) {
      lines.push(
        `${vol.name.padEnd(24)} | ${m.srcBase.padEnd(10)} | ${m.code.padEnd(6)} | ${m.title}`,
      );
    }
  }
  return lines.join('\n');
}

/**
 * Write mapfile + optionally apply via rename (mv). Fail if missing>0 or !ok.
 */
export async function applyFinalizePlan(plan, { dryRun = false, mapPath, undoPath } = {}) {
  if (!plan.ok) {
    throw new Error(`finalize refuse: ${plan.reasons.join(' | ')}`);
  }
  const mapFile =
    mapPath ||
    path.join(plan.stagingRoot, `_finalize_map_${Date.now()}.txt`);
  const undoFile =
    undoPath ||
    path.join(plan.stagingRoot, `_finalize_undo_${Date.now()}.sh`);

  await fsp.writeFile(mapFile, `${plan.mapLines.join('\n')}\n`, 'utf8');

  if (dryRun) {
    return { mapFile, undoFile: null, moved: 0, missing: 0, dryRun: true };
  }

  let moved = 0;
  let missing = 0;
  const undo = ['#!/bin/bash', 'set -euo pipefail'];

  for (const line of plan.mapLines) {
    const bar = line.indexOf('|');
    const src = line.slice(0, bar);
    const dst = line.slice(bar + 1);
    try {
      await fsp.access(src);
    } catch {
      missing += 1;
      continue;
    }
    await fsp.mkdir(path.dirname(dst), { recursive: true });
    await fsp.rename(src, dst);
    undo.push(`mv ${JSON.stringify(dst)} ${JSON.stringify(src)}`);
    moved += 1;
  }

  // Write the undo script BEFORE any abort so partially-applied moves stay reversible.
  await fsp.writeFile(undoFile, `${undo.join('\n')}\n`, 'utf8');
  await fsp.chmod(undoFile, 0o755);

  if (missing > 0) {
    throw new Error(`finalize apply aborted: missing=${missing} (moved=${moved}, undo: ${undoFile})`);
  }
  return { mapFile, undoFile, moved, missing };
}
