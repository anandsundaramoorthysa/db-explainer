import * as fs from 'fs';
import * as path from 'path';

const HEADER = '# Team notes\n\nWhat the tables, columns and values in our database mean. DB Explainer reads this file for every answer, so keep it short and true. Commit it so the whole team benefits.\n';

/** Adds a note to the text of a notes file. Notes about a table go under a heading with its name. */
export function addNoteToText(existing: string, note: string, table?: string): string {
  const clean = note.trim().replace(/\s*\n\s*/g, ' ');
  if (!clean) return existing;
  const base = existing.trim() ? existing.replace(/\s+$/, '') + '\n' : HEADER;
  const bullet = `- ${clean}`;
  if (!table) {
    const generalHeading = /^## General\s*$/m;
    if (!generalHeading.test(base)) return `${base}\n## General\n${bullet}\n`;
    return insertUnderHeading(base, 'General', bullet);
  }
  const heading = new RegExp(`^##\\s+${escapeRegExp(table)}\\s*$`, 'mi');
  if (!heading.test(base)) return `${base}\n## ${table}\n${bullet}\n`;
  return insertUnderHeading(base, table, bullet);
}

function insertUnderHeading(text: string, heading: string, bullet: string): string {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`, 'i').test(l));
  let end = at + 1;
  while (end < lines.length && !/^##?\s/.test(lines[end])) end += 1;
  while (end > at + 1 && lines[end - 1].trim() === '') end -= 1;
  lines.splice(end, 0, bullet);
  return lines.join('\n').replace(/\s+$/, '') + '\n';
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function readNotes(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

export function saveNote(file: string, note: string, table?: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, addNoteToText(readNotes(file), note, table), 'utf8');
}
