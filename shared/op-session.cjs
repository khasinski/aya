// Opt-in 1Password CLI session. Secret data travels only over private local
// sockets/pipes; it never enters Aya's control/debug log or terminal history.
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { spawn } = require('node:child_process');
const MAX_FRAME = 1024 * 1024;
const quote = s => "'" + s.replace(/'/g, "'\\''") + "'";
function frames(socket, receive) {
  let pending = '';
  socket.setEncoding('utf8');
  socket.on('data', chunk => {
    pending += chunk;
    while (pending.includes('\n')) {
      const i = pending.indexOf('\n');
      if (i > MAX_FRAME) return socket.destroy();
      const line = pending.slice(0, i); pending = pending.slice(i + 1);
      try { receive(JSON.parse(line)); } catch { socket.destroy(); return; }
    }
    if (pending.length > MAX_FRAME) socket.destroy();
  });
}
const send = (socket, value) => socket.write(JSON.stringify(value) + '\n');
function pipeOutput(stream, socket, type) {
  stream.on('data', data => {
    if (!send(socket, { type, data: data.toString('base64') })) stream.pause();
  });
  socket.on('drain', () => stream.resume());
}
function realOp(env) {
  for (const dir of (env.PATH || '').split(path.delimiter)) {
    if (!path.isAbsolute(dir) || dir === env.AYA_OP_SESSION_BIN) continue;
    const file = path.join(dir, 'op');
    try { fs.accessSync(file, fs.constants.X_OK); if (fs.statSync(file).isFile()) return file; } catch {}
  }
  throw Error('1Password CLI (op) is not installed on PATH');
}
// This parent runs outside an agent tool's sandbox. Never turn it into a
// general command executor (`op run`, plugins), file writer, or env injector.
function readOnlyArgs(args) {
  const values = new Set(['--account', '--format', '--vault', '--fields', '--encoding']);
  const switches = new Set(['--reveal', '--otp', '--include-archive', '--help', '--version']);
  const words = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (switches.has(arg)) continue;
    if (values.has(arg)) { if (++i >= args.length || args[i].startsWith('-')) return false; continue; }
    if ([...values].some(flag => arg.startsWith(flag + '=') && arg.length > flag.length + 1)) continue;
    if (arg.startsWith('-')) return false;
    words.push(arg);
  }
  if (!words.length) return args.length === 1 && switches.has(args[0]);
  if (words[0] === 'whoami') return words.length === 1;
  if (words[0] === 'read') return words.length === 2 && words[1].startsWith('op://');
  return ['item', 'vault', 'account'].includes(words[0]) &&
    ((words[1] === 'list' && words.length === 2) || (words[1] === 'get' && words.length === 3));
}
function launch(argv) {
  if (!argv.length) throw Error('Usage: aya op-session -- command [args...]');
  if (!process.stdin.isTTY) throw Error('An op session must start in a terminal, not an agent command pipe');
  const executable = realOp(process.env);
  const directory = fs.mkdtempSync('/tmp/aya-op-'); fs.chmodSync(directory, 0o700);
  const socketPath = path.join(directory, 's');
  const token = crypto.randomBytes(32).toString('hex');
  const env = { ...process.env, AYA_OP_SESSION_SOCKET: socketPath, AYA_OP_SESSION_TOKEN: token, AYA_OP_SESSION_BIN: directory };
  const shim = `#!/bin/sh\nexec env ELECTRON_RUN_AS_NODE=1 ${quote(process.execPath)} ${quote(__filename)} client "$@"\n`;
  fs.writeFileSync(path.join(directory, 'op'), shim, { mode: 0o700 });
  delete env.ELECTRON_RUN_AS_NODE;
  const sockets = new Set(), commands = new Set();
  let agent, stopping = false;
  function terminate(child) {
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 1000); timer.unref();
    child.once('close', () => clearTimeout(timer));
  }
  const server = net.createServer(socket => {
    sockets.add(socket);
    let child, authenticated = false;
    socket.on('error', () => {});
    socket.once('close', () => { sockets.delete(socket); if (child) terminate(child); });
    // No authenticated command yet: don't let a silent peer hold a session.
    socket.setTimeout(5000, () => socket.destroy());
    frames(socket, message => {
      if (!authenticated) {
        if (message.type !== 'start' || message.token !== token || !Array.isArray(message.args) ||
            !message.args.every(v => typeof v === 'string' && !v.includes('\0')) ||
            typeof message.cwd !== 'string' || !path.isAbsolute(message.cwd) ||
            (message.account !== undefined && (typeof message.account !== 'string' || message.account.includes('\0')))) return socket.destroy();
        authenticated = true; socket.setTimeout(0);
        if (!readOnlyArgs(message.args)) {
          socket.end(JSON.stringify({ type: 'error', message: 'This session supports read-only op commands; run other commands directly in your terminal.' }) + '\n');
          return;
        }
        const commandEnv = { ...env };
        if (message.account !== undefined) commandEnv.OP_ACCOUNT = message.account;
        // Nested `op run -- ... op ...` must not call back into this shim.
        commandEnv.PATH = (commandEnv.PATH || '').split(path.delimiter).filter(p => p !== directory).join(path.delimiter);
        for (const key of ['AYA_OP_SESSION_SOCKET', 'AYA_OP_SESSION_TOKEN', 'AYA_OP_SESSION_BIN', 'ELECTRON_RUN_AS_NODE']) delete commandEnv[key];
        child = spawn(executable, message.args, { cwd: message.cwd, env: commandEnv, stdio: ['pipe', 'pipe', 'pipe'] });
        commands.add(child);
        child.stdin.on('error', () => {});
        pipeOutput(child.stdout, socket, 'stdout'); pipeOutput(child.stderr, socket, 'stderr');
        child.once('error', () => { send(socket, { type: 'error', message: 'Cannot start 1Password CLI' }); socket.end(); });
        child.once('close', (code, signal) => {
          commands.delete(child); child = undefined;
          if (!socket.destroyed) socket.end(JSON.stringify({ type: 'exit', code: code ?? (signal ? 128 + (os.constants.signals[signal] || 0) : 1) }) + '\n');
        });
      } else if (message.type === 'stdin' && typeof message.data === 'string') {
        if (!child?.stdin.write(Buffer.from(message.data, 'base64'))) {
          socket.pause(); child?.stdin.once('drain', () => socket.resume());
        }
      } else if (message.type === 'end') child?.stdin.end();
      else socket.destroy();
    });
  });
  function cleanup(code) {
    if (stopping) return; stopping = true;
    for (const child of commands) terminate(child);
    for (const socket of sockets) socket.destroy();
    server.close();
    fs.rmSync(directory, { recursive: true, force: true });
    process.exitCode = code;
  }
  server.on('error', () => { process.stderr.write('aya: cannot start op session\n'); cleanup(1); });
  server.listen(socketPath, () => {
    fs.chmodSync(socketPath, 0o600);
    env.PATH = directory + path.delimiter + (env.PATH || '');
    agent = spawn(argv[0], argv.slice(1), { env, stdio: 'inherit' });
    agent.once('error', () => { process.stderr.write('aya: cannot start session command\n'); cleanup(1); });
    agent.once('exit', (code, signal) => cleanup(code ?? (signal ? 128 + (os.constants.signals[signal] || 0) : 1)));
  });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => {
    if (agent) terminate(agent);
    cleanup(signal === 'SIGINT' ? 130 : 143);
  });
}
function client(args) {
  const socketPath = process.env.AYA_OP_SESSION_SOCKET, token = process.env.AYA_OP_SESSION_TOKEN;
  if (!socketPath || !token) throw Error('The op session has ended; restart the Aya pane');
  const socket = net.connect(socketPath);
  let exited = false;
  socket.once('connect', () => {
    send(socket, { type: 'start', token, args, cwd: process.cwd(), account: process.env.OP_ACCOUNT });
    process.stdin.on('data', data => { if (!send(socket, { type: 'stdin', data: data.toString('base64') })) process.stdin.pause(); });
    socket.on('drain', () => process.stdin.resume());
    process.stdin.once('end', () => send(socket, { type: 'end' }));
    process.stdin.resume();
  });
  socket.on('error', () => {});
  socket.once('close', () => {
    process.stdin.pause();
    if (!exited) { process.stderr.write('aya: op session disconnected; command was not retried\n'); process.exitCode = 1; }
  });
  frames(socket, message => {
    if ((message.type === 'stdout' || message.type === 'stderr') && typeof message.data === 'string') {
      const output = message.type === 'stdout' ? process.stdout : process.stderr;
      if (!output.write(Buffer.from(message.data, 'base64'))) { socket.pause(); output.once('drain', () => socket.resume()); }
    } else if (message.type === 'exit' && Number.isInteger(message.code)) {
      exited = true; process.exitCode = message.code; process.stdin.pause(); socket.end();
    } else if (message.type === 'error') { exited = true; process.exitCode = 1; process.stdin.pause(); process.stderr.write(`aya: ${message.message}\n`); socket.end(); }
    else socket.destroy();
  });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => { socket.destroy(); process.exitCode = signal === 'SIGINT' ? 130 : 143; });
}
if (require.main === module) {
  try {
    const [mode, ...args] = process.argv.slice(2);
    if (mode === 'launch') launch(args[0] === '--' ? args.slice(1) : args);
    else if (mode === 'client') client(args);
    else throw Error('Unknown op-session mode');
  } catch (error) { process.stderr.write(`aya: ${error.message}\n`); process.exitCode = 1; }
}
module.exports = { realOp, readOnlyArgs };
