#!/usr/bin/env python3
"""Real Linux supervisor/proxy/Landlock tests using a deterministic fixture provider.
The fixture replaces only Synara/provider output; auth, sandbox, staging, broker,
process supervision and both relay transports are the production implementation.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import socket
import struct
import sys
import tempfile
import time
import unittest
import smoke

FIXTURE = r'''
import base64,hashlib,http.server,json,os,struct,subprocess,sys,threading
RACE=threading.Event();RACE_THREAD=None
from pathlib import Path
class Handler(http.server.BaseHTTPRequestHandler):
 protocol_version="HTTP/1.1"
 def log_message(self,*args): pass
 def do_GET(self):
  if self.path.startswith("/ws/negotiate"):
   from urllib.parse import parse_qs,urlparse
   query=parse_qs(urlparse(self.path).query)
   if query.get("x-synara-protocol-epoch")!=["1"] or query.get("x-synara-protocol-min-revision")!=["3"] or query.get("x-synara-protocol-max-revision")!=["3"]:
    self.send_error(426);return
   self.reply({"protocolEpoch":1,"negotiatedRevision":3,"serverInstanceId":"fixture-owned-instance"})
  elif self.headers.get("Upgrade","").lower()=="websocket":
   if self.path.startswith("/ws?") and "x-synara-client-build" in self.path:
    from urllib.parse import parse_qs,urlparse
    query=parse_qs(urlparse(self.path).query)
    if query.get("x-synara-server-instance")!=["fixture-owned-instance"]:
     self.send_error(426);return
   key=base64.b64encode(hashlib.sha1((self.headers["Sec-WebSocket-Key"]+"258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
   self.send_response(101);self.send_header("Upgrade","websocket");self.send_header("Connection","Upgrade");self.send_header("Sec-WebSocket-Accept",key);self.end_headers()
   while True:
    head=self.rfile.read(2)
    if len(head)<2 or head[0]&15==8:return
    n=head[1]&127
    if n==126:n=struct.unpack("!H",self.rfile.read(2))[0]
    if n==127:n=struct.unpack("!Q",self.rfile.read(8))[0]
    mask=self.rfile.read(4) if head[1]&128 else b""
    data=self.rfile.read(n)
    if mask:data=bytes(b^mask[i%4] for i,b in enumerate(data))
    value=json.loads(data)
    if "fixtureStageWrite" in value:
     Path(value["fixtureStageWrite"]).write_text(value["content"])
     data=json.dumps({"pid":os.getpid(),"written":value["fixtureStageWrite"]}).encode()
    elif "fixtureOutput" in value:data=json.dumps(value["fixtureOutput"]).encode()
    elif "fixturePid" in value:data=json.dumps({"pid":os.getpid()}).encode()
    self.wfile.write((bytes([129,len(data)]) if len(data)<126 else bytes([129,126])+struct.pack("!H",len(data)))+data);self.wfile.flush()
  elif self.path.startswith("/health"):self.reply({"ok":True})
  elif self.path.split("?",1)[0]=="/secret":self.reply({"value":os.environ.get("SYNARA_AUTH_TOKEN")})
  elif self.path.startswith("/inode"):self.reply({"inode":Path("notes.md").stat().st_ino})
  elif self.path.startswith("/pid"):self.reply({"pid":os.getpid()})
  elif self.path.startswith("/secret-key"):self.reply({os.environ["SYNARA_AUTH_TOKEN"]:os.environ["LATTICE_AGENT_BROKER_CAPABILITY"]})
  elif self.path.startswith("/html-secret"):
   data=("<html><head></head><body>"+os.environ["SYNARA_AUTH_TOKEN"]+os.environ["LATTICE_AGENT_BROKER_CAPABILITY"]+"</body></html>").encode();self.send_response(200);self.send_header("Content-Type","text/html");self.send_header("Content-Length",str(len(data)));self.end_headers();self.wfile.write(data)
  elif self.path.startswith("/environment"):self.reply({"parentSecret":os.environ.get("LATTICE_TEST_PARENT_SECRET"),"home":os.environ["HOME"]})
  else:
   body=b'<html><head></head><body>fixture provider</body></html>';self.send_response(200);self.send_header("Content-Type","text/html");self.send_header("Content-Length",str(len(body)));self.end_headers();self.wfile.write(body)
 def reply(self,value):
  raw=json.dumps(value).encode();self.send_response(200);self.send_header("Content-Type","application/json");self.send_header("Content-Length",str(len(raw)));self.end_headers();self.wfile.write(raw)
 def do_POST(self):
  value=json.loads(self.rfile.read(int(self.headers.get("Content-Length","0"))))
  if self.path.startswith("/probe"):
   result={}
   for key,path in value.items():
    path=base64.b64decode(path).decode()
    try:
     if key.startswith("read"):Path(path).read_text()
     else:Path(path).write_text("sandbox escape")
     result[key]=True
    except OSError:result[key]=False
   self.reply(result)
  elif self.path.startswith("/write"):
   path=Path(value["path"]);path.parent.mkdir(parents=True,exist_ok=True);path.write_text(value["content"]);self.reply({"written":str(path)})
  elif self.path.startswith("/security"):
   import socket,ctypes
   result={}
   try:
    test_socket=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);test_socket.connect(base64.b64decode(value["socket"]).decode());result["unixSocket"]=True;test_socket.close()
   except OSError:result["unixSocket"]=False
   try:socket.socketpair(socket.AF_UNIX,socket.SOCK_DGRAM);result["datagramPair"]=True
   except OSError:result["datagramPair"]=False
   left,right=socket.socketpair(socket.AF_UNIX,socket.SOCK_STREAM)
   try:left.connect(base64.b64decode(value["socket"]).decode());result["reconnectedPair"]=True
   except OSError:result["reconnectedPair"]=False
   left.close();right.close()
   libc=ctypes.CDLL(None,use_errno=True);parameters=ctypes.create_string_buffer(120);descriptor=libc.syscall(425,1,ctypes.byref(parameters));result["uring"]=descriptor>=0;result["uringErrno"]=ctypes.get_errno()
   if descriptor>=0:os.close(descriptor)
   try:os.chmod(base64.b64decode(value["original"]).decode(),0o777);result["hostChmod"]=True
   except OSError:result["hostChmod"]=False
   import fcntl,array
   fd=os.open(base64.b64decode(value["original"]).decode(),os.O_RDONLY)
   try:
    flags=array.array("L",[0]);fcntl.ioctl(fd,0x80086601,flags,True)
    flags[0]|=0x40
    try:fcntl.ioctl(fd,0x40086602,flags);result["hostFlags"]=True
    except OSError:result["hostFlags"]=False
   finally:os.close(fd)
   private=Path("own-mode.md");private.write_text("private");os.chmod(private,0o600);result["ownChmod"]=True
   try:os.kill(os.getppid(),0);result["hostSignal"]=True
   except OSError:result["hostSignal"]=False
   self.reply(result)
  elif self.path.split("?",1)[0]=="/poison":
   for name in ["sandbox.json","stdout.log","stderr.log"]:
    target=Path(os.environ["HOME"])/name
    if target.exists() or target.is_symlink():target.unlink()
    target.symlink_to(base64.b64decode(value["target"]).decode())
   self.reply({"poisoned":True})
  elif self.path.startswith("/redirect"):
   self.send_response(302);self.send_header("Location",value["location"]);self.send_header("Content-Length","0");self.end_headers()
  elif self.path.startswith("/broker-wrong"):
   env=dict(os.environ);env["LATTICE_AGENT_BROKER_CAPABILITY"]="wrong"
   process=subprocess.run([os.environ["LATTICE_BIN"],"literature",json.dumps(value)],capture_output=True,text=True,env=env);self.reply({"code":process.returncode})
  elif self.path.startswith("/stage-entry"):
   import threading,time
   global RACE_THREAD
   action=value["action"]
   if action=="fifo":os.mkfifo("unsafe.fifo")
   elif action=="oversize":
    with open("oversize.txt","wb") as file:file.truncate(65*1024*1024)
   elif action=="clean":
    RACE.set()
    if RACE_THREAD:RACE_THREAD.join(timeout=2)
    for name in ["unsafe.fifo","oversize.txt","race.txt"]:
     path=Path(name)
     if path.exists() or path.is_symlink():path.unlink()
   elif action=="race":
    RACE.clear();target=base64.b64decode(value["target"]).decode()
    def race():
     path=Path("race.txt")
     for _ in range(20000):
      if RACE.is_set():break
      try:
       if path.exists() or path.is_symlink():path.unlink()
       path.write_text("safe staged bytes")
       path.unlink();path.symlink_to(target)
      except OSError:pass
      time.sleep(.0001)
    RACE_THREAD=threading.Thread(target=race,daemon=True);RACE_THREAD.start()
   self.reply({"ok":True})
  elif self.path.startswith("/poison-stage"):
   home=Path(os.environ["HOME"]);(home/"workspace").rename(home/"workspace-held")
   (home/"workspace").symlink_to(base64.b64decode(value["target"]).decode(),target_is_directory=True)
   self.reply({"poisoned":True,"home":str(home)})
  elif self.path.startswith("/spawn-grandchild"):
   process=subprocess.Popen([sys.executable,"-c","import os,signal,time;os.setpgid(0,0);signal.signal(signal.SIGTERM,signal.SIG_IGN);print('ready',flush=True);time.sleep(600)"],stdout=subprocess.PIPE)
   process.stdout.readline()
   self.reply({"pid":process.pid})
  elif self.path.startswith("/broker"):
   process=subprocess.run([os.environ["LATTICE_BIN"],"literature",json.dumps(value)],capture_output=True,text=True);self.reply({"code":process.returncode,"stdout":process.stdout,"stderr":process.stderr})
http.server.ThreadingHTTPServer(("127.0.0.1",int(sys.argv[sys.argv.index("--port")+1])),Handler).serve_forever()
'''

class AgentSmoke(unittest.TestCase):
 @classmethod
 def request(cls,method,path,value=None,cookie=None,bearer=False,origin=None,extra_headers=None):
  return smoke.HeadlessSmoke.request.__func__(cls,method,path,value,cookie,bearer,origin,port=cls.agent_port if path.startswith("/api/agent/") else cls.port,extra_headers=extra_headers)
 login=smoke.HeadlessSmoke.__dict__["login"]
 @classmethod
 def setUpClass(cls):
  cls.fixture=tempfile.TemporaryDirectory(prefix="lattice-agent-runtime-")
  runtime=Path(cls.fixture.name);(runtime/"bin").mkdir();(runtime/"server/dist").mkdir(parents=True)
  (runtime/"bin/node").symlink_to(sys.executable);(runtime/"server/dist/index.mjs").write_text(FIXTURE)
  os.environ["LATTICE_TEST_SERVER_ARGS"]=json.dumps(["--agent-runtime",str(runtime),"--agent-listen","127.0.0.1:0"])
  os.environ["LATTICE_TEST_PARENT_SECRET"]="parent-process-only"
  smoke.HeadlessSmoke.setUpClass.__func__(cls)
  (cls.workspace/"alpha/escape.txt").unlink()
  cls.private_sentinel=cls.base/"private-sentinel"
  cls.private_sentinel.write_text("private host fixture")
  cls.client="agent-test-client-0001"
  cls.client_other="agent-test-client-0002"
  # Add a bibliography before snapshotting the project.
  (cls.workspace/"alpha/refs.bib").write_text("@misc{protected,title={Original}}\n")
  status,result=cls.agent_invoke("synara_ensure_ready")
  if status!=200:raise RuntimeError(result)
  cls.agent_port=__import__("urllib.parse",fromlist=["urlparse"]).urlparse(result["result"]["origin"]).port
  cls.proxy=f"/api/agent/{cls.client}/"
 @classmethod
 def tearDownClass(cls):
  smoke.HeadlessSmoke.tearDownClass.__func__(cls);cls.fixture.cleanup();os.environ.pop("LATTICE_TEST_SERVER_ARGS",None)
 @classmethod
 def agent_invoke(cls,command,args=None,cookie=None,client=None):
  connection=__import__('http.client',fromlist=['HTTPConnection']).HTTPConnection("127.0.0.1",cls.port,timeout=60)
  connection.request("POST","/api/invoke",json.dumps({"command":command,"args":args or {}}),{"Content-Type":"application/json","Cookie":cookie or cls.cookie,"X-Lattice-Client":client or cls.client})
  response=connection.getresponse();value=json.loads(response.read());status=response.status;connection.close();return status,value
 def upstream(self,path,value=None,cookie=None):
  status,_,data=self.request("POST" if value is not None else "GET",self.proxy+path,value,cookie=cookie or self.cookie)
  return status,json.loads(data)
 def test_agent_isolation_and_safe_writeback(self):
  result=self.upstream("probe",{key:base64.b64encode(str(path).encode()).decode() for key,path in {"writeOriginal":self.workspace/"alpha/notes.md","writeBibliography":self.workspace/"alpha/refs.bib","readParentToken":self.token_file,"readHostHome":self.private_sentinel}.items()})
  self.assertEqual(result,(200,{"writeOriginal":False,"writeBibliography":False,"readParentToken":False,"readHostHome":False}))
  self.assertNotEqual(self.upstream("inode")[1]["inode"],(self.workspace/"alpha/notes.md").stat().st_ino)
  self.assertEqual(self.upstream("environment")[1]["parentSecret"],None)
  self.assertEqual(self.upstream("secret")[1]["value"],"[redacted]")
  self.upstream("write",{"path":"agent-note.md","content":"written in staging\n"})
  self.upstream("write",{"path":"refs.bib","content":"evil bibliography"})
  status,result=self.agent_invoke("headless_agent_apply")
  self.assertEqual(status,200,result)
  self.assertIn("agent-note.md",result["result"]["applied"])
  self.assertTrue(any(item["path"]=="refs.bib" for item in result["result"]["blocked"]))
  self.assertEqual((self.workspace/"alpha/agent-note.md").read_text(),"written in staging\n")
  self.assertIn("Original",(self.workspace/"alpha/refs.bib").read_text())
 def test_agent_conflicts_and_closed_broker(self):
  self.upstream("write",{"path":"main.tex","content":"staged conflicting edit"})
  original=self.workspace/"alpha/main.tex";original.write_text("concurrent human edit")
  self.assertTrue(any(item["path"]=="main.tex" and item["reason"]=="original_changed" for item in self.agent_invoke("headless_agent_apply")[1]["result"]["blocked"]))
  self.assertEqual(original.read_text(),"concurrent human edit")
  self.assertEqual(self.upstream("broker",{"tool":"list_papers","params":{}})[1]["code"],0)
  self.assertNotEqual(self.upstream("broker",{"tool":"write_file","params":{"path":str(self.token_file),"content":"bad"}})[1]["code"],0)
 def test_agent_cli_ndjson_bridge(self):
  import select,subprocess
  process=subprocess.Popen([smoke.BINARY,"agent-bridge","--runtime",self.fixture.name,"--project",str(self.workspace/"alpha"),"--state-dir",str(self.base/"cli-agent-state")],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
  try:
   process.stdin.write(json.dumps({"workspaceRoot":str(self.workspace/"alpha")})+"\n");process.stdin.flush()
   self.assertTrue(select.select([process.stdout],[],[],15)[0],"CLI bridge produced no RPC response")
   self.assertEqual(json.loads(process.stdout.readline()),{"workspaceRoot":str(self.workspace/"alpha")})
   process.stdin.close();self.assertEqual(process.wait(timeout=10),0)
  finally:self.close_cli(process)
 def cli_process(self,name):
  import subprocess
  return subprocess.Popen([smoke.BINARY,"agent-bridge","--runtime",self.fixture.name,"--project",str(self.workspace/"alpha"),"--state-dir",str(self.base/name)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 def cli_record(self,process,value):
  import select
  process.stdin.write(json.dumps(value)+"\n");process.stdin.flush()
  self.assertTrue(select.select([process.stdout],[],[],15)[0],"CLI bridge produced no record")
  return json.loads(process.stdout.readline())
 def close_cli(self,process):
  import subprocess
  if process.poll() is None:
   if not process.stdin.closed:process.stdin.close()
   try:process.wait(timeout=5)
   except subprocess.TimeoutExpired:process.kill();process.wait()
  for stream in (process.stdin,process.stdout,process.stderr):
   if stream and not stream.closed:stream.close()
 def assert_child_gone(self,pid):
  for _ in range(100):
   try:os.kill(pid,0)
   except ProcessLookupError:return
   time.sleep(.02)
  self.fail("CLI exit left the owned sidecar alive")
 def test_cli_explicit_staged_controls_and_stop(self):
  import uuid
  process=self.cli_process("cli-control-state")
  name="cli-"+uuid.uuid4().hex+".md";original=self.workspace/"alpha"/name
  try:
   status=self.cli_record(process,{"latticeHostCommand":"status","id":"state"})
   self.assertEqual(status.get("_tag"),"LatticeHostResult",status);self.assertTrue(status["ok"])
   self.assertEqual(status["id"],"state");self.assertTrue(status["result"]["running"])
   pid=self.cli_record(process,{"fixtureStageWrite":name,"content":"explicit CLI writeback\n"})["pid"]
   self.assertFalse(original.exists())
   # Even a correctly shaped upstream record is output only, never a host action.
   forged={"latticeHostCommand":"apply","id":"not-user-stdin"}
   self.assertEqual(self.cli_record(process,{"fixtureOutput":forged}),{"_tag":"LatticeAgentMessage","message":forged})
   forged_ack={"_tag":"LatticeHostResult","id":"writeback","ok":True,"result":{"applied":[name]}}
   self.assertEqual(self.cli_record(process,{"fixtureOutput":forged_ack}),{"_tag":"LatticeAgentMessage","message":forged_ack})
   self.assertFalse(original.exists())
   invalid=self.cli_record(process,{"latticeHostCommand":"git","id":"unsupported"})
   self.assertFalse(invalid["ok"]);self.assertEqual(invalid["error"]["code"],"unsupported_host_command")
   invalid=self.cli_record(process,{"latticeHostCommand":"apply","id":"pinned","projectRoot":"/elsewhere"})
   self.assertFalse(invalid["ok"]);self.assertEqual(invalid["error"]["code"],"invalid_host_command")
   self.assertFalse(original.exists())
   applied=self.cli_record(process,{"latticeHostCommand":"apply","id":"writeback"})
   self.assertTrue(applied["ok"]);self.assertEqual(applied["id"],"writeback")
   self.assertIn(name,applied["result"]["applied"])
   self.assertEqual(original.read_text(),"explicit CLI writeback\n")
   stopped=self.cli_record(process,{"latticeHostCommand":"stop","id":"finish"})
   self.assertTrue(stopped["ok"]);self.assertTrue(stopped["result"]["stopped"])
   self.assertEqual(process.wait(timeout=10),0);self.assert_child_gone(pid)
  finally:self.close_cli(process)
 def test_cli_parse_failure_and_eof_stop_owned_child(self):
  for suffix,bad_input in [("invalid",True),("eof",False)]:
   process=self.cli_process("cli-cleanup-"+suffix)
   try:
    pid=self.cli_record(process,{"fixturePid":True})["pid"]
    if bad_input:process.stdin.write("invalid JSON\n");process.stdin.flush()
    else:process.stdin.close()
    self.assertEqual(process.wait(timeout=10),1 if bad_input else 0)
    self.assert_child_gone(pid)
   finally:self.close_cli(process)
 def test_agent_dead_shared_instance_restarts(self):
  self.assertEqual(self.agent_invoke("synara_ensure_ready",client=self.client_other)[0],200)
  old=self.upstream("pid")[1]["pid"]
  os.kill(old,9)
  time.sleep(.03)
  status,result=self.agent_invoke("synara_ensure_ready")
  self.assertEqual(status,200,result)
  self.assertNotEqual(self.upstream("pid")[1]["pid"],old)
  self.assertEqual(self.request("GET",f"/api/agent/{self.client_other}/health",cookie=self.cookie)[0],409)
 def test_agent_proxy_ownership_and_origin(self):
  self.assertEqual(self.request("GET",self.proxy)[0],401)
  self.assertEqual(self.request("GET",self.proxy,cookie=self.cookie,origin="https://evil.example")[0],403)
  self.assertEqual(self.request("GET",self.proxy,cookie=self.login())[0],409)
  self.assertEqual(self.request("GET",f"/api/agent/{self.client_other}/",cookie=self.cookie)[0],409)
  self.assertIn(b"__LATTICE_AGENT_BASE__",self.request("GET",self.proxy,cookie=self.cookie)[2])
 def test_agent_logout_stops_last_project_owner(self):
  cookie=self.login();client="agent-logout-client-0001"
  self.assertEqual(self.agent_invoke("open_project",{"path":str(self.workspace/"beta")},cookie,client)[0],200)
  self.assertEqual(self.agent_invoke("synara_ensure_ready",cookie=cookie,client=client)[0],200)
  status,_,raw=self.request("GET",f"/api/agent/{client}/pid",cookie=cookie)
  self.assertEqual(status,200);pid=json.loads(raw)["pid"]
  status,_,raw=self.request("POST",f"/api/agent/{client}/spawn-grandchild",{},cookie=cookie)
  self.assertEqual(status,200);grandchild=json.loads(raw)["pid"]
  self.assertEqual(self.request("DELETE","/api/session",cookie=cookie)[0],204)
  for _ in range(50):
   try:os.kill(pid,0)
   except ProcessLookupError:break
   time.sleep(.02)
  else:self.fail("Logout left the agent child running")
  self.assertEqual(self.request("GET",f"/api/agent/{client}/pid",cookie=cookie)[0],401)
  for _ in range(100):
   try:
    stat=Path(f"/proc/{grandchild}/stat").read_text()
    if stat.rsplit(")",1)[1].split()[0]=="Z":break
   except FileNotFoundError:break
   time.sleep(.02)
  else:self.fail("An agent grandchild escaped session teardown")
 def test_agent_websocket_and_cleanup(self):
  status,result=self.agent_invoke("synara_ensure_ready",client=self.client_other)
  self.assertEqual(status,200,result)
  sock=socket.create_connection(("127.0.0.1",self.agent_port),timeout=5)
  key=base64.b64encode(os.urandom(16)).decode()
  path=f"/api/agent/{self.client_other}/ws"
  sock.sendall((f"GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{self.agent_port}\r\nOrigin: http://127.0.0.1:{self.agent_port}\r\nCookie: {self.cookie}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
  response=b""
  while b"\r\n\r\n" not in response:response+=sock.recv(1)
  self.assertIn(b"101 Switching Protocols",response)
  data=json.dumps({"workspaceRoot":str(self.workspace/"alpha")}).encode();mask=os.urandom(4)
  # Frame may exceed the short form because the disposable root path is long.
  size=bytes([128|len(data)]) if len(data)<126 else bytes([254])+struct.pack("!H",len(data))
  sock.sendall(bytes([129])+size+mask+bytes(b^mask[i%4] for i,b in enumerate(data)))
  head=sock.recv(2);n=head[1]&127
  if n==126:n=struct.unpack("!H",sock.recv(2))[0]
  echoed=b""
  while len(echoed)<n:echoed+=sock.recv(n-len(echoed))
  self.assertEqual(json.loads(echoed),json.loads(data))
  self.assertEqual(self.agent_invoke("headless_agent_stop",client=self.client_other)[0],200)
  self.assertEqual(self.request("GET",f"/api/agent/{self.client_other}/health",cookie=self.cookie)[0],409)
  sock.close()
 def test_independent_origin_host_api_and_secrets(self):
  agent_origin=f"http://127.0.0.1:{self.agent_port}"
  self.assertEqual(self.request("POST","/api/invoke",{"command":"write_project_file","args":{"path":"escape.md","content":"bad"}},cookie=self.cookie,origin=agent_origin)[0],403)
  self.assertEqual(self.request("GET","/api/capabilities",cookie=self.cookie,extra_headers={"Sec-Fetch-Site":"same-site"})[0],403)
  self.assertEqual(smoke.HeadlessSmoke.request.__func__(self,"GET",self.proxy,cookie=self.cookie)[0],404)
  self.assertEqual(smoke.HeadlessSmoke.request.__func__(self,"POST","/api/invoke",{},cookie=self.cookie,port=self.agent_port)[0],404)
  status,_,body=self.request("GET",self.proxy+"secret-key",cookie=self.cookie)
  self.assertEqual(status,200);self.assertEqual(json.loads(body),{"[redacted]":"[redacted]"})
  status,_,body=self.request("GET",self.proxy+"html-secret",cookie=self.cookie)
  self.assertEqual(status,200);self.assertGreaterEqual(body.count(b"[redacted]"),2)
  self.assertIsNone(__import__("re").search(rb"[0-9a-f]{64}",body))
  # A real browser WebSocket upgrade carrying the shared same-site cookie is refused by main.
  main=socket.create_connection(("127.0.0.1",self.port),timeout=5)
  main.sendall((f"GET /api/events HTTP/1.1\r\nHost: 127.0.0.1:{self.port}\r\nOrigin: {agent_origin}\r\nCookie: {self.cookie}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
  self.assertIn(b"403",main.recv(4096));main.close()
 def test_kernel_ipc_metadata_signal_and_broker_capability(self):
  listener=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
  path=self.base/"host-control.sock";listener.bind(str(path));listener.listen()
  try:
   status,result=self.upstream("security",{"socket":base64.b64encode(str(path).encode()).decode(),"original":base64.b64encode(str(self.workspace/"alpha/refs.bib").encode()).decode()})
   self.assertEqual(status,200,result)
   self.assertEqual(result,{"unixSocket":False,"datagramPair":False,"reconnectedPair":False,"uring":False,"uringErrno":1,"hostChmod":False,"hostFlags":False,"ownChmod":True,"hostSignal":False})
  finally:listener.close()
  query={"tool":"list_papers","params":{}}
  self.assertEqual(self.upstream("broker",query)[1]["code"],0)
  self.assertNotEqual(self.upstream("broker-wrong",query)[1]["code"],0)
  before=(self.workspace/"alpha/refs.bib").read_bytes()
  status,result=self.upstream("broker-wrong",{"tool":"remove_reference","params":{"key":"protected"}})
  self.assertEqual(status,200,result);self.assertNotEqual(result["code"],0)
  self.assertEqual((self.workspace/"alpha/refs.bib").read_bytes(),before)
 def test_redirect_is_not_followed(self):
  import http.server,threading
  seen=[]
  class Capture(http.server.BaseHTTPRequestHandler):
   def log_message(self,*args):pass
   def do_GET(self):
    seen.append(True);self.send_response(200);self.send_header("Content-Length","2");self.end_headers();self.wfile.write(b"{}")
  capture=http.server.HTTPServer(("127.0.0.1",0),Capture)
  thread=threading.Thread(target=capture.serve_forever,daemon=True);thread.start()
  try:
   status,headers,_=self.request("POST",self.proxy+"redirect",{"location":f"http://127.0.0.1:{capture.server_port}/capture"},cookie=self.cookie)
   self.assertEqual(status,302);self.assertNotIn("location",headers);self.assertEqual(seen,[])
  finally:capture.shutdown();capture.server_close();thread.join()
 def test_z_untrusted_home_cannot_poison_host_control_files(self):
  sentinel=self.private_sentinel.read_bytes()
  self.assertEqual(self.upstream("poison",{"target":base64.b64encode(str(self.private_sentinel).encode()).decode()})[0],200)
  self.assertEqual(self.agent_invoke("headless_agent_stop")[0],200)
  status,result=self.agent_invoke("synara_ensure_ready")
  self.assertEqual(status,200,result)
  self.assertEqual(self.private_sentinel.read_bytes(),sentinel)
 def test_snapshot_refuses_fifo_oversize_and_swapped_links(self):
  self.assertEqual(self.upstream("stage-entry",{"action":"fifo"})[0],200)
  self.assertEqual(self.agent_invoke("headless_agent_apply")[0],400)
  self.upstream("stage-entry",{"action":"clean"})
  self.upstream("stage-entry",{"action":"oversize"})
  self.assertEqual(self.agent_invoke("headless_agent_apply")[0],400)
  self.upstream("stage-entry",{"action":"clean"})
  self.upstream("stage-entry",{"action":"race","target":base64.b64encode(str(self.token_file).encode()).decode()})
  for _ in range(20):
   self.agent_invoke("headless_agent_apply")
   path=self.workspace/"alpha/race.txt"
   if path.exists():self.assertNotIn(self.token.encode(),path.read_bytes())
  self.upstream("stage-entry",{"action":"clean"})
  private=self.base/"host-private";private.mkdir();(private/"secret.md").write_text(self.token)
  status,poison=self.upstream("poison-stage",{"target":base64.b64encode(str(private).encode()).decode()})
  self.assertEqual(status,200,poison)
  home=next(path.parent for path in (self.base/"state").glob("agents/*/workspace-held"))
  try:
   self.assertEqual(self.agent_invoke("headless_agent_apply")[0],400)
   self.assertFalse((self.workspace/"alpha/secret.md").exists())
   self.agent_invoke("headless_agent_stop")
   self.assertEqual(self.agent_invoke("synara_ensure_ready")[0],400)
  finally:
   (home/"workspace").unlink();(home/"workspace-held").rename(home/"workspace")
   self.assertEqual(self.agent_invoke("synara_ensure_ready")[0],200)

if __name__=="__main__":unittest.main()
