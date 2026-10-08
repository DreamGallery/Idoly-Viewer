"""Original-only text at the public snapshot boundary."""
import csv
import io


def original_row(row):
    credit = row.get('id') == '译者'
    return {'id': row['id'], 'name': '' if credit else row['name'],
            'text': '' if credit else row['text'], 'trans': ''}


def original_csv(value):
    reader = csv.DictReader(io.StringIO(value.lstrip('\ufeff'), newline=''), strict=True)
    fields = ['id', 'name', 'text', 'trans']
    if reader.fieldnames != fields:
        raise ValueError('Public source CSV requires id, name, text and trans columns')
    rows = []
    for row in reader:
        if None in row or any(row.get(key) is None for key in fields):
            raise ValueError('Invalid public source CSV row')
        rows.append(original_row(row))
    output = io.StringIO(newline='')
    writer = csv.DictWriter(output, fieldnames=fields, lineterminator='\r\n')
    writer.writeheader()
    writer.writerows(rows)
    return output.getvalue().removesuffix('\r\n')


def original_story(story):
    if not isinstance(story, dict) or not isinstance(story.get('rows'), list):
        raise ValueError('Invalid public story JSON')
    fields = ('id', 'path', 'category', 'originalTitle', 'characters', 'lines',
              'aiLines', 'humanLines', 'reviewedLines', 'translationStatus',
              'masterId', 'references', 'sourceHash', 'sourceFileHash', 'script')
    return {**{key: story[key] for key in fields if key in story},
            'title': story.get('originalTitle') or story.get('id'),
            'rows': [{**original_row(row), **{key: row[key] for key in ('start', 'end', 'character') if key in row}}
                     for row in story['rows']],
            'metadata': [original_row(row) for row in story.get('metadata', [])],
            'names': {row['name']: row['name'] for row in story['rows'] if row.get('name')}}
