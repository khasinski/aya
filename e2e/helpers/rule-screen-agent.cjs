// Offline PTY screen stand-in; the preset identifies the agent, not this process name.
const mode=process.argv[2];
process.stdin.setRawMode(true);process.stdin.resume();
const screens={idle:'❯ \r\n? for shortcuts',busy:'❯ \r\n  esc to interrupt',approval:'Do you want to proceed?\r\n❯ 1. Yes\r\n  2. No',account:'Do you want to proceed?\r\nkeep allowing any reads outside the working directories'};
if(!Object.hasOwn(screens,mode))throw Error('Unknown rule-screen mode');
process.stdout.write('\x1b[2J\x1b[H'+screens[mode]+'\r\n');
setInterval(()=>{},1000);
