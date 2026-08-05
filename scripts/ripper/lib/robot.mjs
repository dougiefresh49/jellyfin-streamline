const RECORD_TYPES = new Set(['DRV', 'TINFO', 'CINFO', 'MSG', 'PRGV', 'TCOUNT']);

function parseCsv(text) {
  const fields = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '\\' && (text[i + 1] === '"' || text[i + 1] === '\\')) {
        // makemkvcon escapes quotes/backslashes inside quoted fields as \" and \\
        field += text[i + 1];
        i += 1;
      } else if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
    } else if (char === ',') {
      fields.push(field);
      field = '';
    } else if (char === '"' && field.length === 0) {
      quoted = true;
    } else {
      field += char;
    }
  }
  if (quoted) throw new Error('Unterminated quoted robot field');
  fields.push(field);
  return fields;
}

export function parseRobotLine(line) {
  const clean = String(line).replace(/[\r\n]+$/, '');
  const separator = clean.indexOf(':');
  if (separator < 1) return null;
  const type = clean.slice(0, separator);
  if (!RECORD_TYPES.has(type)) return null;
  return { type, fields: parseCsv(clean.slice(separator + 1)) };
}

function durationSeconds(value) {
  const parts = String(value).split(':').map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return 0;
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

export function parseInfoOutput(text) {
  const drives = [];
  const titlesById = new Map();
  let discLabel = '';

  for (const line of String(text).split(/\r?\n/)) {
    const record = parseRobotLine(line);
    if (!record) continue;
    const { type, fields } = record;
    if (type === 'DRV') {
      drives.push({
        index: Number(fields[0]),
        mediaPresent: Number(fields[3]) !== 0,
        driveName: fields[4] ?? '',
        discLabel: fields[5] ?? '',
        osDevice: fields[6] ?? '',
      });
    } else if (type === 'CINFO' && [2, 30, 32].includes(Number(fields[0])) && fields[2]) {
      discLabel ||= fields[2];
    } else if (type === 'TINFO') {
      const id = Number(fields[0]);
      if (!Number.isInteger(id)) continue;
      const title = titlesById.get(id) ?? { id, chapters: 0, duration_s: 0, sizeStr: '', outName: '' };
      const attr = Number(fields[1]);
      const value = fields[3] ?? '';
      if (attr === 8) title.chapters = Number(value) || 0;
      if (attr === 9) title.duration_s = durationSeconds(value);
      if (attr === 10) title.sizeStr = value;
      if (attr === 27) title.outName = value;
      titlesById.set(id, title);
    }
  }

  return { drives, discLabel, titles: [...titlesById.values()].sort((a, b) => a.id - b.id) };
}
