#!/usr/bin/env python3
"""Exercise the actual transport source with controllable Jetty/runtime test doubles."""
from pathlib import Path
import os, re, subprocess, tempfile
root=Path(__file__).resolve().parents[1]
s=(root/'baskStream-rt/src/com/basidekick/baskstream/BaskStreamJettyWebSocketConnection.java').read_text()
s=re.sub(r'^(?:package|import) .*;\s*','',s,flags=re.M)
s=s.replace('org.eclipse.jetty.websocket.api.WriteCallback','WriteCallback')
test=r'''
import java.io.*;
import java.nio.*;
import java.util.*;
import java.util.logging.*;
public class TransportRegression {
 static void check(boolean b) { if(!b) throw new AssertionError(); }
 public static void main(String[] args) throws Exception {
  BaskStreamWebSocketRuntime runtime=new BaskStreamWebSocketRuntime();
  BaskStreamJettyWebSocketConnection c=new BaskStreamJettyWebSocketConnection(runtime,new ServletUpgradeRequest());
  Session session=new Session(); c.onWebSocketConnect(session);
  c.send(new byte[]{1}); c.send(new byte[]{2});
  check(c.remote.values.equals(Arrays.asList(1)));
  c.remote.complete(); check(c.remote.values.equals(Arrays.asList(1,2)));
  c.remote.complete(); c.send(new byte[]{3});
  check(c.remote.values.equals(Arrays.asList(1,2,3)));
  c.closeTransport(1000,"closed"); c.remote.complete();
  try { c.send(new byte[]{4}); throw new AssertionError(); } catch(IOException expected) {}
  c=new BaskStreamJettyWebSocketConnection(runtime,new ServletUpgradeRequest());
  c.onWebSocketConnect(new Session());
  for(int i=0;i<128;i++) c.send(new byte[]{1});
  try { c.send(new byte[]{1}); throw new AssertionError(); } catch(IOException expected) {}
  check(c.remote.values.size()==1);
  c.remote.callback.writeFailed(new IOException("test")); check(!c.getSession().isOpen());
  check(runtime.client.closed);
  System.out.println("PASS: FIFO, one send in flight, close during send, queue limit, failed-send cleanup");
 }
}
interface WriteCallback { void writeSuccess(); void writeFailed(Throwable t); }
class Remote {
 List<Integer> values=new ArrayList<Integer>(); WriteCallback callback;
 void sendBytes(ByteBuffer b, WriteCallback c) { values.add((int)b.get()); callback=c; }
 void complete() { WriteCallback c=callback; callback=null; c.writeSuccess(); }
}
class Session {
 boolean open=true; void setIdleTimeout(long n) {} boolean isOpen(){return open;}
 Object getRemoteAddress(){return "test";} void close(int n,String s){open=false;}
}
class WebSocketAdapter {
 final Remote remote=new Remote(); Session session;
 public void onWebSocketConnect(Session s){session=s;}
 public void onWebSocketBinary(byte[] b,int o,int l){}
 public void onWebSocketText(String s){}
 public void onWebSocketClose(int n,String s){}
 public void onWebSocketError(Throwable t){}
 Session getSession(){return session;} Remote getRemote(){return remote;}
}
class ServletUpgradeRequest {}
class Service {
 final Logger LOG=Logger.getLogger("test");
 int getHeartbeatIntervalSecValue(){return 30;} void audit(String a,String b){}
}
class BaskStreamWebSocketRuntime {
 final Service service=new Service(); final BaskStreamClientSession client=new BaskStreamClientSession();
 Service getService(){return service;} boolean onOpen(BaskStreamClientSession c){return true;}
 BaskStreamClientSession buildSession(Object c,Object r) throws BaskStreamProtocolException {return client;}
}
class BaskStreamClientSession {
 boolean closed; String getUsername(){return "test";} String getSessionId(){return "test";}
 void start(){} void onBinary(byte[] b){} void close(String s){closed=true;}
}
class BaskStreamProtocolException extends Exception {}
'''
with tempfile.TemporaryDirectory(prefix='baskstream-transport-') as tmp:
 p=Path(tmp)/'TransportRegression.java';p.write_text(test+'\n'+s)
 subprocess.run([os.environ.get('JAVA','/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home/bin/java'),str(p)],check=True)
