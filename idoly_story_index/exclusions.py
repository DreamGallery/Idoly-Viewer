"""Confirmed duplicate exclusions, revalidated against source dialogue on each build."""
import csv

DUPLICATE_STORIES = {
    'adv_event_2410_01_05': ('adv_event_2410_01_05_01', 'adv_event_2410_01_05_02'),
}

def confirmed_exclusions(source):
    paths = {p.stem: p for p in (source / 'CSV').rglob('*.csv')}
    def dialogue(sid):
        with paths[sid].open(encoding='utf-8-sig', newline='') as stream:
            return [(row['name'], row['text']) for row in csv.DictReader(stream)
                    if row['id'] not in ('info', '译者')]
    for duplicate, parts in DUPLICATE_STORIES.items():
        full, first, second = dialogue(duplicate), dialogue(parts[0]), dialogue(parts[1])
        # Each split script repeats the same episode title as its first row.
        if not first or not second or first[0] != second[0] or full != first + second[1:]:
            raise ValueError(f'Previously confirmed duplicate changed; review before exclusion: {duplicate}')
    return set(DUPLICATE_STORIES)
