#!/usr/bin/env python3
"""Check that the operation table, session handlers, protocol spec, source error codes and docs agree.

Static checks only: this reads source and docs; it does not compile or run the module.
"""
from pathlib import Path
import json, re, sys

root = Path(__file__).resolve().parents[1]
src = root / 'baskStream-rt/src/com/basidekick/baskstream'
failures = []


def check(condition, message):
    if not condition:
        failures.append(message)


def strip_comments(text):
    """Drop Java comments so commented-out table entries or handlers do not count."""
    return re.sub(r'/\*.*?\*/|//[^\n]*', '', text, flags=re.S)


def java(name):
    return strip_comments((src / (name + '.java')).read_text())


# 1. Operation table and gates.
operations = re.findall(r'add\("([a-z_]+)", Gate\.([A-Z_]+)\)', java('BaskStreamOperations'))
names = [name for name, _ in operations]
gates = {name: {'NONE': 'none', 'WRITES': 'writes', 'MODEL_EDITS': 'modelEdits'}[gate] for name, gate in operations}
check(len(names) == len(set(names)), 'duplicate operation names in BaskStreamOperations')

# 2. Session handler bindings.
session = java('BaskStreamClientSession')
binder = session[session.index('private Map<String, RequestHandler> bindHandlers()'):]
binder = binder[:binder.index('return bound;')]
bound = set(re.findall(r'bound\.put\("([a-z_]+)"', binder))
array = re.search(r'for \(String model : new String\[\] \{(.*?)\}\)', binder, re.S)
bound |= set(re.findall(r'"([a-z_]+)"', array.group(1))) if array else set()
check(bound == set(names), f'handlers vs operation table: missing handlers {sorted(set(names) - bound)}, '
                           f'unknown handlers {sorted(bound - set(names))}')

# 3. Protocol spec.
spec = json.loads((root / 'spec/baskstream-protocol.json').read_text())
spec_ops = list(spec['operations'])
check(spec_ops == names, f'spec operations differ from the table: missing {sorted(set(names) - set(spec_ops))}, '
                         f'extra {sorted(set(spec_ops) - set(names))}, or order differs')
for name in names:
    if name in spec['operations']:
        check(spec['operations'][name].get('gate') == gates[name],
              f'spec gate for {name} is {spec["operations"][name].get("gate")}, table says {gates[name]}')
check('API_VERSION = "' + str(spec.get('apiVersion')) + '"' in java('BaskStreamCapabilities'),
      'spec apiVersion does not match BaskStreamCapabilities.API_VERSION')
check(not re.search(r'apiVersion\\"\s*:\s*\\?"\d', java('BBaskStreamService')) and 'BaskStreamCapabilities.API_VERSION' in java('BBaskStreamService'),
      '/stream/health must report BaskStreamCapabilities.API_VERSION, not a literal version')

# 4. Error codes: every code raised in source is in the spec, and every spec code exists in source.
sources = '\n'.join(p.read_text() for p in src.glob('*.java') if not p.name.startswith('._'))
patterns = [r'BaskStreamProtocolException\(\s*"([a-z_]+)"', r'\berror\(\s*"([a-z_]+)"',
            r'sendError\([^,()]+,\s*"([a-z_]+)"', r'errorEntry\([^,()]+,\s*"([a-z_]+)"']
raised = {code for pattern in patterns for code in re.findall(pattern, sources)}
spec_errors = set(spec['errors'])
check(raised <= spec_errors, f'error codes raised in source but missing from the spec: {sorted(raised - spec_errors)}')
literals = set(re.findall(r'"([a-z]+(?:_[a-z]+)*)"', sources))
check(spec_errors <= literals, f'spec error codes that never appear in source: {sorted(spec_errors - literals)}')

# 5. Docs: every operation is documented, and the docs' error table matches the spec.
docs = (root / 'docs/THIRD_PARTY_API.md').read_text() + (root / 'docs/MODEL_EDITING_API.md').read_text()
undocumented = [name for name in names if f'`{name}`' not in docs]
check(not undocumented, f'operations missing from THIRD_PARTY_API.md/MODEL_EDITING_API.md: {undocumented}')
api = (root / 'docs/THIRD_PARTY_API.md').read_text()
table = api[api.index('## Error Codes'):] if '## Error Codes' in api else ''
table = table[:table.find('\n## ', 1)] if '\n## ' in table[1:] else table
doc_errors = set(re.findall(r'^\| `([a-z_]+)` \|', table, re.M))
check(doc_errors == spec_errors, f'THIRD_PARTY_API.md error table vs spec: missing {sorted(spec_errors - doc_errors)}, '
                                 f'extra {sorted(doc_errors - spec_errors)}')

# 6. The TypeScript SDK's generated table matches the spec (regenerate with `npm run gen` in sdk/).
sdk_ops = root / 'sdk/src/operations.ts'
if sdk_ops.exists():
    generated = sdk_ops.read_text()
    sdk_names = re.findall(r'^  "([a-z_]+)": \{ gate:', generated, re.M)
    check(sdk_names == list(spec['operations']), 'sdk/src/operations.ts is out of date with the spec; run npm run gen in sdk/')
    check(f'API_VERSION = "{spec["apiVersion"]}"' in generated, 'sdk/src/operations.ts API_VERSION differs from the spec')

if failures:
    print('FAIL:\n  ' + '\n  '.join(failures))
    sys.exit(1)
print(f'PASS: {len(names)} operations, {len(bound)} handlers, spec, {len(spec_errors)} error codes and docs agree')
