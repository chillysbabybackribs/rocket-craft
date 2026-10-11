# Print one field path of GridCraft's ui.inspect over its raw control port (no token in 0.5.0).
import json, socket, sys
s = socket.create_connection(('127.0.0.1', int(sys.argv[1])))
s.sendall(b'{"id":1,"method":"ui.inspect","params":{}}\n')
buf = b''
while not buf.endswith(b'\n'):
    buf += s.recv(65536)
r = json.loads(buf)['result']
print(json.dumps({k: r.get(k) for k in sys.argv[2:]}) if len(sys.argv) > 2 else ' '.join(sorted(r.keys())))
