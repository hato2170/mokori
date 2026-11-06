/* =========================================================================
   本将棋 (Shogi) 完全自立型エンジン & UI
   ・本格9×9盤
   ・成駒（と、成香、成桂、成銀、馬、竜）
   ・持ち駒・打つ・二歩禁止・打ち歩詰め禁止・行き所のない駒打ち禁止
   ・王手判定・詰み判定
   ・CPU対戦（🟢 弱い / 🟡 普通 / 🔴 強い）
   ・リアルタイムオンライン対戦
   ========================================================================= */

(function () {
  "use strict";

  let audioCtx = null;
  function playClickSound() {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === "suspended") audioCtx.resume();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(520, audioCtx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(120, audioCtx.currentTime + 0.06);
      gain.gain.setValueAtTime(0.25, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.06);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.06);
    } catch (_) {}
  }

  function playCheckSound() {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === "suspended") audioCtx.resume();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(659, audioCtx.currentTime);
      osc.frequency.setValueAtTime(880, audioCtx.currentTime + 0.1);
      gain.gain.setValueAtTime(0.3, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.25);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.25);
    } catch (_) {}
  }

  // 駒の文字表現 (先手▲: 玉, 後手▽: 王)
  const PIECE_LABELS = {
    1: { K: "玉", R: "飛", B: "角", G: "金", S: "銀", N: "桂", L: "香", P: "歩", "+R": "竜", "+B": "馬", "+S": "全", "+N": "圭", "+L": "杏", "+P": "と" },
    2: { K: "王", R: "飛", B: "角", G: "金", S: "銀", N: "桂", L: "香", P: "歩", "+R": "竜", "+B": "馬", "+S": "全", "+N": "圭", "+L": "杏", "+P": "と" }
  };

  const HAND_ORDER = ["R", "B", "G", "S", "N", "L", "P"];
  const PIECE_NAMES_JP = { R: "飛車", B: "角行", G: "金将", S: "銀将", N: "桂馬", L: "香車", P: "歩兵" };

  function createBoard() {
    const b = Array(9).fill(null).map(() => Array(9).fill(null));
    const back = ["L", "N", "S", "G", "K", "G", "S", "N", "L"];
    back.forEach((t, c) => { b[0][c] = { type: t, player: 2, promoted: false }; });
    b[1][1] = { type: "B", player: 2, promoted: false };
    b[1][7] = { type: "R", player: 2, promoted: false };
    for (let c = 0; c < 9; c++) b[2][c] = { type: "P", player: 2, promoted: false };

    for (let c = 0; c < 9; c++) b[6][c] = { type: "P", player: 1, promoted: false };
    b[7][1] = { type: "R", player: 1, promoted: false };
    b[7][7] = { type: "B", player: 1, promoted: false };
    back.forEach((t, c) => { b[8][c] = { type: t, player: 1, promoted: false }; });
    return b;
  }

  function cloneBoard(b) {
    return b.map(r => r.map(c => c ? { ...c } : null));
  }

  function cloneHands(h) {
    return {
      1: { ...(h[1] || {}) },
      2: { ...(h[2] || {}) }
    };
  }

  function inBounds(r, c) {
    return r >= 0 && r < 9 && c >= 0 && c < 9;
  }

  function getPseudoMoves(b, r, c) {
    const p = b[r][c];
    if (!p) return [];
    const moves = [];
    const fwd = p.player === 1 ? -1 : 1;

    function addStep(nr, nc) {
      if (!inBounds(nr, nc)) return false;
      const dest = b[nr][nc];
      if (!dest) {
        moves.push({ fromR: r, fromC: c, toR: nr, toC: nc });
        return true;
      }
      if (dest.player !== p.player) {
        moves.push({ fromR: r, fromC: c, toR: nr, toC: nc, capture: dest });
      }
      return false;
    }

    function ray(dr, dc) {
      let nr = r + dr, nc = c + dc;
      while (addStep(nr, nc)) {
        nr += dr; nc += dc;
      }
    }

    const t = p.type;
    const isGoldLike = (p.promoted && ["P", "L", "N", "S"].includes(t)) || t === "G";

    if (isGoldLike) {
      const offsets = [
        [fwd, -1], [fwd, 0], [fwd, 1],
        [0, -1], [0, 1],
        [-fwd, 0]
      ];
      offsets.forEach(([dr, dc]) => addStep(r + dr, c + dc));
    } else if (t === "P") {
      addStep(r + fwd, c);
    } else if (t === "L") {
      ray(fwd, 0);
    } else if (t === "N") {
      addStep(r + fwd * 2, c - 1);
      addStep(r + fwd * 2, c + 1);
    } else if (t === "S") {
      const sOffsets = [
        [fwd, -1], [fwd, 0], [fwd, 1],
        [-fwd, -1], [-fwd, 1]
      ];
      sOffsets.forEach(([dr, dc]) => addStep(r + dr, c + dc));
    } else if (t === "K") {
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr !== 0 || dc !== 0) addStep(r + dr, c + dc);
        }
      }
    } else if (t === "B") {
      ray(-1, -1); ray(-1, 1); ray(1, -1); ray(1, 1);
      if (p.promoted) {
        addStep(r - 1, c); addStep(r + 1, c); addStep(r, c - 1); addStep(r, c + 1);
      }
    } else if (t === "R") {
      ray(-1, 0); ray(1, 0); ray(0, -1); ray(0, 1);
      if (p.promoted) {
        addStep(r - 1, c - 1); addStep(r - 1, c + 1); addStep(r + 1, c - 1); addStep(r + 1, c + 1);
      }
    }

    return moves;
  }

  function findKing(b, player) {
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        const p = b[r][c];
        if (p && p.player === player && p.type === "K") return { r, c };
      }
    }
    return null;
  }

  function isSquareAttacked(b, tr, tc, byPlayer) {
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        const p = b[r][c];
        if (p && p.player === byPlayer) {
          const mvs = getPseudoMoves(b, r, c);
          if (mvs.some(m => m.toR === tr && m.toC === tc)) return true;
        }
      }
    }
    return false;
  }

  function isKingInCheck(b, player) {
    const k = findKing(b, player);
    if (!k) return false;
    return isSquareAttacked(b, k.r, k.c, 3 - player);
  }

  function canPromote(p, fromR, toR) {
    if (p.promoted || p.type === "K" || p.type === "G") return false;
    const zone = p.player === 1 ? [0, 1, 2] : [6, 7, 8];
    return zone.includes(fromR) || zone.includes(toR);
  }

  function mustPromote(p, toR) {
    if (p.promoted) return false;
    if (p.player === 1) {
      if (p.type === "P" || p.type === "L") return toR === 0;
      if (p.type === "N") return toR <= 1;
    } else {
      if (p.type === "P" || p.type === "L") return toR === 8;
      if (p.type === "N") return toR >= 7;
    }
    return false;
  }

  function getLegalMoves(b, hands, player) {
    const legal = [];

    // 盤上の移動
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        const p = b[r][c];
        if (p && p.player === player) {
          const pseudos = getPseudoMoves(b, r, c);
          for (const m of pseudos) {
            const promo = canPromote(p, r, m.toR);
            const force = mustPromote(p, m.toR);

            // 仮想適用
            const nb = cloneBoard(b);
            nb[m.toR][m.toC] = { ...p, promoted: force || p.promoted };
            nb[r][c] = null;

            if (!isKingInCheck(nb, player)) {
              if (force) {
                legal.push({ ...m, promote: true, piece: p });
              } else if (promo) {
                legal.push({ ...m, promote: false, piece: p });
                legal.push({ ...m, promote: true, piece: p });
              } else {
                legal.push({ ...m, promote: false, piece: p });
              }
            }
          }
        }
      }
    }

    // 持ち駒を打つ
    const myH = hands[player] || {};
    for (const t of HAND_ORDER) {
      const count = myH[t] || 0;
      if (count <= 0) continue;

      for (let r = 0; r < 9; r++) {
        if (player === 1) {
          if ((t === "P" || t === "L") && r === 0) continue;
          if (t === "N" && r <= 1) continue;
        } else {
          if ((t === "P" || t === "L") && r === 8) continue;
          if (t === "N" && r >= 7) continue;
        }

        for (let c = 0; c < 9; c++) {
          if (b[r][c] !== null) continue;

          // 二歩チェック
          if (t === "P") {
            let hasPawn = false;
            for (let row = 0; row < 9; row++) {
              const cp = b[row][c];
              if (cp && cp.player === player && cp.type === "P" && !cp.promoted) {
                hasPawn = true;
                break;
              }
            }
            if (hasPawn) continue;
          }

          const nb = cloneBoard(b);
          nb[r][c] = { type: t, player, promoted: false };
          if (!isKingInCheck(nb, player)) {
            // 打ち歩詰め判定
            if (t === "P" && isKingInCheck(nb, 3 - player)) {
              // 相手に合法手があるか確認
              const oppMvs = getLegalMoves(nb, hands, 3 - player);
              if (oppMvs.length === 0) continue; // 打ち歩詰め禁止
            }
            legal.push({ isDrop: true, pieceType: t, toR: r, toC: c });
          }
        }
      }
    }

    return legal;
  }

  // AI 着手決定 (3段階)
  const PIECE_VALS = { P: 100, L: 280, N: 320, S: 500, G: 600, B: 850, R: 1000, K: 50000 };
  const PROMO_BONUS = { P: 350, L: 250, N: 250, S: 150, B: 300, R: 350 };

  function evalBoard(b, hands, aiPlayer) {
    let score = 0;
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        const p = b[r][c];
        if (!p) continue;
        let v = PIECE_VALS[p.type] || 0;
        if (p.promoted) v += PROMO_BONUS[p.type] || 150;
        // 中央支配ボーナス
        const distCenter = Math.abs(r - 4) + Math.abs(c - 4);
        v += Math.max(0, 4 - distCenter) * 10;
        score += (p.player === aiPlayer ? v : -v);
      }
    }
    // 持ち駒価値
    for (const t of HAND_ORDER) {
      const v = (PIECE_VALS[t] || 0) * 0.9;
      score += ((hands[aiPlayer]?.[t] || 0) - (hands[3 - aiPlayer]?.[t] || 0)) * v;
    }
    return score;
  }

  function pickAiMove(b, hands, player, difficulty) {
    const moves = getLegalMoves(b, hands, player);
    if (moves.length === 0) return null;

    if (difficulty === "easy") {
      // 弱い: ランダム手
      return moves[Math.floor(Math.random() * moves.length)];
    }

    if (difficulty === "normal") {
      // 普通: 捕獲優先 + ランダム性
      const captureMoves = moves.filter(m => m.capture);
      if (captureMoves.length > 0 && Math.random() < 0.75) {
        captureMoves.sort((a, b) => (PIECE_VALS[b.capture.type] || 0) - (PIECE_VALS[a.capture.type] || 0));
        return captureMoves[0];
      }
      return moves[Math.floor(Math.random() * moves.length)];
    }

    // 強い: 1手先評価 + 王手優先
    let bestScore = -Infinity;
    let bestMove = moves[0];

    for (const m of moves) {
      const nb = cloneBoard(b);
      const nh = cloneHands(hands);

      if (m.isDrop) {
        nb[m.toR][m.toC] = { type: m.pieceType, player, promoted: false };
        nh[player][m.pieceType]--;
      } else {
        const orig = nb[m.fromR][m.fromC];
        if (m.capture) {
          const capType = m.capture.type;
          nh[player][capType] = (nh[player][capType] || 0) + 1;
        }
        nb[m.toR][m.toC] = { ...orig, promoted: m.promote || orig.promoted };
        nb[m.fromR][m.fromC] = null;
      }

      let sc = evalBoard(nb, nh, player);
      // 王手をかけられる手はボーナス
      if (isKingInCheck(nb, 3 - player)) sc += 250;
      // 相手の詰み手なら即決定
      const oppLegal = getLegalMoves(nb, nh, 3 - player);
      if (oppLegal.length === 0) return m;

      // 相手の最大反撃を少し差し引く (ミニマックス近似)
      let maxOppResponse = 0;
      for (let i = 0; i < Math.min(6, oppLegal.length); i++) {
        const om = oppLegal[i];
        if (om.capture) {
          const val = PIECE_VALS[om.capture.type] || 0;
          if (val > maxOppResponse) maxOppResponse = val;
        }
      }
      sc -= maxOppResponse;

      if (sc > bestScore) {
        bestScore = sc;
        bestMove = m;
      }
    }

    return bestMove;
  }

  // =========================================================================
  // 将棋 UI レンダラー
  // =========================================================================
  window.renderShogiGame = function (container, roomCode = null, options = {}) {
    let board = createBoard();
    let hands = { 1: { P: 0, L: 0, N: 0, S: 0, G: 0, B: 0, R: 0 }, 2: { P: 0, L: 0, N: 0, S: 0, G: 0, B: 0, R: 0 } };
    let turn = 1; // 1: 先手(▲), 2: 後手(▽)
    let selectedSquare = null; // { r, c }
    let selectedHandPiece = null; // "P" など
    let isGameOver = false;
    let aiDifficulty = options.difficulty || "normal";
    let isOnline = Boolean(roomCode && (window.api || options.onSyncState));
    let myRole = options.myRole || 1; // 1: 先手, 2: 後手
    let opponentName = options.opponentName || (isOnline ? "対戦相手" : "CPU");
    let moveHistory = [];
    let pendingPromoMove = null;

    container.innerHTML = `
      <div style="padding:10px; max-width:440px; margin:0 auto; text-align:center; font-family:-apple-system,BlinkMacSystemFont,'Hiragino Kaku Gothic ProN',sans-serif; user-select:none;">
        <!-- ヘッダー情報 -->
        <div style="background:#1e293b; padding:8px 12px; border-radius:10px; margin-bottom:10px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:6px;">
          <div style="font-size:12px; color:#94a3b8;">
            <strong id="shogiModeBadge" style="color:#f59e0b;">♟️ ${isOnline ? "オンライン対戦" : "CPU対戦"}</strong>
            <span style="margin-left:6px; color:#64748b; font-size:11px;">(${roomCode || "ソロ"})</span>
          </div>
          <div style="display:flex; gap:6px;">
            ${isOnline && window.openGameForwardDialog ? `
              <button onclick="window.openGameForwardDialog()" style="background:#06c755; color:#fff; font-size:11px; font-weight:bold; padding:4px 10px; border-radius:6px; border:0; cursor:pointer;">
                📤 招待を転送
              </button>
            ` : ""}
            <button id="shogiResetBtn" style="background:#334155; color:#cbd5e1; font-size:11px; padding:4px 8px; border-radius:6px; border:0; cursor:pointer;">
              🔄 最初から
            </button>
          </div>
        </div>

        <!-- CPU 難易度セレクター -->
        <div id="shogiCpuDiffWrap" style="${isOnline ? "display:none;" : "display:flex;"} background:#1e293b; padding:6px 12px; border-radius:8px; margin-bottom:8px; justify-content:space-between; align-items:center;">
          <span style="font-size:11px; color:#94a3b8; font-weight:bold;">🤖 CPU強さ:</span>
          <div style="display:flex; gap:6px;">
            <button id="sDiffEasy" style="background:#334155; color:#cbd5e1; border:none; padding:3px 8px; border-radius:6px; font-size:11px; font-weight:bold; cursor:pointer;">🟢 弱い</button>
            <button id="sDiffNormal" style="background:#f59e0b; color:#fff; border:none; padding:3px 8px; border-radius:6px; font-size:11px; font-weight:bold; cursor:pointer;">🟡 普通</button>
            <button id="sDiffHard" style="background:#334155; color:#cbd5e1; border:none; padding:3px 8px; border-radius:6px; font-size:11px; font-weight:bold; cursor:pointer;">🔴 強い</button>
          </div>
        </div>

        <!-- 状態バナー -->
        <div id="shogiStatusBanner" style="font-size:13px; font-weight:bold; color:#f59e0b; min-height:22px; margin-bottom:6px;">
          ▲ 先手（あなた）の手番です
        </div>

        <!-- 相手（後手▽）の持ち駒 -->
        <div id="shogiHand2" style="background:#1e293b; border:1px solid #334155; border-radius:8px; padding:6px 8px; margin-bottom:6px; display:flex; justify-content:space-between; align-items:center; min-height:36px;">
          <div style="font-size:11px; color:#94a3b8; font-weight:bold;">▽ 相手の持駒:</div>
          <div id="shogiHand2Pieces" style="display:flex; gap:4px; flex-wrap:wrap; justify-content:flex-end;"></div>
        </div>

        <!-- 将棋 9×9 盤面 -->
        <div style="display:inline-block; background:#d97706; padding:4px; border-radius:8px; box-shadow:0 6px 18px rgba(0,0,0,0.5); border:3px solid #78350f;">
          <div id="shogiBoardGrid" style="display:grid; grid-template-columns:repeat(9, 36px); grid-template-rows:repeat(9, 38px); gap:1px; background:#78350f;"></div>
        </div>

        <!-- 自分（先手▲）の持ち駒 -->
        <div id="shogiHand1" style="background:#1e293b; border:1px solid #334155; border-radius:8px; padding:6px 8px; margin-top:6px; display:flex; justify-content:space-between; align-items:center; min-height:36px;">
          <div style="font-size:11px; color:#38bdf8; font-weight:bold;">▲ あなたの持駒:</div>
          <div id="shogiHand1Pieces" style="display:flex; gap:4px; flex-wrap:wrap; justify-content:flex-end;"></div>
        </div>

        <!-- 操作ボタン・投了 -->
        <div style="margin-top:10px; display:flex; gap:8px; justify-content:center;">
          <button id="shogiResignBtn" style="background:#dc2626; color:#fff; border:0; padding:6px 14px; border-radius:6px; font-size:11px; font-weight:bold; cursor:pointer;">
            🏳️ 投了
          </button>
        </div>

        <!-- 成り選択モーダル -->
        <div id="shogiPromoModal" style="display:none; position:fixed; top:0; left:0; width:100vw; height:100vh; background:rgba(0,0,0,0.7); z-index:9999; justify-content:center; align-items:center;">
          <div style="background:#1e293b; border:2px solid #f59e0b; border-radius:12px; padding:20px; text-align:center; max-width:280px; width:90%; color:#f8fafc;">
            <div style="font-size:16px; font-weight:bold; margin-bottom:12px;">成りますか？</div>
            <div style="display:flex; gap:12px; justify-content:center;">
              <button id="shogiPromoYes" style="background:#f59e0b; color:#fff; border:0; padding:10px 20px; border-radius:8px; font-weight:bold; font-size:14px; cursor:pointer;">成る</button>
              <button id="shogiPromoNo" style="background:#475569; color:#cbd5e1; border:0; padding:10px 20px; border-radius:8px; font-weight:bold; font-size:14px; cursor:pointer;">成らず</button>
            </div>
          </div>
        </div>
      </div>
    `;

    // 難易度ボタン
    function updateDiffUI() {
      ["easy", "normal", "hard"].forEach(d => {
        const btn = document.getElementById("sDiff" + d.charAt(0).toUpperCase() + d.slice(1));
        if (btn) {
          if (d === aiDifficulty) {
            btn.style.background = "#f59e0b";
            btn.style.color = "#fff";
          } else {
            btn.style.background = "#334155";
            btn.style.color = "#cbd5e1";
          }
        }
      });
    }

    document.getElementById("sDiffEasy")?.addEventListener("click", () => { aiDifficulty = "easy"; updateDiffUI(); });
    document.getElementById("sDiffNormal")?.addEventListener("click", () => { aiDifficulty = "normal"; updateDiffUI(); });
    document.getElementById("sDiffHard")?.addEventListener("click", () => { aiDifficulty = "hard"; updateDiffUI(); });
    document.getElementById("shogiResetBtn")?.addEventListener("click", resetGame);
    document.getElementById("shogiResignBtn")?.addEventListener("click", resign);

    function resetGame() {
      board = createBoard();
      hands = { 1: { P: 0, L: 0, N: 0, S: 0, G: 0, B: 0, R: 0 }, 2: { P: 0, L: 0, N: 0, S: 0, G: 0, B: 0, R: 0 } };
      turn = 1;
      selectedSquare = null;
      selectedHandPiece = null;
      isGameOver = false;
      pendingPromoMove = null;
      render();
    }

    function resign() {
      if (isGameOver) return;
      if (!confirm("本当に投了しますか？")) return;
      isGameOver = true;
      const winner = 3 - myRole;
      document.getElementById("shogiStatusBanner").textContent = `🏳️ 投了しました。${winner === 1 ? "▲ 先手" : "▽ 後手"}の勝ちです！`;
      render();
    }

    // 盤面描画
    function render() {
      const grid = document.getElementById("shogiBoardGrid");
      if (!grid) return;
      grid.innerHTML = "";

      const banner = document.getElementById("shogiStatusBanner");
      if (banner && !isGameOver) {
        const isCheck = isKingInCheck(board, turn);
        const turnLabel = turn === 1 ? "▲ 先手" : "▽ 後手";
        const playerNote = isOnline
          ? (turn === myRole ? "（あなた）" : `（${opponentName}）`)
          : (turn === 1 ? "（あなた）" : "（CPU）");
        banner.textContent = `${turnLabel}${playerNote}の手番です${isCheck ? " ⚠️ 王手！" : ""}`;
        banner.style.color = isCheck ? "#ef4444" : "#f59e0b";
      }

      // 有効手の計算
      const legalMoves = (!isGameOver && (!isOnline || turn === myRole)) ? getLegalMoves(board, hands, turn) : [];
      let validDests = [];

      if (selectedSquare) {
        validDests = legalMoves.filter(m => !m.isDrop && m.fromR === selectedSquare.r && m.fromC === selectedSquare.c);
      } else if (selectedHandPiece) {
        validDests = legalMoves.filter(m => m.isDrop && m.pieceType === selectedHandPiece);
      }

      for (let r = 0; r < 9; r++) {
        for (let c = 0; c < 9; c++) {
          const cell = document.createElement("div");
          cell.style.width = "36px";
          cell.style.height = "38px";
          cell.style.background = "#fef3c7";
          cell.style.display = "flex";
          cell.style.flexDirection = "column";
          cell.style.justifyContent = "center";
          cell.style.alignItems = "center";
          cell.style.cursor = "pointer";
          cell.style.position = "relative";
          cell.style.border = "none";

          // 星（黒点 4箇所）
          if ((r === 2 || r === 6) && (c === 2 || c === 6)) {
            const dot = document.createElement("div");
            dot.style.position = "absolute";
            dot.style.bottom = "-2px";
            dot.style.right = "-2px";
            dot.style.width = "4px";
            dot.style.height = "4px";
            dot.style.borderRadius = "50%";
            dot.style.background = "#78350f";
            dot.style.zIndex = "2";
            cell.appendChild(dot);
          }

          const isSelected = selectedSquare && selectedSquare.r === r && selectedSquare.c === c;
          const isValidTarget = validDests.some(m => m.toR === r && m.toC === c);

          if (isSelected) {
            cell.style.background = "#fde047";
          } else if (isValidTarget) {
            cell.style.background = "#bbf7d0";
            const mark = document.createElement("div");
            mark.style.width = "8px";
            mark.style.height = "8px";
            mark.style.borderRadius = "50%";
            mark.style.background = "#16a34a";
            cell.appendChild(mark);
          }

          const p = board[r][c];
          if (p) {
            const pDiv = document.createElement("div");
            const lblKey = (p.promoted ? "+" : "") + p.type;
            const label = (PIECE_LABELS[p.player] && PIECE_LABELS[p.player][lblKey]) || p.type;
            pDiv.textContent = label;
            pDiv.style.fontSize = "17px";
            pDiv.style.fontWeight = "bold";
            pDiv.style.lineHeight = "1";
            pDiv.style.fontFamily = "'Hiragino Mincho ProN', 'Yu Mincho', serif";

            // 成駒は朱色、通常は黒色
            if (p.promoted) {
              pDiv.style.color = "#dc2626";
            } else {
              pDiv.style.color = "#1f2937";
            }

            // 後手は上下反転
            if (p.player === 2) {
              pDiv.style.transform = "rotate(180deg)";
            }

            cell.appendChild(pDiv);
          }

          cell.addEventListener("click", () => handleCellClick(r, c));
          grid.appendChild(cell);
        }
      }

      // 持ち駒描画
      renderHands();
    }

    function renderHands() {
      [1, 2].forEach(pNum => {
        const hContainer = document.getElementById(`shogiHand${pNum}Pieces`);
        if (!hContainer) return;
        hContainer.innerHTML = "";
        const h = hands[pNum] || {};

        HAND_ORDER.forEach(t => {
          const count = h[t] || 0;
          if (count <= 0) return;

          const badge = document.createElement("button");
          badge.style.background = (pNum === turn && selectedHandPiece === t) ? "#fde047" : "#334155";
          badge.style.color = (pNum === turn && selectedHandPiece === t) ? "#1f2937" : "#f8fafc";
          badge.style.border = "1px solid #475569";
          badge.style.borderRadius = "6px";
          badge.style.padding = "2px 6px";
          badge.style.fontSize = "12px";
          badge.style.fontWeight = "bold";
          badge.style.cursor = (pNum === turn && (!isOnline || turn === myRole) && !isGameOver) ? "pointer" : "default";

          const lbl = PIECE_LABELS[pNum][t] || t;
          badge.textContent = `${lbl}×${count}`;

          if (pNum === turn && (!isOnline || turn === myRole) && !isGameOver) {
            badge.addEventListener("click", () => {
              if (selectedHandPiece === t) {
                selectedHandPiece = null;
              } else {
                selectedHandPiece = t;
                selectedSquare = null;
              }
              render();
            });
          }

          hContainer.appendChild(badge);
        });
      });
    }

    function handleCellClick(r, c) {
      if (isGameOver) return;
      if (isOnline && turn !== myRole) return;

      const p = board[r][c];

      // 1. 持ち駒を選択している場合 -> 駒打ち
      if (selectedHandPiece) {
        const legal = getLegalMoves(board, hands, turn);
        const dropMove = legal.find(m => m.isDrop && m.pieceType === selectedHandPiece && m.toR === r && m.toC === c);
        if (dropMove) {
          executeMove(dropMove);
          selectedHandPiece = null;
          return;
        }
      }

      // 2. 盤上の自分の駒を選択した場合
      if (p && p.player === turn) {
        selectedSquare = { r, c };
        selectedHandPiece = null;
        render();
        return;
      }

      // 3. 移動先マスを選択した場合
      if (selectedSquare) {
        const legal = getLegalMoves(board, hands, turn);
        const candMoves = legal.filter(m => !m.isDrop && m.fromR === selectedSquare.r && m.fromC === selectedSquare.c && m.toR === r && m.toC === c);

        if (candMoves.length === 1) {
          executeMove(candMoves[0]);
          selectedSquare = null;
          return;
        } else if (candMoves.length > 1) {
          // 成り / 不成りの選択肢がある場合
          const promoMove = candMoves.find(m => m.promote);
          const noPromoMove = candMoves.find(m => !m.promote);
          askPromotion(promoMove, noPromoMove);
          selectedSquare = null;
          return;
        }
      }

      selectedSquare = null;
      selectedHandPiece = null;
      render();
    }

    function askPromotion(promoMove, noPromoMove) {
      const modal = document.getElementById("shogiPromoModal");
      const yesBtn = document.getElementById("shogiPromoYes");
      const noBtn = document.getElementById("shogiPromoNo");
      if (!modal || !yesBtn || !noBtn) {
        executeMove(promoMove || noPromoMove);
        return;
      }

      modal.style.display = "flex";

      yesBtn.onclick = () => {
        modal.style.display = "none";
        executeMove(promoMove);
      };
      noBtn.onclick = () => {
        modal.style.display = "none";
        executeMove(noPromoMove);
      };
    }

    function executeMove(m) {
      playClickSound();

      if (m.isDrop) {
        board[m.toR][m.toC] = { type: m.pieceType, player: turn, promoted: false };
        hands[turn][m.pieceType]--;
      } else {
        const piece = board[m.fromR][m.fromC];
        if (m.capture) {
          const capType = m.capture.type;
          hands[turn][capType] = (hands[turn][capType] || 0) + 1;
        }
        board[m.toR][m.toC] = { ...piece, promoted: m.promote || piece.promoted };
        board[m.fromR][m.fromC] = null;
      }

      // 王手音
      if (isKingInCheck(board, 3 - turn)) {
        playCheckSound();
      }

      // 詰み判定
      const oppLegal = getLegalMoves(board, hands, 3 - turn);
      if (oppLegal.length === 0) {
        isGameOver = true;
        const winner = turn === 1 ? "▲ 先手" : "▽ 後手";
        document.getElementById("shogiStatusBanner").textContent = `🎉 詰み！${winner}の勝ちです！`;
      }

      turn = 3 - turn;
      render();

      if (isOnline) {
        syncOnlineState(m);
      } else if (!isGameOver && turn === 2) {
        // CPU 手番
        setTimeout(runCpuTurn, 500);
      }
    }

    function runCpuTurn() {
      if (isGameOver || turn !== 2) return;
      const m = pickAiMove(board, hands, 2, aiDifficulty);
      if (!m) {
        isGameOver = true;
        document.getElementById("shogiStatusBanner").textContent = "🎉 相手に指し手がありません。▲ 先手の勝ちです！";
        render();
        return;
      }
      executeMove(m);
    }

    // オンライン同期
    async function syncOnlineState(lastMove) {
      if (!roomCode) return;
      try {
        if (options.onSendMove) {
          options.onSendMove({ board, hands, turn, isGameOver, lastMove });
        } else if (window.api) {
          await window.api(`/api/games/rooms/${roomCode}/update`, {
            method: "POST",
            body: JSON.stringify({
              state: { board, hands, turn, isGameOver, lastMove }
            })
          });
        }
      } catch (err) {
        console.warn("Shogi online sync error:", err);
      }
    }

    // 外部同期受信用
    window._applyRemoteShogiState = function (state) {
      if (!state) return;
      if (state.board) board = state.board;
      if (state.hands) hands = state.hands;
      if (state.turn) turn = state.turn;
      if (state.isGameOver !== undefined) isGameOver = state.isGameOver;
      render();
    };

    window._stopShogi = function () {
      isGameOver = true;
    };

    render();
  };
})();
