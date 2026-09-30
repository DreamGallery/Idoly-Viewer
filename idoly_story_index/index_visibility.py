"""One visibility rule for the main directory and pending-text view."""
import re


def is_indexed_story(story, group_id, nodes):
    if story.get('masterId'):
        return True
    if story['category'] == 'hbd' and re.fullmatch(r'adv_userhbd_\d+_[a-z]+', story['id']):
        return True
    # The builder creates :other only for a unique, named master-backed event
    # matching this CSV event number. Individual Story rows can still be absent.
    if story['category'] == 'event' and group_id.endswith(':other'):
        parent = nodes.get(group_id, {}).get('parent')
        return nodes.get(parent, {}).get('parent') == 'event:normal'
    # Main-story prologues can lack a Story row while their file family maps
    # uniquely to a real StoryPart chapter. Keep these in that chapter.
    if story['category'] == 'main':
        part = nodes.get(group_id, {}).get('parent')
        return nodes.get(part, {}).get('parent') == 'main'
    return False
