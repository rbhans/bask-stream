#!/usr/bin/env python3
"""Write the "Error Codes" section of docs/THIRD_PARTY_API.md from spec/baskstream-protocol.json.

Run after changing error codes in the spec; tests/protocol_contract.py fails if the two differ.
"""
from pathlib import Path
import json

root = Path(__file__).resolve().parents[1]
spec = json.loads((root / 'spec/baskstream-protocol.json').read_text())
doc_path = root / 'docs/THIRD_PARTY_API.md'
doc = doc_path.read_text()

rows = '\n'.join(f"| `{code}` | {entry['scope']} | {entry['meaning'].replace('|', '/')} |"
                 for code, entry in sorted(spec['errors'].items()))
section = f"""## Error Codes

Failures arrive in two ways. A **request** error fails the whole request with an `error` message carrying `code` and `message`. An **entry** error appears inside a batch result (per point, alarm, tag target and so on) with `ok: false`, while the other entries still succeed. Clients should branch on `code`, never on `message`. This table is generated from `spec/baskstream-protocol.json`.

| Code | Scope | Meaning |
| --- | --- | --- |
{rows}

"""

start = doc.find('## Error Codes')
if start >= 0:
    end = doc.find('\n## ', start + 1) + 1
    doc = doc[:start] + section + doc[end:]
else:
    anchor = doc.index('## Node Metadata')
    doc = doc[:anchor] + section + doc[anchor:]
doc_path.write_text(doc)
print(f"wrote {len(spec['errors'])} error codes to {doc_path.relative_to(root)}")
