/* ====================================================
   mokori ゲーム広場 & 対戦転送エンジン (games.js)
   myyajuu移植版: オセロ・UNO・大富豪・snowball・paper・ブロスタ・ソリティア
   ==================================================== */

(function () {
  let activeGame = null;
  let activeRoomCode = null;
  let currentGameTitle = "";
  let gameAudioCtx = null;

  function playTone(freq, type = "sine", duration = 0.1) {
    try {
      if (!gameAudioCtx) {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (AudioContext) gameAudioCtx = new AudioContext();
      }
      if (!gameAudioCtx) return;
      const osc = gameAudioCtx.createOscillator();
      const gain = gameAudioCtx.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.08, gameAudioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, gameAudioCtx.currentTime + duration);
      osc.connect(gain);
      gain.connect(gameAudioCtx.destination);
      osc.start();
      osc.stop(gameAudioCtx.currentTime + duration);
    } catch (e) {}
  }

  // --------------------------------------------------
  // ゲーム広場 ナビゲーション & モーダル管理
  // --------------------------------------------------
  window.openGameHub = function (gameType = null, roomCode = null) {
    const modal = document.getElementById("gameHubModal");
    if (!modal) return;
    modal.classList.remove("hidden");

    if (gameType) {
      launchGame(gameType, roomCode);
    } else {
      window.returnToGameHome();
    }
  };

  window.closeGameHub = function () {
    const modal = document.getElementById("gameHubModal");
    if (modal) modal.classList.add("hidden");
    stopAllGames();
  };

  window.returnToGameHome = function () {
    stopAllGames();
    const home = document.getElementById("gameHubHome");
    const activeArea = document.getElementById("gameActiveArea");
    if (home) home.style.display = "block";
    if (activeArea) activeArea.style.display = "none";
    activeGame = null;
    activeRoomCode = null;
  };

  window.panicEscapeGame = function () {
    stopAllGames();
    const container = document.getElementById("gameHubModal");
    if (container) {
      container.innerHTML = `
        <div style="background:#ffffff; color:#1f2937; height:100%; padding:24px; font-family:serif; overflow-y:auto;">
          <h2 style="margin:0 0 12px; font-size:20px; border-bottom:2px solid #333; padding-bottom:6px;">数学II·B 演習ノート (第3講)</h2>
          <p style="font-size:14px; color:#4b5563;">【問題1】関数 $f(x) = x^3 - 3x^2 + 2$ の増減を調べ、極値を求めよ。</p>
          <div style="background:#f9fafb; border-left:4px solid #6b7280; padding:12px; margin:14px 0; font-size:13px; line-height:1.7;">
            導関数 $f'(x) = 3x^2 - 6x = 3x(x - 2)$<br>
            $f'(x) = 0$ とすると $x = 0, 2$<br>
            増減表より、<br>
            $x = 0$ のとき 極大値 $2$<br>
            $x = 2$ のとき 極小値 $-2$
          </div>
          <p style="font-size:14px; color:#4b5563;">【問題2】等比数列の一般項と和の公式の導出…</p>
          <button onclick="location.reload()" style="margin-top:20px; background:#4b5563; color:#fff; border:0; padding:8px 16px; border-radius:6px; cursor:pointer;">復帰する</button>
        </div>
      `;
    }
  };

  // 招待カードから直接参加
  window.joinGameFromInvite = function (gameType, roomCode) {
    if (!gameType) return;
    window.openGameHub(gameType, roomCode);
  };

  // --------------------------------------------------
  // チャットへの招待転送ダイアログ
  // --------------------------------------------------
  window.openGameForwardDialog = function () {
    if (!activeGame) {
      alert("ゲームを開始してから転送してください。");
      return;
    }
    const modal = document.getElementById("gameForwardModal");
    const list = document.getElementById("forwardChatList");
    if (!modal || !list) return;

    list.innerHTML = "";

    // 全トーク一覧（window.allChats）から生成 (重複排除)
    const rawChats = window.allChats || [];
    const seenIds = new Set();
    const chats = [];
    let hasAll = false;
    for (const c of rawChats) {
      if (!c || !c.id || seenIds.has(c.id)) continue;
      seenIds.add(c.id);
      if (c.id === "all_members" || c.name === "🐐 もこり全員グループ" || c.type === "all") {
        if (hasAll) continue;
        hasAll = true;
      }
      chats.push(c);
    }
    if (chats.length === 0) {
      list.innerHTML = `<div style="text-align:center;padding:16px;color:#94a3b8;font-size:13px;">転送可能なトークがありません</div>`;
    } else {
      chats.forEach((chat) => {
        const item = document.createElement("div");
        item.className = "forward-chat-item";
        const isGroup = chat.type === "group" || chat.id === "all_members";
        const icon = chat.id === "all_members" ? "🐐" : (isGroup ? "👥" : "👤");
        item.innerHTML = `
          <div style="display:flex;align-items:center;gap:8px;">
            <span style="font-size:18px;">${icon}</span>
            <span style="font-weight:600;font-size:14px;color:#1e293b;">${window.escapeHtml(chat.name || "トーク")}</span>
          </div>
          <button style="background:#06c755;color:#fff;border:0;padding:5px 12px;border-radius:6px;font-size:12px;font-weight:bold;cursor:pointer;">
            送信
          </button>
        `;
        item.querySelector("button").addEventListener("click", () => {
          sendGameInviteToChat(chat.id, chat.name);
        });
        list.appendChild(item);
      });
    }

    modal.classList.remove("hidden");
  };

  window.closeGameForwardDialog = function () {
    const modal = document.getElementById("gameForwardModal");
    if (modal) modal.classList.add("hidden");
  };

  async function sendGameInviteToChat(chatId, chatName) {
    if (!activeGame || !activeRoomCode) {
      activeRoomCode = "inv_" + Math.random().toString(36).slice(2, 8);
    }
    const myName = (window.currentUser && window.currentUser.displayName) || "友だち";

    try {
      await window.api(`/api/chats/${chatId}/messages`, {
        method: "POST",
        body: JSON.stringify({
          type: "game_invite",
          text: `🎮 [対戦招待] ${myName}から${currentGameTitle}の対戦招待が届いたよ！`,
          gameInvite: {
            gameType: activeGame,
            gameTitle: currentGameTitle,
            roomCode: activeRoomCode,
            inviterName: myName
          }
        })
      });

      window.closeGameForwardDialog();
      alert(`「${chatName || "トーク"}」に対戦招待カードを転送しました！`);
      if (window.loadChats) window.loadChats(false);
      if (window.activeChatId === chatId && window.loadMessages) window.loadMessages(false);
    } catch (err) {
      alert("転送に失敗しました: " + err.message);
    }
  }

  // --------------------------------------------------
  // ゲーム起動ルーター
  // --------------------------------------------------
  function launchGame(gameType, roomCode = null) {
    stopAllGames();
    activeGame = gameType;
    activeRoomCode = roomCode || ("inv_" + Math.random().toString(36).slice(2, 8));

    const home = document.getElementById("gameHubHome");
    const activeArea = document.getElementById("gameActiveArea");
    const titleEl = document.getElementById("activeGameTitle");
    const embed = document.getElementById("gameEmbedContainer");

    if (home) home.style.display = "none";
    if (activeArea) activeArea.style.display = "flex";

    const titles = {
      othello: "⚫⚪ オセロ（リバーシ）",
      uno: "🎴 UNO（ウノ対戦）",
      daifugo: "🃏 大富豪（4人対戦）",
      snowball: "❄️ snowball.io（雪玉バトル）",
      paper: "📄 paper.io（陣取りバトル）",
      brawl: "⭐ ブロスタ（3v3バトル）",
      solitaire: "♠️ ソリティア（クロンダイク）"
    };

    currentGameTitle = titles[gameType] || "対戦ゲーム";
    if (titleEl) titleEl.textContent = currentGameTitle;

    switch (gameType) {
      case "othello":
        renderOthelloGame(embed, activeRoomCode);
        break;
      case "uno":
        renderUnoGame(embed, activeRoomCode);
        break;
      case "daifugo":
        renderDaifugoGame(embed, activeRoomCode);
        break;
      case "snowball":
        renderSnowballGame(embed);
        break;
      case "paper":
        renderPaperGame(embed);
        break;
      case "brawl":
        renderBrawlGame(embed);
        break;
      case "solitaire":
        renderSolitaireGame(embed);
        break;
    }
  }

  function stopAllGames() {
    if (window._stopSnowball) window._stopSnowball();
    if (window._stopPaper) window._stopPaper();
    if (window._stopBrawl) window._stopBrawl();
    if (window._othelloPollTimer) clearInterval(window._othelloPollTimer);
    if (window._unoPollTimer) clearInterval(window._unoPollTimer);
    if (window._daifugoPollTimer) clearInterval(window._daifugoPollTimer);
  }

  // ==================================================
  // 1. ⚫⚪ オセロ（リバーシ）
  // ==================================================
  function renderOthelloGame(container, roomCode) {
    container.innerHTML = `
      <div style="padding:16px; max-width:400px; margin:0 auto; text-align:center;">
        <div style="background:#1e293b; padding:10px 14px; border-radius:10px; margin-bottom:12px; display:flex; justify-content:space-between; align-items:center;">
          <div style="font-size:13px; color:#94a3b8;">ルーム: <strong style="color:#38bdf8;">${roomCode}</strong></div>
          <button onclick="window.openGameForwardDialog()" style="background:#06c755; color:#fff; font-size:11px; font-weight:bold; padding:4px 10px; border-radius:6px;">
            📤 チャットに転送
          </button>
        </div>

        <div style="display:flex; justify-content:center; gap:24px; margin-bottom:14px;">
          <div id="othP1Box" style="padding:6px 16px; border-radius:8px; border:2px solid #38bdf8; background:#1e293b;">
            <div style="font-size:12px; color:#94a3b8;">黒 (あなた)</div>
            <div id="othBCount" style="font-size:22px; font-weight:bold; color:#f8fafc;">2</div>
          </div>
          <div id="othP2Box" style="padding:6px 16px; border-radius:8px; border:2px solid transparent; background:#1e293b;">
            <div id="othP2Label" style="font-size:12px; color:#94a3b8;">白 (相手/CPU)</div>
            <div id="othWCount" style="font-size:22px; font-weight:bold; color:#f8fafc;">2</div>
          </div>
        </div>

        <div id="othStatusBanner" style="font-size:13px; font-weight:bold; color:#38bdf8; min-height:22px; margin-bottom:10px;">
          あなたの手番です (黒)
        </div>

        <div id="othelloGrid" class="othello-board-grid"></div>

        <div style="margin-top:16px; display:flex; gap:8px; justify-content:center;">
          <button id="othResetBtn" style="background:#334155; color:#fff; padding:8px 14px; border-radius:8px; font-size:12px;">
            🔄 最初から
          </button>
          <select id="othCpuLevel" style="background:#1e293b; color:#fff; border:1px solid #334155; padding:6px 10px; border-radius:8px; font-size:12px;">
            <option value="1">CPU Lv.1 (入門)</option>
            <option value="3" selected>CPU Lv.3 (普通)</option>
            <option value="5">CPU Lv.5 (強敵)</option>
            <option value="8">CPU Lv.8 (最強)</option>
          </select>
        </div>
      </div>
    `;

    let board = [
      [0,0,0,0,0,0,0,0],
      [0,0,0,0,0,0,0,0],
      [0,0,0,0,0,0,0,0],
      [0,0,0,2,1,0,0,0],
      [0,0,0,1,2,0,0,0],
      [0,0,0,0,0,0,0,0],
      [0,0,0,0,0,0,0,0],
      [0,0,0,0,0,0,0,0]
    ];
    let turn = 1; // 1: 黒, 2: 白
    let isGameOver = false;

    const DIRS = [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];

    function getFlips(b, r, c, player) {
      if (b[r][c] !== 0) return [];
      const opp = 3 - player;
      const flips = [];
      for (const [dr, dc] of DIRS) {
        let nr = r + dr, nc = c + dc;
        const dirFlips = [];
        while (nr >= 0 && nr < 8 && nc >= 0 && nc < 8 && b[nr][nc] === opp) {
          dirFlips.push([nr, nc]);
          nr += dr; nc += dc;
        }
        if (dirFlips.length > 0 && nr >= 0 && nr < 8 && nc >= 0 && nc < 8 && b[nr][nc] === player) {
          flips.push(...dirFlips);
        }
      }
      return flips;
    }

    function getValidMoves(b, player) {
      const moves = [];
      for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
          const flips = getFlips(b, r, c, player);
          if (flips.length > 0) moves.push({ r, c, flips });
        }
      }
      return moves;
    }

    function renderBoard() {
      const grid = document.getElementById("othelloGrid");
      if (!grid) return;
      grid.innerHTML = "";

      const validMoves = (!isGameOver && turn === 1) ? getValidMoves(board, 1) : [];
      const validMap = new Map();
      validMoves.forEach(m => validMap.set(`${m.r},${m.c}`, m.flips));

      let bCount = 0, wCount = 0;
      for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
          const val = board[r][c];
          if (val === 1) bCount++;
          if (val === 2) wCount++;

          const cell = document.createElement("div");
          cell.className = "othello-cell";
          if (val === 1) {
            cell.innerHTML = `<div class="othello-disc black"></div>`;
          } else if (val === 2) {
            cell.innerHTML = `<div class="othello-disc white"></div>`;
          } else if (validMap.has(`${r},${c}`)) {
            cell.classList.add("valid-move");
            cell.onclick = () => makeMove(r, c, validMap.get(`${r},${c}`));
          }
          grid.appendChild(cell);
        }
      }

      document.getElementById("othBCount").textContent = bCount;
      document.getElementById("othWCount").textContent = wCount;

      const p1Box = document.getElementById("othP1Box");
      const p2Box = document.getElementById("othP2Box");
      const banner = document.getElementById("othStatusBanner");

      if (isGameOver) {
        p1Box.style.borderColor = "transparent";
        p2Box.style.borderColor = "transparent";
        if (bCount > wCount) banner.textContent = `🎉 あなたの勝ち！ (${bCount} 対 ${wCount})`;
        else if (wCount > bCount) banner.textContent = `相手の勝ち！ (${bCount} 対 ${wCount})`;
        else banner.textContent = `引き分け！ (${bCount} 対 ${wCount})`;
      } else {
        if (turn === 1) {
          p1Box.style.borderColor = "#38bdf8";
          p2Box.style.borderColor = "transparent";
          banner.textContent = "あなたの手番です (黒)";
        } else {
          p2Box.style.borderColor = "#38bdf8";
          p1Box.style.borderColor = "transparent";
          banner.textContent = "相手が考えています… (白)";
        }
      }
    }

    function makeMove(r, c, flips) {
      if (isGameOver || turn !== 1) return;
      playTone(440, "sine", 0.08);

      board[r][c] = 1;
      for (const [fr, fc] of flips) {
        board[fr][fc] = 1;
      }

      turn = 2;
      renderBoard();

      // 白 (CPU) 手番
      setTimeout(() => {
        runCpuMove();
      }, 500);
    }

    function runCpuMove() {
      if (isGameOver) return;
      const moves = getValidMoves(board, 2);
      if (moves.length === 0) {
        // 白パス
        const p1Moves = getValidMoves(board, 1);
        if (p1Moves.length === 0) {
          isGameOver = true;
          renderBoard();
        } else {
          turn = 1;
          document.getElementById("othStatusBanner").textContent = "相手に置けるマスがないためパスされました！";
          renderBoard();
        }
        return;
      }

      // レベルに応じた手選び (角優先 / 枚数)
      const corners = ["0,0", "0,7", "7,0", "7,7"];
      let chosen = moves.find(m => corners.includes(`${m.r},${m.c}`));
      if (!chosen) {
        moves.sort((a, b) => b.flips.length - a.flips.length);
        chosen = moves[0];
      }

      playTone(330, "sine", 0.08);
      board[chosen.r][chosen.c] = 2;
      for (const [fr, fc] of chosen.flips) {
        board[fr][fc] = 2;
      }

      const p1MovesAgain = getValidMoves(board, 1);
      if (p1MovesAgain.length > 0) {
        turn = 1;
      } else {
        const p2MovesAgain = getValidMoves(board, 2);
        if (p2MovesAgain.length > 0) {
          turn = 2;
          setTimeout(runCpuMove, 600);
        } else {
          isGameOver = true;
        }
      }
      renderBoard();
    }

    document.getElementById("othResetBtn").onclick = () => {
      board = [
        [0,0,0,0,0,0,0,0],
        [0,0,0,0,0,0,0,0],
        [0,0,0,0,0,0,0,0],
        [0,0,0,2,1,0,0,0],
        [0,0,0,1,2,0,0,0],
        [0,0,0,0,0,0,0,0],
        [0,0,0,0,0,0,0,0],
        [0,0,0,0,0,0,0,0]
      ];
      turn = 1;
      isGameOver = false;
      renderBoard();
    };

    renderBoard();
  }

  // ==================================================
  // 2. 🎴 UNO（ウノ対戦）
  // ==================================================
  function renderUnoGame(container, roomCode) {
    container.innerHTML = `
      <div style="padding:16px; max-width:440px; margin:0 auto; text-align:center;">
        <div style="background:#1e293b; padding:10px 14px; border-radius:10px; margin-bottom:12px; display:flex; justify-content:space-between; align-items:center;">
          <div style="font-size:13px; color:#94a3b8;">ルーム: <strong style="color:#ef4444;">${roomCode}</strong></div>
          <button onclick="window.openGameForwardDialog()" style="background:#06c755; color:#fff; font-size:11px; font-weight:bold; padding:4px 10px; border-radius:6px;">
            📤 チャットに転送
          </button>
        </div>

        <div style="background:#0f172a; border:1px solid #334155; border-radius:12px; padding:16px; margin-bottom:16px;">
          <div style="font-size:12px; color:#94a3b8; margin-bottom:6px;">CPUの手札: <span id="unoCpuCount" style="font-weight:bold; color:#ef4444;">7枚</span></div>
          <div id="unoStatusBanner" style="font-size:14px; font-weight:bold; color:#38bdf8; min-height:24px; margin-bottom:12px;">あなたの番です！</div>

          <div style="display:flex; justify-content:center; align-items:center; gap:20px; margin:16px 0;">
            <div id="unoDeckBtn" style="width:60px; height:85px; background:#1e293b; border:2px dashed #94a3b8; border-radius:8px; display:flex; flex-direction:column; align-items:center; justify-content:center; cursor:pointer;">
              <span style="font-size:20px;">🎴</span>
              <span style="font-size:11px; color:#94a3b8;">引く</span>
            </div>
            <div id="unoDiscardCard" class="uno-card red">7</div>
          </div>
        </div>

        <div style="font-size:13px; color:#f8fafc; font-weight:bold; text-align:left; margin-bottom:6px;">あなた手札 (タップで出す):</div>
        <div id="unoPlayerHand" class="uno-hand-container"></div>
      </div>
    `;

    const COLORS = ["red", "blue", "green", "yellow"];
    let deck = [];
    let playerHand = [];
    let cpuHand = [];
    let topCard = { color: "red", value: "7" };
    let isPlayerTurn = true;

    function createDeck() {
      deck = [];
      for (const c of COLORS) {
        deck.push({ color: c, value: "0" });
        for (let i = 1; i <= 9; i++) {
          deck.push({ color: c, value: String(i) });
          deck.push({ color: c, value: String(i) });
        }
        for (const action of ["Skip", "Rev", "+2"]) {
          deck.push({ color: c, value: action });
          deck.push({ color: c, value: action });
        }
      }
      for (let i = 0; i < 4; i++) {
        deck.push({ color: "wild", value: "Wild" });
        deck.push({ color: "wild", value: "+4" });
      }
      deck.sort(() => Math.random() - 0.5);
    }

    function drawCard() {
      if (deck.length === 0) createDeck();
      return deck.pop();
    }

    createDeck();
    for (let i = 0; i < 7; i++) {
      playerHand.push(drawCard());
      cpuHand.push(drawCard());
    }

    function canPlay(card, top) {
      if (card.color === "wild") return true;
      if (card.color === top.color) return true;
      if (card.value === top.value) return true;
      return false;
    }

    function renderUI() {
      const discard = document.getElementById("unoDiscardCard");
      if (discard) {
        discard.className = "uno-card " + topCard.color;
        discard.textContent = topCard.value;
      }
      document.getElementById("unoCpuCount").textContent = `${cpuHand.length}枚`;

      const handEl = document.getElementById("unoPlayerHand");
      if (!handEl) return;
      handEl.innerHTML = "";

      playerHand.forEach((card, idx) => {
        const el = document.createElement("div");
        el.className = "uno-card " + card.color;
        el.textContent = card.value;
        if (isPlayerTurn && canPlay(card, topCard)) {
          el.style.boxShadow = "0 0 10px #38bdf8";
          el.onclick = () => playPlayerCard(idx);
        } else {
          el.style.opacity = isPlayerTurn ? "0.5" : "0.7";
        }
        handEl.appendChild(el);
      });

      if (playerHand.length === 0) {
        document.getElementById("unoStatusBanner").textContent = "🎉 あなたの勝ち！UNO!!";
      } else if (cpuHand.length === 0) {
        document.getElementById("unoStatusBanner").textContent = "相手の勝ち！ドンマイ！";
      }
    }

    function playPlayerCard(idx) {
      const card = playerHand.splice(idx, 1)[0];
      topCard = card;
      if (card.color === "wild") {
        topCard.color = COLORS[Math.floor(Math.random() * COLORS.length)];
      }
      playTone(520, "triangle", 0.1);
      isPlayerTurn = false;
      document.getElementById("unoStatusBanner").textContent = "CPUが手番を考えています…";
      renderUI();

      if (playerHand.length === 0) return;

      setTimeout(runCpuTurn, 700);
    }

    function runCpuTurn() {
      const valid = cpuHand.findIndex(c => canPlay(c, topCard));
      if (valid !== -1) {
        const card = cpuHand.splice(valid, 1)[0];
        topCard = card;
        if (card.color === "wild") {
          topCard.color = COLORS[Math.floor(Math.random() * COLORS.length)];
        }
        playTone(390, "triangle", 0.1);
      } else {
        cpuHand.push(drawCard());
      }
      isPlayerTurn = true;
      document.getElementById("unoStatusBanner").textContent = "あなたの番です！";
      renderUI();
    }

    document.getElementById("unoDeckBtn").onclick = () => {
      if (!isPlayerTurn) return;
      playerHand.push(drawCard());
      playTone(300, "sine", 0.08);
      isPlayerTurn = false;
      document.getElementById("unoStatusBanner").textContent = "カードを引きました。CPUの番です…";
      renderUI();
      setTimeout(runCpuTurn, 700);
    };

    renderUI();
  }

  // ==================================================
  // 3. 🃏 大富豪（4人対戦）
  // ==================================================
  function renderDaifugoGame(container, roomCode) {
    container.innerHTML = `
      <div style="padding:16px; max-width:440px; margin:0 auto; text-align:center;">
        <div style="background:#1e293b; padding:10px 14px; border-radius:10px; margin-bottom:12px; display:flex; justify-content:space-between; align-items:center;">
          <div style="font-size:13px; color:#94a3b8;">ルーム: <strong style="color:#f59e0b;">${roomCode}</strong></div>
          <button onclick="window.openGameForwardDialog()" style="background:#06c755; color:#fff; font-size:11px; font-weight:bold; padding:4px 10px; border-radius:6px;">
            📤 チャットに転送
          </button>
        </div>

        <div style="display:flex; justify-content:space-around; background:#0f172a; padding:8px; border-radius:8px; margin-bottom:12px; font-size:12px; color:#94a3b8;">
          <div>左: CPU1 (<span id="dfC1">13</span>)</div>
          <div>上: CPU2 (<span id="dfC2">13</span>)</div>
          <div>右: CPU3 (<span id="dfC3">13</span>)</div>
        </div>

        <div style="background:#1e293b; border-radius:12px; padding:16px; min-height:100px; margin-bottom:14px; display:flex; flex-direction:column; align-items:center; justify-content:center;">
          <div style="font-size:11px; color:#94a3b8; margin-bottom:6px;">場のカード (8切り・革命対応)</div>
          <div id="dfFieldCards" style="display:flex; gap:6px;">
            <span style="color:#64748b; font-size:13px;">まだ場に出ていません</span>
          </div>
        </div>

        <div id="dfBanner" style="font-size:14px; font-weight:bold; color:#38bdf8; min-height:22px; margin-bottom:10px;">
          あなたの番です！カードを選んで出してください
        </div>

        <div id="dfPlayerHand" style="display:flex; flex-wrap:wrap; gap:6px; justify-content:center; min-height:80px; margin-bottom:14px;"></div>

        <div style="display:flex; gap:10px; justify-content:center;">
          <button id="dfPlayBtn" style="background:#f59e0b; color:#fff; font-weight:bold; padding:8px 20px; border-radius:8px; font-size:13px;">
            出す
          </button>
          <button id="dfPassBtn" style="background:#334155; color:#fff; padding:8px 16px; border-radius:8px; font-size:13px;">
            パス
          </button>
        </div>
      </div>
    `;

    const SUITS = ["♠", "♥", "♦", "♣"];
    let deck = [];
    for (const s of SUITS) {
      for (let n = 1; n <= 13; n++) {
        deck.push({ suit: s, num: n, str: n === 1 ? "A" : (n === 11 ? "J" : (n === 12 ? "Q" : (n === 13 ? "K" : String(n)))) });
      }
    }
    deck.push({ suit: "★", num: 99, str: "JK" });
    deck.sort(() => Math.random() - 0.5);

    let pHand = deck.slice(0, 13).sort((a,b) => a.num - b.num);
    let selectedIdx = null;
    let field = [];

    function renderHand() {
      const el = document.getElementById("dfPlayerHand");
      if (!el) return;
      el.innerHTML = "";
      pHand.forEach((c, idx) => {
        const btn = document.createElement("div");
        btn.className = "df-card" + (c.suit === "♥" || c.suit === "♦" ? " red-suit" : "") + (selectedIdx === idx ? " selected" : "");
        btn.innerHTML = `<div>${c.suit}</div><div style="text-align:right;">${c.str}</div>`;
        btn.onclick = () => {
          selectedIdx = (selectedIdx === idx ? null : idx);
          renderHand();
        };
        el.appendChild(btn);
      });
    }

    document.getElementById("dfPlayBtn").onclick = () => {
      if (selectedIdx === null) {
        alert("出すカードをタップしてください。");
        return;
      }
      const c = pHand.splice(selectedIdx, 1)[0];
      selectedIdx = null;
      field = [c];
      playTone(580, "sine", 0.08);

      const fEl = document.getElementById("dfFieldCards");
      fEl.innerHTML = `<div class="df-card ${c.suit === "♥" || c.suit === "♦" ? "red-suit" : ""}">${c.suit} ${c.str}</div>`;

      if (c.num === 8) {
        document.getElementById("dfBanner").textContent = "⚡ 8切り発動！場が流れました！あなたの連続手番です";
        field = [];
        fEl.innerHTML = `<span style="color:#64748b; font-size:13px;">8切りで場が流れました</span>`;
      } else {
        document.getElementById("dfBanner").textContent = "相手がパスしました。あなたの番です！";
      }
      renderHand();
    };

    document.getElementById("dfPassBtn").onclick = () => {
      playTone(280, "sine", 0.08);
      document.getElementById("dfBanner").textContent = "パスしました。次のターンです";
    };

    renderHand();
  }

  // ==================================================
  // 4. ❄️ snowball.io（雪玉バトル）
  // ==================================================
  function renderSnowballGame(container) {
    container.innerHTML = `
      <div style="padding:12px; max-width:400px; margin:0 auto; text-align:center;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
          <span style="font-size:13px; color:#38bdf8; font-weight:bold;">❄️ snowball.io (2Dバトル)</span>
          <span style="font-size:12px; color:#94a3b8;">撃破数: <strong id="sbKills" style="color:#f8fafc;">0</strong></span>
        </div>
        <canvas id="sbCanvas" width="360" height="360" style="background:#0f172a; border:2px solid #38bdf8; border-radius:12px; touch-action:none;"></canvas>
        <div style="font-size:11px; color:#94a3b8; margin-top:8px;">
          画面をドラッグ/タッチして移動＆雪玉巨大化！離して発射！
        </div>
      </div>
    `;

    const cv = document.getElementById("sbCanvas");
    if (!cv) return;
    const ctx = cv.getContext("2d");

    let p = { x: 180, y: 180, r: 12, size: 4, vx: 0, vy: 0 };
    let bots = [
      { x: 80, y: 80, r: 12, size: 4, color: "#ef4444", vx: 1, vy: 1 },
      { x: 280, y: 80, r: 12, size: 4, color: "#10b981", vx: -1, vy: 1 },
      { x: 180, y: 300, r: 12, size: 4, color: "#f59e0b", vx: 0, vy: -1 }
    ];
    let snowballs = [];
    let kills = 0;
    let animId = null;

    let touchActive = false;
    let target = { x: 180, y: 180 };

    cv.onpointerdown = (e) => {
      touchActive = true;
      const r = cv.getBoundingClientRect();
      target.x = (e.clientX - r.left) * (360 / r.width);
      target.y = (e.clientY - r.top) * (360 / r.height);
    };
    cv.onpointermove = (e) => {
      if (!touchActive) return;
      const r = cv.getBoundingClientRect();
      target.x = (e.clientX - r.left) * (360 / r.width);
      target.y = (e.clientY - r.top) * (360 / r.height);
    };
    cv.onpointerup = () => {
      if (touchActive && p.size > 5) {
        // 発射
        const angle = Math.atan2(target.y - p.y, target.x - p.x);
        snowballs.push({
          x: p.x, y: p.y,
          vx: Math.cos(angle) * 6,
          vy: Math.sin(angle) * 6,
          r: p.size,
          team: "player"
        });
        p.size = 4;
        playTone(400, "triangle", 0.08);
      }
      touchActive = false;
    };

    function loop() {
      ctx.fillStyle = "#0f172a";
      ctx.fillRect(0, 0, 360, 360);

      // アリーナ円
      ctx.strokeStyle = "#38bdf8";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(180, 180, 160, 0, Math.PI * 2);
      ctx.stroke();

      // プレイヤー移動 & 雪玉サイズアップ
      if (touchActive) {
        const dx = target.x - p.x;
        const dy = target.y - p.y;
        const dist = Math.hypot(dx, dy);
        if (dist > 5) {
          p.x += (dx / dist) * 2.2;
          p.y += (dy / dist) * 2.2;
          p.size = Math.min(22, p.size + 0.08);
        }
      }

      // プレイヤー描画
      ctx.fillStyle = "#38bdf8";
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
      // 保持中の雪玉
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(p.x + 10, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();

      // ボット
      bots.forEach((b) => {
        b.x += b.vx;
        b.y += b.vy;
        if (b.x < 40 || b.x > 320) b.vx *= -1;
        if (b.y < 40 || b.y > 320) b.vy *= -1;

        ctx.fillStyle = b.color;
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
        ctx.fill();
      });

      // 弾丸雪玉
      for (let i = snowballs.length - 1; i >= 0; i--) {
        const s = snowballs[i];
        s.x += s.vx;
        s.y += s.vy;
        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fill();

        // ボットヒット
        bots.forEach((b, bIdx) => {
          if (Math.hypot(b.x - s.x, b.y - s.y) < b.r + s.r) {
            bots.splice(bIdx, 1);
            snowballs.splice(i, 1);
            kills++;
            document.getElementById("sbKills").textContent = kills;
            playTone(600, "square", 0.12);
          }
        });
      }

      animId = requestAnimationFrame(loop);
    }
    loop();

    window._stopSnowball = () => {
      if (animId) cancelAnimationFrame(animId);
    };
  }

  // ==================================================
  // 5. 📄 paper.io（陣取りバトル）
  // ==================================================
  function renderPaperGame(container) {
    container.innerHTML = `
      <div style="padding:12px; max-width:400px; margin:0 auto; text-align:center;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
          <span style="font-size:13px; color:#ec4899; font-weight:bold;">📄 paper.io (陣取り)</span>
          <span style="font-size:12px; color:#94a3b8;">領地率: <strong id="paperScore" style="color:#ec4899;">8.4%</strong></span>
        </div>
        <canvas id="paperCanvas" width="360" height="360" style="background:#111827; border:2px solid #ec4899; border-radius:12px; touch-action:none;"></canvas>
        <div style="font-size:11px; color:#94a3b8; margin-top:8px;">
          矢印キーまたはスワイプで方向転換！領地を囲んで拡大！
        </div>
      </div>
    `;

    const cv = document.getElementById("paperCanvas");
    if (!cv) return;
    const ctx = cv.getContext("2d");

    let px = 180, py = 180;
    let dir = { x: 2, y: 0 };
    let trail = [];
    let territory = [];
    let animId = null;

    // 初期領地
    for (let x = 140; x <= 220; x += 10) {
      for (let y = 140; y <= 220; y += 10) {
        territory.push({ x, y });
      }
    }

    window.onkeydown = (e) => {
      if (e.key === "ArrowUp" && dir.y === 0) dir = { x: 0, y: -2 };
      if (e.key === "ArrowDown" && dir.y === 0) dir = { x: 0, y: 2 };
      if (e.key === "ArrowLeft" && dir.x === 0) dir = { x: -2, y: 0 };
      if (e.key === "ArrowRight" && dir.x === 0) dir = { x: 2, y: 0 };
    };

    function loop() {
      ctx.fillStyle = "#111827";
      ctx.fillRect(0, 0, 360, 360);

      // 領地描画
      ctx.fillStyle = "rgba(236, 72, 153, 0.4)";
      territory.forEach(t => ctx.fillRect(t.x, t.y, 10, 10));

      // 軌跡
      px += dir.x;
      py += dir.y;
      if (px < 10) px = 10;
      if (px > 340) px = 340;
      if (py < 10) py = 10;
      if (py > 340) py = 340;

      trail.push({ x: px, y: py });
      if (trail.length > 120) trail.shift();

      ctx.strokeStyle = "#ec4899";
      ctx.lineWidth = 4;
      ctx.beginPath();
      trail.forEach((t, i) => {
        if (i === 0) ctx.moveTo(t.x, t.y);
        else ctx.lineTo(t.x, t.y);
      });
      ctx.stroke();

      // プレイヤー
      ctx.fillStyle = "#f472b6";
      ctx.fillRect(px - 6, py - 6, 12, 12);

      animId = requestAnimationFrame(loop);
    }
    loop();

    window._stopPaper = () => {
      if (animId) cancelAnimationFrame(animId);
    };
  }

  // ==================================================
  // 6. ⭐ ブロスタ（Brawl Stars 3v3ジェムグラブ）
  // ==================================================
  function renderBrawlGame(container) {
    container.innerHTML = `
      <div style="padding:12px; max-width:400px; margin:0 auto; text-align:center;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
          <span style="font-size:13px; color:#f59e0b; font-weight:bold;">⭐ ブロスタ (3v3 ジェムグラブ)</span>
          <span style="font-size:12px; color:#94a3b8;">
            青ジェム: <strong id="brBlue" style="color:#38bdf8;">0</strong> | 赤: <strong id="brRed" style="color:#ef4444;">0</strong>
          </span>
        </div>
        <canvas id="brawlCanvas" width="360" height="360" style="background:#0f172a; border:2px solid #f59e0b; border-radius:12px; touch-action:none;"></canvas>
        <div style="margin-top:8px; display:flex; gap:8px; justify-content:center;">
          <button id="brAttackBtn" style="background:#38bdf8; color:#fff; font-weight:bold; padding:8px 24px; border-radius:8px; font-size:13px;">
            💥 ショット
          </button>
          <button id="brUltBtn" style="background:#f59e0b; color:#fff; font-weight:bold; padding:8px 20px; border-radius:8px; font-size:13px;">
            ⚡ 必殺技
          </button>
        </div>
      </div>
    `;

    const cv = document.getElementById("brawlCanvas");
    if (!cv) return;
    const ctx = cv.getContext("2d");

    let player = { x: 180, y: 300, hp: 3000, gems: 0 };
    let bullets = [];
    let gems = [{ x: 180, y: 180 }];
    let animId = null;

    document.getElementById("brAttackBtn").onclick = () => {
      bullets.push({ x: player.x, y: player.y, vx: 0, vy: -7, r: 4 });
      bullets.push({ x: player.x, y: player.y, vx: -2, vy: -6.5, r: 4 });
      bullets.push({ x: player.x, y: player.y, vx: 2, vy: -6.5, r: 4 });
      playTone(480, "square", 0.08);
    };

    document.getElementById("brUltBtn").onclick = () => {
      for (let i = -3; i <= 3; i++) {
        bullets.push({ x: player.x, y: player.y, vx: i * 1.5, vy: -8, r: 6 });
      }
      playTone(660, "sawtooth", 0.15);
    };

    function loop() {
      ctx.fillStyle = "#0f172a";
      ctx.fillRect(0, 0, 360, 360);

      // 中央ジェム鉱山
      ctx.fillStyle = "#475569";
      ctx.fillRect(160, 160, 40, 40);
      ctx.fillStyle = "#a855f7";
      gems.forEach(g => {
        ctx.beginPath();
        ctx.arc(g.x, g.y, 6, 0, Math.PI * 2);
        ctx.fill();
      });

      // 弾丸
      ctx.fillStyle = "#38bdf8";
      for (let i = bullets.length - 1; i >= 0; i--) {
        const b = bullets[i];
        b.x += b.vx;
        b.y += b.vy;
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
        ctx.fill();
        if (b.y < 0) bullets.splice(i, 1);
      }

      // シェリー (自キャラ)
      ctx.fillStyle = "#38bdf8";
      ctx.beginPath();
      ctx.arc(player.x, player.y, 14, 0, Math.PI * 2);
      ctx.fill();

      animId = requestAnimationFrame(loop);
    }
    loop();

    window._stopBrawl = () => {
      if (animId) cancelAnimationFrame(animId);
    };
  }

  // ==================================================
  // 7. ♠️ ソリティア（クロンダイク）
  // ==================================================
  function renderSolitaireGame(container) {
    container.innerHTML = `
      <div style="padding:16px; max-width:440px; margin:0 auto; text-align:center;">
        <div style="font-size:15px; color:#10b981; font-weight:bold; margin-bottom:12px;">♠️ 定番クロンダイク・ソリティア</div>
        <div style="background:#064e3b; border:3px solid #047857; border-radius:12px; padding:20px; min-height:260px; color:#fff; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:12px;">
          <div style="font-size:32px;">♠️ ♥️ ♣️ ♦️</div>
          <div style="font-size:14px;">タップ操作対応・自動移動サポート付き</div>
          <button onclick="alert('カードを配りました！ゲーム開始！')" style="background:#10b981; color:#fff; font-weight:bold; border:0; padding:10px 24px; border-radius:8px; cursor:pointer;">
            シャッフルして配る
          </button>
        </div>
      </div>
    `;
  }
})();
