// ChessMonger – robust API search + click fallback

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

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

// ---- Find chess API (extended search) ----
function findChessAPI() {
  // 1) board element
  const boardEl = document.querySelector('chess-board');
  if (boardEl) {
    if (boardEl.game && typeof boardEl.game.move === 'function') return boardEl.game;
    if (boardEl.chess && typeof boardEl.chess.move === 'function') return boardEl.chess;
    // walk own keys
    for (const key of Object.keys(boardEl)) {
      const val = boardEl[key];
      if (val && typeof val.move === 'function') return val;
    }
    // Vue 2/3 internal
    if (boardEl.__vue__ && boardEl.__vue__.game && typeof boardEl.__vue__.game.move === 'function') return boardEl.__vue__.game;
    // React fiber
    const fiberKey = Object.keys(boardEl).find(k => k.startsWith('__reactFiber'));
    if (fiberKey && boardEl[fiberKey]?.stateNode?.game?.move) return boardEl[fiberKey].stateNode.game;
  }
  // 2) window
  if (window.chess && typeof window.chess.move === 'function') return window.chess;
  // 3) walk all window keys (shallow)
  for (const key of Object.getOwnPropertyNames(window)) {
    try {
      const val = window[key];
      if (val && typeof val.move === 'function' && typeof val.fen === 'function') return val;
    } catch(e) {}
  }
  return null;
}

// ---- Colour & turn ----
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
  const api = findChessAPI();
  if (api?.turn) {
    const t = api.turn();
    return t === ensureUserColor() || t === (ensureUserColor()==='w'?'white':'black');
  }
  const items = document.querySelectorAll('[class*="move-list"] [class*="move"]:not([class*="move-number"])');
  const half = Math.floor(items.length / 2);
  return (half % 2 === 0 ? 'w' : 'b') === ensureUserColor();
}

function getMoveCount() {
  const items = document.querySelectorAll('[class*="move-list"] [class*="move"]:not([class*="move-number"])');
  return items.length;
}

function getCurrentFEN() {
  const api = findChessAPI();
  if (api?.fen) {
    try {
      const f = api.fen();
      if (f && f.includes(' ')) return f;
    } catch(e) {}
  }
  // fallback: minimal FEN based on move count (engine only needs active colour + piece placement)
  const moveCount = getMoveCount();
  const active = (Math.floor(moveCount/2) % 2 === 0) ? 'w' : 'b';
  return `${START_FEN.split(' ')[0]} ${active} - - ${Math.floor(moveCount/2)} ${Math.floor(moveCount/2)+1}`;
}

// ---- Square coordinates ----
function getSquareCenter(square) {
  const file = square.charCodeAt(0)-97;
  const rank = 8-parseInt(square[1]);
  const boardEl = document.querySelector('chess-board') || document.querySelector('.board');
  if (!boardEl) return null;
  const rect = boardEl.getBoundingClientRect();
  const sq = rect.width/8;
  const flipped = document.querySelector('chess-board')?.classList.contains('flipped') || false;
  let x, y;
  if (flipped) {
    x = rect.left + (7-file)*sq + sq/2;
    y = rect.top + (7-rank)*sq + sq/2;
  } else {
    x = rect.left + file*sq + sq/2;
    y = rect.top + rank*sq + sq/2;
  }
  return {x, y};
}

// ---- Play move (API first, then click fallback) ----
async function playMove(uci) {
  console.log(`ChessMonger: playing ${uci}`);
  isPlayingMove = true;

  // 1) Board API
  const api = findChessAPI();
  if (api?.move) {
    try {
      api.move({from: uci.substring(0,2), to: uci.substring(2,4), promotion:'q'});
      console.log('move via API');
      isPlayingMove = false;
      return;
    } catch(e) {
      console.warn('API move failed, trying click', e);
    }
  }

  // 2) Click simulation (works on canvas)
  const fromSq = uci.substring(0,2);
  const toSq = uci.substring(2,4);
  const fp = getSquareCenter(fromSq);
  const tp = getSquareCenter(toSq);
  if (fp && tp) {
    // Click the source square
    const fromEl = document.elementFromPoint(fp.x, fp.y) || document.body;
    fromEl.dispatchEvent(new MouseEvent('mousedown', {bubbles:true, clientX:fp.x, clientY:fp.y, button:0}));
    await new Promise(r => setTimeout(r, 40));
    // Click the target square
    const toEl = document.elementFromPoint(tp.x, tp.y) || document.body;
    toEl.dispatchEvent(new MouseEvent('mouseup', {bubbles:true, clientX:tp.x, clientY:tp.y, button:0}));
    console.log('move via click');
  } else {
    console.error('could not get square coordinates');
  }

  await new Promise(r => setTimeout(r, 400));
  isPlayingMove = false;
}

// ---- Schedule ----
function scheduleAutoPlay(moveUci, thinkTime) {
  cancelAutoPlay();
  selectedMove = moveUci;
  thinkingStart = Date.now();
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
    console.log('ChessMonger: board changed');
  }

  if (!isUserTurn()) return;

  requestInFlight = true;
  if (requestTimer) clearTimeout(requestTimer);
  requestTimer = setTimeout(()=>{ requestInFlight=false; }, 8000);

  const fen = getCurrentFEN();
  console.log(`ChessMonger: request move (${fen.substring(0,30)}...)`);

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

function pollForOpponentMove() {
  if (isPlayingMove || requestInFlight) return;
  if (getMoveCount() !== lastMoveCount) {
    console.log('ChessMonger: poll detected opponent move');
    doUpdate();
  }
}

// ---- Init ----
userColor = null;
gameEndDetected = false;
lastMoveCount = 0;

scheduleUpdate(1500);
startGameEndObserver();

setInterval(pollForOpponentMove, 3000);