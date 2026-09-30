import type { Story } from './idoly-types';

export type TranslationStatus = 'empty' | 'human' | 'completed';
export const translationStatusLabels = {empty:'待翻译',human:'待校对',completed:'已完成'};
export function storyTranslationStatus(story: Story): TranslationStatus {
 return story.translationStatus ?? (story.humanLines > 0 ? 'human' : 'empty');
}
