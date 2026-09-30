export function isTextOnlyStoryGroup(id: string): boolean {
  return /^event:(?:cmn|excursion)(?::|$)/.test(id) || id === 'adv_event_2505_01';
}
