/* regexlab · 页面接线：主题、输入、步进播放、三个引擎的对比 */
(function () {
  'use strict';

  const $ = function (id) { return document.getElementById(id); };
  const BT_CAP = 150000;

  const state = {
    pattern: '',
    input: '',
    mode: 'search',
    ast: null,
    nfa: null,
    dfa: null,
    sim: null,
    bt: null,
    dfaRun: null,
    idx: 0,
    playing: null,
  };

  // ---------------------------------------------------------------- 主题
  const themeBtn = $('themeBtn');
  const mq = window.matchMedia('(prefers-color-scheme: light)');

  function effectiveTheme() {
    const forced = document.documentElement.getAttribute('data-theme');
    if (forced) return forced;
    return mq.matches ? 'light' : 'dark';
  }
  function paintThemeBtn() {
    themeBtn.textContent = effectiveTheme() === 'dark' ? '☾ 深色' : '☀ 浅色';
  }
  const fromUrl = new URLSearchParams(location.search).get('theme');
  if (fromUrl === 'dark' || fromUrl === 'light') localStorage.setItem('regexlab.theme', fromUrl);
  const saved = localStorage.getItem('regexlab.theme');
  if (saved === 'dark' || saved === 'light') document.documentElement.setAttribute('data-theme', saved);
  paintThemeBtn();
  mq.addEventListener('change', paintThemeBtn);

  themeBtn.addEventListener('click', function () {
    const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('regexlab.theme', next);
    paintThemeBtn();
    if (state.nfa) renderStep(state.idx); // 重画一遍让 SVG 用上新变量
  });

  // ---------------------------------------------------------------- AST 渲染
  const NODE_NAME = {
    cat: 'cat 连接', alt: 'alt 选择', star: 'star 闭包 *', plus: 'plus 1+',
    opt: 'opt 可选 ?', empty: 'empty ε',
  };

  function renderAstFixed(node) {
    const box = $('ast');
    let count = 0;

    function label(n) {
      if (n.t === 'char') return 'char ' + JSON.stringify(n.c);
      if (n.t === 'class') return 'class ' + RX.classDesc(n);
      if (n.t === 'any') return 'any .';
      if (n.t === 'anchor') return 'anchor ' + (n.kind === 'start' ? '^ 串首' : '$ 串尾');
      if (n.t === 'empty') return 'empty ε';
      return (NODE_NAME[n.t] || n.t);
    }

    function kids(n) {
      return n.items || (n.node ? [n.node] : []);
    }

    const lines = [];
    function walk(n, prefix, isLast, isRoot) {
      count++;
      const branch = isRoot ? '' : (isLast ? '└─ ' : '├─ ');
      lines.push('<span class="k">' + prefix + branch + RX.esc(label(n)) + '</span>');
      const cs = kids(n);
      const nextPrefix = prefix + (isRoot ? '' : (isLast ? '   ' : '│  '));
      cs.forEach(function (k, i) { walk(k, nextPrefix, i === cs.length - 1, false); });
    }
    walk(node, '', true, true);

    box.innerHTML = lines.join(String.fromCharCode(10));
    $('astTag').textContent = count + ' 个节点';
  }

  // ---------------------------------------------------------------- 步进器
  const TAPE_LIMIT = 96;

  function tapeWindow() {
    const len = state.input.length;
    if (len <= TAPE_LIMIT) return { from: 0, to: len };
    const pos = state.sim.trace[state.idx] ? state.sim.trace[state.idx].pos : 0;
    const half = Math.floor(TAPE_LIMIT / 2);
    let from = Math.max(0, pos - half);
    let to = Math.min(len, from + TAPE_LIMIT);
    from = Math.max(0, to - TAPE_LIMIT);
    return { from: from, to: to };
  }

  function renderTape() {
    const trace = state.sim.trace;
    const step = trace[state.idx] || trace[trace.length - 1];
    const pos = step.pos;
    const win = tapeWindow();
    const tape = $('tape');
    const frag = document.createDocumentFragment();
    if (win.from > 0) {
      const s = document.createElement('span');
      s.className = 'cell';
      s.textContent = '…';
      frag.appendChild(s);
    }
    for (let i = win.from; i < win.to; i++) {
      const cell = document.createElement('span');
      cell.className = 'cell' + (i < pos ? ' seen' : '') + (i === pos ? ' head' : '');
      cell.textContent = state.input[i] === ' ' ? '␠' : state.input[i] === '\n' ? '⏎' : state.input[i];
      frag.appendChild(cell);
    }
    if (win.to < state.input.length) {
      const s = document.createElement('span');
      s.className = 'cell';
      s.textContent = '…';
      frag.appendChild(s);
    }
    const tail = document.createElement('span');
    tail.className = 'cell' + (pos >= state.input.length ? ' head' : '');
    tail.textContent = '␄';
    frag.appendChild(tail);
    tape.innerHTML = '';
    tape.appendChild(frag);
  }

  function renderStep(idx) {
    state.idx = Math.max(0, Math.min(idx, state.sim.trace.length - 1));
    const step = state.sim.trace[state.idx];
    $('scrub').value = state.idx;
    renderTape();
    RX.renderNfa($('nfa'), state.nfa, step.set, step.used);
    const chips = step.set.map(function (s) {
      const acc = s === state.nfa.accept;
      return '<span class="' + (acc ? 'acc' : '') + '">' + s + (acc ? '*' : '') + '</span>';
    });
    $('states').innerHTML = chips.length ? chips.join('') : '<span style="border-color:var(--danger)">空集 · 已停机</span>';
    $('stepTag').textContent = '第 ' + state.idx + ' / ' + (state.sim.trace.length - 1) + ' 步 · 位置 ' + step.pos;
    $('stepNote').textContent = step.used.length
      ? '这一步消耗了 ' + step.used.length + ' 条转移边（并发，全部同时推进）'
      : '起始闭包：只走 ε，不吃字符';
  }

  function renderVerdict() {
    const box = $('verdict');
    const bits = [];
    bits.push(state.sim.ok
      ? '<span class="badge ok">命中 · 位置 ' + state.sim.matchedAt + '</span>'
      : '<span class="badge no">未命中</span>');
    bits.push('<span class="badge">NFA ' + state.sim.steps + ' 步</span>');
    if (state.nfa) bits.push('<span class="badge">' + state.nfa.states.length + ' 状态</span>');
    box.innerHTML = bits.join('');
  }

  // ---------------------------------------------------------------- DFA 面板
  function renderDfa() {
    const wrap = $('dfaWrap');
    if (!state.dfa) {
      wrap.innerHTML = '<p class="note">' + RX.esc(state.dfaReason || '未构造') + '</p>';
      $('dfaTag').textContent = '跳过';
      return;
    }
    const d = state.dfa;
    const rows = [];
    rows.push('<thead><tr><th>DFA 状态</th><th>NFA 集合</th>' +
      d.alpha.map(function (c) { return '<th class="mono">' + RX.esc(c === ' ' ? '␠' : c) + '</th>'; }).join('') +
      '</tr></thead>');
    rows.push('<tbody>');
    d.sets.forEach(function (set, i) {
      const acc = d.accept.indexOf(i) >= 0;
      rows.push('<tr>' +
        '<td class="mono">D' + i + (i === d.start ? ' <span class="v">start</span>' : '') + (acc ? ' <span style="color:var(--accent)">*</span>' : '') + '</td>' +
        '<td class="mono" style="color:var(--muted)">{' + set.join(',') + '}</td>' +
        d.trans[i].map(function (t) {
          return '<td class="mono">' + (t < 0 ? '—' : 'D' + t) + '</td>';
        }).join('') + '</tr>');
    });
    rows.push('</tbody>');
    wrap.innerHTML = '<table>' + rows.join('') + '</table>' +
      '<p class="note">子集构造：把 NFA 的活跃状态集合当成 DFA 的一个状态，于是每个字符只需查一次表，不再回退。' +
      (d.truncated ? ' <span style="color:var(--amber)">状态数超上限，已截断。</span>' : '') +
      (state.dfaRun ? ' 本串在 DFA 上走了 ' + state.dfaRun.steps + ' 步。' : '') + '</p>';
    $('dfaTag').textContent = d.sets.length + ' 个状态';
  }

  // ---------------------------------------------------------------- 引擎对比
  function renderBars(rows) {
    const box = $('bars');
    const max = Math.max.apply(null, rows.map(function (r) { return r.steps || 1; }));
    const scale = function (v) {
      if (!v) return 0;
      return Math.max(2, Math.log10(v + 1) / Math.log10(max + 1) * 100);
    };
    box.innerHTML = rows.map(function (r) {
      const cls = r.dead ? ' dead' : (r.steps === max && rows.length > 1 ? ' slow' : '');
      return '<div class="bar-row">' +
        '<span>' + RX.esc(r.name) + '</span>' +
        '<span class="bar-track"><span class="bar-fill' + cls + '" style="width:' + scale(r.steps) + '%"></span></span>' +
        '<span class="num">' + (r.dead ? '爆栈' : r.steps) + ' 步 · ' + r.ms.toFixed(2) + 'ms</span>' +
        '</div>';
    }).join('');
  }

  function bench() {
    const rows = [];
    let t0 = performance.now();
    const sim = RX.simulate(state.nfa, state.input, state.mode);
    rows.push({ name: '并行 NFA', steps: sim.steps, ms: performance.now() - t0 });
    state.sim = sim;

    if (state.dfa) {
      t0 = performance.now();
      const r = RX.runDfa(state.dfa, state.input, state.mode);
      state.dfaRun = r;
      rows.push({ name: '子集 DFA', steps: r.steps, ms: performance.now() - t0 });
    }

    t0 = performance.now();
    const bt = RX.btRun(state.prog, state.input, state.mode, BT_CAP);
    state.bt = bt;
    rows.push({ name: '朴素回溯', steps: bt.steps, ms: performance.now() - t0, dead: bt.overflow });

    renderBars(rows);
    return { rows: rows, sim: sim, bt: bt };
  }

  function nativeCheck(pattern, input, mode) {
    try {
      const src = mode === 'full' ? '^(?:' + pattern + ')$' : pattern;
      const re = new RegExp(src);
      return re.test(input);
    } catch (e) {
      return null;
    }
  }

  // ---------------------------------------------------------------- 主流程
  function rebuild() {
    stopPlay();
    state.pattern = $('pattern').value;
    state.input = $('input').value;
    const errBox = $('astNote');

    let ast;
    try {
      ast = RX.parse(state.pattern);
    } catch (e) {
      errBox.className = 'err';
      errBox.textContent = '解析失败：' + e.message;
      $('ast').innerHTML = '';
      $('astTag').textContent = '—';
      $('bars').innerHTML = '<p class="note">修好正则再跑。</p>';
      $('dfaWrap').innerHTML = '<p class="note">—</p>';
      $('verdict').innerHTML = '';
      $('tape').innerHTML = '';
      $('states').innerHTML = '';
      $('nfa').innerHTML = '';
      return;
    }
    errBox.className = 'note';
    errBox.textContent = '';
    state.ast = ast;
    state.nfa = RX.compile(ast);
    state.prog = RX.toProgram(ast);

    state.dfa = null;
    state.dfaReason = '';
    if (RX.hasAnchor(ast)) {
      state.dfaReason = '这条正则带 ^ / $ 锚点：锚点的成立与否取决于字符位置，纯 DFA 无法表达，这里跳过子集构造。去掉锚点即可看到 DFA 表。';
    } else {
      state.dfa = RX.buildDfa(state.nfa, ast, 160, { inject: state.mode === 'search', input: state.input });
    }

    renderAstFixed(ast);
    $('nfaTag').textContent = state.nfa.states.length + ' 状态';

    const b = bench();
    const last = state.sim.trace.length - 1;
    $('scrub').max = String(last);
    renderVerdict();
    renderStep(0);
    renderDfa();

    // 与浏览器内置 RegExp 交叉验证（只做布尔比对，不参与匹配）
    const native = nativeCheck(state.pattern, state.input, state.mode);
    const agree = native === null ? '无法验证' : (native === b.sim.ok ? '一致' : '不一致（差在语义边界，请看脚注）');
    const tips = [];
    if (state.bt && state.bt.overflow) tips.push('回溯器撞上 ' + BT_CAP + ' 步上限，说明这条正则在这个输入上是指数级回溯——页面因此卡不住，直接截断。');
    if (state.input.length > 200) tips.push('输入 ' + state.input.length + ' 字符：NFA 与 DFA 都是线性，回溯器可能指数爆炸，这就是两者最本质的差别。');
    $('benchNote').innerHTML = '与浏览器 RegExp 交叉验证：' + agree + '。' +
      (tips.length ? ' ' + tips.join(' ') : ' 三条柱子的横轴取对数，否则长串下小柱子会看不见。') +
      '<br>「步数」定义：NFA/DFA 数转移边与闭包边，回溯器数递归调用次数——量级可比，绝对值不必较真。';
  }

  // ---------------------------------------------------------------- 播放控制
  function stopPlay() {
    if (state.playing) { clearInterval(state.playing); state.playing = null; }
    $('playBtn').textContent = '播放';
  }

  function play() {
    if (state.playing) { stopPlay(); return; }
    $('playBtn').textContent = '暂停';
    if (state.idx >= state.sim.trace.length - 1) renderStep(0);
    state.playing = setInterval(function () {
      if (state.idx >= state.sim.trace.length - 1) { stopPlay(); return; }
      renderStep(state.idx + 1);
    }, 260);
  }

  // ---------------------------------------------------------------- 事件
  $('pattern').addEventListener('input', debounce(rebuild, 260));
  $('input').addEventListener('input', debounce(rebuild, 260));
  $('scrub').addEventListener('input', function () {
    stopPlay();
    renderStep(parseInt($('scrub').value, 10) || 0);
  });
  $('playBtn').addEventListener('click', play);
  $('nextBtn').addEventListener('click', function () { stopPlay(); renderStep(state.idx + 1); });
  $('prevBtn').addEventListener('click', function () { stopPlay(); renderStep(state.idx - 1); });

  document.querySelectorAll('#modeGroup button').forEach(function (b) {
    b.addEventListener('click', function () {
      document.querySelectorAll('#modeGroup button').forEach(function (x) { x.classList.remove('primary'); });
      b.classList.add('primary');
      state.mode = b.dataset.mode;
      rebuild();
    });
  });

  document.querySelectorAll('[data-sample]').forEach(function (b) {
    b.addEventListener('click', function () {
      $('pattern').value = b.dataset.sample;
      rebuild();
    });
  });

  document.querySelectorAll('[data-gen]').forEach(function (b) {
    b.addEventListener('click', function () {
      const parts = b.dataset.gen.split(':');
      const unit = parts[0], n = parseInt(parts[1], 10);
      $('input').value = unit.repeat(n);
      rebuild();
    });
  });

  function debounce(fn, ms) {
    let t = null;
    return function () {
      clearTimeout(t);
      t = setTimeout(fn, ms);
    };
  }

  // 深链：/ ?p=<正则>&s=<输入>&mode=search|full 方便分享一条实验
  const qp = new URLSearchParams(location.search);
  if (qp.get('p')) $('pattern').value = qp.get('p');
  if (qp.get('s') !== null) $('input').value = qp.get('s');
  if (qp.get('mode') === 'full') {
    state.mode = 'full';
    document.querySelectorAll('#modeGroup button').forEach(function (b) {
      b.classList.toggle('primary', b.dataset.mode === 'full');
    });
  }

  rebuild();
})();
