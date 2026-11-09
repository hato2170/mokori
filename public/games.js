/* ====================================================
   mokori ゲーム広場 & 対戦転送エンジン (games.js)
   myyajuu移植版: オセロ・UNO・大富豪・snowball・paper・ブロスタ・ソリティア
   ==================================================== */

(function () {
  let activeGame = null;
  let activeRoomCode = null;
  let currentGameTitle = "";
  let gameAudioCtx = null;
  const CRAZYGAMES_BRAWL_URL = "https://www.crazygames.com/game/brawl-squad";

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
    if (activeArea) {
      activeArea.style.display = "none";
      activeArea.classList.remove("external-game-active");
    }
    activeGame = null;
    activeRoomCode = null;
  };

  window.currentPanicSubject = localStorage.getItem("mokori_panic_subj") || "kokugo";

  window.switchMokoriPanic = function(subj) {
    window.currentPanicSubject = subj;
    try { localStorage.setItem("mokori_panic_subj", subj); } catch (_) {}
    const subjects = ["kokugo", "english", "rika"];
    const colors = { kokugo: "#dc2626", english: "#2563eb", rika: "#059669" };
    subjects.forEach(s => {
      const tab = document.getElementById("mpTab" + s.charAt(0).toUpperCase() + s.slice(1));
      const box = document.getElementById("mpBox" + s.charAt(0).toUpperCase() + s.slice(1));
      if (tab && box) {
        if (s === subj) {
          tab.style.background = colors[s];
          tab.style.color = "#fff";
          tab.style.border = "none";
          box.style.display = "block";
        } else {
          tab.style.background = "#f3f4f6";
          tab.style.color = "#4b5563";
          tab.style.border = "1px solid #d1d5db";
          box.style.display = "none";
        }
      }
    });
  };

  window.panicEscapeGame = function () {
    stopAllGames();
    const container = document.getElementById("gameHubModal");
    if (container) {
      container.innerHTML = `
        <div style="background:#ffffff; color:#1f2937; height:100%; padding:20px; font-family:'Hiragino Mincho ProN', 'Yu Mincho', serif; overflow-y:auto; box-sizing:border-box;">
          <div style="max-width:760px; margin:0 auto;">
            <!-- 教科セレクター (国語・英語・理科) -->
            <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:2px solid #e5e7eb; padding-bottom:12px; margin-bottom:16px; flex-wrap:wrap; gap:8px;">
              <div style="display:flex; gap:6px;">
                <button id="mpTabKokugo" onclick="window.switchMokoriPanic('kokugo')" style="background:#dc2626; color:#fff; border:none; padding:8px 14px; border-radius:6px; font-weight:bold; cursor:pointer; font-size:12px; font-family:sans-serif;">📖 国語（現代文・古典）</button>
                <button id="mpTabEnglish" onclick="window.switchMokoriPanic('english')" style="background:#f3f4f6; color:#4b5563; border:1px solid #d1d5db; padding:8px 14px; border-radius:6px; font-weight:bold; cursor:pointer; font-size:12px; font-family:sans-serif;">📝 英語（Reading & Grammar）</button>
                <button id="mpTabRika" onclick="window.switchMokoriPanic('rika')" style="background:#f3f4f6; color:#4b5563; border:1px solid #d1d5db; padding:8px 14px; border-radius:6px; font-weight:bold; cursor:pointer; font-size:12px; font-family:sans-serif;">🔬 理科（物理・化学基礎）</button>
              </div>
              <button onclick="location.reload()" style="background:#e5e7eb; color:#6b7280; border:none; padding:6px 12px; border-radius:6px; font-size:12px; cursor:pointer; font-family:sans-serif;">✕ 復帰</button>
            </div>

            <!-- 国語 -->
            <div id="mpBoxKokugo">
              <h2 style="font-size:19px; color:#111827; margin:0 0 8px; border-left:4px solid #dc2626; padding-left:10px;">現代文・古文 演習ノート (第4講)</h2>
              <p style="font-size:12px; color:#6b7280; margin:0 0 14px;">単元: 近代文学の成立と人間心理の相克（芥川龍之介『羅生門』）</p>
              <div style="background:#f9fafb; border:1px solid #e5e7eb; border-radius:8px; padding:14px; margin-bottom:14px; font-size:13px; line-height:1.8;">
                <strong>【読解問題】</strong>「ある日の暮方の事である。一人の下人が、羅生門の下で雨やみを待っていた。」<br>
                下人が羅生門の下に取り残され、「盗人になるよりほかに仕方がない」と思いつめながらも踏み切れない心理の変遷について、本文中の描写に即して60字以内で説明せよ。<br>
                <hr style="border:none; border-top:1px dashed #d1d5db; margin:10px 0;">
                <span style="color:#b91c1c; font-weight:bold;">【解答・解説メモ】</span><br>
                生き延びるために悪に手を染めることへの逡巡と羞恥心が残っていたが、老婆の生存の論理を目の当たりにしたことで悪の肯定へと至る。
              </div>
              <div style="font-size:12px; color:#4b5563; line-height:1.7;">
                <strong>【重要古文単語】</strong><br>
                ・「あはれなり」: しみじみと心に深く感じられるさま（情趣・哀愁）<br>
                ・助動詞「けり」: 過去（〜した）・詠嘆（〜だなあ）
              </div>
            </div>

            <!-- 英語 -->
            <div id="mpBoxEnglish" style="display:none;">
              <h2 style="font-size:19px; color:#111827; margin:0 0 8px; border-left:4px solid #2563eb; padding-left:10px;">Standard English Reading & Grammar (Lesson 5)</h2>
              <p style="font-size:12px; color:#6b7280; margin:0 0 14px;">Topic: Technological Innovation and Society</p>
              <div style="background:#f9fafb; border:1px solid #e5e7eb; border-radius:8px; padding:14px; margin-bottom:14px; font-size:13px; line-height:1.8; font-family:sans-serif;">
                <strong>【Passage】</strong><br>
                "Artificial intelligence is rapidly transforming modern society. While machines can process vast amounts of data in seconds, human creativity and critical thinking remain essential."<br>
                <hr style="border:none; border-top:1px dashed #d1d5db; margin:10px 0;">
                <strong style="color:#1d4ed8;">【Key Grammar】</strong><br>
                1. <strong>Contrastive "While":</strong> 〜である一方で (whereas)<br>
                2. <strong>Subjunctive Past Perfect:</strong> <em>If I had studied harder, I would have passed the exam.</em> (仮定法過去完了)
              </div>
            </div>

            <!-- 理科 -->
            <div id="mpBoxRika" style="display:none;">
              <h2 style="font-size:19px; color:#111827; margin:0 0 8px; border-left:4px solid #059669; padding-left:10px;">高校理科総合（物理・化学基礎）ノート</h2>
              <p style="font-size:12px; color:#6b7280; margin:0 0 14px;">単元: 運動の法則・酸化還元反応の基礎</p>
              <div style="background:#f9fafb; border:1px solid #e5e7eb; border-radius:8px; padding:14px; margin-bottom:14px; font-size:13px; line-height:1.8;">
                <strong>【物理: 等加速度直線運動】</strong><br>
                初速 $v_0 = 4.0\\text{ m/s}$, 加速度 $a = 2.0\\text{ m/s}^2$ のとき $t = 3.0\\text{ s}$ 後の速度 $v$ と変位 $x$:<br>
                ・$v = v_0 + at = 4.0 + 2.0 \\times 3.0 = 10.0\\text{ m/s}$<br>
                ・$x = v_0 t + \\frac{1}{2}at^2 = 4.0 \\times 3.0 + \\frac{1}{2} \\times 2.0 \\times 9.0 = 21.0\\text{ m}$
              </div>
              <div style="background:#f9fafb; border:1px solid #e5e7eb; border-radius:8px; padding:14px; font-size:13px; line-height:1.8;">
                <strong>【化学: 酸化還元反応と電子】</strong><br>
                $2\\text{Mg} + \\text{O}_2 \\longrightarrow 2\\text{MgO}$<br>
                Mgは電子を失い酸化された（$\\text{Mg} \\rightarrow \\text{Mg}^{2+} + 2e^-$）。
              </div>
            </div>
          </div>
        </div>
      `;
      window.switchMokoriPanic(window.currentPanicSubject || "kokugo");
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
    if (activeArea) {
      activeArea.style.display = "flex";
      activeArea.classList.toggle("external-game-active", gameType === "brawl-crazygames");
    }

    const titles = {
      othello: "⚫⚪ オセロ（リバーシ）",
      uno: "🎴 UNO（ウノ対戦）",
      daifugo: "🃏 大富豪（4人対戦）",
      snowball: "❄️ snowball.io（雪玉バトル）",
      paper: "📄 paper.io（2D陣取りバトル）",
      "paper-webgl": "⭐ paper.io WebGL版（本家完全再現）",
      brawl: "⭐ ブロスタ 3D本家完全再現版",
      "brawl-webgl": "⭐ ブロスタ 3D本家完全再現版",
      "brawl-crazygames": "⭐ Brawl Squad（CrazyGames版）",
      fortnite: "🏆 Fortnite 3D（バトルロイヤル）",
      solitaire: "♠️ ソリティア（クロンダイク）",
      drawquiz: "🎨 お絵描きクイズ（リアルタイム対戦＆ソロ）",
      shogi: "♟️ 将棋（本将棋・AI＆対人オンライン対戦）"
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
      case "paper-webgl":
        renderPaperWebglGame(embed);
        break;
      case "brawl":
      case "brawl-webgl":
        renderBrawlGame(embed);
        break;
      case "brawl-crazygames":
        renderCrazyGamesBrawl(embed);
        break;
      case "fortnite":
        renderFortniteGame(embed);
        break;
      case "solitaire":
        renderSolitaireGame(embed);
        break;
      case "drawquiz":
        renderDrawQuizGame(embed, activeRoomCode);
        break;
      case "shogi":
        if (window.renderShogiGame) {
          window.renderShogiGame(embed, activeRoomCode);
        }
        break;
    }
  }

  function renderCrazyGamesBrawl(container) {
    container.innerHTML = `
      <div class="crazygames-embed-frame-wrap">
        <iframe
          class="crazygames-embed-frame"
          src="${CRAZYGAMES_BRAWL_URL}"
          title="Brawl Squad on CrazyGames"
          allow="autoplay; fullscreen; gamepad; accelerometer; gyroscope; picture-in-picture"
          allowfullscreen
          webkitallowfullscreen
          loading="eager">
        </iframe>
      </div>
      <div class="crazygames-embed-fallback">
        <span>埋め込みで遊べない場合はこちら</span>
        <a href="${CRAZYGAMES_BRAWL_URL}" target="_blank" rel="noopener noreferrer">
          CrazyGames公式ページを開く ↗
        </a>
      </div>
    `;
  }

  function stopAllGames() {
    if (activeGame === "brawl-crazygames") {
      const embed = document.getElementById("gameEmbedContainer");
      if (embed) embed.innerHTML = "";
    }
    window.onkeydown = null;
    if (window._stopShogi) { window._stopShogi(); window._stopShogi = null; }
    if (window._stopDrawQuiz) { window._stopDrawQuiz(); window._stopDrawQuiz = null; }
    if (window.stopFortnite3DGame) window.stopFortnite3DGame();
    if (window.stop3DBrawlGame) window.stop3DBrawlGame();
    if (window._stopSnowball) { window._stopSnowball(); window._stopSnowball = null; }
    if (window._stopPaper) { window._stopPaper(); window._stopPaper = null; }
    if (window._stopBrawl) { window._stopBrawl(); window._stopBrawl = null; }
    const mokoriBrawlIframe = document.getElementById("mokoriBrawlIframe");
    if (mokoriBrawlIframe) mokoriBrawlIframe.src = "about:blank";
    const mokoriPaperIframe = document.getElementById("mokoriPaperIframe");
    if (mokoriPaperIframe) mokoriPaperIframe.src = "about:blank";
    if (window._othelloPollTimer) { clearInterval(window._othelloPollTimer); window._othelloPollTimer = null; }
    if (window._unoPollTimer) { clearInterval(window._unoPollTimer); window._unoPollTimer = null; }
    if (window._daifugoPollTimer) { clearInterval(window._daifugoPollTimer); window._daifugoPollTimer = null; }
  }

  // ==================================================
  // 1. ⚫⚪ オセロ（リバーシ）- リアルタイムオンライン対人対戦 & CPU
  // ==================================================
  function renderOthelloGame(container, roomCode) {
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
    let isOnline = Boolean(roomCode && window.api);
    let myRole = 1; // 1: 黒(ホスト), 2: 白(参加者)
    let opponentName = "対戦相手";
    let othelloCpuDifficulty = "normal";

    container.innerHTML = `
      <div style="padding:16px; max-width:400px; margin:0 auto; text-align:center;">
        <div style="background:#1e293b; padding:10px 14px; border-radius:10px; margin-bottom:12px; display:flex; justify-content:space-between; align-items:center;">
          <div style="font-size:13px; color:#94a3b8;">
            <strong id="othModeBadge" style="color:#38bdf8;">👥 オンライン対戦</strong>
            <span style="margin-left:6px; color:#64748b; font-size:11px;">(${roomCode || "ソロ"})</span>
          </div>
          <button onclick="window.openGameForwardDialog()" style="background:#06c755; color:#fff; font-size:11px; font-weight:bold; padding:4px 10px; border-radius:6px; border:0; cursor:pointer;">
            📤 招待を転送
          </button>
        </div>

        <div id="othWaitBanner" style="display:none; background:#0284c7; color:#fff; font-size:12px; padding:8px 12px; border-radius:8px; margin-bottom:12px; font-weight:bold;">
          ⏳ 相手の参加を待っています…上の「招待を転送」でチャットにカードを送ってください！
        </div>

        <!-- CPU強さ選択 -->
        <div id="othCpuDiffWrap" style="${isOnline ? "display:none;" : "display:flex;"} background:#1e293b; padding:6px 12px; border-radius:8px; margin-bottom:10px; justify-content:space-between; align-items:center;">
          <span style="font-size:11px; color:#94a3b8; font-weight:bold;">🤖 CPU強さ:</span>
          <div style="display:flex; gap:6px;">
            <button id="oDiffEasy" style="background:#334155; color:#cbd5e1; border:none; padding:3px 8px; border-radius:6px; font-size:11px; font-weight:bold; cursor:pointer;">🟢 弱い</button>
            <button id="oDiffNormal" style="background:#38bdf8; color:#fff; border:none; padding:3px 8px; border-radius:6px; font-size:11px; font-weight:bold; cursor:pointer;">🟡 普通</button>
            <button id="oDiffHard" style="background:#334155; color:#cbd5e1; border:none; padding:3px 8px; border-radius:6px; font-size:11px; font-weight:bold; cursor:pointer;">🔴 強い</button>
          </div>
        </div>

        <div style="display:flex; justify-content:center; gap:20px; margin-bottom:14px;">
          <div id="othP1Box" style="padding:6px 14px; border-radius:8px; border:2px solid #38bdf8; background:#1e293b; min-width:110px;">
            <div id="othP1Label" style="font-size:12px; color:#94a3b8;">黒 (ホスト)</div>
            <div id="othBCount" style="font-size:22px; font-weight:bold; color:#f8fafc;">2</div>
          </div>
          <div id="othP2Box" style="padding:6px 14px; border-radius:8px; border:2px solid transparent; background:#1e293b; min-width:110px;">
            <div id="othP2Label" style="font-size:12px; color:#94a3b8;">白 (参加者)</div>
            <div id="othWCount" style="font-size:22px; font-weight:bold; color:#f8fafc;">2</div>
          </div>
        </div>

        <div id="othStatusBanner" style="font-size:14px; font-weight:bold; color:#38bdf8; min-height:24px; margin-bottom:10px;">
          ルームに接続中…
        </div>

        <div id="othelloGrid" class="othello-board-grid"></div>

        <div style="margin-top:16px; display:flex; gap:8px; justify-content:center; flex-wrap:wrap;">
          <button id="othSwitchCpuBtn" style="background:#334155; color:#fff; padding:8px 14px; border-radius:8px; font-size:12px; border:0; cursor:pointer;">
            🤖 待たずにCPU戦に切替
          </button>
          <button id="othResetBtn" style="background:#1e293b; border:1px solid #334155; color:#94a3b8; padding:8px 14px; border-radius:8px; font-size:12px; border:0; cursor:pointer;">
            🔄 最初から
          </button>
        </div>
      </div>
    `;

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

      const isMyTurn = isOnline ? (turn === myRole) : (turn === 1);
      const validMoves = (!isGameOver && isMyTurn) ? getValidMoves(board, turn) : [];
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
        if (bCount > wCount) {
          banner.textContent = myRole === 1 ? `🎉 黒（あなた）の勝利！ (${bCount} 対 ${wCount})` : `黒の勝利！ (${bCount} 対 ${wCount})`;
        } else if (wCount > bCount) {
          banner.textContent = myRole === 2 ? `🎉 白（あなた）の勝利！ (${wCount} 対 ${bCount})` : `白の勝利！ (${wCount} 対 ${bCount})`;
        } else {
          banner.textContent = `引き分け！ (${bCount} 対 ${wCount})`;
        }
      } else {
        if (turn === 1) {
          p1Box.style.borderColor = "#38bdf8";
          p2Box.style.borderColor = "transparent";
        } else {
          p2Box.style.borderColor = "#38bdf8";
          p1Box.style.borderColor = "transparent";
        }

        if (isOnline) {
          if (turn === myRole) {
            banner.textContent = `あなたの手番です！ (${myRole === 1 ? "黒" : "白"})`;
          } else {
            banner.textContent = `相手（${opponentName}）の手番です… 考え中`;
          }
        } else {
          banner.textContent = turn === 1 ? "あなたの手番です (黒)" : "CPUが考えています… (白)";
        }
      }
    }

    async function makeMove(r, c, flips) {
      if (isGameOver) return;
      if (isOnline && turn !== myRole) return;
      if (!isOnline && turn !== 1) return;

      playTone(440, "sine", 0.08);

      const movingRole = isOnline ? myRole : 1;
      board[r][c] = movingRole;
      for (const [fr, fc] of flips) {
        board[fr][fc] = movingRole;
      }

      const nextRole = 3 - movingRole;
      const nextMoves = getValidMoves(board, nextRole);
      let nextTurn = nextRole;
      let over = false;

      if (nextMoves.length === 0) {
        const myMovesAgain = getValidMoves(board, movingRole);
        if (myMovesAgain.length > 0) {
          nextTurn = movingRole;
          document.getElementById("othStatusBanner").textContent = "置けるマスがないためパスされました！";
        } else {
          over = true;
          isGameOver = true;
        }
      }

      turn = nextTurn;
      renderBoard();

      if (isOnline) {
        try {
          await window.api(`/api/games/rooms/${roomCode}/update`, {
            method: "POST",
            body: JSON.stringify({
              state: {
                board,
                turn,
                isGameOver: over
              }
            })
          });
        } catch (e) {
          console.warn("Move sync error:", e);
        }
      } else {
        setTimeout(runCpuMove, 500);
      }
    }

    function runCpuMove() {
      if (isGameOver) return;
      const moves = getValidMoves(board, 2);
      if (moves.length === 0) {
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

      const corners = ["0,0", "0,7", "7,0", "7,7"];
      let chosen = null;

      if (othelloCpuDifficulty === "easy") {
        moves.sort((a, b) => a.flips.length - b.flips.length);
        chosen = moves[0];
      } else if (othelloCpuDifficulty === "normal") {
        chosen = moves.find(m => corners.includes(`${m.r},${m.c}`));
        if (!chosen) {
          moves.sort((a, b) => b.flips.length - a.flips.length);
          chosen = moves[0];
        }
      } else {
        const POS_WEIGHTS = [
          [ 100, -25,  10,   5,   5,  10, -25, 100],
          [ -25, -50,  -2,  -2,  -2,  -2, -50, -25],
          [  10,  -2,   2,   1,   1,   2,  -2,  10],
          [   5,  -2,   1,   0,   0,   1,  -2,   5],
          [   5,  -2,   1,   0,   0,   1,  -2,   5],
          [  10,  -2,   2,   1,   1,   2,  -2,  10],
          [ -25, -50,  -2,  -2,  -2,  -2, -50, -25],
          [ 100, -25,  10,   5,   5,  10, -25, 100]
        ];
        let bestScore = -999999;
        for (const m of moves) {
          let score = POS_WEIGHTS[m.r][m.c] * 3 + m.flips.length * 2;
          if (score > bestScore) {
            bestScore = score;
            chosen = m;
          }
        }
        if (!chosen) chosen = moves[0];
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

    // オンライン同期初期化
    async function initOnline() {
      if (!isOnline) {
        document.getElementById("othModeBadge").textContent = "🤖 ソロCPU対戦";
        renderBoard();
        return;
      }

      try {
        const myName = (window.currentUser && (window.currentUser.displayName || window.currentUser.username)) || (document.getElementById("myProfileUsernameInput") && document.getElementById("myProfileUsernameInput").value.trim()) || "プレイヤー";
        const res = await window.api(`/api/games/rooms/${roomCode}/join`, {
          method: "POST",
          body: JSON.stringify({
            gameType: "othello",
            username: myName,
            initialState: {
              board,
              turn: 1,
              isGameOver: false
            }
          })
        });

        myRole = res.role; // 1: 黒(ホスト), 2: 白(参加者)
        handleRoomUpdate(res.room);
        startPolling();
      } catch (err) {
        console.warn("Online join failed, switching to CPU:", err.message);
        switchToCpu();
      }
    }

    function startPolling() {
      if (window._othelloPollTimer) clearInterval(window._othelloPollTimer);
      window._othelloPollTimer = setInterval(async () => {
        if (!isOnline) return;
        try {
          const res = await window.api(`/api/games/rooms/${roomCode}`);
          if (res && res.room) {
            handleRoomUpdate(res.room);
          }
        } catch (e) {}
      }, 1000);
    }

    function handleRoomUpdate(room) {
      if (!room) return;
      const players = room.players || [];
      const p1 = players[0] || { username: "ホスト" };
      const p2 = players[1] || null;

      const p1El = document.getElementById("othP1Label");
      const p2El = document.getElementById("othP2Label");
      const waitBanner = document.getElementById("othWaitBanner");

      if (p1El) p1El.textContent = `黒 (${p1.username}${myRole === 1 ? "·あなた" : ""})`;
      if (p2El) p2El.textContent = `白 (${p2 ? p2.username + (myRole === 2 ? "·あなた" : "") : "待機中…"})`;

      if (players.length >= 2) {
        if (waitBanner) waitBanner.style.display = "none";
        opponentName = (myRole === 1 ? (p2 ? p2.username : "白") : p1.username) || "相手";
      } else {
        if (waitBanner) waitBanner.style.display = "block";
      }

      if (room.state) {
        if (room.state.board) board = room.state.board;
        if (room.state.turn) turn = room.state.turn;
        if (room.state.isGameOver !== undefined) isGameOver = room.state.isGameOver;
      }

      renderBoard();
    }

    function switchToCpu() {
      isOnline = false;
      if (window._othelloPollTimer) clearInterval(window._othelloPollTimer);
      document.getElementById("othModeBadge").textContent = "🤖 ソロCPU対戦";
      document.getElementById("othWaitBanner").style.display = "none";
      const diffWrap = document.getElementById("othCpuDiffWrap");
      if (diffWrap) diffWrap.style.display = "flex";
      document.getElementById("othP1Label").textContent = "黒 (あなた)";
      document.getElementById("othP2Label").textContent = "白 (CPU)";
      renderBoard();
    }

    function updateOthDiffUI() {
      ["easy", "normal", "hard"].forEach(d => {
        const btn = document.getElementById("oDiff" + d.charAt(0).toUpperCase() + d.slice(1));
        if (btn) {
          if (d === othelloCpuDifficulty) {
            btn.style.background = "#38bdf8";
            btn.style.color = "#fff";
          } else {
            btn.style.background = "#334155";
            btn.style.color = "#cbd5e1";
          }
        }
      });
    }

    document.getElementById("oDiffEasy")?.addEventListener("click", () => { othelloCpuDifficulty = "easy"; updateOthDiffUI(); });
    document.getElementById("oDiffNormal")?.addEventListener("click", () => { othelloCpuDifficulty = "normal"; updateOthDiffUI(); });
    document.getElementById("oDiffHard")?.addEventListener("click", () => { othelloCpuDifficulty = "hard"; updateOthDiffUI(); });

    document.getElementById("othSwitchCpuBtn").onclick = () => {
      switchToCpu();
    };

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
      if (isOnline) {
        window.api(`/api/games/rooms/${roomCode}/update`, {
          method: "POST",
          body: JSON.stringify({
            state: { board, turn, isGameOver: false }
          })
        }).catch(() => {});
      }
    };

    initOnline();
  }

  // ==================================================
  // 2. 🎴 UNO（ウノ対戦）- リアルタイムオンライン対人対戦 & CPU
  // ==================================================
  function renderUnoGame(container, roomCode) {
    const COLORS = ["red", "blue", "green", "yellow"];
    let isOnline = Boolean(roomCode && window.api);
    let myRole = 1; // 1: ホスト, 2: 参加者
    let turnRole = 1;
    let opponentName = "相手";
    let deck = [];
    let playerHand = [];
    let oppHandCount = 7;
    let topCard = { color: "red", value: "7" };

    container.innerHTML = `
      <div style="padding:16px; max-width:440px; margin:0 auto; text-align:center;">
        <div style="background:#1e293b; padding:10px 14px; border-radius:10px; margin-bottom:12px; display:flex; justify-content:space-between; align-items:center;">
          <div style="font-size:13px; color:#94a3b8;">
            <strong id="unoModeBadge" style="color:#ef4444;">👥 オンライン対戦</strong>
            <span style="margin-left:6px; color:#64748b; font-size:11px;">(${roomCode || "ソロ"})</span>
          </div>
          <button onclick="window.openGameForwardDialog()" style="background:#06c755; color:#fff; font-size:11px; font-weight:bold; padding:4px 10px; border-radius:6px; border:0; cursor:pointer;">
            📤 招待を転送
          </button>
        </div>

        <div id="unoWaitAlert" style="display:none; background:#0284c7; color:#fff; font-size:12px; padding:8px 12px; border-radius:8px; margin-bottom:12px; font-weight:bold;">
          ⏳ 相手の参加を待っています…上の「招待を転送」でチャットにカードを送ってください！
        </div>

        <div style="background:#0f172a; border:1px solid #334155; border-radius:12px; padding:16px; margin-bottom:16px;">
          <div style="font-size:12px; color:#94a3b8; margin-bottom:6px;">
            相手 (<span id="unoOppName">相手</span>) の手札: <span id="unoCpuCount" style="font-weight:bold; color:#ef4444;">7枚</span>
          </div>
          <div id="unoStatusBanner" style="font-size:14px; font-weight:bold; color:#38bdf8; min-height:24px; margin-bottom:12px;">接続中…</div>

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

        <div style="margin-top:16px; display:flex; gap:8px; justify-content:center;">
          <button id="unoSwitchCpuBtn" style="background:#334155; color:#fff; padding:6px 14px; border-radius:8px; font-size:12px; border:0; cursor:pointer;">
            🤖 待たずにCPU戦に切替
          </button>
        </div>
      </div>
    `;

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
    }

    function canPlay(card, top) {
      if (card.color === "wild") return true;
      if (card.color === top.color) return true;
      if (card.value === top.value) return true;
      return false;
    }

    function isMyTurn() {
      return isOnline ? (turnRole === myRole) : (turnRole === 1);
    }

    function renderUI() {
      const discard = document.getElementById("unoDiscardCard");
      if (discard) {
        discard.className = "uno-card " + topCard.color;
        discard.textContent = topCard.value;
      }
      const countEl = document.getElementById("unoCpuCount");
      if (countEl) countEl.textContent = `${oppHandCount}枚`;

      const banner = document.getElementById("unoStatusBanner");
      if (banner) {
        if (playerHand.length === 0) {
          banner.textContent = "🎉 あなたの勝ち！UNO!!";
        } else if (oppHandCount <= 0) {
          banner.textContent = `相手（${opponentName}）の勝ち！ドンマイ！`;
        } else if (isMyTurn()) {
          banner.textContent = "あなたの手番です！出せるカードを選んでください";
        } else {
          banner.textContent = `相手（${opponentName}）が考えています…`;
        }
      }

      const handEl = document.getElementById("unoPlayerHand");
      if (!handEl) return;
      handEl.innerHTML = "";

      playerHand.forEach((card, idx) => {
        const el = document.createElement("div");
        el.className = "uno-card " + card.color;
        el.textContent = card.value;
        if (isMyTurn() && canPlay(card, topCard)) {
          el.style.boxShadow = "0 0 10px #38bdf8";
          el.style.opacity = "1";
          el.onclick = () => playPlayerCard(idx);
        } else {
          el.style.opacity = "0.5";
        }
        handEl.appendChild(el);
      });
    }

    async function playPlayerCard(idx) {
      if (!isMyTurn()) return;
      const card = playerHand.splice(idx, 1)[0];
      topCard = card;
      if (card.color === "wild") {
        topCard.color = COLORS[Math.floor(Math.random() * COLORS.length)];
      }
      playTone(520, "triangle", 0.1);

      turnRole = isOnline ? (3 - myRole) : 2;
      renderUI();

      if (isOnline) {
        syncUnoState();
      } else {
        setTimeout(runCpuTurn, 700);
      }
    }

    function runCpuTurn() {
      if (isOnline) return;
      if (oppHandCount <= 0) return;
      const dummyCard = { color: COLORS[Math.floor(Math.random() * 4)], value: String(Math.floor(Math.random() * 10)) };
      topCard = dummyCard;
      oppHandCount = Math.max(0, oppHandCount - 1);
      playTone(390, "triangle", 0.1);
      turnRole = 1;
      renderUI();
    }

    async function syncUnoState() {
      if (!isOnline) return;
      try {
        await window.api(`/api/games/rooms/${roomCode}/update`, {
          method: "POST",
          body: JSON.stringify({
            state: {
              topCard,
              turnRole,
              [myRole === 1 ? "p1Count" : "p2Count"]: playerHand.length
            }
          })
        });
      } catch (e) {
        console.warn("UNO sync error:", e);
      }
    }

    document.getElementById("unoDeckBtn").onclick = () => {
      if (!isMyTurn()) return;
      playerHand.push(drawCard());
      playTone(300, "sine", 0.08);
      turnRole = isOnline ? (3 - myRole) : 2;
      renderUI();
      if (isOnline) {
        syncUnoState();
      } else {
        setTimeout(runCpuTurn, 700);
      }
    };

    // オンライン初期化
    async function initOnlineUno() {
      if (!isOnline) {
        document.getElementById("unoModeBadge").textContent = "🤖 ソロCPU対戦";
        renderUI();
        return;
      }

      try {
        const myName = (window.currentUser && (window.currentUser.displayName || window.currentUser.username)) || (document.getElementById("myProfileUsernameInput") && document.getElementById("myProfileUsernameInput").value.trim()) || "プレイヤー";
        const res = await window.api(`/api/games/rooms/${roomCode}/join`, {
          method: "POST",
          body: JSON.stringify({
            gameType: "uno",
            username: myName,
            initialState: {
              topCard,
              turnRole: 1,
              p1Count: 7,
              p2Count: 7
            }
          })
        });

        myRole = res.role;
        handleUnoUpdate(res.room);
        startUnoPolling();
      } catch (err) {
        console.warn("Online UNO join failed, fallback to CPU:", err.message);
        switchToCpuUno();
      }
    }

    function startUnoPolling() {
      if (window._unoPollTimer) clearInterval(window._unoPollTimer);
      window._unoPollTimer = setInterval(async () => {
        if (!isOnline) return;
        try {
          const res = await window.api(`/api/games/rooms/${roomCode}`);
          if (res && res.room) {
            handleUnoUpdate(res.room);
          }
        } catch (e) {}
      }, 1000);
    }

    function handleUnoUpdate(room) {
      if (!room) return;
      const players = room.players || [];
      const waitAlert = document.getElementById("unoWaitAlert");
      const oppNameEl = document.getElementById("unoOppName");

      if (players.length >= 2) {
        if (waitAlert) waitAlert.style.display = "none";
        opponentName = (myRole === 1 ? (players[1] ? players[1].username : "相手") : players[0].username) || "相手";
        if (oppNameEl) oppNameEl.textContent = opponentName;
      } else {
        if (waitAlert) waitAlert.style.display = "block";
      }

      if (room.state) {
        if (room.state.topCard) topCard = room.state.topCard;
        if (room.state.turnRole) turnRole = room.state.turnRole;
        if (myRole === 1 && room.state.p2Count !== undefined) oppHandCount = room.state.p2Count;
        if (myRole === 2 && room.state.p1Count !== undefined) oppHandCount = room.state.p1Count;
      }

      renderUI();
    }

    function switchToCpuUno() {
      isOnline = false;
      if (window._unoPollTimer) clearInterval(window._unoPollTimer);
      document.getElementById("unoModeBadge").textContent = "🤖 ソロCPU対戦";
      document.getElementById("unoWaitAlert").style.display = "none";
      document.getElementById("unoOppName").textContent = "CPU";
      renderUI();
    }

    document.getElementById("unoSwitchCpuBtn").onclick = () => {
      switchToCpuUno();
    };

    initOnlineUno();
  }

  // ==================================================
  // 3. 🃏 大富豪（4人対戦）- リアルタイムオンライン対人対戦 & CPU
  // ==================================================
  function renderDaifugoGame(container, roomCode) {
    let isOnline = Boolean(roomCode && window.api);
    let myRole = 1;
    let turnRole = 1;
    let opponentName = "対戦相手";

    container.innerHTML = `
      <div style="padding:16px; max-width:440px; margin:0 auto; text-align:center;">
        <!-- モード切替タブ: CPU vs オンライン -->
        <div style="display:flex; gap:8px; margin-bottom:12px;">
          <button id="dfModeCpuBtn" style="flex:1; background:${isOnline ? '#1e293b' : '#0284c7'}; color:${isOnline ? '#94a3b8' : '#fff'}; border:1px solid ${isOnline ? '#334155' : '#0284c7'}; padding:8px; border-radius:8px; font-weight:bold; font-size:12px; cursor:pointer;">
            🤖 4人CPU対戦 (即開始)
          </button>
          <button id="dfModeOnlineBtn" style="flex:1; background:${isOnline ? '#06c755' : '#1e293b'}; color:${isOnline ? '#fff' : '#94a3b8'}; border:1px solid ${isOnline ? '#06c755' : '#334155'}; padding:8px; border-radius:8px; font-weight:bold; font-size:12px; cursor:pointer;">
            👥 オンライン友達対戦
          </button>
        </div>

        <div style="background:#1e293b; padding:10px 14px; border-radius:10px; margin-bottom:12px; display:flex; justify-content:space-between; align-items:center;">
          <div style="font-size:13px; color:#94a3b8;">
            <strong id="dfModeBadge" style="color:#f59e0b;">${isOnline ? '👥 オンライン対戦' : '🤖 ソロ4人CPU戦'}</strong>
            <span style="margin-left:6px; color:#64748b; font-size:11px;">(${roomCode || "ソロ"})</span>
          </div>
          <button onclick="window.openGameForwardDialog()" style="background:#06c755; color:#fff; font-size:11px; font-weight:bold; padding:4px 10px; border-radius:6px; border:0; cursor:pointer;">
            📤 招待を転送
          </button>
        </div>

        <div id="dfWaitAlert" style="display:none; background:#0284c7; color:#fff; font-size:12px; padding:8px 12px; border-radius:8px; margin-bottom:12px; font-weight:bold;">
          ⏳ 相手の参加を待っています…上の「招待を転送」でチャットにカードを送ってください！
        </div>

        <div style="display:flex; justify-content:space-around; background:#0f172a; padding:8px; border-radius:8px; margin-bottom:12px; font-size:12px; color:#94a3b8;">
          <div>相手: <span id="dfOppName" style="color:#38bdf8;">相手</span> (<span id="dfC1">13</span>)</div>
          <div>CPU1 (<span id="dfC2">13</span>)</div>
          <div>CPU2 (<span id="dfC3">13</span>)</div>
        </div>

        <div style="background:#1e293b; border-radius:12px; padding:16px; min-height:100px; margin-bottom:14px; display:flex; flex-direction:column; align-items:center; justify-content:center;">
          <div style="font-size:11px; color:#94a3b8; margin-bottom:6px;">場のカード (8切り対応)</div>
          <div id="dfFieldCards" style="display:flex; gap:6px;">
            <span style="color:#64748b; font-size:13px;">まだ場に出ていません</span>
          </div>
        </div>

        <div id="dfBanner" style="font-size:14px; font-weight:bold; color:#38bdf8; min-height:22px; margin-bottom:10px;">
          接続中…
        </div>

        <div id="dfPlayerHand" style="display:flex; flex-wrap:wrap; gap:6px; justify-content:center; min-height:80px; margin-bottom:14px;"></div>

        <div style="display:flex; gap:10px; justify-content:center;">
          <button id="dfPlayBtn" style="background:#f59e0b; color:#fff; font-weight:bold; padding:8px 20px; border-radius:8px; font-size:13px; border:0; cursor:pointer;">
            出す
          </button>
          <button id="dfPassBtn" style="background:#334155; color:#fff; padding:8px 16px; border-radius:8px; font-size:13px; border:0; cursor:pointer;">
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

    const cpuBtn = document.getElementById("dfModeCpuBtn");
    const onlineBtn = document.getElementById("dfModeOnlineBtn");
    if (cpuBtn) {
      cpuBtn.onclick = () => {
        isOnline = false;
        if (window._dfPollTimer) clearInterval(window._dfPollTimer);
        document.getElementById("dfModeBadge").textContent = "🤖 ソロ4人CPU戦";
        document.getElementById("dfModeBadge").style.color = "#38bdf8";
        cpuBtn.style.background = "#0284c7";
        cpuBtn.style.color = "#fff";
        if (onlineBtn) {
          onlineBtn.style.background = "#1e293b";
          onlineBtn.style.color = "#94a3b8";
        }
        const w = document.getElementById("dfWaitAlert");
        if (w) w.style.display = "none";
        renderHand();
      };
    }
    if (onlineBtn) {
      onlineBtn.onclick = () => {
        isOnline = true;
        document.getElementById("dfModeBadge").textContent = "👥 オンライン対戦";
        document.getElementById("dfModeBadge").style.color = "#f59e0b";
        onlineBtn.style.background = "#06c755";
        onlineBtn.style.color = "#fff";
        if (cpuBtn) {
          cpuBtn.style.background = "#1e293b";
          cpuBtn.style.color = "#94a3b8";
        }
        initOnlineDaifugo();
      };
    }

    function isMyTurn() {
      return isOnline ? (turnRole === myRole) : (turnRole === 1);
    }

    function renderHand() {
      const el = document.getElementById("dfPlayerHand");
      if (!el) return;
      el.innerHTML = "";
      pHand.forEach((c, idx) => {
        const btn = document.createElement("div");
        btn.className = "df-card" + (c.suit === "♥" || c.suit === "♦" ? " red-suit" : "") + (selectedIdx === idx ? " selected" : "");
        btn.innerHTML = `<div>${c.suit}</div><div style="text-align:right;">${c.str}</div>`;
        btn.onclick = () => {
          if (!isMyTurn()) return;
          selectedIdx = (selectedIdx === idx ? null : idx);
          renderHand();
        };
        el.appendChild(btn);
      });

      const banner = document.getElementById("dfBanner");
      if (banner) {
        if (pHand.length === 0) {
          banner.textContent = "🎉 上がり！あなたの勝ちです！";
        } else if (isMyTurn()) {
          banner.textContent = "あなたの手番です！カードを選んで出してください";
        } else {
          banner.textContent = `相手（${opponentName}）の手番です…`;
        }
      }
    }

    async function syncDf() {
      if (!isOnline) return;
      try {
        await window.api(`/api/games/rooms/${roomCode}/update`, {
          method: "POST",
          body: JSON.stringify({
            state: {
              field,
              turnRole
            }
          })
        });
      } catch (e) {}
    }

    document.getElementById("dfPlayBtn").onclick = () => {
      if (!isMyTurn()) return;
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
        document.getElementById("dfBanner").textContent = "⚡ 8切り発動！場が流れました！連続手番です";
        field = [];
        fEl.innerHTML = `<span style="color:#64748b; font-size:13px;">8切りで場が流れました</span>`;
      } else {
        turnRole = isOnline ? (3 - myRole) : 2;
      }
      renderHand();

      if (isOnline) {
        syncDf();
      } else {
        setTimeout(() => {
          turnRole = 1;
          renderHand();
        }, 800);
      }
    };

    document.getElementById("dfPassBtn").onclick = () => {
      if (!isMyTurn()) return;
      playTone(280, "sine", 0.08);
      turnRole = isOnline ? (3 - myRole) : 2;
      renderHand();
      if (isOnline) {
        syncDf();
      } else {
        setTimeout(() => {
          turnRole = 1;
          renderHand();
        }, 800);
      }
    };

    async function initOnlineDf() {
      if (!isOnline) {
        document.getElementById("dfModeBadge").textContent = "🤖 ソロCPU対戦";
        renderHand();
        return;
      }
      try {
        const myName = (window.currentUser && (window.currentUser.displayName || window.currentUser.username)) || (document.getElementById("myProfileUsernameInput") && document.getElementById("myProfileUsernameInput").value.trim()) || "プレイヤー";
        const res = await window.api(`/api/games/rooms/${roomCode}/join`, {
          method: "POST",
          body: JSON.stringify({
            gameType: "daifugo",
            username: myName,
            initialState: {
              field: [],
              turnRole: 1
            }
          })
        });

        myRole = res.role;
        handleDfUpdate(res.room);
        startDfPolling();
      } catch (err) {
        console.warn("Online Daifugo join failed:", err.message);
        isOnline = false;
        renderHand();
      }
    }

    function startDfPolling() {
      if (window._daifugoPollTimer) clearInterval(window._daifugoPollTimer);
      window._daifugoPollTimer = setInterval(async () => {
        if (!isOnline) return;
        try {
          const res = await window.api(`/api/games/rooms/${roomCode}`);
          if (res && res.room) {
            handleDfUpdate(res.room);
          }
        } catch (e) {}
      }, 1000);
    }

    function handleDfUpdate(room) {
      if (!room) return;
      const players = room.players || [];
      const waitAlert = document.getElementById("dfWaitAlert");
      const oppNameEl = document.getElementById("dfOppName");

      if (players.length >= 2) {
        if (waitAlert) waitAlert.style.display = "none";
        opponentName = (myRole === 1 ? (players[1] ? players[1].username : "相手") : players[0].username) || "相手";
        if (oppNameEl) oppNameEl.textContent = opponentName;
      } else {
        if (waitAlert) waitAlert.style.display = "block";
      }

      if (room.state) {
        if (room.state.field) {
          field = room.state.field;
          const fEl = document.getElementById("dfFieldCards");
          if (fEl && field.length > 0) {
            const c = field[0];
            fEl.innerHTML = `<div class="df-card ${c.suit === "♥" || c.suit === "♦" ? "red-suit" : ""}">${c.suit} ${c.str}</div>`;
          }
        }
        if (room.state.turnRole) turnRole = room.state.turnRole;
      }

      renderHand();
    }

    initOnlineDf();
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
  // 5. 📄 paper.io（2D陣取りバトル）
  // ==================================================
  window.switchPaperMode = function(mode) {
    const embed = document.getElementById("gameEmbedContainer") || document.getElementById("gameEmbedArea");
    if (!embed) return;
    if (mode === "webgl" || mode === "official") {
      renderPaperWebglGame(embed);
    } else {
      renderPaperGame(embed);
    }
  };

  function renderPaperGame(container) {
    container.innerHTML = `
      <div style="padding:12px; max-width:400px; margin:0 auto; text-align:center;">
        <div style="display:flex; gap:8px; margin-bottom:10px;">
          <button id="pm2d" onclick="window.switchPaperMode('2d')" style="flex:1; background:#ec4899; color:#fff; border:0; padding:6px; border-radius:8px; font-weight:bold; font-size:12px; cursor:pointer;">👑 完全内蔵2D版 (ブロック回避)</button>
          <button id="pmWebgl" onclick="window.switchPaperMode('webgl')" style="flex:1; background:#1e293b; color:#94a3b8; border:1px solid #475569; padding:6px; border-radius:8px; font-weight:bold; font-size:12px; cursor:pointer;">🌐 本家版 (Paper.io 2)</button>
        </div>
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
          <span style="font-size:13px; color:#ec4899; font-weight:bold;">📄 paper.io (2D陣取り)</span>
          <span style="font-size:12px; color:#94a3b8;">領地率: <strong id="paperScore" style="color:#ec4899;">8.4%</strong></span>
        </div>
        <canvas id="paperCanvas" width="360" height="360" style="background:#111827; border:2px solid #ec4899; border-radius:12px; touch-action:none;"></canvas>
        <!-- iPhone / iPad タッチ操作用 D-Pad -->
        <div style="margin-top:10px; display:inline-grid; grid-template-columns:52px 52px 52px; grid-template-rows:44px 44px; gap:6px; justify-content:center;">
          <div></div>
          <button id="pUp" style="background:#1e293b; color:#fff; border:1px solid #475569; border-radius:8px; font-size:18px; cursor:pointer; touch-action:manipulation;">▲</button>
          <div></div>
          <button id="pLeft" style="background:#1e293b; color:#fff; border:1px solid #475569; border-radius:8px; font-size:18px; cursor:pointer; touch-action:manipulation;">◀</button>
          <button id="pDown" style="background:#1e293b; color:#fff; border:1px solid #475569; border-radius:8px; font-size:18px; cursor:pointer; touch-action:manipulation;">▼</button>
          <button id="pRight" style="background:#1e293b; color:#fff; border:1px solid #475569; border-radius:8px; font-size:18px; cursor:pointer; touch-action:manipulation;">▶</button>
        </div>
        <div style="font-size:11px; color:#94a3b8; margin-top:8px;">
          ボタンタップ・画面スワイプ・矢印キーで方向転換！領地を囲んで拡大！
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

    function changeDir(newX, newY) {
      if (newX !== 0 && dir.x === 0) dir = { x: newX, y: 0 };
      if (newY !== 0 && dir.y === 0) dir = { x: 0, y: newY };
    }

    window.onkeydown = (e) => {
      if (e.key === "ArrowUp") changeDir(0, -2);
      if (e.key === "ArrowDown") changeDir(0, 2);
      if (e.key === "ArrowLeft") changeDir(-2, 0);
      if (e.key === "ArrowRight") changeDir(2, 0);
    };

    // ボタンクリック・タッチ
    const btnUp = document.getElementById("pUp");
    const btnDown = document.getElementById("pDown");
    const btnLeft = document.getElementById("pLeft");
    const btnRight = document.getElementById("pRight");
    if (btnUp) btnUp.onpointerdown = (e) => { e.preventDefault(); changeDir(0, -2); };
    if (btnDown) btnDown.onpointerdown = (e) => { e.preventDefault(); changeDir(0, 2); };
    if (btnLeft) btnLeft.onpointerdown = (e) => { e.preventDefault(); changeDir(-2, 0); };
    if (btnRight) btnRight.onpointerdown = (e) => { e.preventDefault(); changeDir(2, 0); };

    // スワイプ操作 (iOS/iPadOS対応)
    let touchStart = null;
    cv.addEventListener("touchstart", (e) => {
      e.preventDefault();
      const t = e.touches[0];
      touchStart = { x: t.clientX, y: t.clientY };
    }, { passive: false });

    cv.addEventListener("touchmove", (e) => {
      e.preventDefault();
      if (!touchStart) return;
      const t = e.touches[0];
      const dx = t.clientX - touchStart.x;
      const dy = t.clientY - touchStart.y;
      if (Math.hypot(dx, dy) > 15) {
        if (Math.abs(dx) > Math.abs(dy)) {
          changeDir(dx > 0 ? 2 : -2, 0);
        } else {
          changeDir(0, dy > 0 ? 2 : -2);
        }
        touchStart = { x: t.clientX, y: t.clientY };
      }
    }, { passive: false });

    cv.addEventListener("touchend", () => { touchStart = null; });

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
      if (trail.length > 200) trail.shift();

      // 領地帰還 & 領土拡張判定
      const inTerritory = territory.some(t => Math.hypot(t.x - px, t.y - py) < 12);
      if (inTerritory && trail.length > 6) {
        trail.forEach(t => {
          const gx = Math.round(t.x / 10) * 10;
          const gy = Math.round(t.y / 10) * 10;
          if (!territory.some(existing => existing.x === gx && existing.y === gy)) {
            territory.push({ x: gx, y: gy });
          }
        });
        trail = [];
        playTone(520, "sine", 0.08);
        const scoreEl = document.getElementById("paperScore");
        if (scoreEl) {
          const pct = Math.min(100, (territory.length / (34 * 34) * 100)).toFixed(1);
          scoreEl.textContent = pct + "%";
        }
      }

      // 自分の軌跡への衝突判定
      for (let i = 0; i < trail.length - 8; i++) {
        if (Math.hypot(trail[i].x - px, trail[i].y - py) < 6) {
          playTone(200, "sawtooth", 0.15);
          px = 180; py = 180;
          dir = { x: 2, y: 0 };
          trail = [];
          break;
        }
      }

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
  // 5-b. ⭐ paper.io WebGL版（本家完全再現 & 埋め込み）
  // ==================================================
  const PAPER_WEBGL_SERVERS = {
    1: { name: "⚡ サーバー1 (サイト内蔵・推奨)", url: "paper/index.html" },
    2: { name: "🚀 サーバー2 (GitLab高速版)", url: "/api/proxy?url=" + encodeURIComponent("https://paperio2.gitlab.io/file/") },
    3: { name: "🌐 サーバー3 (GitHub Pages公式)", url: "/api/proxy?url=" + encodeURIComponent("https://ubg17.github.io/PaperIO2/") }
  };
  let currentMokoriPaperServer = 1;

  window.switchMokoriPaperServer = function(num) {
    currentMokoriPaperServer = num;
    for (let i = 1; i <= 3; i++) {
      const btn = document.getElementById("mokoriPaperSrv" + i);
      if (!btn) continue;
      if (i === num) {
        btn.style.background = "#ec4899";
        btn.style.color = "#fff";
        btn.style.border = "none";
      } else {
        btn.style.background = "#1e293b";
        btn.style.color = "#94a3b8";
        btn.style.border = "1px solid #475569";
      }
    }
    const iframe = document.getElementById("mokoriPaperIframe");
    const cfg = PAPER_WEBGL_SERVERS[num] || PAPER_WEBGL_SERVERS[1];
    if (iframe) iframe.src = cfg.url;
  };

  window.reloadMokoriPaper = function() {
    const iframe = document.getElementById("mokoriPaperIframe");
    if (iframe) {
      const cfg = PAPER_WEBGL_SERVERS[currentMokoriPaperServer] || PAPER_WEBGL_SERVERS[1];
      iframe.src = "about:blank";
      setTimeout(() => {
        iframe.src = cfg.url + (cfg.url.includes("?") ? "&" : "?") + "t=" + Date.now();
      }, 50);
    }
  };

  window.toggleMokoriPaperFullscreen = function() {
    const wrap = document.getElementById("mokoriPaperFrameWrap");
    if (!wrap) return;
    if (!document.fullscreenElement) {
      if (wrap.requestFullscreen) wrap.requestFullscreen();
      else if (wrap.webkitRequestFullscreen) wrap.webkitRequestFullscreen();
    } else {
      if (document.exitFullscreen) document.exitFullscreen();
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
    }
  };

  function renderPaperWebglGame(container) {
    container.innerHTML = `
      <div style="padding:10px; max-width:860px; margin:0 auto; text-align:center;">
        <div style="display:flex; gap:8px; margin-bottom:10px;">
          <button id="pm2d" onclick="window.switchPaperMode('2d')" style="flex:1; background:#1e293b; color:#94a3b8; border:1px solid #475569; padding:6px; border-radius:8px; font-weight:bold; font-size:12px; cursor:pointer;">👑 完全内蔵2D版 (ブロック回避)</button>
          <button id="pmWebgl" onclick="window.switchPaperMode('webgl')" style="flex:1; background:#ec4899; color:#fff; border:0; padding:6px; border-radius:8px; font-weight:bold; font-size:12px; cursor:pointer;">🌐 本家版 (Paper.io 2)</button>
        </div>
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; flex-wrap:wrap; gap:6px;">
          <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
            <span style="font-size:12px; color:#ec4899; font-weight:bold;">🌐 サーバー:</span>
            <button id="mokoriPaperSrv1" onclick="switchMokoriPaperServer(1)" style="background:#ec4899; color:#fff; padding:4px 10px; font-size:11px; border-radius:6px; border:none; cursor:pointer;">
              ⚡ サーバー1 (サイト内蔵・推奨)
            </button>
            <button id="mokoriPaperSrv2" onclick="switchMokoriPaperServer(2)" style="background:#1e293b; color:#94a3b8; padding:4px 10px; font-size:11px; border-radius:6px; border:1px solid #475569; cursor:pointer;">
              🚀 サーバー2 (GitLab高速版)
            </button>
            <button id="mokoriPaperSrv3" onclick="switchMokoriPaperServer(3)" style="background:#1e293b; color:#94a3b8; padding:4px 10px; font-size:11px; border-radius:6px; border:1px solid #475569; cursor:pointer;">
              🌐 サーバー3 (GitHub Pages公式)
            </button>
          </div>
          <div style="display:flex; gap:6px;">
            <button onclick="reloadMokoriPaper()" style="background:#1e293b; color:#cbd5e1; border:1px solid #475569; padding:4px 10px; border-radius:6px; font-size:11px; cursor:pointer;">
              🔄 再読込
            </button>
            <button onclick="toggleMokoriPaperFullscreen()" style="background:#1e293b; color:#fff; border:1px solid #475569; padding:4px 10px; border-radius:6px; font-size:11px; cursor:pointer;">
              ⛶ 全画面
            </button>
            <button onclick="window.open((PAPER_WEBGL_SERVERS[currentMokoriPaperServer]||PAPER_WEBGL_SERVERS[1]).url, '_blank')" style="background:#1e293b; color:#cbd5e1; border:1px solid #475569; padding:4px 10px; border-radius:6px; font-size:11px; cursor:pointer;">
              ↗️ 別タブ
            </button>
          </div>
        </div>
        <div id="mokoriPaperFrameWrap" style="position:relative; width:100%; height:68vh; min-height:440px; background:#000; border-radius:12px; overflow:hidden; border:2px solid #ec4899;">
          <iframe id="mokoriPaperIframe" src="paper/index.html" style="width:100%; height:100%; border:none; display:block;" allow="autoplay; fullscreen; web-share; gamepad; pointer-lock" allowfullscreen></iframe>
        </div>
        <div style="font-size:11px; color:#94a3b8; margin-top:8px;">
          💡 iPhone・iPad・PC対応！学校のiPadでもブロックされず快適に動きます。
        </div>
      </div>
    `;
  }

  // ==================================================
  // 6-b. ⭐ ブロスタ WebGL版（本家完全再現 & 埋め込み）
  // ==================================================
  const BRAWL_WEBGL_SERVERS = {
    1: { name: "本家3D WebGL版 (StaticQuasar)", url: "/api/proxy?url=" + encodeURIComponent("https://staticquasar931.github.io/Brawl-Stars/") },
    2: { name: "TurboWarp 60FPS版 (全69キャラ)", url: "/api/proxy?url=" + encodeURIComponent("https://turbowarp.org/544538470/embed?autoplay=true") },
    3: { name: "TurboWarp最新アプデ版 (Gods vs Monsters)", url: "/api/proxy?url=" + encodeURIComponent("https://turbowarp.org/1059386427/embed?autoplay=true") }
  };
  let currentMokoriBrawlServer = 1;

  window.switchMokoriBrawlServer = function(num) {
    currentMokoriBrawlServer = num;
    for (let i = 1; i <= 3; i++) {
      const btn = document.getElementById("mokoriBrawlSrv" + i);
      if (!btn) continue;
      if (i === num) {
        btn.style.background = "#424239";
        btn.style.color = "#fff";
        btn.style.border = "none";
      } else {
        btn.style.background = "#fff";
        btn.style.color = "#424239";
        btn.style.border = "1px solid #d4d2c9";
      }
    }
    const iframe = document.getElementById("mokoriBrawlIframe");
    const cfg = BRAWL_WEBGL_SERVERS[num] || BRAWL_WEBGL_SERVERS[1];
    if (iframe) iframe.src = cfg.url;
  };

  window.reloadMokoriBrawl = function() {
    const iframe = document.getElementById("mokoriBrawlIframe");
    if (iframe) {
      const s = iframe.src;
      iframe.src = "about:blank";
      setTimeout(() => { iframe.src = s; }, 50);
    }
  };

  window.openMokoriBrawlNewTab = function() {
    const cfg = BRAWL_WEBGL_SERVERS[currentMokoriBrawlServer] || BRAWL_WEBGL_SERVERS[1];
    window.open(cfg.url, "_blank");
  };

  window.toggleMokoriBrawlFs = function() {
    const wrap = document.getElementById("mokoriBrawlIframeWrap");
    if (!wrap) return;
    if (!document.fullscreenElement) {
      wrap.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  };

  function renderBrawlWebglGame(container) {
    currentMokoriBrawlServer = 1;
    container.innerHTML = `
      <div style="display:flex; flex-direction:column; width:100%; height:100%; max-width:860px; margin:0 auto; padding:4px;">
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:6px; margin-bottom:8px; background:#f0eee8; padding:8px 12px; border-radius:10px;">
          <div style="display:flex; gap:4px; align-items:center; flex-wrap:wrap;">
            <span style="font-size:12px; font-weight:bold; color:#424239;">🌐 サーバー:</span>
            <button id="mokoriBrawlSrv1" onclick="window.switchMokoriBrawlServer(1)" style="background:#424239; color:#fff; border:none; padding:4px 8px; font-size:11px; border-radius:6px; cursor:pointer;">⚡ 1: 本家3D WebGL</button>
            <button id="mokoriBrawlSrv2" onclick="window.switchMokoriBrawlServer(2)" style="background:#fff; color:#424239; border:1px solid #d4d2c9; padding:4px 8px; font-size:11px; border-radius:6px; cursor:pointer;">🌐 2: TurboWarp 69キャラ</button>
            <button id="mokoriBrawlSrv3" onclick="window.switchMokoriBrawlServer(3)" style="background:#fff; color:#424239; border:1px solid #d4d2c9; padding:4px 8px; font-size:11px; border-radius:6px; cursor:pointer;">🚀 3: TurboWarp最新版</button>
          </div>
          <div style="display:flex; gap:6px;">
            <button onclick="window.reloadMokoriBrawl()" style="background:#fff; color:#424239; border:1px solid #d4d2c9; padding:4px 8px; font-size:11px; border-radius:6px; cursor:pointer;">🔄 再読込</button>
            <button onclick="window.openMokoriBrawlNewTab()" style="background:#fff; color:#424239; border:1px solid #d4d2c9; padding:4px 8px; font-size:11px; border-radius:6px; cursor:pointer;">🔗 別タブ</button>
            <button onclick="window.toggleMokoriBrawlFs()" style="background:#fff; color:#424239; border:1px solid #d4d2c9; padding:4px 8px; font-size:11px; border-radius:6px; cursor:pointer;">⛶ 全画面</button>
          </div>
        </div>
        <div id="mokoriBrawlIframeWrap" style="flex:1; width:100%; min-height:480px; height:68vh; border-radius:12px; overflow:hidden; border:2px solid #e0ded5; background:#000;">
          <iframe id="mokoriBrawlIframe" src="/api/proxy?url=" + encodeURIComponent("https://staticquasar931.github.io/Brawl-Stars/") style="width:100%; height:100%; border:none; display:block;" allow="autoplay; fullscreen; web-share; gamepad; pointer-lock" allowfullscreen></iframe>
        </div>
      </div>
    `;
  }

  // ==================================================
  // 6. ⭐ ブロスタ（自前内蔵 3D本家完全再現版）
  // ==================================================
  function renderBrawlGame(container) {
    if (window.start3DBrawlGame) {
      window.start3DBrawlGame(container, "shelly");
    } else {
      renderBrawlWebglGame(container);
    }
  }

  // ==================================================
  // 6-c. 🏆 Fortnite 3D（フォートナイト バトルロイヤル）
  // ==================================================
  function renderFortniteGame(container) {
    if (window.startFortnite3DGame) {
      window.startFortnite3DGame(container);
    }
  }

  // ==================================================
  // 7. ♠️ ソリティア（本物クロンダイク完全実装）
  // ==================================================
/* ======================
   ソリティア (クロンダイク)
====================== */

let solStock = [];
let solWaste = [];
let solFoundations = [[], [], [], []];
let solTableau = [[], [], [], [], [], [], []];
let solScore = 0;
let solMoves = 0;
let solSelected = null;
let solInitialSnapshot = null;

const SOL_SUITS = [
  { name: "spade", symbol: "♠", color: "black", foundIdx: 0 },
  { name: "heart", symbol: "♥", color: "red", foundIdx: 1 },
  { name: "diamond", symbol: "♦", color: "red", foundIdx: 2 },
  { name: "club", symbol: "♣", color: "black", foundIdx: 3 }
];

const SOL_NUM_NAMES = {
  1: "A", 2: "2", 3: "3", 4: "4", 5: "5", 6: "6", 7: "7", 8: "8", 9: "9", 10: "10", 11: "J", 12: "Q", 13: "K"
};

function createSolDeck() {
  const deck = [];
  for (let sIdx = 0; sIdx < 4; sIdx++) {
    for (let num = 1; num <= 13; num++) {
      deck.push({
        id: `${SOL_SUITS[sIdx].name}_${num}_${Math.random().toString(36).slice(2, 6)}`,
        suit: SOL_SUITS[sIdx].name,
        symbol: SOL_SUITS[sIdx].symbol,
        color: SOL_SUITS[sIdx].color,
        foundIdx: SOL_SUITS[sIdx].foundIdx,
        num: num,
        name: SOL_NUM_NAMES[num],
        faceUp: false
      });
    }
  }
  return deck;
}

function shuffleSolDeck(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

window.openSolitaireHub = function () {
  window.hideAllScreens();
  const screen = document.getElementById("solitaireScreen");
  if (screen) screen.style.display = "block";
  if (!solInitialSnapshot) {
    window.startNewSolitaireGame();
  } else {
    renderSolitaireUI();
  }
};

window.startNewSolitaireGame = function () {
  const deck = shuffleSolDeck(createSolDeck());
  solStock = [];
  solWaste = [];
  solFoundations = [[], [], [], []];
  solTableau = [[], [], [], [], [], [], []];
  solScore = 0;
  solMoves = 0;
  solSelected = null;

  for (let col = 0; col < 7; col++) {
    for (let row = 0; row <= col; row++) {
      const card = deck.pop();
      card.faceUp = (row === col);
      solTableau[col].push(card);
    }
  }

  solStock = deck;

  solInitialSnapshot = JSON.stringify({
    stock: solStock,
    waste: solWaste,
    foundations: solFoundations,
    tableau: solTableau
  });

  renderSolitaireUI();
};

window.restartSolitaire = function () {
  if (!solInitialSnapshot) {
    window.startNewSolitaireGame();
    return;
  }
  const snap = JSON.parse(solInitialSnapshot);
  solStock = snap.stock;
  solWaste = snap.waste;
  solFoundations = snap.foundations;
  solTableau = snap.tableau;
  solScore = 0;
  solMoves = 0;
  solSelected = null;
  renderSolitaireUI();
};

window.drawSolitaireStock = function () {
  solSelected = null;
  if (solStock.length > 0) {
    const card = solStock.pop();
    card.faceUp = true;
    solWaste.push(card);
    solMoves++;
  } else if (solWaste.length > 0) {
    solStock = solWaste.reverse().map(c => {
      c.faceUp = false;
      return c;
    });
    solWaste = [];
    solMoves++;
  }
  renderSolitaireUI();
};

window.clickSolWaste = function () {
  if (solWaste.length === 0) return;
  const topCard = solWaste[solWaste.length - 1];

  if (solSelected && solSelected.location === "waste") {
    solSelected = null;
    renderSolitaireUI();
    return;
  }

  const canSendFound = tryAutoMoveCardToFoundation(topCard);
  if (canSendFound) {
    solWaste.pop();
    solScore += 10;
    solMoves++;
    solSelected = null;
    checkSolitaireWinCondition();
    renderSolitaireUI();
    return;
  }

  solSelected = { location: "waste", card: topCard };
  renderSolitaireUI();
};

function tryAutoMoveCardToFoundation(card) {
  const fIdx = card.foundIdx;
  const foundPile = solFoundations[fIdx];
  if (foundPile.length === 0) {
    if (card.num === 1) {
      foundPile.push(card);
      return true;
    }
  } else {
    const top = foundPile[foundPile.length - 1];
    if (top.num + 1 === card.num) {
      foundPile.push(card);
      return true;
    }
  }
  return false;
}

window.clickSolFoundation = function (fIdx) {
  const foundPile = solFoundations[fIdx];

  if (solSelected) {
    const card = solSelected.card;
    let valid = false;
    if (foundPile.length === 0 && card.num === 1 && card.foundIdx === fIdx) {
      valid = true;
    } else if (foundPile.length > 0) {
      const top = foundPile[foundPile.length - 1];
      if (top.foundIdx === fIdx && top.num + 1 === card.num) {
        valid = true;
      }
    }

    if (valid) {
      removeSelectedSolCard();
      foundPile.push(card);
      solScore += 10;
      solMoves++;
      solSelected = null;
      checkSolitaireWinCondition();
      renderSolitaireUI();
      return;
    }
  }

  if (foundPile.length > 0) {
    const card = foundPile[foundPile.length - 1];
    if (solSelected && solSelected.location === "found" && solSelected.fIdx === fIdx) {
      solSelected = null;
    } else {
      solSelected = { location: "found", fIdx: fIdx, card: card };
    }
    renderSolitaireUI();
  }
};

window.clickSolTableau = function (colIdx, cardIdx) {
  const col = solTableau[colIdx];

  if (col.length === 0) {
    if (solSelected && solSelected.card.num === 13) {
      const movingCards = getSelectedSolCards();
      removeSelectedSolCard();
      solTableau[colIdx].push(...movingCards);
      solScore += 5;
      solMoves++;
      solSelected = null;
      renderSolitaireUI();
    }
    return;
  }

  const clickedCard = col[cardIdx];

  if (!clickedCard.faceUp) {
    if (cardIdx === col.length - 1) {
      clickedCard.faceUp = true;
      solScore += 5;
      solMoves++;
      renderSolitaireUI();
    }
    return;
  }

  if (solSelected) {
    if (solSelected.location === "tableau" && solSelected.colIdx === colIdx && solSelected.cardIdx === cardIdx) {
      solSelected = null;
      renderSolitaireUI();
      return;
    }

    const movingCard = solSelected.card;
    const destCard = col[col.length - 1];

    if (destCard.color !== movingCard.color && destCard.num === movingCard.num + 1) {
      const movingCards = getSelectedSolCards();
      removeSelectedSolCard();
      solTableau[colIdx].push(...movingCards);
      solScore += 5;
      solMoves++;
      solSelected = null;
      renderSolitaireUI();
      return;
    }
  }

  if (cardIdx === col.length - 1) {
    const canFound = tryAutoMoveCardToFoundation(clickedCard);
    if (canFound) {
      col.pop();
      if (col.length > 0 && !col[col.length - 1].faceUp) {
        col[col.length - 1].faceUp = true;
        solScore += 5;
      }
      solScore += 10;
      solMoves++;
      solSelected = null;
      checkSolitaireWinCondition();
      renderSolitaireUI();
      return;
    }
  }

  solSelected = {
    location: "tableau",
    colIdx: colIdx,
    cardIdx: cardIdx,
    card: clickedCard
  };
  renderSolitaireUI();
};

function getSelectedSolCards() {
  if (!solSelected) return [];
  if (solSelected.location === "waste" || solSelected.location === "found") {
    return [solSelected.card];
  }
  if (solSelected.location === "tableau") {
    const col = solTableau[solSelected.colIdx];
    return col.slice(solSelected.cardIdx);
  }
  return [];
}

function removeSelectedSolCard() {
  if (!solSelected) return;
  if (solSelected.location === "waste") {
    solWaste.pop();
  } else if (solSelected.location === "found") {
    solFoundations[solSelected.fIdx].pop();
  } else if (solSelected.location === "tableau") {
    const col = solTableau[solSelected.colIdx];
    col.splice(solSelected.cardIdx);
    if (col.length > 0 && !col[col.length - 1].faceUp) {
      col[col.length - 1].faceUp = true;
      solScore += 5;
    }
  }
}

function checkSolitaireWinCondition() {
  const totalFound = solFoundations.reduce((acc, f) => acc + f.length, 0);
  if (totalFound === 52) {
    setTimeout(() => {
      alert("🎉 祝・クリア！ソリティア完成おめでとうございます！スコア: " + solScore);
    }, 200);
    return;
  }

  let allFaceUp = true;
  for (const col of solTableau) {
    for (const c of col) {
      if (!c.faceUp) { allFaceUp = false; break; }
    }
  }
  const canAuto = allFaceUp && solStock.length === 0 && solWaste.length === 0;
  const autoBtn = document.getElementById("solitaireAutoBtn");
  if (autoBtn) autoBtn.style.display = canAuto ? "block" : "none";
}

window.autoSolveSolitaire = function () {
  let moved = false;
  for (let c = 0; c < 7; c++) {
    const col = solTableau[c];
    if (col.length > 0) {
      const card = col[col.length - 1];
      if (tryAutoMoveCardToFoundation(card)) {
        col.pop();
        solScore += 10;
        solMoves++;
        moved = true;
        break;
      }
    }
  }
  renderSolitaireUI();
  checkSolitaireWinCondition();
  if (moved) {
    setTimeout(window.autoSolveSolitaire, 80);
  }
};

function renderSolitaireUI() {
  document.getElementById("solitaireScore").textContent = solScore;
  document.getElementById("solitaireMoves").textContent = solMoves;

  const wasteEl = document.getElementById("solWaste");
  if (wasteEl) {
    if (solWaste.length === 0) {
      wasteEl.innerHTML = "";
    } else {
      const top = solWaste[solWaste.length - 1];
      const isSel = solSelected && solSelected.location === "waste";
      wasteEl.innerHTML = `
        <div class="pcard ${top.color} ${isSel ? 'selected' : ''}" style="width:100%; height:100%; margin:0;">
          <div style="font-size:10px;">${top.symbol}${top.name}</div>
          <div style="font-size:16px; text-align:center;">${top.symbol}</div>
          <div style="font-size:10px; text-align:right;">${top.name}</div>
        </div>
      `;
    }
  }

  for (let i = 0; i < 4; i++) {
    const fEl = document.getElementById(`solFound${i}`);
    if (!fEl) continue;
    const fPile = solFoundations[i];
    if (fPile.length === 0) {
      const symbols = ["♠", "♥", "♦", "♣"];
      fEl.innerHTML = symbols[i];
    } else {
      const top = fPile[fPile.length - 1];
      const isSel = solSelected && solSelected.location === "found" && solSelected.fIdx === i;
      fEl.innerHTML = `
        <div class="pcard ${top.color} ${isSel ? 'selected' : ''}" style="width:100%; height:100%; margin:0;">
          <div style="font-size:10px;">${top.symbol}${top.name}</div>
          <div style="font-size:16px; text-align:center;">${top.symbol}</div>
          <div style="font-size:10px; text-align:right;">${top.name}</div>
        </div>
      `;
    }
  }

  const tableauArea = document.getElementById("solTableauArea");
  if (!tableauArea) return;
  tableauArea.innerHTML = "";

  for (let colIdx = 0; colIdx < 7; colIdx++) {
    const col = solTableau[colIdx];
    const colDiv = document.createElement("div");
    colDiv.style.position = "relative";
    colDiv.style.minHeight = "280px";
    colDiv.onclick = (e) => {
      if (e.target === colDiv && col.length === 0) {
        window.clickSolTableau(colIdx, 0);
      }
    };

    if (col.length === 0) {
      colDiv.innerHTML = `<div style="width:100%; height:60px; border:1px dashed #059669; border-radius:6px; background:rgba(0,0,0,0.15);"></div>`;
    } else {
      col.forEach((card, cardIdx) => {
        const isSel = solSelected && solSelected.location === "tableau" && solSelected.colIdx === colIdx && cardIdx >= solSelected.cardIdx;
        const cardDiv = document.createElement("div");
        cardDiv.className = `pcard ${card.faceUp ? card.color : 'back'} ${isSel ? 'selected' : ''}`;
        cardDiv.style.position = "absolute";
        cardDiv.style.top = `${cardIdx * 18}px`;
        cardDiv.style.left = "0";
        cardDiv.style.right = "0";
        cardDiv.style.width = "100%";
        cardDiv.style.zIndex = cardIdx + 1;

        if (card.faceUp) {
          cardDiv.innerHTML = `
            <div style="font-size:10px;">${card.symbol}${card.name}</div>
            <div style="font-size:14px; text-align:center;">${card.symbol}</div>
            <div style="font-size:10px; text-align:right;">${card.name}</div>
          `;
        } else {
          cardDiv.innerHTML = `🎴`;
        }

        cardDiv.onclick = (e) => {
          e.stopPropagation();
          window.clickSolTableau(colIdx, cardIdx);
        };
        colDiv.appendChild(cardDiv);
      });
    }

    tableauArea.appendChild(colDiv);
  }
}



  function renderSolitaireGame(container) {
    container.innerHTML = `
      <div style="padding:10px; max-width:540px; margin:0 auto; text-align:center;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; flex-wrap:wrap; gap:6px;">
          <div style="font-size:14px; color:#10b981; font-weight:bold;">♠️ クロンダイク・ソリティア</div>
          <div style="display:flex; gap:6px;">
            <button onclick="window.restartSolitaire()" style="background:#1e293b; border:1px solid #334155; color:#f0f6fc; padding:4px 10px; font-size:12px; border-radius:6px; cursor:pointer;">
              🔄 最初から
            </button>
            <button onclick="window.startNewSolitaireGame()" style="background:#10b981; color:#fff; border:none; padding:4px 10px; font-size:12px; font-weight:bold; border-radius:6px; cursor:pointer;">
              🆕 新ゲーム
            </button>
          </div>
        </div>

        <!-- ステータスバー -->
        <div style="display:flex; justify-content:space-between; align-items:center; background:#161b22; border:1px solid #30363d; border-radius:8px; padding:6px 12px; margin-bottom:10px; font-size:12px;">
          <div style="display:flex; gap:12px;">
            <span style="color:#94a3b8;">スコア: <strong id="solitaireScore" style="color:#f0f6fc;">0</strong></span>
            <span style="color:#94a3b8;">手数: <strong id="solitaireMoves" style="color:#f0f6fc;">0</strong></span>
          </div>
          <button id="solitaireAutoBtn" onclick="window.autoSolveSolitaire()" style="display:none; background:linear-gradient(135deg, #f59e0b, #d97706); color:#fff; font-size:11px; font-weight:bold; padding:3px 8px; border-radius:4px; border:none; cursor:pointer;">
            ✨ 自動完成
          </button>
        </div>

        <!-- ソリティア盤面コンテナ (グリーンフェルト背景) -->
        <div id="solitaireBoard" style="background:#064e3b; border:2px solid #047857; border-radius:12px; padding:10px 6px; min-height:440px; user-select:none; box-shadow:inset 0 2px 8px rgba(0,0,0,0.5);">
          <!-- 上段: 山札 / 捨て札 ＆ 組札 4枠 -->
          <div style="display:flex; justify-content:space-between; gap:4px; margin-bottom:12px;">
            <div style="display:flex; gap:6px;">
              <div id="solStock" onclick="window.drawSolitaireStock()" style="width:42px; height:60px; border:1px dashed #059669; border-radius:6px; display:flex; align-items:center; justify-content:center; cursor:pointer; background:#022c22;">
                <span style="font-size:20px;">🎴</span>
              </div>
              <div id="solWaste" onclick="window.clickSolWaste()" style="width:42px; height:60px; border:1px solid #047857; border-radius:6px; position:relative;"></div>
            </div>
            <div style="display:flex; gap:4px;">
              <div id="solFound0" onclick="window.clickSolFoundation(0)" style="width:42px; height:60px; border:1px dashed #059669; border-radius:6px; display:flex; align-items:center; justify-content:center; color:#047857; font-size:16px; cursor:pointer; position:relative;">♠</div>
              <div id="solFound1" onclick="window.clickSolFoundation(1)" style="width:42px; height:60px; border:1px dashed #059669; border-radius:6px; display:flex; align-items:center; justify-content:center; color:#047857; font-size:16px; cursor:pointer; position:relative;">♥</div>
              <div id="solFound2" onclick="window.clickSolFoundation(2)" style="width:42px; height:60px; border:1px dashed #059669; border-radius:6px; display:flex; align-items:center; justify-content:center; color:#047857; font-size:16px; cursor:pointer; position:relative;">♦</div>
              <div id="solFound3" onclick="window.clickSolFoundation(3)" style="width:42px; height:60px; border:1px dashed #059669; border-radius:6px; display:flex; align-items:center; justify-content:center; color:#047857; font-size:16px; cursor:pointer; position:relative;">♣</div>
            </div>
          </div>

          <!-- 下段: 場札 7列 -->
          <div id="solTableauArea" style="display:grid; grid-template-columns:repeat(7, 1fr); gap:4px; min-height:340px;"></div>
        </div>
      </div>
    `;

    window.startNewSolitaireGame();
  }

  // ====================================================
  // 🎨 お絵描きクイズ（リアルタイム対戦 & ソロ絵心判定）
  // ====================================================
  const DQ_WORDS = [
    { word: "りんご", kana: "りんご", hint: "赤い果物 🍎" },
    { word: "バナナ", kana: "ばなな", hint: "黄色い果物 🍌" },
    { word: "スイカ", kana: "すいか", hint: "夏の果物 🍉" },
    { word: "ねこ", kana: "ねこ", hint: "にゃーと鳴く動物 🐱" },
    { word: "いぬ", kana: "いぬ", hint: "わんわん鳴く動物 🐶" },
    { word: "パンダ", kana: "ぱんだ", hint: "白黒の動物 🐼" },
    { word: "ヤギ", kana: "やぎ", hint: "草を食べる動物 🐐" },
    { word: "ライオン", kana: "らいおん", hint: "百獣の王 🦁" },
    { word: "ペンギン", kana: "ぺんぎん", hint: "氷の上の鳥 🐧" },
    { word: "オムライス", kana: "おむらいす", hint: "卵とケチャップのご飯 🍳" },
    { word: "カレーライス", kana: "かれーらいす", hint: "みんな大好きな辛い料理 🍛" },
    { word: "ラーメン", kana: "らーめん", hint: "麺料理 🍜" },
    { word: "ハンバーガー", kana: "はんばーがー", hint: "パンに挟んだお肉 🍔" },
    { word: "ピザ", kana: "ぴざ", hint: "とろけるチーズの料理 🍕" },
    { word: "車", kana: "くるま", hint: "道路を走る乗り物 🚗" },
    { word: "飛行機", kana: "ひこうき", hint: "空を飛ぶ乗り物 ✈️" },
    { word: "新幹線", kana: "しんかんせん", hint: "日本の超特急 🚅" },
    { word: "ロケット", kana: "ろけっと", hint: "宇宙へ行く乗り物 🚀" },
    { word: "富士山", kana: "ふじさん", hint: "日本一高い山 🗻" },
    { word: "東京タワー", kana: "とうきょうたわー", hint: "赤と白の電波塔 🗼" },
    { word: "雪だるま", kana: "ゆきだるま", hint: "雪で作る冬の友達 ⛄" },
    { word: "ひまわり", kana: "ひまわり", hint: "黄色い大きな夏の花 🌻" },
    { word: "たいよう", kana: "たいよう", hint: "空で輝く恒星 ☀️" },
    { word: "サッカーボール", kana: "さっかーぼーる", hint: "白黒の丸いボール ⚽" },
    { word: "フォートナイト", kana: "ふぉーとないと", hint: "大人気3Dバトロワ 🎮" },
    { word: "オセロ", kana: "おせろ", hint: "白と黒のボードゲーム ⚫⚪" },
    { word: "ギター", kana: "ぎたー", hint: "弦を弾く楽器 🎸" },
    { word: "ピアノ", kana: "ぴあの", hint: "鍵盤楽器 🎹" },
    { word: "テレビ", kana: "てれび", hint: "番組を見る家電 📺" },
    { word: "スマホ", kana: "すまほ", hint: "いつも持ってる電話 📱" },
    { word: "パソコン", kana: "ぱそこん", hint: "キーボードで打つ電子頭脳 💻" },
    { word: "メガネ", kana: "めがね", hint: "目にかけるもの 👓" },
    { word: "ぼうし", kana: "ぼうし", hint: "頭にかぶるもの 🧢" },
    { word: "スニーカー", kana: "すにーかー", hint: "足に履く靴 👟" },
    { word: "かさ", kana: "かさ", hint: "雨の日に差すもの ☂️" }
  ];

  function kataToHira(str) {
    return str.replace(/[\u30a1-\u30f6]/g, m => String.fromCharCode(m.charCodeAt(0) - 0x60));
  }

  function renderDrawQuizGame(container, roomCode) {
    const isOnline = !!roomCode;
    let strokes = []; // [ { color, size, points: [[x,y],...] } ]
    let currentStroke = null;
    let currentColor = "#000000";
    let currentSize = 5;
    let isEraser = false;
    let isDrawing = false;
    let myRole = 1; // 1: Drawer, 2+: Guesser
    let drawerUid = (window.currentUser && window.currentUser.uid) || "host";
    let drawerName = (window.currentUser && window.currentUser.displayName) || "ホスト";
    let currentWordIndex = Math.floor(Math.random() * DQ_WORDS.length);
    let currentWord = DQ_WORDS[currentWordIndex];
    let guesses = []; // [ { username, text, isCorrect, time } ]
    let scores = {}; // username -> points
    let timeLeft = 60;
    let timerInterval = null;
    let pollInterval = null;
    let isGuessedCorrectly = false;

    container.innerHTML = `
      <div style="display:flex; flex-direction:column; width:100%; height:100%; background:#0f172a; color:#f8fafc; font-family:-apple-system,BlinkMacSystemFont,sans-serif; overflow:hidden;">
        <!-- 上部バー -->
        <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 16px; background:#1e293b; border-bottom:1px solid #334155; flex-shrink:0;">
          <div style="display:flex; align-items:center; gap:10px;">
            <span id="dqModeBadge" style="background:#0284c7; color:#fff; font-size:11px; font-weight:bold; padding:3px 10px; border-radius:12px;">
              ${isOnline ? "👥 オンライン対戦" : "🤖 ソロお絵描き"}
            </span>
            <span style="font-size:12px; color:#94a3b8;" id="dqRoomInfo">
              ${isOnline ? "ルーム: " + roomCode : "自由に描いて当てよう"}
            </span>
          </div>
          <div id="dqTimerDisplay" style="font-size:18px; font-weight:800; color:#f59e0b; font-variant-numeric:tabular-nums;">
            ⏳ 60秒
          </div>
          <div style="display:flex; gap:8px;">
            ${isOnline ? '<button id="dqShareBtn" style="background:#06c755; color:#fff; border:0; padding:6px 12px; border-radius:6px; font-size:12px; font-weight:bold; cursor:pointer;">📤 トークに招待</button>' : ''}
            <button id="dqNextWordBtn" style="background:#3b82f6; color:#fff; border:0; padding:6px 12px; border-radius:6px; font-size:12px; font-weight:bold; cursor:pointer;">お題変更 🎲</button>
          </div>
        </div>

        <!-- お題・役割バナー -->
        <div id="dqBanner" style="padding:10px 16px; background:#1e293b; text-align:center; font-size:15px; font-weight:bold; color:#38bdf8; border-bottom:1px solid #334155; flex-shrink:0;">
          🎨 あなたがお題を描いてください！ お題: 【 ${currentWord.word} 】 (${currentWord.hint})
        </div>

        <!-- メイン対戦エリア -->
        <div style="display:flex; flex:1; min-height:0; gap:10px; padding:10px;">
          <!-- キャンバス側 -->
          <div style="display:flex; flex-direction:column; flex:1; min-width:0; background:#1e293b; border-radius:12px; padding:10px; border:1px solid #334155;">
            <div style="flex:1; min-height:0; position:relative; display:flex; align-items:center; justify-content:center; background:#cbd5e1; border-radius:8px; overflow:hidden;">
              <canvas id="dqCanvas" style="background:#ffffff; border-radius:6px; width:100%; height:100%; touch-action:none; cursor:crosshair;"></canvas>
            </div>

            <!-- お絵描きツールバー -->
            <div id="dqToolbar" style="display:flex; justify-content:space-between; align-items:center; padding-top:10px; gap:8px; flex-wrap:wrap; flex-shrink:0;">
              <!-- カラーパレット -->
              <div style="display:flex; gap:6px; align-items:center;" id="dqColorPalette">
                <div class="dq-color-dot active" data-color="#000000" style="width:24px; height:24px; border-radius:50%; background:#000000; cursor:pointer; border:2px solid #fff; box-shadow:0 0 4px rgba(0,0,0,0.5);"></div>
                <div class="dq-color-dot" data-color="#ef4444" style="width:24px; height:24px; border-radius:50%; background:#ef4444; cursor:pointer; border:2px solid transparent;"></div>
                <div class="dq-color-dot" data-color="#3b82f6" style="width:24px; height:24px; border-radius:50%; background:#3b82f6; cursor:pointer; border:2px solid transparent;"></div>
                <div class="dq-color-dot" data-color="#10b981" style="width:24px; height:24px; border-radius:50%; background:#10b981; cursor:pointer; border:2px solid transparent;"></div>
                <div class="dq-color-dot" data-color="#f59e0b" style="width:24px; height:24px; border-radius:50%; background:#f59e0b; cursor:pointer; border:2px solid transparent;"></div>
                <div class="dq-color-dot" data-color="#8b5cf6" style="width:24px; height:24px; border-radius:50%; background:#8b5cf6; cursor:pointer; border:2px solid transparent;"></div>
                <div class="dq-color-dot" data-color="#78350f" style="width:24px; height:24px; border-radius:50%; background:#78350f; cursor:pointer; border:2px solid transparent;"></div>
              </div>

              <!-- ブラシ太さ・消しゴム・クリア -->
              <div style="display:flex; gap:6px; align-items:center;">
                <button id="dqBrushSmall" class="dq-tool-btn" style="padding:4px 8px; border-radius:6px; background:#334155; border:0; color:#fff; font-size:11px; cursor:pointer;">細 (2px)</button>
                <button id="dqBrushMed" class="dq-tool-btn active" style="padding:4px 8px; border-radius:6px; background:#0284c7; border:0; color:#fff; font-size:11px; cursor:pointer;">中 (5px)</button>
                <button id="dqBrushLarge" class="dq-tool-btn" style="padding:4px 8px; border-radius:6px; background:#334155; border:0; color:#fff; font-size:11px; cursor:pointer;">太 (12px)</button>
                <button id="dqEraserBtn" style="padding:4px 10px; border-radius:6px; background:#334155; border:0; color:#fff; font-size:11px; cursor:pointer;">🧹 消しゴム</button>
                <button id="dqUndoBtn" style="padding:4px 10px; border-radius:6px; background:#334155; border:0; color:#fff; font-size:11px; cursor:pointer;">↩️ 戻す</button>
                <button id="dqClearBtn" style="padding:4px 10px; border-radius:6px; background:#ef4444; border:0; color:#fff; font-size:11px; font-weight:bold; cursor:pointer;">🗑️ 全消去</button>
              </div>
            </div>
          </div>

          <!-- 回答チャット & スコアボード -->
          <div style="width:260px; display:flex; flex-direction:column; background:#1e293b; border-radius:12px; padding:12px; border:1px solid #334155; flex-shrink:0;">
            <div style="font-size:11px; font-weight:bold; color:#94a3b8; margin-bottom:6px; text-transform:uppercase;">🏆 プレイヤー＆スコア</div>
            <div id="dqScoreList" style="max-height:80px; overflow-y:auto; margin-bottom:10px; font-size:12px; display:flex; flex-direction:column; gap:4px; background:#0f172a; padding:6px; border-radius:6px;">
              <div style="display:flex; justify-content:space-between; font-weight:bold;">
                <span>🐐 ${drawerName} (描き手)</span>
                <span style="color:#f59e0b;">0 pt</span>
              </div>
            </div>

            <div style="font-size:11px; font-weight:bold; color:#94a3b8; margin-bottom:6px; text-transform:uppercase;">💬 みんなの回答</div>
            <div id="dqChatFeed" style="flex:1; overflow-y:auto; background:#0f172a; border-radius:6px; padding:8px; font-size:12px; display:flex; flex-direction:column; gap:6px; margin-bottom:10px; min-height:120px;">
              <div style="color:#64748b; font-size:11px; text-align:center;">お題がわかったら下の入力欄から送信！</div>
            </div>

            <!-- 回答入力エリア -->
            <div style="display:flex; gap:6px;">
              <input type="text" id="dqGuessInput" placeholder="お題を入力して回答！" style="flex:1; min-width:0; background:#0f172a; border:1px solid #475569; border-radius:6px; color:#fff; padding:8px 10px; font-size:13px; outline:none;">
              <button id="dqGuessBtn" style="background:#06c755; color:#fff; border:0; border-radius:6px; padding:0 14px; font-weight:bold; font-size:13px; cursor:pointer;">送信</button>
            </div>
          </div>
        </div>
      </div>
    `;

    // キャンバス初期化
    const canvas = document.getElementById("dqCanvas");
    const ctx = canvas.getContext("2d");
    let dpr = window.devicePixelRatio || 1;

    function resizeCanvas() {
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      redrawAllStrokes();
    }

    setTimeout(resizeCanvas, 50);
    window.addEventListener("resize", resizeCanvas);

    function redrawAllStrokes() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      strokes.forEach(s => {
        if (!s.points || s.points.length < 2) return;
        ctx.beginPath();
        ctx.strokeStyle = s.color;
        ctx.lineWidth = s.size * dpr;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.moveTo(s.points[0][0] * canvas.width, s.points[0][1] * canvas.height);
        for (let i = 1; i < s.points.length; i++) {
          ctx.lineTo(s.points[i][0] * canvas.width, s.points[i][1] * canvas.height);
        }
        ctx.stroke();
      });
    }

    function getCanvasCoords(e) {
      const rect = canvas.getBoundingClientRect();
      let clientX = e.clientX;
      let clientY = e.clientY;
      if (e.touches && e.touches.length > 0) {
        clientX = e.touches[0].clientX;
        clientY = e.touches[0].clientY;
      }
      return [
        Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)),
        Math.max(0, Math.min(1, (clientY - rect.top) / rect.height))
      ];
    }

    function isMyTurnToDraw() {
      if (!isOnline) return true;
      const myUid = (window.currentUser && window.currentUser.uid) || "";
      return drawerUid === myUid || myRole === 1;
    }

    // マウス / タッチ イベント
    function handleStart(e) {
      if (!isMyTurnToDraw()) return;
      isDrawing = true;
      const [nx, ny] = getCanvasCoords(e);
      currentStroke = {
        color: isEraser ? "#ffffff" : currentColor,
        size: isEraser ? currentSize * 2.5 : currentSize,
        points: [[nx, ny]]
      };
      strokes.push(currentStroke);
      playTone(260, "triangle", 0.05);
    }

    function handleMove(e) {
      if (!isDrawing || !currentStroke) return;
      e.preventDefault();
      const [nx, ny] = getCanvasCoords(e);
      currentStroke.points.push([nx, ny]);

      // 部分描画
      ctx.beginPath();
      ctx.strokeStyle = currentStroke.color;
      ctx.lineWidth = currentStroke.size * dpr;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      const pts = currentStroke.points;
      const prev = pts[pts.length - 2];
      ctx.moveTo(prev[0] * canvas.width, prev[1] * canvas.height);
      ctx.lineTo(nx * canvas.width, ny * canvas.height);
      ctx.stroke();
    }

    function handleEnd() {
      if (!isDrawing) return;
      isDrawing = false;
      currentStroke = null;
      syncOnlineState();
    }

    canvas.addEventListener("pointerdown", handleStart);
    canvas.addEventListener("pointermove", handleMove);
    canvas.addEventListener("pointerup", handleEnd);
    canvas.addEventListener("pointercancel", handleEnd);

    // ツールバー操作
    document.querySelectorAll(".dq-color-dot").forEach(dot => {
      dot.addEventListener("click", () => {
        isEraser = false;
        currentColor = dot.dataset.color;
        document.querySelectorAll(".dq-color-dot").forEach(d => d.style.borderColor = "transparent");
        dot.style.borderColor = "#fff";
        document.getElementById("dqEraserBtn").style.background = "#334155";
      });
    });

    const brushBtns = [
      { id: "dqBrushSmall", size: 2 },
      { id: "dqBrushMed", size: 5 },
      { id: "dqBrushLarge", size: 12 }
    ];
    brushBtns.forEach(b => {
      document.getElementById(b.id).addEventListener("click", () => {
        currentSize = b.size;
        brushBtns.forEach(x => document.getElementById(x.id).style.background = "#334155");
        document.getElementById(b.id).style.background = "#0284c7";
      });
    });

    document.getElementById("dqEraserBtn").addEventListener("click", () => {
      isEraser = !isEraser;
      document.getElementById("dqEraserBtn").style.background = isEraser ? "#dc2626" : "#334155";
    });

    document.getElementById("dqUndoBtn").addEventListener("click", () => {
      if (!isMyTurnToDraw() || strokes.length === 0) return;
      strokes.pop();
      redrawAllStrokes();
      syncOnlineState();
    });

    document.getElementById("dqClearBtn").addEventListener("click", () => {
      if (!isMyTurnToDraw()) return;
      strokes = [];
      redrawAllStrokes();
      syncOnlineState();
    });

    // お題変更ボタン
    document.getElementById("dqNextWordBtn").addEventListener("click", () => {
      if (!isMyTurnToDraw()) return;
      currentWordIndex = (currentWordIndex + 1) % DQ_WORDS.length;
      currentWord = DQ_WORDS[currentWordIndex];
      strokes = [];
      redrawAllStrokes();
      isGuessedCorrectly = false;
      timeLeft = 60;
      updateBanner();
      syncOnlineState();
    });

    // 招待ボタン
    const shareBtn = document.getElementById("dqShareBtn");
    if (shareBtn) {
      shareBtn.addEventListener("click", () => {
        window.openGameForwardDialog("drawquiz", "🎨 お絵描きクイズ", roomCode);
      });
    }

    function updateBanner() {
      const banner = document.getElementById("dqBanner");
      if (!banner) return;
      if (isMyTurnToDraw()) {
        banner.innerHTML = `🎨 あなたがお題を描いてください！ お題: 【 <span style="color:#f59e0b;font-size:18px;">${currentWord.word}</span> 】 (${currentWord.hint})`;
      } else {
        banner.innerHTML = `❓ ${drawerName} さんがお題を描いています… 何の絵かわかったら当ててね！`;
      }
    }

    function addChatMessage(uname, text, isCorrect = false) {
      const feed = document.getElementById("dqChatFeed");
      if (!feed) return;
      const row = document.createElement("div");
      row.style.padding = "4px 8px";
      row.style.borderRadius = "6px";
      row.style.fontSize = "12px";
      if (isCorrect) {
        row.style.background = "linear-gradient(135deg, #059669, #10b981)";
        row.style.color = "#ffffff";
        row.style.fontWeight = "bold";
        row.textContent = `🎉 正解！ ${uname} さんが当てました！ (+100pt)`;
      } else {
        row.style.background = "#1e293b";
        row.innerHTML = `<span style="font-weight:bold;color:#38bdf8;">${escapeHtml(uname)}:</span> ${escapeHtml(text)}`;
      }
      feed.appendChild(row);
      feed.scrollTop = feed.scrollHeight;
    }

    // 回答判定処理
    function submitGuess() {
      const input = document.getElementById("dqGuessInput");
      const text = (input ? input.value : "").trim();
      if (!text) return;
      input.value = "";

      const myName = (window.currentUser && window.currentUser.displayName) || "自分";
      const normalizedGuess = kataToHira(text.toLowerCase());
      const normalizedWord = kataToHira(currentWord.word.toLowerCase());
      const normalizedKana = kataToHira(currentWord.kana.toLowerCase());

      const isMatch = (normalizedGuess === normalizedWord || normalizedGuess === normalizedKana);

      if (isMatch) {
        playTone(523.25, "triangle", 0.1);
        setTimeout(() => playTone(659.25, "triangle", 0.1), 100);
        setTimeout(() => playTone(783.99, "triangle", 0.2), 200);

        scores[myName] = (scores[myName] || 0) + 100;
        updateScoreBoard();
        addChatMessage(myName, text, true);

        guesses.push({ username: myName, text, isCorrect: true, time: Date.now() });
        isGuessedCorrectly = true;

        if (isMyTurnToDraw()) {
          setTimeout(() => {
            currentWordIndex = (currentWordIndex + 1) % DQ_WORDS.length;
            currentWord = DQ_WORDS[currentWordIndex];
            strokes = [];
            redrawAllStrokes();
            isGuessedCorrectly = false;
            timeLeft = 60;
            updateBanner();
            syncOnlineState();
          }, 3000);
        } else {
          syncOnlineState();
        }
      } else {
        playTone(180, "sawtooth", 0.08);
        addChatMessage(myName, text, false);
        guesses.push({ username: myName, text, isCorrect: false, time: Date.now() });
        syncOnlineState();
      }
    }

    document.getElementById("dqGuessBtn").addEventListener("click", submitGuess);
    document.getElementById("dqGuessInput").addEventListener("keydown", (e) => {
      if (e.key === "Enter") submitGuess();
    });

    function updateScoreBoard() {
      const list = document.getElementById("dqScoreList");
      if (!list) return;
      list.innerHTML = "";
      Object.entries(scores).forEach(([name, pt]) => {
        const item = document.createElement("div");
        item.style.display = "flex";
        item.style.justifyContent = "space-between";
        item.style.fontWeight = "bold";
        item.innerHTML = `<span>👤 ${escapeHtml(name)}</span><span style="color:#f59e0b;">${pt} pt</span>`;
        list.appendChild(item);
      });
    }

    // オンライン同期
    async function syncOnlineState() {
      if (!isOnline) return;
      try {
        await window.api(`/api/games/rooms/${roomCode}/update`, {
          method: "POST",
          body: JSON.stringify({
            state: {
              word: currentWord.word,
              kana: currentWord.kana,
              hint: currentWord.hint,
              drawerUid,
              drawerName,
              strokes: strokes.slice(-80), // 最新ストローク
              guesses: guesses.slice(-20),
              scores,
              timeLeft
            }
          })
        });
      } catch(e){}
    }

    async function initOnline() {
      if (!isOnline) {
        scores[drawerName] = 0;
        updateScoreBoard();
        updateBanner();
        return;
      }

      try {
        const myName = (window.currentUser && (window.currentUser.displayName || window.currentUser.username)) || (document.getElementById("myProfileUsernameInput") && document.getElementById("myProfileUsernameInput").value.trim()) || "プレイヤー";
        const myUid = (window.currentUser && window.currentUser.uid) || "";
        const res = await window.api(`/api/games/rooms/${roomCode}/join`, {
          method: "POST",
          body: JSON.stringify({
            gameType: "drawquiz",
            username: myName,
            initialState: {
              word: currentWord.word,
              kana: currentWord.kana,
              hint: currentWord.hint,
              drawerUid: myUid,
              drawerName: myName,
              strokes: [],
              guesses: [],
              scores: { [myName]: 0 },
              timeLeft: 60
            }
          })
        });

        if (res && res.role) {
          myRole = res.role;
          if (res.room && res.room.players) {
            drawerUid = res.room.players[0].uid;
            drawerName = res.room.players[0].username;
          }
        }
        updateBanner();
        startPolling();
      } catch(e) {
        console.warn("Online drawquiz join failed, solo mode:", e);
      }
    }

    function startPolling() {
      if (pollInterval) clearInterval(pollInterval);
      pollInterval = setInterval(async () => {
        if (!isOnline) return;
        try {
          const res = await window.api(`/api/games/rooms/${roomCode}`);
          if (res && res.room && res.room.state) {
            const st = res.room.state;
            if (!isMyTurnToDraw()) {
              if (st.strokes && JSON.stringify(st.strokes) !== JSON.stringify(strokes)) {
                strokes = st.strokes || [];
                redrawAllStrokes();
              }
              if (st.word && st.word !== currentWord.word) {
                currentWord = { word: st.word, kana: st.kana || st.word, hint: st.hint || "" };
                updateBanner();
              }
              if (st.drawerName && st.drawerName !== drawerName) {
                drawerName = st.drawerName;
                drawerUid = st.drawerUid;
                updateBanner();
              }
            }
            if (st.scores) {
              scores = st.scores;
              updateScoreBoard();
            }
          }
        } catch(e){}
      }, 1000);
    }

    // タイマー
    timerInterval = setInterval(() => {
      timeLeft = Math.max(0, timeLeft - 1);
      const timerEl = document.getElementById("dqTimerDisplay");
      if (timerEl) {
        timerEl.textContent = `⏳ ${timeLeft}秒`;
        if (timeLeft <= 10) timerEl.style.color = "#ef4444";
      }
      if (timeLeft === 0 && isMyTurnToDraw()) {
        currentWordIndex = (currentWordIndex + 1) % DQ_WORDS.length;
        currentWord = DQ_WORDS[currentWordIndex];
        strokes = [];
        redrawAllStrokes();
        timeLeft = 60;
        updateBanner();
        syncOnlineState();
      }
    }, 1000);

    // クリーンアップ関数
    window._stopDrawQuiz = function () {
      if (timerInterval) clearInterval(timerInterval);
      if (pollInterval) clearInterval(pollInterval);
      window.removeEventListener("resize", resizeCanvas);
    };

    initOnline();
  }

})();
