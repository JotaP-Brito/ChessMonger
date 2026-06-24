// ChessMonger – with turn‑wait retry loop

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
let turnWaitRetries = 0;        // track retry attempts

// ---- Orientation & game object ----
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
  return active === user;
}

// ★ FEN from internal game object – works even on canvas
function getFEN() {
  const game = getGameObject();
  if (game && typeof game.fen === 'function') {
    try {
      const fen = game.fen();
      if (fen && typeof fen === 'string' && fen.includes(' ')) return fen;
    } catch(e) {}
  }
  // fallback to DOM (may be inaccurate)
  return buildFENFromDOM();
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

function isBoardReady() {
  const game = getGameObject();
  if (game && typeof game.fen === 'function') return true;
  return document.querySelectorAll('.piece').length >= 20;
}

// ---- Move execution (board‑API first) ----
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

async function tryDragMove(from, to) {
  const fp = getSquareCenter(from);
  const tp = getSquareCenter(to);
  if (!fp||!tp) return false;
  const piece = document.elementFromPoint(fp.x, fp.y);
  if (!piece || !piece.classList.contains('piece')) return false;
  piece.dispatchEvent(new PointerEvent('pointerdown', {bubbles:true, cancelable:true, clientX:fp.x, clientY:fp.y, button:0, pointerId:1, pointerType:'mouse', isPrimary:true}));
  await new Promise(r=>setTimeout(r,60));
  const target = document.elementFromPoint(tp.x, tp.y)||document.body;
  target.dispatchEvent(new PointerEvent('pointermove', {bubbles:true, cancelable:true, clientX:tp.x, clientY:tp.y, button:0, pointerId:1, pointerType:'mouse', isPrimary:true}));
  await new Promise(r=>setTimeout(r,40));
  target.dispatchEvent(new PointerEvent('pointerup', {bubbles:true, cancelable:true, clientX:tp.x, clientY:tp.y, button:0, pointerId:1, pointerType:'mouse', isPrimary:true}));
  return true;
}

async function playMove(uci) {
  const from = uci.substring(0,2), to = uci.substring(2,4);
  console.log(`ChessMonger: playing ${from}→${to}`);
  isPlayingMove = true;

  // 1) Board API
  const boardEl = document.querySelector('chess-board');
  if (boardEl) {
    const chess = boardEl.game || boardEl.chess || window.chess;
    if (chess && typeof chess.move === 'function') {
      try { chess.move({from,to,promotion:'q'}); console.log('move via API'); isPlayingMove = false; return; } catch(e){}
    }
  }
  // 2) Drag fallback
  if (await tryDragMove(from, to)) {
    await new Promise(r=>setTimeout(r,400));
    if (getFEN() !== lastFEN) { console.log('move via drag'); isPlayingMove = false; return; }
  }
  // 3) Click fallback
  const fp = getSquareCenter(from), tp = getSquareCenter(to);
  if (fp && tp) {
    (document.elementFromPoint(fp.x,fp.y)||document.body).dispatchEvent(new MouseEvent('mousedown',{bubbles:true,clientX:fp.x,clientY:fp.y,button:0}));
    await new Promise(r=>setTimeout(r,20));
    (document.elementFromPoint(tp.x,tp.y)||document.body).dispatchEvent(new MouseEvent('mouseup',{bubbles:true,clientX:tp.x,clientY:tp.y,button:0}));
  }
  isPlayingMove = false;
}

// ---- Auto‑play scheduling ----
function scheduleAutoPlay(moveUci, thinkTime) {
  cancelAutoPlay();
  selectedMove = moveUci;
  thinkingStart = Date.now();
  autoPlayTimeout = setTimeout(() => {
    if (selectedMove === moveUci && isUserTurn() && isBoardReady()) {
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
  if (!lastFEN) return false;
  const selectors = [
    '.game-over-modal','[class*="game-over"]','.post-game-modal',
    '[class*="post-game"]','.result-modal','[class*="result-modal"]',
    '.game-review-modal','[class*="game-review"]',
    '.game-end-modal','[class*="game-end"]'
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el && el.offsetParent !== null) return true;
  }
  const resultText = document.querySelector('.game-result, [class*="result"], .sidebar-result, .game-end-text, [class*="end-text"]');
  if (resultText && /\b(1\-0|0\-1|½\-½|won|drew|draw|resign|abandon|timeout|forfeit|stalemate|game over|game ended|won on time|white wins|black wins)\b/.test(resultText.textContent?.toLowerCase()||'')) return true;
  const reviewBtn = document.querySelector('[class*="game-review-button"], button[class*="review"], a[class*="review"]');
  if (reviewBtn) return true;
  const wc = document.querySelector('.clock-white, [class*="clock-white"]');
  const bc = document.querySelector('.clock-black, [class*="clock-black"]');
  if (wc && bc) {
    const wt = wc.textContent?.trim()||'', bt = bc.textContent?.trim()||'';
    if ((wt==='0:00'||wt==='0.0') && (bt==='0:00'||bt==='0.0')) return true;
  }
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
  if (document.querySelectorAll('.piece').length >= 28) {
    gameEndDetected = false;
  }
}

function startGameEndObserver() {
  const obs = new MutationObserver(() => {
    resetGameEndDetection();
    if (!gameEndDetected && checkGameEnd()) tryStartNextGame();
  });
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

// ---- Update loop with turn‑wait retry ----
function scheduleUpdate(delay=400) {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(doUpdate, delay);
}

async function doUpdate() {
  if (isPlayingMove || requestInFlight) return;
  if (autoPlayTimeout && selectedMove && lastFEN && getFEN()===lastFEN) return;
  if (!isBoardReady()) return;

  requestInFlight = true;
  if (requestTimer) clearTimeout(requestTimer);
  requestTimer = setTimeout(()=>{ requestInFlight=false; }, 8000);

  ensureUserColor();
  const fen = getFEN();
  if (fen === lastFEN) { requestInFlight = false; return; }
  lastFEN = fen;
  if (autoPlayTimeout) cancelAutoPlay();

  console.log(`ChessMonger: request move (${fen.substring(0,20)}...)`);

  chrome.runtime.sendMessage({type:'getMove', fen, time:0.5, multipv:1}, (response) => {
    requestInFlight = false;
    if (!response?.moves?.length) return;
    const chosen = response.moves[0];
    console.log(`ChessMonger: engine suggests ${chosen.uci}`);

    if (autoPlayEnabled) {
      // ★ If it's our turn, schedule immediately
      if (isUserTurn()) {
        const think = computeThinkTime(fen);
        console.log(`ChessMonger: scheduling ${chosen.uci} in ${think}ms`);
        scheduleAutoPlay(chosen.uci, think);
        turnWaitRetries = 0;
      } else {
        // Not our turn yet — wait and retry
        if (turnWaitRetries < 8) {
          turnWaitRetries++;
          console.log(`ChessMonger: not our turn, retry ${turnWaitRetries}/8 in 600ms`);
          setTimeout(() => {
            // Only retry if board hasn't changed again
            if (getFEN() === fen) {
              doUpdate();
            } else {
              turnWaitRetries = 0;  // board changed, fresh start
            }
          }, 600);
        } else {
          console.log('ChessMonger: turn wait exhausted');
          turnWaitRetries = 0;
        }
      }
    }
  });
}

function pollForOpponentMove() {
  if (isPlayingMove || requestInFlight) return;
  if (!isBoardReady()) return;
  const fen = getFEN();
  if (fen !== lastFEN) {
    turnWaitRetries = 0;
    doUpdate();
  }
}

// ---- Init ----
userColor = null;
gameEndDetected = false;
turnWaitRetries = 0;

scheduleUpdate(1500);
setupBoardObserver();
startGameEndObserver();

setInterval(pollForOpponentMove, 3000);
setInterval(setupBoardObserver, 30000);