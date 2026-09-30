"""Directory status from source-matched, validated translation rows."""


def translation_status(rows):
    required = [row for row in rows if row['text'].strip()]
    if required and all(row.get('reviewed', '').strip() for row in required):
        return 'completed'
    if any(row.get('human', '').strip() or row.get('reviewed', '').strip() for row in rows):
        return 'human'
    return 'empty'
