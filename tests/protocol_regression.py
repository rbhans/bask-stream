#!/usr/bin/env python3
"""Run project-owned protocol sources without building/loading a Niagara module."""
from pathlib import Path
import os, re, subprocess, tempfile
root = Path(__file__).resolve().parents[1]
src = root / 'baskStream-rt/src/com/basidekick/baskstream'
imports = set()
bodies = []
for name in ('BaskStreamCodec', 'BaskStreamProtocolException', 'BaskStreamAccessPolicy'):
    text = (src / (name + '.java')).read_text()
    imports.update(re.findall(r'^import .*;', text, re.M))
    bodies.append(re.sub(r'^(?:package|import) .*;\s*', '', text, flags=re.M))
main = r'''
public class ProtocolRegression {
  static void check(boolean ok) { if (!ok) throw new AssertionError(); }
  static void reject(BaskStreamCodec c, byte[] b) throws Exception {
    try { c.decodeMessage(b); throw new AssertionError("accepted invalid payload"); }
    catch (BaskStreamProtocolException expected) { check("bad_request".equals(expected.getCode())); }
  }
  public static void main(String[] args) throws Exception {
    BaskStreamCodec c = new BaskStreamCodec();
    Map<String,Object> m = new LinkedHashMap<String,Object>(); m.put("op", "ping");
    byte[] b = c.encodeMessage(m);
    check(c.decodeMessage(b).equals(m));
    reject(c, java.util.Arrays.copyOf(b,b.length+1));
    reject(c, new byte[]{(byte)0x81,(byte)0xa1,'v',(byte)0xcf,-1,-1,-1,-1,-1,-1,-1,-1});
    reject(c, new byte[]{(byte)0x82,(byte)0xa1,'v',1,(byte)0xa1,'v',2});
    try { c.decodeMessage(b,b.length-1); throw new AssertionError(); }
    catch (BaskStreamProtocolException expected) {}
    check(c.decodeMessage(b,b.length).equals(m));
    BBaskStreamService s = new BBaskStreamService();
    check(BaskStreamAccessPolicy.isAllowed(s,"slot:/Allowed/point/out"));
    check(!BaskStreamAccessPolicy.isAllowed(s,"slot:/Outside/point"));
    check(!BaskStreamAccessPolicy.isAllowed(s,"slot:/Allowed/point|slot:/Outside/point"));
    check(!BaskStreamAccessPolicy.isAllowed(s,"slot:/Allowed/../Outside/point"));
    System.out.println("PASS: roundtrip, trailing bytes, uint64 overflow, duplicate keys, size limits, ORD policy");
  }
}
class BBaskStreamService { String getAllowedPathPatterns() { return "slot:/Allowed/*"; } }
'''
with tempfile.TemporaryDirectory(prefix='baskstream-protocol-') as tmp:
    path = Path(tmp) / 'ProtocolRegression.java'
    path.write_text('\n'.join(sorted(imports)) + '\n' + main + '\n' + '\n'.join(bodies))
    subprocess.run([os.environ.get('JAVA', '/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home/bin/java'), str(path)], check=True)
