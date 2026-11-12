// node refs.cjs <file> <line> <symbol> [projects...]  -> references across the given tsconfig projects (deduped)
const ts = require('/tmp/vbench-hotel/node_modules/typescript');
const path = require('path'); const fs = require('fs');
const [file, line, sym, ...projects] = process.argv.slice(2);
const root = '/private/tmp/vbench-hotel';
const out = new Set();
for (const proj of projects) {
  const cfgPath = path.join(root, proj, 'tsconfig.json');
  const cfg = ts.getParsedCommandLineOfConfigFile(cfgPath, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: d => console.error(d.messageText) });
  const files = new Set(cfg.fileNames);
  const abs = path.join(root, file); files.add(abs);
  const host = {
    getScriptFileNames: () => [...files], getScriptVersion: () => '1',
    getScriptSnapshot: f => fs.existsSync(f) ? ts.ScriptSnapshot.fromString(fs.readFileSync(f, 'utf8')) : undefined,
    getCurrentDirectory: () => path.join(root, proj), getCompilationSettings: () => cfg.options,
    getDefaultLibFileName: o => ts.getDefaultLibFilePath(o), fileExists: ts.sys.fileExists, readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory, directoryExists: ts.sys.directoryExists, getDirectories: ts.sys.getDirectories, realpath: ts.sys.realpath,
  };
  const ls = ts.createLanguageService(host);
  const text = fs.readFileSync(abs, 'utf8'); const lines = text.split('\n');
  const col = lines[+line - 1].search(new RegExp(`\\b${sym}\\b`));
  let pos = 0; for (let i = 0; i < +line - 1; i++) pos += lines[i].length + 1; pos += col;
  const refs = ls.findReferences(abs, pos) || [];
  for (const r of refs) for (const e of r.references) {
    const t = fs.readFileSync(e.fileName, 'utf8'); const l = t.slice(0, e.textSpan.start).split('\n').length;
    out.add(`${path.relative(fs.realpathSync(root), fs.realpathSync(e.fileName))}:${l}${e.isDefinition ? ' (def)' : ''}  ${t.split('\n')[l-1].trim().slice(0,110)}`);
  }
  if (process.env.IMPL) { const im = ls.getImplementationAtPosition(abs, pos) || []; for (const e of im) { const t = fs.readFileSync(e.fileName,'utf8'); const l = t.slice(0,e.textSpan.start).split('\n').length; out.add(`IMPL ${path.relative(fs.realpathSync(root), fs.realpathSync(e.fileName))}:${l} ${t.split('\n')[l-1].trim().slice(0,100)}`);} }
}
console.log([...out].sort().join('\n'));
