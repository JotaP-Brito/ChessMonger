// ChessMonger – background engine controller with fallback

let engine = null;
let engineReady = false;
let lastBestMove = null;
let pendingResolve = null;
let fallbackMode = false;

console.log('ChessMonger background: starting engine...');

function randomizeEngine() {
  if (!engine || fallbackMode) return;
  const skill = Math.floor(Math.random() * 13) + 5;
  const contempt = Math.floor(Math.random() * 40) - 20;
  const overhead = Math.floor(Math.random() * 300) + 50;
  engine.postMessage(`setoption name Skill Level value ${skill}`);
  engine.postMessage(`setoption name Contempt value ${contempt}`);
  engine.postMessage(`setoption name Move Overhead value ${overhead}`);
  engine.postMessage('ucinewgame');
  console.log(`ChessMonger: engine randomized – Skill=${skill} Contempt=${contempt} Overhead=${overhead}`);
}

function startEngine() {
  try {
    const engineUrl = chrome.runtime.getURL('stockfish.js');
    console.log('ChessMonger: engine URL =', engineUrl);
    engine = new Worker(engineUrl);
    engine.onmessage = (e) => {
      const line = e.data || e;
      if (line === 'uciok') {
        console.log('ChessMonger: uciok received');
        engine.postMessage('setoption name MultiPV value 1');
        engine.postMessage('isready');
      } else if (line === 'readyok') {
        engineReady = true;
        console.log('ChessMonger: engine ready');
        randomizeEngine();
        if (pendingResolve) {
          pendingResolve(true);
          pendingResolve = null;
        }
      } else if (line.startsWith('bestmove')) {
        const parts = line.split(' ');
        lastBestMove = parts[1];
        console.log('ChessMonger: bestmove =', lastBestMove);
      }
    };
    engine.onerror = (err) => {
      console.error('ChessMonger engine error:', err);
      fallbackMode = true;
      if (pendingResolve) {
        pendingResolve(true);
        pendingResolve = null;
      }
    };
    engine.postMessage('uci');
  } catch (e) {
    console.error('ChessMonger: failed to create worker', e);
    fallbackMode = true;
    if (pendingResolve) {
      pendingResolve(true);
      pendingResolve = null;
    }
  }
}

function waitForEngine() {
  return new Promise(resolve => {
    if (engineReady || fallbackMode) resolve(true);
    else pendingResolve = resolve;
  });
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'getMove') {
    const fen = request.fen;
    const time = Math.max(0.1, Math.min(request.time || 0.5, 10.0));
    console.log(`ChessMonger: getMove request – fen=${fen.substring(0,20)}..., time=${time}`);
    if (!engineReady && !fallbackMode) {
      console.log('ChessMonger: waiting for engine...');
      waitForEngine().then(() => sendBestMove(fen, time, sendResponse));
      return true;
    }
    sendBestMove(fen, time, sendResponse);
    return true;
  }
});

function getFallbackMove(fen) {
  // Extract active colour and suggest a simple pawn move
  const active = fen.split(' ')[1];
  if (active === 'w') return 'e2e4';
  else return 'e7e5';
}

async function sendBestMove(fen, time, sendResponse) {
  if (fallbackMode) {
    console.log('ChessMonger: using fallback move');
    const move = getFallbackMove(fen);
    console.log('ChessMonger: fallback move =', move);
    sendResponse({ moves: [{ uci: move, san: '', score: '' }] });
    return;
  }

  lastBestMove = null;
  engine.postMessage(`position fen ${fen}`);
  engine.postMessage(`go movetime ${Math.floor(time * 1000)}`);
  const start = Date.now();
  const maxWait = time * 1000 + 3000;
  while (Date.now() - start < maxWait) {
    if (lastBestMove) {
      sendResponse({ moves: [{ uci: lastBestMove, san: '', score: '' }] });
      return;
    }
    await new Promise(r => setTimeout(r, 50));
  }
  console.warn('ChessMonger: no bestmove received in time');
  // Fallback move
  const move = getFallbackMove(fen);
  sendResponse({ moves: [{ uci: move, san: '', score: '' }] });
}

startEngine();