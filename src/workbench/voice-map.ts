import type { ChapterVoices } from '../catalog';
import type { IdolyVoices } from '../StoryChapter';
import type { CsvTextInfo } from './upstream/csv';

export function buildVoiceMap(source: CsvTextInfo | null, sourceHash: string, voices?: ChapterVoices, idolyVoices?: IdolyVoices) {
  const result = new Map<number, ChapterVoices['lines'][number]>();
  if (!source) return result;
  const rowIndices = new Map(source.data.map((row, index) => [row, index]));
  const identity = (id: string, text: string, name: string) => JSON.stringify([id, text, name]);
  const rowIds = new Map<string, number>();
  source.data.forEach((row, index) => {
    const key = identity(row.id, row.text, row.name);
    if (!rowIds.has(key)) rowIds.set(key, index);
  });
  if (voices?.source_sha256 === sourceHash) {
    for (const line of voices.lines) {
      const row = source.records[line.record_index - 1];
      const index = row && rowIndices.get(row);
      if (index !== undefined && row.text === line.text && row.name === line.speaker) result.set(index, line);
    }
  }
  for (const line of idolyVoices?.lines || []) {
    const index = rowIds.get(identity(line.row_id, line.text, line.speaker));
    if (index !== undefined) result.set(index, { record_index: index + 1, text: line.text, speaker: line.speaker, clips: line.clips });
  }
  return result;
}
