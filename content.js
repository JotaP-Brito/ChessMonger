// ChessMonger – with robust move execution

const pieceMap = {
  'br':'r','bn':'n','bb':'b','bq':'q','bk':'k','bp':'p',
  'wr':'R','wn':'N','wb':'B','wq':'Q','wk':'K','wp':'P'
};

let autoPlayEnabled = true;
let autoQueueEnabled = true;
let autoPlayTimeout = null;
let selectedMove = null;
let thinkingStart = null;
let lastFEN = null;
let userColor = null;
let requestInFlight = false;
let requestTimer = null;
let debounceTimer = null;
let boardObserver = null;
let gameEndDetected = false;
let isPlayingMove = false;
let lastObservedBoardElement = null;

// ---- Helper functions ----
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
    console.log('ChessMonger: detected user color =', userColor);
  }
  return userColor;
}

function getActiveColor() {
  const game = getGameObject();
  if (game && typeof game.turn === 'function') {
    try {
      let t = game.turn();
      if (t === 'white') return 'w';
      if (t === 'black') return 'b';
    } catch(e){}
  }
  const w = document.querySelector('.clock-white.clock-active, [class*="clock"][class*="white"][class*="active"]');
  const b = document.querySelector('.clock-black.clock-active, [class*="clock"][class*="black"][class*="active"]');
  if (b && !w) return 'b';
  if (w && !b) return 'w';
  const items = document.querySelectorAll('[class*="move-list"] [class*="move"]:not([class*="move-number"])');
  if (items.length) {
    const half = Math.floor(items.length / 2);
    return half % 2 === 0 ? 'w' : 'b';
  }
  return 'w';
}

function isUserTurn() {
  const active = getActiveColor();
  const user = ensureUserColor();
  const result = active === user;
  console.log(`ChessMonger: turn check – active=${active}, user=${user}, isMyTurn=${result}`);
  return result;
}

function getFEN() {
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
      else {
        if (empty>0) { fen+=empty; empty=0; }
        fen+=board[r][c];
      }
    }
    if (empty>0) fen+=empty;
    if (r<7) fen+='/';
  }
  fen += ` ${getActiveColor()} - - 0 1`;
  return fen;
}

// ---- Square center (used by drag) ----
function getSquareCenter(square) {
  const file = square.charCodeAt(0)-97;
  const rank = 8-parseInt(square[1]);
  const boardEl = document.querySelector('chess-board') || document.querySelector('.board');
  if (!boardEl) return null;
  const rect = boardEl.getBoundingClientRect();
  const sq = rect.width/8;
  const flipped = isFlipped();
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

// ---- Robust drag using direct piece element lookup ----
function findPieceOnSquare(square) {
  // square like 'e2'
  const targetSquareClass = `square-${square.charCodeAt(0)-96}${square[1]}`; // square-55 for e2? Wait, chess.com uses square-XY where X=file, Y=rank. e2 = file 5, rank 2 => square-52.
  const file = square.charCodeAt(0) - 96; // a=1, b=2, ..., h=8
  const rank = parseInt(square[1]);
  const className = `square-${file}${rank}`;
  const squareEl = document.querySelector(`.${className}`);
  if (squareEl) {
    return squareEl.querySelector('.piece');
  }
  return null;
}

async function robustDragMove(from, to) {
  // Method 1: Use direct piece lookup
  const piece = findPieceOnSquare(from);
  if (!piece) {
    console.warn(`ChessMonger: no piece found on ${from}`);
    return false;
  }
  const fp = getSquareCenter(from);
  const tp = getSquareCenter(to);
  if (!fp || !tp) {
    console.warn('ChessMonger: could not get square centers');
    return false;
  }

  // Simulate a simple drag
  console.log(`ChessMonger: dragging from ${from} to ${to}`);
  piece.dispatchEvent(new PointerEvent('pointerdown', {
    bubbles: true, cancelable: true, view: window,
    clientX: fp.x, clientY: fp.y, button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true
  }));
  await new Promise(r=>setTimeout(r, 60));

  const targetSquareEl = findPieceOnSquare(to) || document.querySelector(`.square-${to.charCodeAt(0)-96}${to[1]}`) || document.body;
  targetSquareEl.dispatchEvent(new PointerEvent('pointermove', {
    bubbles: true, cancelable: true, view: window,
    clientX: tp.x, clientY: tp.y, button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true
  }));
  await new Promise(r=>setTimeout(r, 40));

  targetSquareEl.dispatchEvent(new PointerEvent('pointerup', {
    bubbles: true, cancelable: true, view: window,
    clientX: tp.x, clientY: tp.y, button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true
  }));
  return true;
}

async function playMove(uci) {
  const from = uci.substring(0,2);
  const to = uci.substring(2,4);
  console.log(`ChessMonger: playing ${from}→${to}`);
  isPlayingMove = true;

  // Try robust drag
  let success = await robustDragMove(from, to);
  if (success) {
    await new Promise(r=>setTimeout(r, 400));
    // Verify FEN changed
    const newFEN = getFEN();
    if (newFEN === lastFEN) {
      console.warn('ChessMonger: drag did not register, trying fallback click...');
      // Fallback: try text input or board API
      const boardEl = document.querySelector('chess-board');
      if (boardEl) {
        const chess = boardEl.game || boardEl.chess || window.chess;
        if (chess && typeof chess.move === 'function') {
          try {
            chess.move({from, to, promotion:'q'});
            console.log('ChessMonger: move via board API');
          } catch(e) {
            console.error('ChessMonger: board API failed', e);
          }
        }
      }
    }
  } else {
    console.warn('ChessMonger: drag failed completely');
  }

  isPlayingMove = false;
}

// ---- Auto‑play scheduling ----
function scheduleAutoPlay(moveUci, thinkTime) {
  cancelAutoPlay();
  selectedMove = moveUci;
  thinkingStart = Date.now();
  console.log(`ChessMonger: scheduling ${moveUci} in ${thinkTime}ms`);
  autoPlayTimeout = setTimeout(() => {
    if (selectedMove === moveUci && isUserTurn()) {
      playMove(moveUci);
      selectedMove = null;
      thinkingStart = null;
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

// ---- Game‑end detection & auto‑queue ----
function checkGameEnd() {
  if (!lastFEN) return false;
  const selectors = [
    '.game-over-modal', '[class*="game-over"]', '.post-game-modal',
    '[class*="post-game"]', '.result-modal', '[class*="result-modal"]',
    '.game-review-modal', '[class*="game-review"]',
    '.game-end-modal', '[class*="game-end"]'
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el && el.offsetParent !== null) return true;
  }
  const resultText = document.querySelector('.game-result, [class*="result"], .sidebar-result, .game-end-text, [class*="end-text"]');
  if (resultText) {
    const text = resultText.textContent?.toLowerCase() || '';
    if (/\b(1\-0|0\-1|½\-½|won|drew|draw|resign|abandon|timeout|forfeit|stalemate|game over|game ended|won on time|white wins|black wins)\b/.test(text)) return true;
  }
  const reviewBtn = document.querySelector('[class*="game-review-button"], button[class*="review"], a[class*="review"]');
  if (reviewBtn) return true;
  const wc = document.querySelector('.clock-white, [class*="clock-white"]');
  const bc = document.querySelector('.clock-black, [class*="clock-black"]');
  if (wc && bc) {
    const wt = wc.textContent?.trim() || '';
    const bt = bc.textContent?.trim() || '';
    if ((wt === '0:00' || wt === '0.0') && (bt === '0:00' || bt === '0.0')) return true;
  }
  return false;
}

function actuallyStartNextGame() {
  const buttons = document.querySelectorAll('button, a, span[role="button"]');
  const texts = ['10 min', '10+0', 'new 10', 'play again 10'];
  for (const btn of buttons) {
    const t = btn.textContent?.toLowerCase() || '';
    for (const x of texts) {
      if (t.includes(x)) {
        console.log('ChessMonger: starting next game');
        btn.click();
        return;
      }
    }
  }
  for (const btn of buttons) {
    const t = btn.textContent?.toLowerCase() || '';
    if (t.includes('new game') || t.includes('play again')) {
      btn.click();
      return;
    }
  }
  window.location.href = 'https://www.chess.com/play/online/new?action=createLiveChallenge&base=600&timeIncrement=0&rated=rated';
}

function tryStartNextGame() {
  if (gameEndDetected) return;
  gameEndDetected = true;
  console.log('ChessMonger: game ended, queueing next');
  if (Math.random() < 0.20) {
    const mins = 2 + Math.random() * 6;
    console.log(`ChessMonger: taking a ${Math.round(mins)}min break`);
    setTimeout(() => actuallyStartNextGame(), mins * 60000);
    return;
  }
  setTimeout(actuallyStartNextGame, 3000 + Math.random() * 5000);
}

function resetGameEndDetection() {
  if (!gameEndDetected) return;
  if (document.querySelectorAll('.piece').length >= 28) {
    console.log('ChessMonger: new game detected – resetting auto-queue');
    gameEndDetected = false;
  }
}

function startGameEndObserver() {
  const obs = new MutationObserver(() => {
    resetGameEndDetection();
    if (!gameEndDetected && checkGameEnd()) {
      if (autoQueueEnabled) tryStartNextGame();
    }
  });
  obs.observe(document.body, { childList:true, subtree:true, attributes:true });
  console.log('ChessMonger: game end observer started');
}

// ---- Board change observer ----
function setupBoardObserver() {
  const board = document.querySelector('chess-board') || document.querySelector('.board');
  const target = board || document.body;
  if (lastObservedBoardElement === target) return;
  if (boardObserver) boardObserver.disconnect();
  lastObservedBoardElement = target;
  boardObserver = new MutationObserver(() => scheduleUpdate(400));
  boardObserver.observe(target, {
    childList: true,
    subtree: true,
    attributes: target !== document.body,
    attributeFilter: target !== document.body ? ['class', 'style'] : undefined
  });
  console.log(`ChessMonger: board observer attached to ${target.tagName}`);
}

// ---- Update loop ----
function scheduleUpdate(delay=400) {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(doUpdate, delay);
}

async function doUpdate() {
  if (isPlayingMove || requestInFlight) return;
  if (autoPlayTimeout && selectedMove && lastFEN && getFEN()===lastFEN) return;

  requestInFlight = true;
  if (requestTimer) clearTimeout(requestTimer);
  requestTimer = setTimeout(()=>{ requestInFlight=false; }, 8000);

  ensureUserColor();
  const fen = getFEN();
  if (fen === lastFEN) { requestInFlight=false; return; }
  lastFEN = fen;
  if (autoPlayTimeout) cancelAutoPlay();

  console.log(`ChessMonger: requesting best move for FEN (${fen.substring(0,20)}...)`);

  chrome.runtime.sendMessage({ type:'getMove', fen, time:0.5, multipv:1 }, (response) => {
    requestInFlight = false;
    if (!response?.moves?.length) {
      console.warn('ChessMonger: no move received from engine');
      return;
    }
    const chosen = response.moves[0];
    console.log(`ChessMonger: engine suggests ${chosen.uci}`);
    if (autoPlayEnabled && isUserTurn()) {
      const think = computeThinkTime(fen);
      console.log(`ChessMonger: scheduling ${chosen.uci} in ${think}ms`);
      scheduleAutoPlay(chosen.uci, think);
    }
  });
}

// ---- Polling fallback ----
function pollForOpponentMove() {
  if (isPlayingMove || requestInFlight) return;
  const fen = getFEN();
  if (fen !== lastFEN) {
    console.log('ChessMonger: poll detected opponent move');
    doUpdate();
  }
}

// ---- Init ----
userColor = null;
gameEndDetected = false;

scheduleUpdate(1500);
setupBoardObserver();
startGameEndObserver();

setInterval(pollForOpponentMove, 3000);
setInterval(setupBoardObserver, 30000);
