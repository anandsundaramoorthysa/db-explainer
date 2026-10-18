/** Column names that probably hold personal or secret data. Their values are never sent to the AI. */
const SENSITIVE_COLUMN = /(pass(word|wd)?|pwd|secret|token|api[_-]?key|salt|hash|ssn|aadhaar|aadhar|pan[_-]?(no|number)?|passport|card|cvv|iban|account[_-]?(no|number)|email|e[_-]?mail|phone|mobile|contact|address|street|dob|birth|salary|wage|license|licence)/i;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const LONG_NUMBER = /\b\d[\d -]{8,}\d\b/g;
const TOKEN = /\b[A-Za-z0-9+/_-]{32,}={0,2}(?![A-Za-z0-9+/_-])/g;

export interface MaskedSample {
  columns: string[];
  rows: string[][];
  maskedColumns: string[];
  totalRows: number;
  sentRows: number;
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function maskValue(text: string): string {
  return text.replace(EMAIL, '[email]').replace(LONG_NUMBER, '[number]').replace(TOKEN, '[token]');
}

/** Prepares a few result rows for the AI: sensitive-looking columns are replaced, and emails, long numbers and tokens are hidden in the rest. */
export function maskSample(columns: string[], rows: unknown[][], maxRows: number): MaskedSample {
  const maskedColumns = columns.filter((c) => SENSITIVE_COLUMN.test(c));
  const sent = rows.slice(0, maxRows).map((row) => row.map((value, i) => (SENSITIVE_COLUMN.test(columns[i]) ? '[hidden]' : maskValue(cell(value)).slice(0, 120))));
  return { columns, rows: sent, maskedColumns, totalRows: rows.length, sentRows: sent.length };
}

/** Plain text table for the prompt. */
export function sampleToText(s: MaskedSample): string {
  const lines = [s.columns.join(' | ')];
  for (const r of s.rows) lines.push(r.join(' | '));
  return lines.join('\n');
}
