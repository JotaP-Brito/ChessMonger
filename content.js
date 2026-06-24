// ChessMonger – self‑tracking FEN, move‑list opponent detection

const pieceMap = {
  'br':'r','bn':'n','bb':'b','bq':'q','bk':'k','bp':'p',
  'wr':'R','wn':'N','wb':'B','wq':'Q','wk':'K','wp':'P'
};

// ---- Global state ----
let autoPlayEnabled = true;
let autoQueueEnabled = true;
let autoPlayTimeout = null;
let selectedMove = null;
let thinkingStart = null;
let localFEN = null;           // ★ our own FEN tracker
let lastMoveCount = 0;         // ★ move‑list count for opponent detection
let userColor = null;
let requestInFlight = false;
let requestTimer = null;
let debounceTimer = null;
let boardObserver = null;
let gameEndDetected = false;
let isPlayingMove = false;
let lastObservedBoardElement = null;

// ---- Starting FEN ----
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

// ---- FEN helpers ----
function applyMoveToFEN(fen, uci) {
  // Apply a UCI move to a FEN string and return the new FEN
  const parts = fen.split(' ');
  const placement = parts[0];
  const active = parts[1];
  const castling = parts[2];
  const enPassant = parts[3];
  const halfmove = parts[4];
  const fullmove = parts[5];

  const from = uci.substring(0,2);
  const to = uci.substring(2,4);
  const promotion = uci.length > 4 ? uci.substring(4,5) : null;

  // Convert placement to 2D array
  const rows = placement.split('/');
  const board = rows.map(row => {
    const arr = [];
    for (const ch of row) {
      if (ch >= '1' && ch <= '8') {
        for (let i=0; i<parseInt(ch); i++) arr.push(null);
      } else {
        arr.push(ch);
      }
    }
    return arr;
  });

  // Get piece from source square
  const fromCol = from.charCodeAt(0)-97;
  const fromRow = 8-parseInt(from[1]);
  const piece = board[fromRow][fromCol];

  // Handle castling
  let newCastling = castling;
  if (piece === 'K') {
    newCastling = newCastling.replace('K','').replace('Q','');
  }
  if (piece === 'k') {
    newCastling = newCastling.replace('k','').replace('q','');
  }
  if (from === 'a1' || to === 'a1') newCastling = newCastling.replace('Q','');
  if (from === 'h1' || to === 'h1') newCastling = newCastling.replace('K','');
  if (from === 'a8' || to === 'a8') newCastling = newCastling.replace('q','');
  if (from === 'h8' || to === 'h8') newCastling = newCastling.replace('k','');
  if (!newCastling) newCastling = '-';

  // Castling move
  if (piece === 'K' && from === 'e1' && to === 'g1') {
    board[7][5] = 'R'; board[7][7] = null;
  }
  if (piece === 'K' && from === 'e1' && to === 'c1') {
    board[7][3] = 'R'; board[7][0] = null;
  }
  if (piece === 'k' && from === 'e8' && to === 'g8') {
    board[0][5] = 'r'; board[0][7] = null;
  }
  if (piece === 'k' && from === 'e8' && to === 'c8') {
    board[0][3] = 'r'; board[0][0] = null;
  }

  // Move piece
  board[fromRow][fromCol] = null;
  const toCol = to.charCodeAt(0)-97;
  const toRow = 8-parseInt(to[1]);
  board[toRow][toCol] = promotion || piece;

  // En passant capture
  let newEnPassant = '-';
  if (piece === 'P' && fromCol !== toCol && board[toRow][toCol] === null) {
    board[fromRow][toCol] = null; // capture en passant
  }
  if (piece === 'p' && fromCol !== toCol && board[toRow][toCol] === null) {
    board[fromRow][toCol] = null;
  }
  // Set new en passant square
  if (piece === 'P' && Math.abs(fromRow-toRow) === 2) {
    newEnPassant = String.fromCharCode(97+fromCol) + (8-(fromRow+toRow)/2);
  }
  if (piece === 'p' && Math.abs(fromRow-toRow) === 2) {
    newEnPassant = String.fromCharCode(97+fromCol) + (8-(fromRow+toRow)/2);
  }

  // Rebuild placement
  const newRows = board.map(row => {
    let str = '';
    let empty = 0;
    for (const cell of row) {
      if (cell === null) empty++;
      else {
        if (empty>0) { str+=empty; empty=0; }
        str+=cell;
      }
    }
    if (empty>0) str+=empty;
    return str;
  });

  const newActive = active === 'w' ? 'b' : 'w';
  const newFullmove = active === 'b' ? parseInt(fullmove)+1 : fullmove;

  return `${newRows.join('/')} ${newActive} ${newCastling} ${newEnPassant} 0 ${newFullmove}`;
}

function parseSANtoUCI(san, fen) {
  // Very simplified SAN parser – handles common cases
  if (!san || san === '...') return null;
  san = san.replace(/[+#!?]/g, '');
  if (san === 'O-O' || san === '0-0') {
    return fen.split(' ')[1] === 'w' ? 'e1g1' : 'e8g8';
  }
  if (san === 'O-O-O' || san === '0-0-0') {
    return fen.split(' ')[1] === 'w' ? 'e1c1' : 'e8c8';
  }

  // Extract destination (last 2 chars)
  const dest = san.substring(san.length-2);
  const destCol = dest.charCodeAt(0)-97;
  const destRow = 8-parseInt(dest[1]);

  // Get piece type
  let pieceType = 'P';
  const firstChar = san[0];
  if ('KQRBN'.includes(firstChar)) { pieceType = firstChar; }
  else if ('kqrbn'.includes(firstChar)) { pieceType = firstChar; }

  const active = fen.split(' ')[1];
  const pieceChar = active === 'w' ? pieceType.toUpperCase() : pieceType.toLowerCase();

  // Find the source square
  const rows = fen.split(' ')[0].split('/');
  const board = rows.map(row => {
    const arr = [];
    for (const ch of row) {
      if (ch >= '1' && ch <= '8') {
        for (let i=0; i<parseInt(ch); i++) arr.push(null);
      } else arr.push(ch);
    }
    return arr;
  });

  // Look for candidate pieces that can reach the destination
  const candidates = [];
  for (let r=0; r<8; r++) {
    for (let c=0; c<8; c++) {
      if (board[r][c] === pieceChar) {
        candidates.push({row: r, col: c});
      }
    }
  }

  // Disambiguate based on SAN hints
  let fromFile = null, fromRank = null;
  if (san.length > 2 && pieceType !== 'P') {
    const disambig = san.substring(1, san.length-2);
    if (disambig.length === 1) {
      if ('abcdefgh'.includes(disambig)) fromFile = disambig.charCodeAt(0)-97;
      else fromRank = 8-parseInt(disambig);
    } else if (disambig.length === 2) {
      fromFile = disambig.charCodeAt(0)-97;
      fromRank = 8-parseInt(disambig[1]);
    }
  }

  for (const cand of candidates) {
    if (fromFile !== null && cand.col !== fromFile) continue;
    if (fromRank !== null && cand.row !== fromRank) continue;
    // Simple reachability check (not perfect but works for most cases)
    const dc = Math.abs(cand.col - destCol);
    const dr = Math.abs(cand.row - destRow);
    const valid = true; // Accept the first candidate
    return String.fromCharCode(97+cand.col) + (8-cand.row) + dest;
  }

  return null;
}

function getMoveCount() {
  const items = document.querySelectorAll('[class*="move-list"] [class*="move"]:not([class*="move-number"])');
  return items.length;
}

function syncFENFromMoveList() {
  // Replay all moves from the move list to get the current FEN
  let fen = START_FEN;
  const items = document.querySelectorAll('[class*="move-list"] [class*="move"]:not([class*="move-number"])');
  for (const item of items) {
    const san = item.textContent?.trim();
    if (!san) continue;
    const uci = parseSANtoUCI(san, fen);
    if (uci) {
      fen = applyMoveToFEN(fen, uci);
    }
  }
  return fen;
}

function getCurrentFEN() {
  // 1) Try game.fen()
  const game = getGameObject();
  if (game && typeof game.fen === 'function') {
    try {
      const fen = game.fen();
      if (fen && typeof fen === 'string' && fen.includes(' ')) return fen;
    } catch(e) {}
  }

  // 2) Use move list (most reliable)
  const moveFEN = syncFENFromMoveList();
  if (moveFEN !== START_FEN) return moveFEN;

  // 3) Fallback to DOM
  return buildFENFromDOM();
}

// ---- Board orientation & game object ----
function isFlipped() {
  const board = document.querySelector('chess-board') || document.querySelector('.board');
  return board ? board.classList.contains('flipped') : false;
}

function getGameObject() {
  try {
    const boardEl = document.querySelector('chess-board');
    if (!boardEl) return null;
    for (const key of Object.keys(boardEl)) {
      const val = boardEl[key];
      if (val && typeof val.turn === 'function' && typeof val.myColor === 'function') return val;
    }
    if (boardEl.game?.turn) return boardEl.game;
    if (boardEl.chess?.turn) return boardEl.chess;
    if (window.chess?.turn) return window.chess;
  } catch(e){}
  return null;
}

function detectUserColor() {
  const game = getGameObject();
  if (game) {
    try {
      let c = game.myColor?.();
      if (c === 'white') return 'w';
      if (c === 'black') return 'b';
    } catch(e){}
  }
  if (isFlipped()) return 'b';
  return 'w';
}

function ensureUserColor() {
  if (!userColor) {
    userColor = detectUserColor();
    console.log('ChessMonger: user color =', userColor);
  }
  return userColor;
}

function isUserTurn() {
  const fen = localFEN || getCurrentFEN();
  const active = fen.split(' ')[1];
  return active === ensureUserColor();
}

function buildFENFromDOM() {
  const board = Array(8).fill().map(()=>Array(8).fill(null));
  const flipped = isFlipped();
  document.querySelectorAll('.piece').forEach(piece => {
    const cls = [...piece.classList];
    const pc = cls.find(c=>pieceMap[c]);
    if (!pc) return;
    const sq = cls.find(c=>c.startsWith('square-'));
    if (!sq) return;
    const s = sq.replace('square-','');
    if (s.length<2) return;
    let col = parseInt(s[0])-1;
    let row = 8-parseInt(s[1]);
    if (flipped) { col = 7-col; row = 7-row; }
    if (row>=0 && row<8 && col>=0 && col<8) board[row][col] = pieceMap[pc];
  });
  let fen = '';
  for (let r=0; r<8; r++) {
    let empty=0;
    for (let c=0; c<8; c++) {
      if (board[r][c]===null) empty++;
      else { if (empty>0) { fen+=empty; empty=0; } fen+=board[r][c]; }
    }
    if (empty>0) fen+=empty;
    if (r<7) fen+='/';
  }
  fen += ` ${isUserTurn()?'w':'b'} - - 0 1`;
  return fen;
}

// ---- Move execution ----
function getSquareCenter(square) {
  const file = square.charCodeAt(0)-97;
  const rank = 8-parseInt(square[1]);
  const boardEl = document.querySelector('chess-board') || document.querySelector('.board');
  if (!boardEl) return null;
  const rect = boardEl.getBoundingClientRect();
  const sq = rect.width/8;
  const flipped = isFlipped();
  let x,y;
  if (flipped) { x = rect.left+(7-file)*sq+sq/2; y = rect.top+(7-rank)*sq+sq/2; }
  else { x = rect.left+file*sq+sq/2; y = rect.top+rank*sq+sq/2; }
  return {x,y};
}

async function tryDragMove(from, to) {
  const fp = getSquareCenter(from), tp = getSquareCenter(to);
  if (!fp||!tp) return false;
  const piece = document.elementFromPoint(fp.x, fp.y);
  if (!piece || !piece.classList.contains('piece')) return false;
  piece.dispatchEvent(new PointerEvent('pointerdown', {bubbles:true, cancelable:true, clientX:fp.x, clientY:fp.y, button:0, pointerId:1, pointerType:'mouse', isPrimary:true}));
  await new Promise(r=>setTimeout(r,60));
  const target = document.elementFromPoint(tp.x,tp.y)||document.body;
  target.dispatchEvent(new PointerEvent('pointermove', {bubbles:true, cancelable:true, clientX:tp.x, clientY:tp.y, button:0, pointerId:1, pointerType:'mouse', isPrimary:true}));
  await new Promise(r=>setTimeout(r,40));
  target.dispatchEvent(new PointerEvent('pointerup', {bubbles:true, cancelable:true, clientX:tp.x, clientY:tp.y, button:0, pointerId:1, pointerType:'mouse', isPrimary:true}));
  return true;
}

async function playMove(uci) {
  const from=uci.substring(0,2), to=uci.substring(2,4);
  console.log(`ChessMonger: playing ${from}→${to}`);
  isPlayingMove = true;

  // Board API
  const boardEl = document.querySelector('chess-board');
  if (boardEl) {
    const chess = boardEl.game || boardEl.chess || window.chess;
    if (chess && typeof chess.move === 'function') {
      try { chess.move({from,to,promotion:'q'}); console.log('move via API'); } catch(e){}
    }
  }

  // Drag fallback
  if (await tryDragMove(from, to)) {
    await new Promise(r=>setTimeout(r,400));
    console.log('move via drag');
  }

  // ★ Update our local FEN immediately
  if (localFEN) {
    localFEN = applyMoveToFEN(localFEN, uci);
  } else {
    localFEN = applyMoveToFEN(START_FEN, uci);
  }
  lastMoveCount = getMoveCount();
  isPlayingMove = false;
}

// ---- Auto‑play ----
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

// ---- Game‑end & auto‑queue ----
function checkGameEnd() {
  if (!localFEN) return false;
  const selectors = ['.game-over-modal','[class*="game-over"]','.post-game-modal','[class*="post-game"]','.result-modal','[class*="result-modal"]','.game-review-modal','[class*="game-review"]','.game-end-modal','[class*="game-end"]'];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el && el.offsetParent !== null) return true;
  }
  const resultText = document.querySelector('.game-result, [class*="result"], .sidebar-result, .game-end-text, [class*="end-text"]');
  if (resultText && /\b(1\-0|0\-1|½\-½|won|drew|draw|resign|abandon|timeout|forfeit|stalemate|game over|game ended|won on time|white wins|black wins)\b/.test(resultText.textContent?.toLowerCase()||'')) return true;
  const reviewBtn = document.querySelector('[class*="game-review-button"], button[class*="review"], a[class*="review"]');
  if (reviewBtn) return true;
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
  if (Math.random()<0.20) { const mins = 2+Math.random()*6; setTimeout(()=>actuallyStartNextGame(), mins*60000); return; }
  setTimeout(actuallyStartNextGame, 3000+Math.random()*5000);
}

function resetGameEndDetection() {
  if (!gameEndDetected) return;
  if (document.querySelectorAll('.piece').length >= 28) { gameEndDetected = false; }
}

function startGameEndObserver() {
  const obs = new MutationObserver(() => { resetGameEndDetection(); if (!gameEndDetected && checkGameEnd()) tryStartNextGame(); });
  obs.observe(document.body, {childList:true, subtree:true, attributes:true});
}

// ---- Board observer ----
function setupBoardObserver() {
  const board = document.querySelector('chess-board') || document.querySelector('.board');
  const target = board || document.body;
  if (lastObservedBoardElement === target) return;
  if (boardObserver) boardObserver.disconnect();
  lastObservedBoardElement = target;
  boardObserver = new MutationObserver(() => scheduleUpdate(400));
  boardObserver.observe(target, {childList:true, subtree:true, attributes: target!==document.body, attributeFilter: target!==document.body?['class','style']:undefined});
}

// ---- Update loop ----
function scheduleUpdate(delay=400) {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(doUpdate, delay);
}

async function doUpdate() {
  if (isPlayingMove || requestInFlight) return;
  if (autoPlayTimeout && selectedMove) return; // already scheduled

  ensureUserColor();

  // ★ Detect opponent move via move list count
  const currentMoveCount = getMoveCount();
  if (currentMoveCount > lastMoveCount) {
    // Opponent has moved – sync FEN from move list
    console.log('ChessMonger: opponent move detected via move list');
    localFEN = syncFENFromMoveList();
    lastMoveCount = currentMoveCount;
  }

  // Initialise FEN if needed
  if (!localFEN) {
    localFEN = getCurrentFEN();
    lastMoveCount = getMoveCount();
  }

  const fen = localFEN;
  if (!fen) return;

  if (!isUserTurn()) return;

  requestInFlight = true;
  if (requestTimer) clearTimeout(requestTimer);
  requestTimer = setTimeout(()=>{ requestInFlight=false; }, 8000);

  console.log(`ChessMonger: request move (${fen.substring(0,30)}...)`);

  chrome.runtime.sendMessage({type:'getMove', fen, time:0.5, multipv:1}, (response) => {
    requestInFlight = false;
    if (!response?.moves?.length) return;
    const chosen = response.moves[0];
    console.log(`ChessMonger: engine suggests ${chosen.uci}`);
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
  const currentMoveCount = getMoveCount();
  if (currentMoveCount !== lastMoveCount) {
    console.log('ChessMonger: poll detected opponent move');
    doUpdate();
  }
}

// ---- Init ----
userColor = null;
gameEndDetected = false;
localFEN = null;
lastMoveCount = 0;

scheduleUpdate(1500);
setupBoardObserver();
startGameEndObserver();

setInterval(pollForOpponentMove, 3000);
setInterval(setupBoardObserver, 30000);