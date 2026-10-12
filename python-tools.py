import json
import pathlib
import sys

if sys.version_info < (3, 10):
    raise RuntimeError('Python formatting requires Python 3.10 or newer.')

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent / 'python-runtime' / 'lib'))
import black

data = json.load(sys.stdin)
if data.get('action') != 'format':
    raise ValueError('Unsupported Python editor action')
try:
    formatted = black.format_file_contents(data['content'], fast=False, mode=black.FileMode())
except black.NothingChanged:
    formatted = data['content']
json.dump({'content': formatted}, sys.stdout, ensure_ascii=False)
