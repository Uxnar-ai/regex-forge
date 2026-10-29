/* regexlab · 引擎
 *
 * 全部手写，不依赖浏览器 RegExp：
 *   parse()       递归下降 → 语法树
 *   compile()     Thompson 构造 → ε-NFA（补丁表回填）
 *   simulate()    ε-闭包 + 活跃集合并行推进（含"每步注入起点"实现包含匹配）
 *   buildDfa()    子集构造 → DFA 转移表
 *   toProgram()   AST → 指令序列，btRun() 用递归回溯执行（无记忆化，故意暴露指数回溯）
 */
(function (global) {
  'use strict';

  // ---------------------------------------------------------------- 字符类
  const ESC_CLASS = {
    d: [[48, 57]],
    w: [[48, 57], [65, 90], [95, 95], [97, 122]],
    s: [[9, 9], [10, 10], [13, 13], [32, 32]],
  };
  const ESC_CHAR = { t: '\t', n: '\n', r: '\r' };

  function inRanges(ranges, ch) {
    const c = ch.codePointAt(0);
    for (let i = 0; i < ranges.length; i++) {
      if (c >= ranges[i][0] && c <= ranges[i][1]) return true;
    }
    return false;
  }

  function classDesc(node) {
    let out = '[';
    if (node.neg) out += '^';
    for (const r of node.ranges) {
      out += String.fromCharCode(r[0]);
      if (r[1] !== r[0]) out += '-' + String.fromCharCode(r[1]);
    }
    return out + ']';
  }

  // ---------------------------------------------------------------- 解析器
  function parse(src) {
    let i = 0;

    function fail(msg) {
      throw new Error(msg + '（位置 ' + i + '）');
    }

    function parseAlt() {
      const items = [parseConcat()];
      while (src[i] === '|') {
        i++;
        items.push(parseConcat());
      }
      return items.length === 1 ? items[0] : { t: 'alt', items };
    }

    function parseConcat() {
      const items = [];
      while (i < src.length && src[i] !== '|' && src[i] !== ')') {
        items.push(parseRepeat());
      }
      if (items.length === 0) return { t: 'empty' };
      return items.length === 1 ? items[0] : { t: 'cat', items };
    }

    function parseRepeat() {
      let node = parseAtom();
      for (;;) {
        const c = src[i];
        if (c === '*') { i++; node = { t: 'star', node }; }
        else if (c === '+') { i++; node = { t: 'plus', node }; }
        else if (c === '?') { i++; node = { t: 'opt', node }; }
        else if (c === '{') {
          const rep = parseCount();
          if (!rep) break;
          node = applyCount(node, rep[0], rep[1]);
        } else break;
      }
      return node;
    }

    function parseCount() {
      const save = i;
      i++; // {
      let n = '';
      while (/\d/.test(src[i] || '')) n += src[i++];
      let m = null;
      if (src[i] === ',') {
        i++;
        let mm = '';
        while (/\d/.test(src[i] || '')) mm += src[i++];
        m = mm === '' ? Infinity : parseInt(mm, 10);
      } else {
        m = parseInt(n, 10);
      }
      if (src[i] !== '}' || n === '') { i = save; return null; }
      i++;
      const lo = parseInt(n, 10);
      if (m !== Infinity && m < lo) fail('{n,m} 里 m 小于 n');
      if (lo > 8 || (m !== Infinity && m > 8)) fail('计数上限 8（NFA 会炸）');
      return [lo, m];
    }

    function applyCount(node, lo, hi) {
      const parts = [];
      for (let k = 0; k < lo; k++) parts.push(node);
      if (hi === Infinity) {
        parts.push({ t: 'star', node });
      } else {
        for (let k = 0; k < hi - lo; k++) parts.push({ t: 'opt', node });
      }
      if (parts.length === 1) return parts[0];
      return { t: 'cat', items: parts };
    }

    function parseAtom() {
      const c = src[i];
      if (c === undefined) fail('正则在连接处意外结束');
      if (c === '(') {
        i++;
        const inner = parseAlt();
        if (src[i] !== ')') fail('缺少右括号');
        i++;
        return inner;
      }
      if (c === '[') return parseClass();
      if (c === '.') { i++; return { t: 'any' }; }
      if (c === '^') { i++; return { t: 'anchor', kind: 'start' }; }
      if (c === '$') { i++; return { t: 'anchor', kind: 'end' }; }
      if (c === '\\') {
        i++;
        const e = src[i];
        if (e === undefined) fail('转义符后没有字符');
        i++;
        if (ESC_CLASS[e]) {
          const ranges = ESC_CLASS[e];
          const neg = e === 'D' || e === 'W' || e === 'S';
          if (neg) {
            return { t: 'class', ranges: ESC_CLASS[e.toLowerCase()], neg: true };
          }
          return { t: 'class', ranges: ranges, neg: false };
        }
        return { t: 'char', c: ESC_CHAR[e] || e };
      }
      if (c === '*' || c === '+' || c === '?') fail('量词前没有原子');
      i++;
      return { t: 'char', c: c };
    }

    function parseClassEscape() {
      const e = src[i];
      if (e === undefined) fail('字符类里的转义符后没有字符');
      i++;
      if (ESC_CLASS[e]) return { ranges: ESC_CLASS[e], neg: false };
      return { ranges: [[(ESC_CHAR[e] || e).codePointAt(0)].concat([])], ch: ESC_CHAR[e] || e };
    }

    function parseClass() {
      i++; // [
      let neg = false;
      if (src[i] === '^') { neg = true; i++; }
      const ranges = [];
      let first = true;
      while (i < src.length) {
        if (src[i] === ']' && !first) { i++; return { t: 'class', ranges: ranges, neg: neg }; }
        first = false;
        let lo;
        if (src[i] === '\\') {
          const esc = parseClassEscape();
          if (esc.ranges.length > 1) { ranges.push(...esc.ranges); continue; }
          lo = esc.ranges[0][0];
        } else {
          lo = src.codePointAt(i);
          i++;
        }
        if (src[i] === '-' && src[i + 1] !== ']' && src[i + 1] !== undefined) {
          i++;
          let hi;
          if (src[i] === '\\') {
            const esc = parseClassEscape();
            hi = esc.ranges[0][0];
          } else {
            hi = src.codePointAt(i);
            i++;
          }
          if (hi < lo) fail('字符类区间反了');
          ranges.push([lo, hi]);
        } else {
          ranges.push([lo, lo]);
        }
      }
      fail('字符类没有闭合');
    }

    const ast = parseAlt();
    if (i < src.length) fail('多余的 ' + src[i]);
    return ast;
  }

  // ---------------------------------------------------------------- AST → ε-NFA
  function compile(ast) {
    const states = []; // states[i] = [{to, cond}]
    const nw = function () { states.push([]); return states.length - 1; };
    const eps = function (a, b) { states[a].push({ to: b, cond: null }); };
    const move = function (a, b, cond) { states[a].push({ to: b, cond: cond }); };

    function frag(node) {
      switch (node.t) {
        case 'empty': { const s = nw(); return { start: s, outs: [s] }; }
        case 'char': { const s = nw(), e = nw(); move(s, e, { t: 'char', c: node.c }); return { start: s, outs: [e] }; }
        case 'any': { const s = nw(), e = nw(); move(s, e, { t: 'any' }); return { start: s, outs: [e] }; }
        case 'class': { const s = nw(), e = nw(); move(s, e, { t: 'class', ranges: node.ranges, neg: node.neg }); return { start: s, outs: [e] }; }
        case 'anchor': { const s = nw(), e = nw(); move(s, e, { t: 'anchor', kind: node.kind }); return { start: s, outs: [e] }; }
        case 'cat': {
          let acc = frag(node.items[0]);
          for (let k = 1; k < node.items.length; k++) {
            const nxt = frag(node.items[k]);
            for (const o of acc.outs) eps(o, nxt.start);
            acc = { start: acc.start, outs: nxt.outs };
          }
          return acc;
        }
        case 'alt': {
          const s = nw(), e = nw();
          for (const item of node.items) {
            const f = frag(item);
            eps(s, f.start);
            for (const o of f.outs) eps(o, e);
          }
          return { start: s, outs: [e] };
        }
        case 'star': {
          const f = frag(node.node), s = nw(), e = nw();
          eps(s, f.start); eps(s, e);
          for (const o of f.outs) eps(o, s);
          return { start: s, outs: [e] };
        }
        case 'plus': {
          const f = frag(node.node), s = f.start, e = nw();
          for (const o of f.outs) { eps(o, s); eps(o, e); }
          return { start: s, outs: [e] };
        }
        case 'opt': {
          const f = frag(node.node), s = nw(), e = nw();
          eps(s, f.start); eps(s, e);
          for (const o of f.outs) eps(o, e);
          return { start: s, outs: [e] };
        }
        default:
          throw new Error('未知节点 ' + node.t);
      }
    }

    const root = frag(ast);
    const accept = nw();
    for (const o of root.outs) eps(o, accept);
    return { states: states, start: root.start, accept: accept };
  }

  function edgeMatches(cond, ch) {
    if (!cond) return false;
    if (cond.t === 'char') return cond.c === ch;
    if (cond.t === 'any') return true;
    if (cond.t === 'class') {
      const hit = inRanges(cond.ranges, ch);
      return cond.neg ? !hit : hit;
    }
    return false;
  }

  function edgeLabel(cond) {
    if (!cond) return 'ε';
    if (cond.t === 'char') return cond.c === ' ' ? '␠' : cond.c;
    if (cond.t === 'any') return '.';
    if (cond.t === 'class') return classDesc(cond);
    if (cond.t === 'anchor') return cond.kind === 'start' ? '^' : '$';
    return '?';
  }

  // ---------------------------------------------------------------- 并行 NFA 模拟
  function closure(nfa, seeds, pos, len) {
    const set = new Set(seeds);
    const stack = Array.from(set);
    let cost = 0;
    while (stack.length) {
      const s = stack.pop();
      const edges = nfa.states[s];
      for (let k = 0; k < edges.length; k++) {
        const e = edges[k];
        cost++;
        if (e.cond && e.cond.t !== 'anchor') continue;
        if (e.cond && e.cond.t === 'anchor') {
          if (e.cond.kind === 'start' && pos !== 0) continue;
          if (e.cond.kind === 'end' && pos !== len) continue;
        }
        if (!set.has(e.to)) { set.add(e.to); stack.push(e.to); }
      }
    }
    return { set: set, cost: cost };
  }

  /**
   * 并行推进：整个活跃状态集合一起走，遇到空集就停（整串匹配）或重新注入起点（包含匹配）。
   * @param {object} nfa
   * @param {string} input
   * @param {string} mode 'search' | 'full'
   */
  function simulate(nfa, input, mode) {
    const len = input.length;
    let cur = closure(nfa, [nfa.start], 0, len);
    let steps = cur.cost;
    const trace = [];
    let hit = null;

    const snapshot = function (pos, used) {
      trace.push({
        pos: pos,
        set: Array.from(cur.set).sort(function (a, b) { return a - b; }),
        used: used || [],
        char: pos < len ? input[pos] : null,
      });
    };

    if (mode === 'search' && cur.set.has(nfa.accept)) hit = 0;
    snapshot(0, []);

    for (let p = 0; p < len; p++) {
      // 包含匹配：每一步都把起点闭包并回活跃集合，等价于隐式前缀 .*
      if (mode === 'search' && p > 0) {
        const add = closure(nfa, [nfa.start], p, len);
        steps += add.cost;
        for (const st of add.set) cur.set.add(st);
      }
      const next = new Set();
      const used = [];
      for (const s of cur.set) {
        const edges = nfa.states[s];
        for (let k = 0; k < edges.length; k++) {
          const e = edges[k];
          steps++;
          if (!edgeMatches(e.cond, input[p])) continue;
          next.add(e.to);
          used.push([s, e.to]);
        }
      }
      if (next.size === 0) {
        cur = { set: new Set(), cost: 0 };
        snapshot(p + 1, used);
        if (mode === 'full') break;   // 整串匹配：断了就没救
        continue;                      // 包含匹配：下一个位置重新起跑
      }
      const cl = closure(nfa, next, p + 1, len);
      steps += cl.cost;
      cur = { set: cl.set, cost: 0 };
      if (mode === 'search' && cur.set.has(nfa.accept) && hit === null) hit = p + 1;
      snapshot(p + 1, used);
      if (hit !== null && mode === 'search') break; // 命中即可，不再推进
    }

    if (mode === 'full') hit = cur.set.has(nfa.accept) ? len : null;

    return {
      ok: hit !== null,
      matchedAt: hit,
      steps: steps,
      trace: trace,
      stateCount: nfa.states.length,
    };
  }

  // ---------------------------------------------------------------- 子集构造
  function alphabetOf(ast) {
    const chars = new Set();
    const other = '\u0000';
    (function walk(node) {
      if (!node) return;
      if (node.t === 'char') chars.add(node.c);
      else if (node.t === 'class') {
        for (const r of node.ranges) {
          for (let c = r[0]; c <= r[1] && c - r[0] < 64; c++) chars.add(String.fromCharCode(c));
        }
      } else if (node.items) node.items.forEach(walk);
      else if (node.node) walk(node.node);
    })(ast);
    return { chars: Array.from(chars).sort(), other: other };
  }

  function hasAnchor(ast) {
    let found = false;
    (function walk(node) {
      if (!node || found) return;
      if (node.t === 'anchor') { found = true; return; }
      if (node.items) node.items.forEach(walk);
      else if (node.node) walk(node.node);
    })(ast);
    return found;
  }

  function buildDfa(nfa, ast, cap, opts) {
    cap = cap || 160;
    opts = opts || {};
    const inject = !!opts.inject;      // 包含匹配：闭包时始终并上起点
    // 字母表 = 正则里出现的字面量/字符类 + 输入串里实际出现的字符（否则 . 或宽字符类会漏列）
    const set = new Set(alphabetOf(ast).chars);
    for (const ch of (opts.input || '')) { if (set.size >= 24) break; set.add(ch); }
    const alpha = Array.from(set).sort();
    const key = function (set) { return Array.from(set).sort(function (a, b) { return a - b; }).join(','); };
    const cl = function (seeds) {
      const arr = Array.from(seeds);
      return closure(nfa, inject ? arr.concat([nfa.start]) : arr, 0, 1e9).set;
    };
    const startSet = cl([nfa.start]);
    const sets = [startSet];
    const index = new Map([[key(startSet), 0]]);
    const trans = [];
    let truncated = false;

    for (let i = 0; i < sets.length; i++) {
      const row = [];
      for (const ch of alpha) {
        const moved = new Set();
        for (const s of sets[i]) {
          for (const e of nfa.states[s]) {
            if (edgeMatches(e.cond, ch)) moved.add(e.to);
          }
        }
        if (moved.size === 0) {
          if (!inject) { row.push(-1); continue; }
        }
        const target = cl(moved);
        const k = key(target);
        if (!index.has(k)) {
          if (sets.length >= cap) { truncated = true; row.push(-1); continue; }
          index.set(k, sets.length);
          sets.push(target);
        }
        row.push(index.get(k));
      }
      trans.push(row);
    }

    const acceptIdx = [];
    sets.forEach(function (set, i) { if (set.has(nfa.accept)) acceptIdx.push(i); });

    return {
      alpha: alpha,
      sets: sets.map(function (s) { return Array.from(s).sort(function (a, b) { return a - b; }); }),
      trans: trans,
      accept: acceptIdx,
      truncated: truncated,
      start: 0,
    };
  }

  function runDfa(dfa, input, mode) {
    const map = new Map();
    dfa.alpha.forEach(function (c, i) { map.set(c, i); });
    let steps = 0;
    let st = dfa.start;
    let hit = mode === 'search' && dfa.accept.indexOf(st) >= 0 ? 0 : null;

    for (let p = 0; p < input.length; p++) {
      const col = map.has(input[p]) ? map.get(input[p]) : -1;
      if (col < 0 && !dfa.hasOther) { st = -1; }
      else if (col < 0) { st = dfa.start; }
      else { st = dfa.trans[st][col]; }
      steps++;
      if (st < 0) break;
      if (mode === 'search' && dfa.accept.indexOf(st) >= 0 && hit === null) hit = p + 1;
    }

    if (mode === 'full') return { ok: dfa.accept.indexOf(st) >= 0, matchedAt: dfa.accept.indexOf(st) >= 0 ? input.length : null, steps: steps };
    return { ok: hit !== null, matchedAt: hit, steps: steps };
  }

  // ---------------------------------------------------------------- AST → 指令 → 回溯执行
  function toProgram(ast) {
    const prog = [];
    const emit = function (ins) { prog.push(ins); return prog.length - 1; };

    function gen(node) {
      switch (node.t) {
        case 'empty': return;
        case 'char': emit({ op: 'char', c: node.c }); return;
        case 'any': emit({ op: 'any' }); return;
        case 'class': emit({ op: 'cls', ranges: node.ranges, neg: node.neg }); return;
        case 'anchor': emit({ op: 'assert', kind: node.kind }); return;
        case 'cat': node.items.forEach(gen); return;
        case 'alt': {
          // 分支链：split → item0 → jmp 结尾 / split → item1 …
          (function chain(k) {
            if (k === node.items.length - 1) { gen(node.items[k]); return; }
            const sp = emit({ op: 'split', x: 0, y: 0 });
            prog[sp].x = prog.length;
            gen(node.items[k]);
            const jmp = emit({ op: 'jmp', x: 0 });
            prog[sp].y = prog.length;
            chain(k + 1);
            prog[jmp].x = prog.length;
          })(0);
          return;
        }
        case 'star': {
          const l1 = emit({ op: 'split', x: 0, y: 0 });
          prog[l1].x = prog.length;
          gen(node.node);
          emit({ op: 'jmp', x: l1 });
          prog[l1].y = prog.length;
          return;
        }
        case 'plus': {
          const l1 = prog.length;
          gen(node.node);
          const sp = emit({ op: 'split', x: l1, y: 0 });
          prog[sp].y = prog.length;
          return;
        }
        case 'opt': {
          const sp = emit({ op: 'split', x: 0, y: 0 });
          prog[sp].x = prog.length;
          gen(node.node);
          prog[sp].y = prog.length;
          return;
        }
        default: throw new Error('未知节点 ' + node.t);
      }
    }

    gen(ast);
    emit({ op: 'match' });
    return prog;
  }

  function btRun(prog, input, mode, cap) {
    cap = cap || 120000;
    const len = input.length;
    const full = mode === 'full';
    let steps = 0;
    let overflow = false;

    function exec(pc, pos) {
      if (steps++ > cap) { overflow = true; return -1; }
      const ins = prog[pc];
      switch (ins.op) {
        case 'char':
          if (pos < len && input[pos] === ins.c) return exec(pc + 1, pos + 1);
          return -1;
        case 'cls': {
          if (pos >= len) return -1;
          const hit = inRanges(ins.ranges, input[pos]);
          if (ins.neg ? !hit : hit) return exec(pc + 1, pos + 1);
          return -1;
        }
        case 'any':
          if (pos < len) return exec(pc + 1, pos + 1);
          return -1;
        case 'assert':
          if (ins.kind === 'start' && pos !== 0) return -1;
          if (ins.kind === 'end' && pos !== len) return -1;
          return exec(pc + 1, pos);
        case 'split': {
          const r = exec(ins.x, pos);
          if (r >= 0) return r;
          if (overflow) return -1;
          return exec(ins.y, pos);
        }
        case 'jmp':
          return exec(ins.x, pos);
        case 'match':
          return full && pos !== len ? -1 : pos;   // 整串匹配必须吃完整个输入
        default:
          return -1;
      }
    }

    let hit = null;
    const starts = mode === 'full' ? [0] : null;
    if (starts) {
      hit = exec(0, 0);
      if (hit < 0) hit = null;
    } else {
      for (let p = 0; p <= len; p++) {
        const r = exec(0, p);
        if (r >= 0) { hit = r; break; }
        if (overflow) break;
      }
    }
    return { ok: hit !== null, matchedAt: hit, steps: steps, overflow: overflow };
  }

  // ---------------------------------------------------------------- NFA 图布局
  function layoutNfa(nfa) {
    const n = nfa.states.length;
    const cols = n <= 6 ? n : Math.ceil(Math.sqrt(n * 1.6));
    const gapX = 62, gapY = 66, padX = 34, padY = 26;
    const pos = [];
    for (let i = 0; i < n; i++) {
      const r = Math.floor(i / cols), c = i % cols;
      pos.push({ x: padX + c * gapX, y: padY + r * gapY });
    }
    const rows = Math.ceil(n / cols);
    return { pos: pos, width: padX * 2 + (cols - 1) * gapX + 16, height: padY * 2 + (rows - 1) * gapY };
  }

  function renderNfa(svg, nfa, active, used) {
    const lay = layoutNfa(nfa);
    svg.setAttribute('viewBox', '0 0 ' + Math.round(lay.width) + ' ' + Math.round(lay.height));
    const NS = 'http://www.w3.org/2000/svg';
    const activeSet = new Set(active || []);
    const liveSet = new Set((used || []).map(function (p) { return p[0] + '>' + p[1]; }));
    const parts = [];

    // 边
    nfa.states.forEach(function (edges, from) {
      edges.forEach(function (e, idx) {
        const a = lay.pos[from], b = lay.pos[e.to];
        const isEps = !e.cond;
        const live = liveSet.has(from + '>' + e.to);
        const cls = 'edge' + (isEps ? ' eps' : '') + (live ? ' live' : '');
        if (from === e.to) {
          // 自环
          const x = a.x, y = a.y - 14;
          parts.push('<path class="' + cls + '" d="M' + (x - 7) + ' ' + y + ' C' + (x - 16) + ' ' + (y - 22) + ' ' + (x + 16) + ' ' + (y - 22) + ' ' + (x + 7) + ' ' + y + '"/>');
          parts.push('<text class="elabel" x="' + x + '" y="' + (y - 20) + '" text-anchor="middle">' + esc(edgeLabel(e.cond)) + '</text>');
          return;
        }
        const dx = b.x - a.x, dy = b.y - a.y;
        const dist = Math.max(1, Math.hypot(dx, dy));
        const ux = dx / dist, uy = dy / dist;
        const r = 13;
        const x1 = a.x + ux * r, y1 = a.y + uy * r;
        const x2 = b.x - ux * (r + 4), y2 = b.y - uy * (r + 4);
        const bend = (e.to < from ? 26 : 10) * (idx % 2 === 0 ? 1 : -1);
        const mx = (x1 + x2) / 2 - uy * bend, my = (y1 + y2) / 2 + ux * bend;
        parts.push('<path class="' + cls + '" d="M' + r2(x1) + ' ' + r2(y1) + ' Q' + r2(mx) + ' ' + r2(my) + ' ' + r2(x2) + ' ' + r2(y2) + '"/>');
        // 箭头
        const ax = x2 - mx, ay = y2 - my;
        const al = Math.max(1, Math.hypot(ax, ay));
        const bx = x2 - (ax / al) * 7, by = y2 - (ay / al) * 7;
        const px = -(ay / al) * 3.4, py = (ax / al) * 3.4;
        parts.push('<path class="edge' + (live ? ' live' : '') + '" d="M' + r2(x2) + ' ' + r2(y2) + ' L' + r2(bx + px) + ' ' + r2(by + py) + ' L' + r2(bx - px) + ' ' + r2(by - py) + ' Z" style="fill:currentColor;stroke:none;opacity:.55"/>');
        const midX = (x1 + 2 * mx + x2) / 4, midY = (y1 + 2 * my + y2) / 4;
        const bulgeX = mx - (x1 + x2) / 2, bulgeY = my - (y1 + y2) / 2;
        const bl = Math.max(1e-6, Math.hypot(bulgeX, bulgeY));
        const lx = midX + (bulgeX / bl) * 9, ly = midY + (bulgeY / bl) * 9;
        parts.push('<text class="elabel" x="' + r2(lx) + '" y="' + r2(ly - 4) + '" text-anchor="middle">' + esc(edgeLabel(e.cond)) + '</text>');
      });
    });

    // 状态
    lay.pos.forEach(function (p, i) {
      const isAcc = i === nfa.accept;
      const on = activeSet.has(i);
      const cls = 'st-circle' + (on ? ' active' : '') + (isAcc ? ' accept' : '');
      parts.push('<circle class="' + cls + '" cx="' + p.x + '" cy="' + p.y + '" r="13"/>');
      if (isAcc) parts.push('<circle cx="' + p.x + '" cy="' + p.y + '" r="9.5" fill="none" stroke="var(--accent)" stroke-width=".8" opacity=".65"/>');
      parts.push('<text class="st-num" x="' + p.x + '" y="' + (p.y + 3.6) + '" text-anchor="middle">' + i + '</text>');
    });

    // 起点标记：斜向上的小箭头 + 文字，永远在圆的外侧，不会压到邻接状态
    const sp = lay.pos[nfa.start];
    parts.push('<path class="edge" d="M' + (sp.x - 20) + ' ' + (sp.y - 20) + ' L' + (sp.x - 11) + ' ' + (sp.y - 11) + '"/>');
    parts.push('<path class="edge" d="M' + (sp.x - 15) + ' ' + (sp.y - 13) + ' L' + (sp.x - 11) + ' ' + (sp.y - 11) + ' L' + (sp.x - 13) + ' ' + (sp.y - 17) + ' Z" style="fill:currentColor;stroke:none;opacity:.55"/>');
    parts.push('<text class="elabel" x="' + (sp.x - 22) + '" y="' + (sp.y - 21) + '" text-anchor="end">start</text>');

    svg.innerHTML = parts.join('');
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function r2(v) { return Math.round(v * 10) / 10; }

  global.RX = {
    parse: parse,
    compile: compile,
    simulate: simulate,
    buildDfa: buildDfa,
    runDfa: runDfa,
    toProgram: toProgram,
    btRun: btRun,
    hasAnchor: hasAnchor,
    renderNfa: renderNfa,
    layoutNfa: layoutNfa,
    classDesc: classDesc,
    esc: esc,
  };
})(window);
