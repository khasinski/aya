# A stand-in agent: each op invocation has a NEW controlling terminal.
import errno, json, os, pty, socket, stat, subprocess, sys

def terminal():
    return subprocess.check_output(['/bin/ps', '-o', 'tty=', '-p', str(os.getpid())]).decode().strip()

def run_pty(argv):
    pid, master = pty.fork()
    if pid == 0:
        os.execvp(argv[0], argv)
    data = b''
    try:
        while True:
            try:
                chunk = os.read(master, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
            if not chunk:
                break
            data += chunk
    finally:
        os.close(master)
    _, status = os.waitpid(pid, 0)
    return os.waitstatus_to_exitcode(status), data

if sys.argv[1] == 'outer':
    code, data = run_pty(sys.argv[2:])
    sys.stdout.buffer.write(data)
    sys.exit(code)
elif sys.argv[1] == 'agent':
    directory = os.environ['AYA_OP_SESSION_BIN']
    results = []
    for _ in range(2):
        result = subprocess.check_output([sys.executable, __file__, 'fresh'])
        results.append(json.loads(result))
    peer = socket.socket(socket.AF_UNIX)
    peer.connect(os.environ['AYA_OP_SESSION_SOCKET'])
    peer.sendall((json.dumps({'type': 'start', 'token': 'wrong', 'args': ['read'], 'cwd': os.getcwd(), 'env': dict(os.environ)}) + '\n').encode())
    unauthorized = peer.recv(1024).decode()
    peer.close()
    print(json.dumps({'session': terminal(), 'directory': directory, 'results': results,
        'directoryMode': stat.S_IMODE(os.stat(directory).st_mode),
        'socketMode': stat.S_IMODE(os.stat(os.environ['AYA_OP_SESSION_SOCKET']).st_mode),
        'unauthorized': unauthorized}), flush=True)
elif sys.argv[1] == 'fresh':
    # stdin/out are pipes as in an agent tool, but the process has a new ctty.
    pid, master = pty.fork()
    if pid == 0:
        caller = terminal()
        result = subprocess.run(['op', 'read', 'op://test/secret'], input=b'stdin payload', stdout=subprocess.PIPE)
        print(json.dumps({'caller': caller, 'value': json.loads(result.stdout)}), flush=True)
        sys.exit(result.returncode)
    data = b''
    while True:
        try:
            chunk = os.read(master, 65536)
        except OSError as error:
            if error.errno == errno.EIO: break
            raise
        if not chunk: break
        data += chunk
    os.close(master)
    _, status = os.waitpid(pid, 0)
    sys.stdout.buffer.write(data)
    sys.exit(os.waitstatus_to_exitcode(status))
