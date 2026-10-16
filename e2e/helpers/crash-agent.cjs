// Offline TUI: redraws on WINCH, or deliberately leaves an incomplete screen.
const fs=require('node:fs'),path=require('node:path');
const mode=process.argv[2],cli=process.argv[3];let nudged=false,redrawEnabled=false;
process.stdin.setRawMode(true);process.stdin.resume();
function draw(force=false){
 if(mode==='fragment'&&nudged&&!force&&!redrawEnabled){for(let y=1;y<=process.stdout.rows;y++)process.stdout.write(`\x1b[${y};1Hx`);return;}
 process.stdout.write('\x1b[2J\x1b[H');
 if(mode==='recorded')process.stdout.write(fs.readFileSync(path.join(__dirname,'../../tests/fixtures/own-screens',cli==='codex'?'codex-skip.raw':'claude-idle.raw')));
 else if(mode==='held')process.stdout.write('Do you want to proceed?\r\n❯ 1. Yes\r\n  2. No\r\nEsc to cancel\r\n');
 else process.stdout.write('──────────────────────────\r\n❯ \r\n──────────────────────────\r\n'+(mode==='busy'?'  ⏵⏵ auto mode on · esc to interrupt\r\n':'  ? for shortcuts\r\n'));
}
process.on('SIGWINCH',()=>{nudged=true;draw();});
process.stdin.on('data',data=>{fs.appendFileSync(path.join(process.env.AYA_PROJECT_DIR,'team-'+process.env.AYA_TERMINAL_ID+'.log'),data);if(String(data).includes('REDRAW')){redrawEnabled=true;draw(true);}});
draw();
