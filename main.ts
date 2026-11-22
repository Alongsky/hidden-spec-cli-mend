import fs from 'node:fs';
import path from 'node:path';

// ---------- text helpers ----------

// Patch lines (section 3): split at \n, remove one trailing \r each,
// drop the empty piece after a final \n.
function splitPatchLines(text) {
  const parts = text.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function rstrip(s) {
  return s.replace(/[ \t]+$/, '');
}

function stripST(s) {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function leadingST(s) {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

// ---------- file model (section 3) ----------

function parseFile(text) {
  const idx = text.indexOf('\n');
  const brk = idx > 0 && text[idx - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], brk, eol: false };
  const parts = text.split(brk);
  let eol = false;
  if (parts.length > 0 && parts[parts.length - 1] === '') {
    parts.pop();
    eol = true;
  }
  return { lines: parts, brk, eol };
}

function serializeFile(f) {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.brk) + (f.eol ? f.brk : '');
}

function isSafePath(p) {
  if (p === '') return false;
  if (p.startsWith('/')) return false;
  if (p.includes('\\')) return false;
  const segs = p.split('/');
  for (const s of segs) {
    if (s === '' || s === '.' || s === '..') return false;
  }
  return true;
}

// ---------- line matching (section 5) ----------

function lineEqAtTier(a, b, tier) {
  if (tier === 0) return a === b;
  if (tier === 1) return rstrip(a) === rstrip(b);
  return stripST(a) === stripST(b);
}

// First tier (0, 1, 2) at which oldLines occurs at least once; all positions.
function findOccurrences(fileLines, oldLines, strict) {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions = [];
    const n = oldLines.length;
    for (let i = 0; i + n <= fileLines.length; i++) {
      let ok = true;
      for (let k = 0; k < n; k++) {
        if (!lineEqAtTier(fileLines[i + k], oldLines[k], tier)) { ok = false; break; }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

// First occurrence at position >= minPos, at the first tier with one.
// When eofOnly, only occurrences ending at the file's last line count.
function findOccurrencesAtOrAfter(fileLines, oldLines, minPos, strict, eofOnly) {
  const tiers = strict ? [0] : [0, 1, 2];
  const n = oldLines.length;
  for (const tier of tiers) {
    for (let i = minPos; i + n <= fileLines.length; i++) {
      if (eofOnly && i + n !== fileLines.length) continue;
      let ok = true;
      for (let k = 0; k < n; k++) {
        if (!lineEqAtTier(fileLines[i + k], oldLines[k], tier)) { ok = false; break; }
      }
      if (ok) return { tier, pos: i };
    }
  }
  return null;
}

function reindentLine(line, fileFirst, oldFirst) {
  if (line === '' || /^[ \t]+$/.test(line)) return line;
  const F = leadingST(fileFirst);
  const P = leadingST(oldFirst);
  if (line.startsWith(P)) return F + line.slice(P.length);
  return line;
}

// Replace fileLines[at .. at+oldLines.length) with newLines.
// ctx[j] is the index into oldLines for context lines, -1 for new lines.
function applyReplacement(fileLines, at, oldLines, newLines, ctx, tier) {
  const out = [];
  for (let i = 0; i < at; i++) out.push(fileLines[i]);
  for (let j = 0; j < newLines.length; j++) {
    const oi = ctx[j];
    if (oi >= 0) {
      out.push(fileLines[at + oi]);
    } else if (tier === 2) {
      out.push(reindentLine(newLines[j], fileLines[at], oldLines[0]));
    } else {
      out.push(newLines[j]);
    }
  }
  for (let i = at + oldLines.length; i < fileLines.length; i++) out.push(fileLines[i]);
  return out;
}

// Build O, N and the context map from hunk/chunk body lines.
// Also reports whether a \ line follows the last context-or-+ line,
// and whether one follows the last + line.
function analyzeBody(body) {
  const o = [];
  const n = [];
  const ctx = [];
  let lastCtxPlus = -1;
  let lastPlus = -1;
  for (let k = 0; k < body.length; k++) {
    const bl = body[k];
    if (bl === '' || bl[0] === ' ') {
      const text = bl === '' ? '' : bl.slice(1);
      ctx.push(o.length);
      o.push(text);
      n.push(text);
      lastCtxPlus = k;
    } else if (bl[0] === '-') {
      o.push(bl.slice(1));
    } else if (bl[0] === '+') {
      ctx.push(-1);
      n.push(bl.slice(1));
      lastCtxPlus = k;
      lastPlus = k;
    }
  }
  const backslashAfterLast = lastCtxPlus >= 0 && lastCtxPlus + 1 < body.length && body[lastCtxPlus + 1][0] === '\\';
  const backslashAfterLastPlus = lastPlus >= 0 && lastPlus + 1 < body.length && body[lastPlus + 1][0] === '\\';
  return { o, n, ctx, backslashAfterLast, backslashAfterLastPlus };
}

// ---------- CLI (section 1) ----------

function parseArgs(argv) {
  let format = 'auto';
  let check = false;
  let strict = false;
  let seenFormat = false;
  let seenCheck = false;
  let seenStrict = false;
  let noMoreOptions = false;
  const positionals = [];
  for (const arg of argv) {
    if (!noMoreOptions && arg === '--') {
      noMoreOptions = true;
      continue;
    }
    if (!noMoreOptions && arg.startsWith('-') && arg !== '-') {
      if (arg === '--check') {
        if (seenCheck) return { error: true };
        seenCheck = true;
        check = true;
      } else if (arg === '--strict') {
        if (seenStrict) return { error: true };
        seenStrict = true;
        strict = true;
      } else if (arg.startsWith('--format=')) {
        if (seenFormat) return { error: true };
        const v = arg.slice('--format='.length);
        if (v !== 'unified' && v !== 'search-replace' && v !== 'v4a' && v !== 'json' && v !== 'auto') return { error: true };
        seenFormat = true;
        format = v;
      } else {
        return { error: true };
      }
    } else {
      positionals.push(arg);
    }
  }
  if (positionals.length > 1) return { error: true };
  return { error: false, format, check, strict, patch: positionals.length === 1 ? positionals[0] : null };
}

// ---------- format detection (section 4) ----------

function detectFormat(lines) {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') { first = i; break; }
  }
  if (first === -1) return null;
  const firstLine = lines[first];
  if (firstLine.trim() === '*** Begin Patch') return 'v4a';
  const firstNonWS = firstLine.replace(/^\s+/, '');
  if (firstNonWS.startsWith('[') || firstNonWS.startsWith('{')) return 'json';
  for (const l of lines) {
    if (rstrip(l) === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) return 'unified';
  }
  return null;
}

class ParseError extends Error {
  constructor(line) {
    super('parse ' + line);
    this.line = line;
  }
}

// ---------- unified diffs (section 6) ----------

function unifiedPath(s) {
  const cut = s.split('\t')[0];
  let p = cut.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function isDiffGitLine(line) {
  return line === 'diff --git' || line.startsWith('diff --git ');
}

function parseUnified(lines) {
  const sections = [];
  let cur = null;
  let curHunk = null;

  const finishHunk = () => {
    if (!curHunk) return;
    while (curHunk.body.length > 0 && curHunk.body[curHunk.body.length - 1] === '') {
      curHunk.body.pop();
    }
    const a = analyzeBody(curHunk.body);
    curHunk.o = a.o;
    curHunk.n = a.n;
    curHunk.ctx = a.ctx;
    curHunk.backslashAfterLast = a.backslashAfterLast;
    curHunk.backslashAfterLastPlus = a.backslashAfterLastPlus;
    delete curHunk.body;
    curHunk = null;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isDiffGitLine(line)) {
      finishHunk();
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(rstrip(line));
      if (!m) throw new ParseError(i + 1);
      cur = { oldPath: m[1], newPath: m[2], createFlag: false, deleteFlag: false, hasPair: false, inHeader: true, hunks: [] };
      sections.push(cur);
      i++;
      continue;
    }
    if (line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
      finishHunk();
      if (cur && cur.inHeader) {
        cur.oldPath = unifiedPath(line.slice(4));
        cur.newPath = unifiedPath(lines[i + 1].slice(4));
        cur.hasPair = true;
      } else {
        cur = { oldPath: unifiedPath(line.slice(4)), newPath: unifiedPath(lines[i + 1].slice(4)), createFlag: false, deleteFlag: false, hasPair: true, inHeader: true, hunks: [] };
        sections.push(cur);
      }
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (!cur) throw new ParseError(i + 1);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) throw new ParseError(i + 1);
      finishHunk();
      cur.inHeader = false;
      curHunk = { a: parseInt(m[1], 10), body: [] };
      cur.hunks.push(curHunk);
      i++;
      continue;
    }
    if (curHunk) {
      if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+' || line[0] === '\\') {
        curHunk.body.push(line);
        i++;
        continue;
      }
      finishHunk();
      continue;
    }
    if (cur) {
      if (line.startsWith('--- ')) {
        if (cur.inHeader) throw new ParseError(i + 2);
        i++;
        continue;
      }
      if (line.startsWith('rename from ')) {
        if (!cur.hasPair) cur.oldPath = line.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        if (!cur.hasPair) cur.newPath = line.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (line === 'new file mode' || line.startsWith('new file mode ')) {
        cur.createFlag = true;
        i++;
        continue;
      }
      if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) {
        cur.deleteFlag = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  finishHunk();
  if (sections.length === 0) throw new ParseError(1);
  return sections;
}

// Apply a section's hunks to file text. Returns {text} or {error:{code,path}}.
function applyHunks(text, hunks, strict, filePath) {
  let f = parseFile(text);
  let d = 0;
  for (const h of hunks) {
    const O = h.o;
    const N = h.n;
    if (O.length === 0 && N.length === 0) continue;
    if (O.length === 0) {
      let idx = h.a + d;
      if (idx < 0) idx = 0;
      if (idx > f.lines.length) idx = f.lines.length;
      const atEnd = idx === f.lines.length;
      const newLines = f.lines.slice(0, idx).concat(N, f.lines.slice(idx));
      let eol = f.eol;
      if (atEnd && N.length > 0) eol = !h.backslashAfterLast;
      f = { lines: newLines, brk: f.brk, eol };
      d += N.length;
      continue;
    }
    const found = findOccurrences(f.lines, O, strict);
    if (!found) return { error: { code: 'no-match', path: filePath } };
    const target = h.a - 1 + d;
    let best = found.positions[0];
    let bestDist = Math.abs(best - target);
    for (const p of found.positions) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) { bestDist = dist; best = p; }
    }
    const at = best;
    const runsToEnd = at + O.length === f.lines.length;
    const newLines = applyReplacement(f.lines, at, O, N, h.ctx, found.tier);
    let eol = f.eol;
    if (runsToEnd) eol = !h.backslashAfterLast;
    f = { lines: newLines, brk: f.brk, eol };
    d += N.length - O.length;
  }
  return { text: serializeFile(f) };
}

function applyUnifiedSection(sec, tree, strict, moves) {
  const oldPath = sec.oldPath;
  const newPath = sec.newPath;
  const isCreate = oldPath === '/dev/null' || sec.createFlag;
  const isDelete = newPath === '/dev/null' || sec.deleteFlag;
  const isMove = !isCreate && !isDelete && oldPath !== newPath;

  if (isCreate) {
    if (!isSafePath(newPath)) return { code: 'unsafe', path: newPath };
    if (tree.has(newPath)) return { code: 'exists', path: newPath };
    const plusLines = [];
    let lastPlusHunk = null;
    for (const h of sec.hunks) {
      let hasPlus = false;
      for (let j = 0; j < h.n.length; j++) {
        if (h.ctx[j] === -1) { plusLines.push(h.n[j]); hasPlus = true; }
      }
      if (hasPlus) lastPlusHunk = h;
    }
    const noBreak = lastPlusHunk !== null && lastPlusHunk.backslashAfterLastPlus;
    const f = { lines: plusLines, brk: '\n', eol: plusLines.length > 0 && !noBreak };
    tree.set(newPath, serializeFile(f));
    return null;
  }
  if (isDelete) {
    if (!isSafePath(oldPath)) return { code: 'unsafe', path: oldPath };
    if (!tree.has(oldPath)) return { code: 'missing', path: oldPath };
    tree.delete(oldPath);
    return null;
  }
  if (isMove) {
    if (!isSafePath(oldPath)) return { code: 'unsafe', path: oldPath };
    if (!isSafePath(newPath)) return { code: 'unsafe', path: newPath };
    if (!tree.has(oldPath)) return { code: 'missing', path: oldPath };
    if (tree.has(newPath)) return { code: 'exists', path: newPath };
    const result = applyHunks(tree.get(oldPath), sec.hunks, strict, oldPath);
    if (result.error) return result.error;
    tree.delete(oldPath);
    tree.set(newPath, result.text);
    moves.push([oldPath, newPath]);
    return null;
  }
  if (!isSafePath(oldPath)) return { code: 'unsafe', path: oldPath };
  if (!tree.has(oldPath)) return { code: 'missing', path: oldPath };
  const result = applyHunks(tree.get(oldPath), sec.hunks, strict, oldPath);
  if (result.error) return result.error;
  tree.set(oldPath, result.text);
  return null;
}

// ---------- SEARCH/REPLACE blocks (section 7) ----------

function parseSearchReplace(lines) {
  const blocks = [];
  let prevReplaceEnd = -1;
  let i = 0;
  while (i < lines.length) {
    if (rstrip(lines[i]) === '<<<<<<< SEARCH') {
      const searchLine = i + 1;
      let p = null;
      for (let j = i - 1; j > prevReplaceEnd; j--) {
        const l = lines[j];
        if (l.trim() === '') continue;
        const stripped = l.trim();
        if (stripped.startsWith('```')) continue;
        p = stripped;
        break;
      }
      if (p === null) {
        if (blocks.length > 0) {
          p = blocks[blocks.length - 1].path;
        } else {
          throw new ParseError(searchLine);
        }
      }
      let eqIdx = -1;
      for (let j = i + 1; j < lines.length; j++) {
        if (rstrip(lines[j]) === '=======') { eqIdx = j; break; }
      }
      if (eqIdx === -1) throw new ParseError(searchLine);
      let repIdx = -1;
      for (let j = eqIdx + 1; j < lines.length; j++) {
        if (rstrip(lines[j]) === '>>>>>>> REPLACE') { repIdx = j; break; }
      }
      if (repIdx === -1) throw new ParseError(searchLine);
      const oldLines = lines.slice(i + 1, eqIdx);
      const newLines = lines.slice(eqIdx + 1, repIdx);
      blocks.push({ path: p, oldLines, newLines });
      prevReplaceEnd = repIdx;
      i = repIdx + 1;
      continue;
    }
    i++;
  }
  if (blocks.length === 0) throw new ParseError(1);
  return blocks;
}

function applySearchReplaceBlock(block, tree, strict) {
  const p = block.path;
  if (!isSafePath(p)) return { code: 'unsafe', path: p };
  if (block.oldLines.length === 0) {
    if (tree.has(p)) return { code: 'exists', path: p };
    const f = { lines: block.newLines.slice(), brk: '\n', eol: block.newLines.length > 0 };
    tree.set(p, serializeFile(f));
    return null;
  }
  if (!tree.has(p)) return { code: 'missing', path: p };
  const f = parseFile(tree.get(p));
  const found = findOccurrences(f.lines, block.oldLines, strict);
  if (!found) return { code: 'no-match', path: p };
  if (found.positions.length !== 1) return { code: 'ambiguous', path: p };
  const at = found.positions[0];
  const ctx = block.newLines.map(() => -1);
  const newLines = applyReplacement(f.lines, at, block.oldLines, block.newLines, ctx, found.tier);
  tree.set(p, serializeFile({ lines: newLines, brk: f.brk, eol: f.eol }));
  return null;
}

// ---------- V4A patches (section 8) ----------

function parseV4A(lines) {
  let firstIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') { firstIdx = i; break; }
  }
  if (firstIdx === -1) throw new ParseError(1);
  if (lines[firstIdx].trim() !== '*** Begin Patch') throw new ParseError(firstIdx + 1);
  let lastIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() !== '') { lastIdx = i; break; }
  }
  if (lines[lastIdx].trim() !== '*** End Patch') throw new ParseError(lines.length + 1);

  const isSectionStart = (l) => l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const sections = [];
  let i = firstIdx + 1;
  while (i < lastIdx) {
    const line = lines[i];
    if (line.trim() === '') { i++; continue; }
    if (line.startsWith('*** Add File: ')) {
      const sec = { type: 'add', path: line.slice('*** Add File: '.length).trim(), lines: [] };
      sections.push(sec);
      i++;
      const raw = [];
      while (i < lastIdx) {
        const l2 = lines[i];
        if (isSectionStart(l2) || l2.trim() === '*** End Patch') break;
        raw.push({ text: l2, num: i + 1 });
        i++;
      }
      while (raw.length > 0 && raw[raw.length - 1].text.trim() === '') raw.pop();
      for (const { text, num } of raw) {
        if (text === '') { sec.lines.push(''); continue; }
        if (text[0] === '+') { sec.lines.push(text.slice(1)); continue; }
        throw new ParseError(num);
      }
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const sec = { type: 'delete', path: line.slice('*** Delete File: '.length).trim() };
      sections.push(sec);
      i++;
      const raw = [];
      while (i < lastIdx) {
        const l2 = lines[i];
        if (isSectionStart(l2) || l2.trim() === '*** End Patch') break;
        raw.push({ text: l2, num: i + 1 });
        i++;
      }
      while (raw.length > 0 && raw[raw.length - 1].text.trim() === '') raw.pop();
      if (raw.length > 0) throw new ParseError(raw[0].num);
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const headerLine = i + 1;
      const sec = { type: 'update', path: line.slice('*** Update File: '.length).trim(), moveTo: null, chunks: [] };
      sections.push(sec);
      i++;
      const raw = [];
      while (i < lastIdx) {
        const l2 = lines[i];
        if (isSectionStart(l2) || l2.trim() === '*** End Patch') break;
        raw.push({ text: l2, num: i + 1 });
        i++;
      }
      while (raw.length > 0 && raw[raw.length - 1].text.trim() === '') raw.pop();
      let idx = 0;
      if (idx < raw.length && raw[idx].text.startsWith('*** Move to: ')) {
        sec.moveTo = raw[idx].text.slice('*** Move to: '.length).trim();
        idx++;
      }
      let curChunk = null;
      let afterEOF = false;
      while (idx < raw.length) {
        const { text, num } = raw[idx];
        if (text.startsWith('@@')) {
          const anchor = text.slice(2).trim();
          curChunk = { anchor, body: [], eof: false };
          sec.chunks.push(curChunk);
          afterEOF = false;
          idx++;
          continue;
        }
        if (text === '*** End of File') {
          if (!curChunk) throw new ParseError(num);
          curChunk.eof = true;
          afterEOF = true;
          idx++;
          continue;
        }
        if (text === '' || text[0] === ' ' || text[0] === '-' || text[0] === '+') {
          if (afterEOF) throw new ParseError(num);
          if (!curChunk) {
            curChunk = { anchor: '', body: [], eof: false };
            sec.chunks.push(curChunk);
          }
          curChunk.body.push(text);
          idx++;
          continue;
        }
        throw new ParseError(num);
      }
      for (const ch of sec.chunks) {
        const a = analyzeBody(ch.body);
        ch.o = a.o;
        ch.n = a.n;
        ch.ctx = a.ctx;
        delete ch.body;
      }
      if (sec.chunks.length === 0 && sec.moveTo === null) {
        throw new ParseError(headerLine);
      }
      continue;
    }
    throw new ParseError(i + 1);
  }
  if (sections.length === 0) throw new ParseError(1);
  return sections;
}

function applyV4ASection(sec, tree, strict, moves) {
  if (sec.type === 'add') {
    if (!isSafePath(sec.path)) return { code: 'unsafe', path: sec.path };
    if (tree.has(sec.path)) return { code: 'exists', path: sec.path };
    const f = { lines: sec.lines.slice(), brk: '\n', eol: sec.lines.length > 0 };
    tree.set(sec.path, serializeFile(f));
    return null;
  }
  if (sec.type === 'delete') {
    if (!isSafePath(sec.path)) return { code: 'unsafe', path: sec.path };
    if (!tree.has(sec.path)) return { code: 'missing', path: sec.path };
    tree.delete(sec.path);
    return null;
  }
  if (!isSafePath(sec.path)) return { code: 'unsafe', path: sec.path };
  if (sec.moveTo !== null && !isSafePath(sec.moveTo)) return { code: 'unsafe', path: sec.moveTo };
  if (!tree.has(sec.path)) return { code: 'missing', path: sec.path };
  if (sec.moveTo !== null && tree.has(sec.moveTo)) return { code: 'exists', path: sec.moveTo };
  let f = parseFile(tree.get(sec.path));
  let cursor = 0;
  for (const ch of sec.chunks) {
    if (ch.anchor !== '') {
      const found = findOccurrencesAtOrAfter(f.lines, [ch.anchor], cursor, strict, false);
      if (!found) return { code: 'no-match', path: sec.path };
      cursor = found.pos + 1;
    }
    if (ch.o.length === 0) {
      const idx = ch.eof ? f.lines.length : cursor;
      const newLines = f.lines.slice(0, idx).concat(ch.n, f.lines.slice(idx));
      f = { lines: newLines, brk: f.brk, eol: f.eol };
      cursor = idx + ch.n.length;
      continue;
    }
    const found = findOccurrencesAtOrAfter(f.lines, ch.o, cursor, strict, ch.eof);
    if (!found) return { code: 'no-match', path: sec.path };
    const at = found.pos;
    const newLines = applyReplacement(f.lines, at, ch.o, ch.n, ch.ctx, found.tier);
    f = { lines: newLines, brk: f.brk, eol: f.eol };
    cursor = at + ch.n.length;
  }
  const text = serializeFile(f);
  if (sec.moveTo !== null) {
    tree.delete(sec.path);
    tree.set(sec.moveTo, text);
    moves.push([sec.path, sec.moveTo]);
  } else {
    tree.set(sec.path, text);
  }
  return null;
}

// ---------- JSON edits (section 9) ----------

function validateEditObject(obj, errLine) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) throw new ParseError(errLine);
  if (typeof obj.path !== 'string') throw new ParseError(errLine);
  if (typeof obj.command !== 'string') throw new ParseError(errLine);
  if (obj.command === 'create') {
    if (typeof obj.file_text !== 'string') throw new ParseError(errLine);
    return { type: 'create', path: obj.path, file_text: obj.file_text };
  }
  if (obj.command === 'str_replace') {
    if (typeof obj.old_str !== 'string' || obj.old_str === '') throw new ParseError(errLine);
    let newStr = '';
    if (obj.new_str !== undefined) {
      if (typeof obj.new_str !== 'string') throw new ParseError(errLine);
      newStr = obj.new_str;
    }
    return { type: 'str_replace', path: obj.path, old_str: obj.old_str, new_str: newStr };
  }
  if (obj.command === 'insert') {
    if (!Number.isInteger(obj.insert_line)) throw new ParseError(errLine);
    if (typeof obj.new_str !== 'string') throw new ParseError(errLine);
    return { type: 'insert', path: obj.path, insert_line: obj.insert_line, new_str: obj.new_str };
  }
  throw new ParseError(errLine);
}

function parseJSON(lines, patchText) {
  let firstIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') { firstIdx = i; break; }
  }
  if (firstIdx === -1) throw new ParseError(1);
  const firstNonWS = lines[firstIdx].replace(/^\s+/, '');
  if (firstNonWS.startsWith('[')) {
    let arr;
    try {
      arr = JSON.parse(patchText);
    } catch {
      throw new ParseError(firstIdx + 1);
    }
    if (!Array.isArray(arr)) throw new ParseError(firstIdx + 1);
    if (arr.length === 0) throw new ParseError(1);
    const edits = [];
    for (const el of arr) {
      edits.push(validateEditObject(el, firstIdx + 1));
    }
    return edits;
  }
  const edits = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '') continue;
    let obj;
    try {
      obj = JSON.parse(l);
    } catch {
      throw new ParseError(i + 1);
    }
    edits.push(validateEditObject(obj, i + 1));
  }
  if (edits.length === 0) throw new ParseError(1);
  return edits;
}

function applyJSONEdit(edit, tree) {
  const p = edit.path;
  if (!isSafePath(p)) return { code: 'unsafe', path: p };
  if (edit.type === 'create') {
    if (tree.has(p)) return { code: 'exists', path: p };
    tree.set(p, edit.file_text);
    return null;
  }
  if (edit.type === 'str_replace') {
    if (!tree.has(p)) return { code: 'missing', path: p };
    const text = tree.get(p);
    const idx = text.indexOf('\n');
    const isCRLF = idx > 0 && text[idx - 1] === '\r';
    let hay = text;
    let oldS = edit.old_str;
    let newS = edit.new_str;
    if (isCRLF) {
      hay = text.replace(/\r\n/g, '\n');
      oldS = oldS.replace(/\r\n/g, '\n');
      newS = newS.replace(/\r\n/g, '\n');
    }
    let count = 0;
    let firstPos = -1;
    let pos = 0;
    for (;;) {
      const found = hay.indexOf(oldS, pos);
      if (found === -1) break;
      if (count === 0) firstPos = found;
      count++;
      pos = found + 1;
    }
    if (count === 0) return { code: 'no-match', path: p };
    if (count > 1) return { code: 'ambiguous', path: p };
    let result = hay.slice(0, firstPos) + newS + hay.slice(firstPos + oldS.length);
    if (isCRLF) result = result.replace(/\n/g, '\r\n');
    tree.set(p, result);
    return null;
  }
  if (!tree.has(p)) return { code: 'missing', path: p };
  const f = parseFile(tree.get(p));
  if (edit.insert_line < 0 || edit.insert_line > f.lines.length) return { code: 'no-match', path: p };
  const insLines = splitPatchLines(edit.new_str);
  const newLines = f.lines.slice(0, edit.insert_line).concat(insLines, f.lines.slice(edit.insert_line));
  tree.set(p, serializeFile({ lines: newLines, brk: f.brk, eol: f.eol }));
  return null;
}

// ---------- tree I/O and output (sections 2, 3, 10) ----------

function readTree(dir) {
  const out = new Map();
  const walk = (d, prefix) => {
    let names;
    try {
      names = fs.readdirSync(d);
    } catch {
      return;
    }
    for (const name of names) {
      const p = path.join(d, name);
      const rel = prefix ? prefix + '/' + name : name;
      let st;
      try {
        st = fs.statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(p, rel);
      } else if (st.isFile()) {
        try {
          out.set(rel, fs.readFileSync(p, 'utf8'));
        } catch {
          // skip unreadable entries
        }
      }
    }
  };
  walk(dir, '');
  return out;
}

function writeTreeChanges(initial, final) {
  for (const [p, text] of final) {
    if (!initial.has(p) || initial.get(p) !== text) {
      const full = path.join(process.cwd(), ...p.split('/'));
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, text);
    }
  }
  for (const p of initial.keys()) {
    if (!final.has(p)) {
      const full = path.join(process.cwd(), ...p.split('/'));
      try { fs.unlinkSync(full); } catch {}
    }
  }
}

function computeOutput(initial, final, moves) {
  const entries = [];
  const dSet = new Set();
  const aSet = new Set();
  for (const [p, text] of initial) {
    if (!final.has(p)) {
      dSet.add(p);
    } else if (final.get(p) !== text) {
      entries.push({ key: p, line: 'M ' + p });
    }
  }
  for (const p of final.keys()) {
    if (!initial.has(p)) aSet.add(p);
  }
  const usedD = new Set();
  const usedA = new Set();
  for (const [oldP, newP] of moves) {
    if (dSet.has(oldP) && aSet.has(newP) && !usedD.has(oldP) && !usedA.has(newP)) {
      entries.push({ key: newP, line: 'R ' + oldP + ' -> ' + newP });
      usedD.add(oldP);
      usedA.add(newP);
    }
  }
  for (const p of dSet) {
    if (!usedD.has(p)) entries.push({ key: p, line: 'D ' + p });
  }
  for (const p of aSet) {
    if (!usedA.has(p)) entries.push({ key: p, line: 'A ' + p });
  }
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
  return entries.map((e) => e.line);
}

// ---------- main ----------

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    process.stdout.write('error: usage\n');
    process.exit(2);
  }
  let patchText;
  if (args.patch === null || args.patch === '-') {
    try {
      patchText = fs.readFileSync(0, 'utf8');
    } catch {
      process.stdout.write('error: no-patch\n');
      process.exit(2);
    }
  } else {
    try {
      patchText = fs.readFileSync(args.patch, 'utf8');
    } catch {
      process.stdout.write('error: no-patch\n');
      process.exit(2);
    }
  }
  const lines = splitPatchLines(patchText);
  let format = args.format;
  if (format === 'auto') {
    const detected = detectFormat(lines);
    if (!detected) {
      process.stdout.write('error: format\n');
      process.exit(2);
    }
    format = detected;
  }
  let edits;
  try {
    if (format === 'unified') edits = parseUnified(lines).map((s) => ({ kind: 'unified', section: s }));
    else if (format === 'search-replace') edits = parseSearchReplace(lines).map((b) => ({ kind: 'search-replace', block: b }));
    else if (format === 'v4a') edits = parseV4A(lines).map((s) => ({ kind: 'v4a', section: s }));
    else edits = parseJSON(lines, patchText).map((e) => ({ kind: 'json', edit: e }));
  } catch (err) {
    if (err instanceof ParseError) {
      process.stdout.write('error: parse ' + err.line + '\n');
      process.exit(2);
    }
    throw err;
  }
  const initial = readTree(process.cwd());
  const tree = new Map(initial);
  const moves = [];
  const failures = [];
  for (const ed of edits) {
    const trial = new Map(tree);
    let result = null;
    if (ed.kind === 'unified') result = applyUnifiedSection(ed.section, trial, args.strict, moves);
    else if (ed.kind === 'search-replace') result = applySearchReplaceBlock(ed.block, trial, args.strict);
    else if (ed.kind === 'v4a') result = applyV4ASection(ed.section, trial, args.strict, moves);
    else result = applyJSONEdit(ed.edit, trial);
    if (result) {
      failures.push(result);
    } else {
      tree.clear();
      for (const [k, v] of trial) tree.set(k, v);
    }
  }
  if (failures.length > 0) {
    const outLines = failures.map((f) => 'error: ' + f.code + ' ' + f.path);
    outLines.push('failed: ' + failures.length + ' of ' + edits.length + ' edits');
    process.stdout.write(outLines.join('\n') + '\n');
    process.exit(1);
  }
  const changeLines = computeOutput(initial, tree, moves);
  const n = changeLines.length;
  if (!args.check) {
    writeTreeChanges(initial, tree);
  }
  const okLine = n === 1 ? 'ok: 1 file' : 'ok: ' + n + ' files';
  process.stdout.write(changeLines.concat([okLine]).join('\n') + '\n');
  process.exit(0);
}

if (process.env.MAKEFUN_ENV_URL) {
  const { runTrial } = await import('./runner.ts');
  await runTrial(process.env.MAKEFUN_ENV_URL);
} else {
  main();
}
