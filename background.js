// ChessMonger – background engine controller

let engine = null;
let engineReady = false;
let lastBestMove = null;
let pendingResolve = null;

function randomizeEngine() {
  if (!engine) return;
  const skill = Math.floor(Math.random() * 13) + 5;
  const contempt = Math.floor(Math.random() * 40) - 20;
  const overhead = Math.floor(Math.random() * 300) + 50;
  engine.postMessage(`setoption name Skill Level value ${skill}`);
  engine.postMessage(`setoption name Contempt value ${contempt}`);
  engine.postMessage(`setoption name Move Overhead value ${overhead}`);
  engine.postMessage('ucinewgame');
  console.log(`ChessMonger engine randomized: Skill=${skill} Contempt=${contempt} Overhead=${overhead}`);
}

function startEngine() {
  // CORRECTED: use full extension URL
  const engineUrl = chrome.runtime.getURL('stockfish.js');
  engine = new Worker(engineUrl);
  engine.onmessage = (e) => {
    const line = e.data || e;
    if (line === 'uciok') {
      engine.postMessage('setoption name MultiPV value 1');
      engine.postMessage('isready');
    } else if (line === 'readyok') {
      engineReady = true;
      randomizeEngine();
      if (pendingResolve) {
        pendingResolve(true);
        pendingResolve = null;
      }
      console.log('ChessMonger: engine ready');
    } else if (line.startsWith('bestmove')) {
      const parts = line.split(' ');
      lastBestMove = parts[1];
    }
  };
  engine.onerror = (err) => {
    console.error('ChessMonger engine error:', err);
  };
  engine.postMessage('uci');
}

function waitForEngine() {
  return new Promise(resolve => {
    if (engineReady) resolve(true);
    else pendingResolve = resolve;
  });
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'getMove') {
    const fen = request.fen;
    const time = Math.max(0.1, Math.min(request.time || 0.5, 10.0));
    if (!engine || !engineReady) {
      waitForEngine().then(() => sendBestMove(fen, time, sendResponse));
      return true;
    }
    sendBestMove(fen, time, sendResponse);
    return true;
  }
});

async function sendBestMove(fen, time, sendResponse) {
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
  console.warn('ChessMonger: no move found within time');
  sendResponse({ moves: [] });
}

startEngine();