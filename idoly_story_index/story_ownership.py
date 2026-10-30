"""Resolve story categories from MasterDB relationships before CSV folders."""


def story_assets(story):
    return story.get('advAssetIds', []) + [
        choice['advAssetId'] for choice in story.get('branchChoices', [])
        if choice.get('advAssetId')
    ]


class StoryOwnershipIndex:
    def __init__(self, tables):
        self.stories = {row['id']: row for row in tables['Story']}
        self.by_asset = {
            asset: row['id'] for row in tables['Story'] for asset in story_assets(row)
        }
        self.owners = {}

        def register(category, episode, priority, include_asset=True):
            story_id = episode['storyId']
            assets = story_assets(self.stories.get(story_id, {}))
            script_assets = set(assets)
            if include_asset and episode.get('assetId'):
                assets.append(episode['assetId'])
            for asset in assets:
                previous = self.owners.get(asset)
                exact = asset in script_assets
                if previous and (previous[0], previous[3]) > (priority, exact):
                    continue
                if previous and (previous[0], previous[3]) == (priority, exact) and previous[1] != category:
                    raise ValueError(f'Conflicting MasterDB categories for {asset}: {previous[1]}, {category}')
                self.owners[asset] = (priority, category, story_id, exact)

        # Permanent archives supersede event aliases. Dedicated main/group,
        # character, card and love relationships supersede archived copies.
        for event in tables['EventStory']:
            for episode in event['episodes']:
                register('event', episode, 0)
        extra_parts = {row['id']: row for row in tables['ExtraStoryPart']}
        for extra in tables['ExtraStory']:
            part = extra_parts.get(extra['extraStoryPartId'], {})
            category = 'hbd' if part.get('assetId', '').startswith('birthday-') else 'event'
            for episode in extra['episodes']:
                register(category, episode, 1)
        for part in tables['StoryPart']:
            category = 'group' if part['type'] == 2 else 'main'
            for chapter in part['chapters']:
                for episode in chapter['episodes']:
                    register(category, episode, 2)
        for character in tables['Character']:
            for episode in character.get('companyEnjoyStories', []):
                # These episodes' assetId values are display sequences, not scripts.
                register('bond', episode, 2, include_asset=False)
        for card in tables['Card']:
            for episode in card['stories']:
                register('card', episode, 2, include_asset=False)
        for episode in tables['LoveStoryEpisode']:
            register('love', episode, 2)

    def resolve(self, asset, fallback_category):
        owner = self.owners.get(asset)
        if owner:
            return owner[1], owner[2]
        return fallback_category, self.by_asset.get(asset)
