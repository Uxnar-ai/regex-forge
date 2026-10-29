/* 引擎自检：node tests/engine_test.mjs
 * 覆盖：基本匹配、锚点、计数、包含/整串语义、病态回溯、以及与浏览器 RegExp 的随机交叉验证。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'static', 'engine.js'), 'utf8');
const window = {};
new Function('window', src)(window);
const RX = window.RX;

let fails = 0;
function chk(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.log('FAIL', name, 'got', JSON.stringify(got), 'want', JSON.stringify(want)); }
  else console.log('ok  ', name);
}

function run(pat, input, mode) {
  const ast = RX.parse(pat);
  const nfa = RX.compile(ast);
  const sim = RX.simulate(nfa, input, mode);
  const bt = RX.btRun(RX.toProgram(ast), input, mode, 150000);
  let dfa = null, dr = null;
  if (!RX.hasAnchor(ast)) {
    dfa = RX.buildDfa(nfa, ast, 160, { inject: mode === 'search', input: input });
    dr = RX.runDfa(dfa, input, mode);
  }
  return { ast, nfa, sim, bt, dfa, dr };
}

// ---- 基本语义
let r = run('(a|b)*abb', 'aababbababb', 'search');
chk('教材例 包含匹配 命中', r.sim.ok, true);
chk('教材例 回溯一致', r.bt.ok, true);
chk('教材例 DFA 一致', r.dr.ok, true);
r = run('(a|b)*abb', 'aababbababb', 'full');
chk('教材例 整串匹配（本身就以 abb 结尾）', r.sim.ok, true);
chk('教材例 整串 回溯一致', r.bt.ok, true);
chk('教材例 整串 DFA 一致', r.dr.ok, true);
r = run('(a|b)*abb', 'aababbabab', 'full');
chk('整串不匹配', [r.sim.ok, r.bt.ok, r.dr.ok], [false, false, false]);

// ---- 计数 + 字符类 + 锚点
r = run('^[a-z0-9_]{3,8}$', 'abc_12', 'full');
chk('标识符 合法', r.sim.ok, true);
chk('标识符 太短', run('^[a-z0-9_]{3,8}$', 'ab', 'full').sim.ok, false);
chk('标识符 太长', run('^[a-z0-9_]{3,8}$', 'abcdefghi', 'full').sim.ok, false);
chk('标识符 非法字符', run('^[a-z0-9_]{3,8}$', 'abC', 'full').sim.ok, false);
chk('标识符 回溯一致', run('^[a-z0-9_]{3,8}$', 'abc_12', 'full').bt.ok, true);

r = run('\\d{4}-\\d{2}-\\d{2}', 'x 2026-10-30 y', 'search');
chk('日期 命中位置到 12', [r.sim.ok, r.sim.matchedAt], [true, 12]);
chk('日期 回溯一致', r.bt.matchedAt, 12);
chk('日期 不足位', run('\\d{4}-\\d{2}-\\d{2}', '26-10-30', 'search').sim.ok, false);

chk('^ 只在串首', run('^ab', 'abc', 'search').sim.ok, true);
chk('^ 不在串中', run('^ab', 'xabc', 'search').sim.ok, false);
chk('$ 在串尾', run('bc$', 'abc', 'search').sim.ok, true);
chk('$ 不在串中', run('bc$', 'abcx', 'search').sim.ok, false);

// ---- 空串与空语言
chk('a* 匹配空串', run('a*', '', 'full').sim.ok, true);
chk('a 不匹配空串', run('a', '', 'full').sim.ok, false);
chk('空语言不匹配', run('a|b', '', 'full').sim.ok, false);

// ---- 病态回溯
const bomb = 'a'.repeat(20);
r = run('(a|a)*b', bomb, 'search');
chk('回溯炸弹 正确判否', r.sim.ok, false);
chk('回溯炸弹 NFA 线性', r.sim.steps < 5000, true);
chk('回溯炸弹 回溯器撞上限', r.bt.overflow, true);
r = run('(a|a)*b', 'a'.repeat(20) + 'b', 'search');
chk('回溯炸弹 末尾补 b 后命中', r.sim.ok, true);

// ---- 与浏览器 RegExp 交叉验证
const pats = ['a', 'ab', 'a*', 'a+', '(a|b)*abb', '[a-c]+', 'a?b', '(ab|b)+', '.b', '[^a]+', 'a{2,4}', '.*', 'b+a?'];
const alph = 'abc';
let mism = 0, total = 0;
for (const p of pats) {
  for (const mode of ['search', 'full']) {
    for (let n = 0; n <= 7; n++) {
      for (let t = 0; t < 10; t++) {
        let s = '';
        for (let i = 0; i < n; i++) s += alph[Math.floor(Math.random() * alph.length)];
        const res = run(p, s, mode);
        const native = new RegExp(mode === 'full' ? '^(?:' + p + ')$' : p).test(s);
        total++;
        if (res.sim.ok !== native) { mism++; if (mism < 6) console.log('MISMATCH nfa', p, mode, JSON.stringify(s), res.sim.ok, native); }
        if (res.dr && res.dr.ok !== res.sim.ok) { mism++; if (mism < 6) console.log('MISMATCH dfa', p, mode, JSON.stringify(s), res.dr.ok, res.sim.ok); }
        if (!res.bt.overflow && res.bt.ok !== res.sim.ok) { mism++; if (mism < 6) console.log('MISMATCH bt', p, mode, JSON.stringify(s), res.bt.ok, res.sim.ok); }
      }
    }
  }
}
chk('随机交叉验证 ' + total + ' 例', mism, 0);

// ---- 规模检查
const big = run('(a|b)*abb', 'ab'.repeat(400), 'search');
chk('长串 NFA 线性增长 (' + big.sim.steps + ' 步 / ' + (big.sim.steps / 800).toFixed(1) + ' 步每字符)', big.sim.steps < 800 * 80, true);
chk('长串 DFA 状态数有限', big.dfa.sets.length <= 160, true);

console.log(fails ? 'FAILURES: ' + fails : 'ALL PASS');
process.exit(fails ? 1 : 0);
