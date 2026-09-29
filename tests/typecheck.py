#!/usr/bin/env python3
"""Type-check the module sources against an installed Niagara 4 SDK with javac.

    python3 tests/typecheck.py /path/to/niagara_home

This only compiles into a temporary directory that is deleted afterwards. It is not a
module build: no Slot-o-matic, no jar, no signing. The dependency list is read from
baskStream-rt.gradle.kts so it stays in step with the real build.
"""
from pathlib import Path
import os, re, subprocess, sys, tempfile

root = Path(__file__).resolve().parents[1]
if len(sys.argv) != 2:
    sys.exit(__doc__)
home = Path(sys.argv[1])
javac = os.environ.get('JAVAC', '/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home/bin/javac')

gradle = (root / 'baskStream-rt/baskStream-rt.gradle.kts').read_text()
modules = re.findall(r'^\s*api\(":([\w-]+)"\)', gradle, re.M)
classpath = [home / 'modules' / f'{name}.jar' for name in modules]
classpath.append(home / 'bin/ext/nre.jar')
for pattern in re.findall(r'include\("([^"]+)"\)', gradle):  # compileOnly jars from bin/ext
    classpath += sorted(p for p in (home / 'bin/ext').glob(pattern) if p.suffix == '.jar')
missing = [str(p) for p in classpath if not p.is_file() or p.stat().st_size == 0]
if missing:
    sys.exit('FAIL: missing or empty SDK jars:\n  ' + '\n  '.join(missing))

sources = sorted(str(p) for p in (root / 'baskStream-rt/src').rglob('*.java') if not p.name.startswith('._'))
with tempfile.TemporaryDirectory() as out:
    result = subprocess.run([javac, '--release', '8', '-proc:none', '-nowarn', '-Xlint:-options', '-d', out,
                             '-cp', os.pathsep.join(map(str, classpath))] + sources,
                            capture_output=True, text=True)
errors = [line for line in (result.stdout + result.stderr).splitlines() if not line.startswith('Note:')]
if result.returncode != 0:
    print('FAIL:\n' + '\n'.join(errors[:60]))
    sys.exit(1)
print(f'PASS: {len(sources)} sources type-check against {home.name} ({len(modules)} modules plus nre and bin/ext jars)')
