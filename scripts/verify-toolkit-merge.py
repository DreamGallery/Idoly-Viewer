"""Compare every web-export result against the actual local Toolkit merger."""
import csv, hashlib, importlib.util, json, sys, tempfile
from pathlib import Path
root = Path(__file__).resolve().parents[1]
module_path = root.parent / 'HoshimiToolkit/src/adv_csv.py'
spec = importlib.util.spec_from_file_location('adv_csv', module_path)
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
catalog = json.loads((root / 'public/data/catalog.json').read_text())
names = json.loads((root / 'public/data/glossary.json').read_text())['names']
results = {}
with tempfile.TemporaryDirectory() as directory:
    tmp = Path(directory)
    for story in catalog['stories']:
        doc = json.loads((root / f"public/data/stories/{story['id']}.json").read_text())
        source = tmp / (story['id'] + '.txt')
        source.write_bytes(doc['script'].encode())
        translation = tmp / 'translation.csv'
        with translation.open('w', newline='') as out:
            writer = csv.DictWriter(out, fieldnames=['id', 'name', 'text', 'trans'], extrasaction='ignore')
            writer.writeheader()
            writer.writerows(doc['rows'])
            writer.writerow(dict(id='info', name=source.name, text=doc['sourceHash']))
            writer.writerow(dict(id='译者'))
        hashes = []
        for glossary in [None, names]:
            output = tmp / 'output.txt'
            module.merge_file(source, translation, output, glossary)
            hashes.append(hashlib.sha256(output.read_bytes()).hexdigest())
        results[story['id']] = hashes
(root / 'reports/toolkit-merge-hashes.json').write_text(json.dumps(results))
print(f'Toolkit merge_file: {len(results)} stories × 2 export modes')
