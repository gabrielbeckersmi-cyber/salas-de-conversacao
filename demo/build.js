// Gera public/simulacao.html: um único arquivo com a tela real do aluno + servidor e vídeo simulados.
const fs = require('fs'), path = require('path'), cp = require('child_process');
const root = path.join(__dirname, '..');
const pub = path.join(root, 'public');
const rd = (f) => fs.readFileSync(f, 'utf8');
const esbuild = process.env.ESBUILD || 'esbuild';
const lib = path.join(__dirname, '.simlib.js');
cp.execFileSync(esbuild, [path.join(__dirname, 'entry.js'), '--bundle', '--format=iife', '--platform=browser', '--outfile=' + lib,
  '--alias:crypto=' + path.join(__dirname, 'shims/crypto.js'), '--alias:fs=' + path.join(__dirname, 'shims/fs.js'), '--alias:path=' + path.join(__dirname, 'shims/path.js'),
  '--banner:js=var __dirname="";var process={env:{CLOSING_MINUTES:"3",MAX_STUDENTS:"80"}};', '--log-level=warning']);
const esc = (s) => s.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
const logo = 'data:image/png;base64,' + fs.readFileSync(path.join(pub, 'logo.png')).toString('base64');
let aluno = rd(path.join(pub, 'aluno.html'));
const inl = (f) => esc(rd(path.join(pub, f)));
aluno = aluno
  .replace('<link rel="stylesheet" href="/shared.css">', () => '<style>' + rd(path.join(pub, 'shared.css')) + '</style>')
  .replace('<link rel="stylesheet" href="/tema.css">', () => '<style>' + rd(path.join(pub, 'tema.css')) + '</style>')
  .replace('<script src="/vendor/livekit-client.umd.js"></script>', () => '<script>/*__SLOT__*/\n/*__MOCK__*/</script>')
  .replace('<script src="/shared.js"></script>', () => '<script>' + inl('shared.js').replace(/photoSet\[pid\] \? '\/api\/classes\/' \+ encodeURIComponent\(photoClass\) \+ '\/foto\/' \+ encodeURIComponent\(pid\) : ''/, () => 'photoSet[pid] ? (window.__photo ? window.__photo(pid) : "") : ""') + '</script>')
  .replace('<script src="/jogo.js"></script>', () => '<script>' + inl('jogo.js') + '</script>')
  .replace('<script src="/aluno.js"></script>', () => '<script>' + inl('aluno.js') + '</script>')
  .split('/logo.png').join(logo);
if (/(src|href)="\/[a-z]/.test(aluno.replace(/href="https?:/g, ''))) console.warn('AVISO: ainda há referências locais em aluno.html:', aluno.match(/(src|href)="\/[a-z][^"]*"/g));
const parts = {
  LOGO: logo,
  SIMLIB: esc(rd(lib)),
  DINAMICAS: JSON.stringify(rd(path.join(root, 'lib/dinamicas.json'))).replace(/<\//g, '<\\/'),
  PERGUNTAS: JSON.stringify(rd(path.join(root, 'lib/perguntas.json'))).replace(/<\//g, '<\\/'),
  SIMJS: esc(rd(path.join(__dirname, 'sim.js'))),
  ALUNO: JSON.stringify(aluno).replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--'),
  MOCK: JSON.stringify(rd(path.join(__dirname, 'mock.js'))).replace(/<\/script/gi, '<\\/script')
};
// uma só passada: o texto inserido não é reprocessado
const html = rd(path.join(__dirname, 'template.html')).replace(/@@(LOGO|SIMLIB|DINAMICAS|PERGUNTAS|SIMJS|ALUNO|MOCK)@@/g, (m, k) => parts[k]);
fs.writeFileSync(path.join(pub, 'simulacao.html'), html);
fs.unlinkSync(lib);
console.log('simulacao.html', (html.length / 1024).toFixed(0) + ' KB');
