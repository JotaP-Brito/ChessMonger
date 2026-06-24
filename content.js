// ChessMonger – full-featured with robust FEN tracking

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

// ---- Global state ----
let autoPlayEnabled = true;
let autoQueueEnabled = true;
let autoPlayTimeout = null;
let selectedMove = null;
let thinkingStart = null;
let userColor = null;
let requestInFlight = false;
let requestTimer = null;
let debounceTimer = null;
let lastMoveCount = 0;
let gameEndDetected = false;
let isPlayingMove = false;
let observer = null;

// ---- Internal board state ----
let boardState = {
  placement: START_FEN.split(' ')[0],
  active: 'w',
  castling: 'KQkq',
  enPassant: '-',
  halfMove: 0,
  fullMove: 1
};

// ---- Find chess API ----
function findChessAPI() {
  const boardEl = document.querySelector('chess-board');
  if (boardEl) {
    if (boardEl.game && typeof boardEl.game.move === 'function') return boardEl.game;
    if (boardEl.chess && typeof boardEl.chess.move === 'function') return boardEl.chess;
    for (const key of Object.keys(boardEl)) {
      const val = boardEl[key];
      if (val && typeof val.move === 'function') return val;
    }
  }
  if (window.chess && typeof window.chess.move === 'function') return window.chess;
  return null;
}

// ---- User colour ----
function detectUserColor() {
  const api = findChessAPI();
  if (api?.myColor) {
    const c = api.myColor();
    if (c === 'white' || c === 'w') return 'w';
    if (c === 'black' || c === 'b') return 'b';
  }
  const board = document.querySelector('chess-board') || document.querySelector('.board');
  if (board?.classList.contains('flipped')) return 'b';
  return 'w';
}

function ensureUserColor() {
  if (!userColor) {
    userColor = detectUserColor();
    console.log('ChessMonger: color =', userColor);
  }
  return userColor;
}

function isUserTurn() {
  return boardState.active === ensureUserColor();
}

// ---- Move count ----
function getMoveCount() {
  const items = document.querySelectorAll('[class*="move-list"] [class*="move"]:not([class*="move-number"])');
  return items.length;
}

// ---- SAN parser ----
function parseSAN(san, fen) {
  if (!san || san === '...') return null;
  san = san.replace(/[+#!?]/g, '');
  if (san === 'O-O' || san === '0-0') return fen.split(' ')[1] === 'w' ? 'e1g1' : 'e8g8';
  if (san === 'O-O-O' || san === '0-0-0') return fen.split(' ')[1] === 'w' ? 'e1c1' : 'e8c8';

  let pieceType = 'P';
  let destStr = '';
  if (san.length >= 2) {
    const last2 = san.substring(san.length-2);
    if (/[a-h][1-8]/.test(last2)) destStr = last2;
  }
  if (!destStr) return null;

  const dest = destStr;
  const destCol = dest.charCodeAt(0)-97;
  const destRow = 8-parseInt(dest[1]);

  if ('KQRBN'.includes(san[0]) || 'kqrbn'.includes(san[0])) {
    pieceType = san[0].toUpperCase();
  }

  const active = fen.split(' ')[1];
  const pieceChar = active === 'w' ? pieceType : pieceType.toLowerCase();

  let disambig = '';
  if (pieceType !== 'P' && san.length > 2) {
    let temp = san.substring(1, san.length-2);
    temp = temp.replace('x','');
    disambig = temp;
  } else if (pieceType === 'P' && san.includes('x')) {
    disambig = san[0];
  }

  let fromFile = null, fromRank = null;
  if (disambig.length === 1) {
    if ('abcdefgh'.includes(disambig)) fromFile = disambig.charCodeAt(0)-97;
    else fromRank = 8-parseInt(disambig);
  } else if (disambig.length === 2) {
    fromFile = disambig.charCodeAt(0)-97;
    fromRank = 8-parseInt(disambig[1]);
  }

  const rows = fen.split(' ')[0].split('/');
  const board = rows.map(row => {
    const arr = [];
    for (const ch of row) {
      if (ch >= '1' && ch <= '8') { for (let i=0; i<parseInt(ch); i++) arr.push(null); }
      else arr.push(ch);
    }
    return arr;
  });

  for (let r=0; r<8; r++) {
    for (let c=0; c<8; c++) {
      if (board[r][c] === pieceChar) {
        if (fromFile !== null && c !== fromFile) continue;
        if (fromRank !== null && r !== fromRank) continue;
        return String.fromCharCode(97+c) + (8-r) + dest;
      }
    }
  }
  return null;
}

// ---- Apply UCI move to board state ----
function applyMove(uci) {
  const from = uci.substring(0,2);
  const to = uci.substring(2,4);
  const promotion = uci.length > 4 ? uci[4] : null;

  let { placement, active, castling, enPassant } = boardState;
  const rows = placement.split('/');
  const board = rows.map(row => {
    const arr = [];
    for (const ch of row) {
      if (ch >= '1' && ch <= '8') { for (let i=0; i<parseInt(ch); i++) arr.push(null); }
      else arr.push(ch);
    }
    return arr;
  });

  const fromCol = from.charCodeAt(0)-97;
  const fromRow = 8-parseInt(from[1]);
  const toCol = to.charCodeAt(0)-97;
  const toRow = 8-parseInt(to[1]);

  const piece = board[fromRow][fromCol];
  const captured = board[toRow][toCol];

  board[fromRow][fromCol] = null;
  board[toRow][toCol] = promotion ? (active==='w'?promotion.toUpperCase():promotion) : piece;

  if (piece === 'K') {
    castling = castling.replace('K','').replace('Q','');
    if (from === 'e1' && to === 'g1') { board[7][5] = 'R'; board[7][7] = null; }
    if (from === 'e1' && to === 'c1') { board[7][3] = 'R'; board[7][0] = null; }
  }
  if (piece === 'k') {
    castling = castling.replace('k','').replace('q','');
    if (from === 'e8' && to === 'g8') { board[0][5] = 'r'; board[0][7] = null; }
    if (from === 'e8' && to === 'c8') { board[0][3] = 'r'; board[0][0] = null; }
  }
  if (piece === 'R' && from === 'a1') castling = castling.replace('Q','');
  if (piece === 'R' && from === 'h1') castling = castling.replace('K','');
  if (piece === 'r' && from === 'a8') castling = castling.replace('q','');
  if (piece === 'r' && from === 'h8') castling = castling.replace('k','');

  if (piece === 'P' && fromCol !== toCol && !captured) board[fromRow][toCol] = null;
  if (piece === 'p' && fromCol !== toCol && !captured) board[fromRow][toCol] = null;

  let newEnPassant = '-';
  if (piece === 'P' && Math.abs(fromRow-toRow) === 2) {
    newEnPassant = String.fromCharCode(97+fromCol) + (8-(fromRow+toRow)/2);
  }
  if (piece === 'p' && Math.abs(fromRow-toRow) === 2) {
    newEnPassant = String.fromCharCode(97+fromCol) + (8-(fromRow+toRow)/2);
  }

  const newPlacement = board.map(row => {
    let str = '';
    let empty = 0;
    for (const cell of row) {
      if (cell === null) empty++;
      else { if (empty>0) { str+=empty; empty=0; } str+=cell; }
    }
    if (empty>0) str+=empty;
    return str;
  }).join('/');

  boardState.placement = newPlacement;
  boardState.active = active === 'w' ? 'b' : 'w';
  boardState.castling = castling || '-';
  boardState.enPassant = newEnPassant;
  if (active === 'b') boardState.fullMove++;
}

// ---- Sync from move list ----
function syncFromMoveList() {
  boardState = {
    placement: START_FEN.split(' ')[0],
    active: 'w',
    castling: 'KQkq',
    enPassant: '-',
    halfMove: 0,
    fullMove: 1
  };
  let fen = START_FEN;
  const items = document.querySelectorAll('[class*="move-list"] [class*="move"]:not([class*="move-number"])');
  for (const item of items) {
    const san = item.textContent?.trim();
    if (!san) continue;
    const uci = parseSAN(san, fen);
    if (uci) {
      applyMove(uci);
      fen = boardState.placement + ' ' + boardState.active + ' ' + boardState.castling + ' ' + boardState.enPassant + ' 0 ' + boardState.fullMove;
    }
  }
}

function getCurrentFEN() {
  return boardState.placement + ' ' + boardState.active + ' ' + boardState.castling + ' ' + boardState.enPassant + ' 0 ' + boardState.fullMove;
}

// ---- Move execution ----
function getSquareCenter(square) {
  const file = square.charCodeAt(0)-97;
  const rank = 8-parseInt(square[1]);
  const boardEl = document.querySelector('chess-board') || document.querySelector('.board');
  if (!boardEl) return null;
  const rect = boardEl.getBoundingClientRect();
  const sq = rect.width/8;
  const flipped = boardEl.classList.contains('flipped');
  let x,y;
  if (flipped) {
    x = rect.left + (7-file)*sq + sq/2;
    y = rect.top + (7-rank)*sq + sq/2;
  } else {
    x = rect.left + file*sq + sq/2;
    y = rect.top + rank*sq + sq/2;
  }
  return {x,y};
}

async function playMove(uci) {
  console.log(`ChessMonger: playing ${uci}`);
  isPlayingMove = true;

  // Update internal state immediately
  applyMove(uci);

  // Try API first
  const api = findChessAPI();
  if (api?.move) {
    try {
      api.move({from: uci.substring(0,2), to: uci.substring(2,4), promotion:'q'});
      console.log('move via API');
    } catch(e) { /* fall through */ }
  }

  // Click fallback
  const fp = getSquareCenter(uci.substring(0,2));
  const tp = getSquareCenter(uci.substring(2,4));
  if (fp && tp) {
    const fromEl = document.elementFromPoint(fp.x, fp.y) || document.body;
    fromEl.dispatchEvent(new MouseEvent('mousedown', {bubbles:true, clientX:fp.x, clientY:fp.y, button:0}));
    await new Promise(r=>setTimeout(r,40));
    const toEl = document.elementFromPoint(tp.x, tp.y) || document.body;
    toEl.dispatchEvent(new MouseEvent('mouseup', {bubbles:true, clientX:tp.x, clientY:tp.y, button:0}));
    console.log('move via click');
  }

  await new Promise(r=>setTimeout(r,400));

  // Update move count AFTER our move registers in the DOM
  lastMoveCount = getMoveCount();
  isPlayingMove = false;
}

// ---- Auto‑play scheduling ----
function scheduleAutoPlay(moveUci, thinkTime) {
  cancelAutoPlay();
  selectedMove = moveUci;
  thinkingStart = Date.now();
  autoPlayTimeout = setTimeout(() => {
    if (selectedMove === moveUci && isUserTurn()) {
      playMove(moveUci);
      selectedMove = null; thinkingStart = null;
    }
  }, thinkTime);
}

function cancelAutoPlay() {
  if (autoPlayTimeout) { clearTimeout(autoPlayTimeout); autoPlayTimeout = null; }
  selectedMove = null; thinkingStart = null;
}

function computeThinkTime(fen) {
  const pieces = fen.split(' ')[0].replace(/[\/0-9]/g,'').length;
  const isEnd = pieces<=12;
  if (Math.random()<0.05) return 100+Math.random()*300;
  if (Math.random()<0.05) return 15000+Math.random()*30000;
  if (Math.random()<0.1)  return 8000+Math.random()*7000;
  let base = isEnd ? 0.5+Math.random()*2.5 : 2+Math.random()*8;
  return Math.round(base*1000);
}

// ---- Game end & auto‑queue ----
function checkGameEnd() {
  const selectors = ['.game-over-modal','[class*="game-over"]','.post-game-modal','[class*="post-game"]','.result-modal','[class*="result-modal"]','.game-review-modal','[class*="game-review"]','.game-end-modal','[class*="game-end"]'];
  for (const s of selectors) {
    const el = document.querySelector(s);
    if (el && el.offsetParent !== null) return true;
  }
  const rt = document.querySelector('.game-result, [class*="result"], .sidebar-result, .game-end-text, [class*="end-text"]');
  if (rt && /\b(1\-0|0\-1|½\-½|won|drew|draw|resign|abandon|timeout|forfeit|stalemate|game over|game ended|won on time|white wins|black wins)\b/.test(rt.textContent?.toLowerCase()||'')) return true;
  const rb = document.querySelector('[class*="game-review-button"], button[class*="review"], a[class*="review"]');
  if (rb) return true;
  return false;
}

function actuallyStartNextGame() {
  const buttons = document.querySelectorAll('button, a, span[role="button"]');
  const texts = ['10 min','10+0','new 10','play again 10'];
  for (const btn of buttons) {
    const t = btn.textContent?.toLowerCase()||'';
    for (const x of texts) if (t.includes(x)) { btn.click(); return; }
  }
  for (const btn of buttons) {
    const t = btn.textContent?.toLowerCase()||'';
    if (t.includes('new game')||t.includes('play again')) { btn.click(); return; }
  }
  window.location.href = 'https://www.chess.com/play/online/new?action=createLiveChallenge&base=600&timeIncrement=0&rated=rated';
}

function tryStartNextGame() {
  if (gameEndDetected) return;
  gameEndDetected = true;
  if (Math.random()<0.20) {
    const mins = 2+Math.random()*6;
    setTimeout(()=>actuallyStartNextGame(), mins*60000);
    return;
  }
  setTimeout(actuallyStartNextGame, 3000+Math.random()*5000);
}

function resetGameEndDetection() {
  if (!gameEndDetected) return;
  if (document.querySelectorAll('.piece').length >= 28) gameEndDetected = false;
}

function startGameEndObserver() {
  const obs = new MutationObserver(() => { resetGameEndDetection(); if (!gameEndDetected && checkGameEnd()) tryStartNextGame(); });
  obs.observe(document.body, {childList:true, subtree:true, attributes:true});
}

// ---- Update loop ----
function scheduleUpdate(delay=400) {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(doUpdate, delay);
}

async function doUpdate() {
  if (isPlayingMove || requestInFlight) return;
  if (autoPlayTimeout && selectedMove) return;

  ensureUserColor();

  const currentMoveCount = getMoveCount();
  if (currentMoveCount !== lastMoveCount) {
    lastMoveCount = currentMoveCount;
    syncFromMoveList();
    console.log('ChessMonger: board synced');
  }

  if (!isUserTurn()) return;

  requestInFlight = true;
  if (requestTimer) clearTimeout(requestTimer);
  requestTimer = setTimeout(()=>{ requestInFlight=false; }, 8000);

  const fen = getCurrentFEN();
  console.log(`ChessMonger: request move (${fen.substring(0,40)}...)`);

  chrome.runtime.sendMessage({type:'getMove', fen, time:0.5, multipv:1}, (response) => {
    requestInFlight = false;
    if (!response?.moves?.length) return;
    const chosen = response.moves[0];
    console.log(`ChessMonger: engine says ${chosen.uci}`);
    if (autoPlayEnabled && isUserTurn()) {
      const think = computeThinkTime(fen);
      console.log(`ChessMonger: scheduling ${chosen.uci} in ${think}ms`);
      scheduleAutoPlay(chosen.uci, think);
    }
  });
}

// ---- Polling ----
function pollForOpponentMove() {
  if (isPlayingMove || requestInFlight) return;
  if (getMoveCount() !== lastMoveCount) {
    doUpdate();
  }
}

// ---- Init ----
userColor = null;
gameEndDetected = false;
lastMoveCount = getMoveCount();
syncFromMoveList();
console.log('ChessMonger: initial FEN', getCurrentFEN());

scheduleUpdate(1500);
startGameEndObserver();

setInterval(pollForOpponentMove, 3000);