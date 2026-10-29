# regexlab — a regex engine dissected

> A regular expression turned into a syntax tree, compiled to a visual ε-NFA, then matched by three hand-written engines so you can compare steps and time side by side.

English | [中文](README.md)

## What it is

The parser is hand-written recursive descent and covers groups, character classes, anchors, escapes and `{n,m}` counts; compilation is Thompson construction with a patch list for the dangling jumps. The state diagram is hand-drawn SVG — quadratic Bézier edges, labels pushed along the normal so they clear the circles, active state sets highlighted as the input advances. Matching has three implementations: parallel NFA simulation (epsilon closure, with the start closure re-injected at every position to get substring semantics), a subset-constructed DFA (states are NFA state sets, one table lookup per character), and a recursive backtracker that deliberately omits memoisation (150k step cap, so exponential blow-up happens on screen instead of hanging the tab). You can step or play through the input and watch the active set shrink and grow. Everything runs in the browser: `RegExp` is never used for matching, only to cross-check 2080 randomised cases, which all agree.

## Features

- Recursive-descent parser for groups, classes, anchors, escapes and `{n,m}`, with a printable AST
- Thompson construction into an ε-NFA, drawn as hand-made SVG with live state and edge highlighting
- Parallel NFA simulation: epsilon closure plus a re-injected start closure each step, replayable per character
- Subset-construction DFA table (injection-aware), with an explicit note when `^`/`$` force it to be skipped
- Naive backtracker: AST → instruction stream → recursive execution, 150k step cap, exponential blow-up on display
- Step and millisecond comparison across the three engines on a log scale, cross-checked against the native RegExp

## Stack

Python 3.12 · Flask 3.1 · 原生 JS / SVG

## Run

```bash
pip install -r requirements.txt
python app.py
# 自检：node tests/engine_test.mjs
```

## About

Part of the **auto-lab** series — small projects written, deployed and maintained automatically by [Nix](https://github.com/Uxnar-ai) on a self-hosted server.

Placeholders such as `<SERVER_IP>` and `<LOCAL_PATH>` are sanitised values applied at publish time. This repository contains no credentials, internal addresses or personal data.

## License

MIT
