import { translationLineLengths } from '../../server/idoly-script.mjs';
// CSV uses literal backslash-n; textarea uses real line breaks.
export const editorText = (text: string) => text.replace(/\\n/g, '\n').replace(/\r\n?/g, '\n');
export const csvText = (text: string) => text.replace(/\r\n?|\n/g, '\\n');
export function lineLengths(text: string): number[] {
  // Count visible base text only, not markup or ruby annotations.
  return translationLineLengths(text);
}
export function longLines(rows: { text: string; trans: string }[]) {
  return rows.flatMap((row, i) => row.text.includes('\\n') ? lineLengths(row.trans).flatMap((length, line) => length > 21 ? [{ row: i + 1, line: line + 1, length }] : []) : []);
}
export function insertFormat(text: string, start: number, end: number, kind: 'em' | 'ruby', annotation = '') {
  const selected = text.slice(start, end) || '文字';
  if (kind === 'ruby' && /[<>\r\n\\]/.test(annotation)) throw new Error('注音不能包含尖括号、反斜杠或换行');
  const open = kind === 'em' ? '<em\\=>' : `<r\\=${annotation}>`;
  const close = kind === 'em' ? '</em>' : '</r>';
  return { text: text.slice(0, start) + open + selected + close + text.slice(end), start: start + open.length, end: start + open.length + selected.length };
}
