import type { Catalog, Story } from './idoly-types';
import type { Directory } from './StoryDirectory';
import { matchesCardFilters, type CardFilters, type CardTraits } from './card-filters';
import { storyTranslationStatus } from './translation-status';

type IndexedStory = {
  story: Story;
  characters: string[];
  groups: Set<string>;
  search: string;
  status: ReturnType<typeof storyTranslationStatus>;
  traits?: CardTraits;
};
export type StorySearchIndex = Map<string, IndexedStory[]>;

// Catalog metadata stays fixed for the pinned release; prepare it once.
export function buildStorySearchIndex(catalog: Catalog | null, directory: Directory | null): StorySearchIndex {
  const index: StorySearchIndex = new Map();
  if (!catalog || !directory) return index;
  const groups = new Map(catalog.characters.map(character => [character.id, character.group]));
  const labels = new Map<string, string>();
  function groupLabel(id: string): string {
    if (!labels.has(id)) {
      const node = directory!.nodes[id];
      labels.set(id, node ? [node.label, node.parent ? groupLabel(node.parent) : ''].filter(Boolean).join(' ') : '');
    }
    return labels.get(id)!;
  }
  for (const story of catalog.stories) {
    const entry = directory.stories[story.id];
    if (!entry?.indexVisible) continue;
    const category = story.category === 'love' ? 'event' : story.category;
    const characters = ['bond', 'card', 'hbd'].includes(story.category)
      ? [story.id.split('_')[story.category === 'hbd' ? 3 : 2]] : story.characters;
    const bucket = index.get(category) || [];
    bucket.push({
      story, characters,
      groups: new Set(characters.map(id => groups.get(id)).filter((id): id is string => id !== undefined)),
      search: `${story.title} ${story.originalTitle} ${story.id} ${groupLabel(entry.group)} ${story.references.map(ref => ref.label).join(' ')}`.toLowerCase(),
      status: storyTranslationStatus(story),
      traits: directory.nodes[entry.group]?.cardTraits,
    });
    index.set(category, bucket);
  }
  return index;
}

export function filterStories(index: StorySearchIndex, filters: {
  category: string; character: string; group: string; status: string; query: string; cardFilters: CardFilters;
}): Story[] {
  const { category, character, group, status, cardFilters } = filters;
  const query = filters.query.toLowerCase();
  return (index.get(category) || []).filter(entry =>
    (!character || entry.characters.includes(character)) &&
    (group === 'all' || entry.groups.has(group)) &&
    (category !== 'card' || matchesCardFilters(entry.traits, cardFilters)) &&
    (status === 'all' || entry.status === status) &&
    (!query || entry.search.includes(query))
  ).map(entry => entry.story);
}
