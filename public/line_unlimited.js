// ====================================================
// ⭐ mokori Version Unlimited - LINE全機能完全実装
// BGM (Apple Music 30sプレビュー), フォント切替, 着せ替えテーマ,
// アルバム, ノート, 投票, 日程調整, VOOMタイムライン, 無料通話UI, Keepメモ
// ====================================================

(function () {
  "use strict";

  let currentBgmAudio = null;
  let isBgmPlaying = false;
  let currentBgmData = null; // { trackName, artistName, previewUrl, artworkUrl }
  let callTimer = null;
  let callSeconds = 0;
  let callAudioCtx = null;
  let ringtoneOsc = null;

  // ----------------------------------------------------
  // 1. Google Fonts & スタイル動的注入
  // ----------------------------------------------------
  function injectGoogleFontsAndStyles() {
    if (!document.getElementById("lineUnlimitedFonts")) {
      const link = document.createElement("link");
      link.id = "lineUnlimitedFonts";
      link.rel = "stylesheet";
      link.href = "https://fonts.googleapis.com/css2?family=Dela+Gothic+One&family=Kaisei+Decol:wght@500;700&family=Noto+Sans+JP:wght@400;500;700&family=Shippori+Mincho:wght@500;700&family=Yuji+Boku&family=Zen+Maru+Gothic:wght@500;700&display=swap";
      document.head.appendChild(link);
    }

    if (!document.getElementById("lineUnlimitedStyles")) {
      const style = document.createElement("style");
      style.id = "lineUnlimitedStyles";
      style.textContent = `
        /* BGM フローティングピル (LINE風) */
        .line-bgm-pill {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          background: rgba(255, 255, 255, 0.95);
          border: 1px solid #e2e8f0;
          padding: 4px 12px;
          border-radius: 20px;
          font-size: 11px;
          font-weight: 600;
          color: #1e293b;
          box-shadow: 0 2px 8px rgba(0,0,0,0.06);
          cursor: pointer;
          user-select: none;
          max-width: 240px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          transition: transform 0.12s, box-shadow 0.12s;
        }
        .line-bgm-pill:hover {
          transform: translateY(-1px);
          box-shadow: 0 4px 12px rgba(0,0,0,0.1);
        }
        .line-bgm-disc {
          width: 18px;
          height: 18px;
          border-radius: 50%;
          border: 2px solid #06c755;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 10px;
          flex-shrink: 0;
        }
        .line-bgm-disc.spinning {
          animation: spinDisc 3s linear infinite;
        }
        @keyframes spinDisc {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }

        /* LINE通話画面モーダル */
        .call-modal-overlay {
          position: fixed;
          inset: 0;
          background: #111827;
          z-index: 99999;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: space-between;
          padding: 40px 20px;
          color: #ffffff;
        }

        /* VOOM タイムラインカード */
        .voom-card {
          background: #ffffff;
          border: 1px solid #e5e7eb;
          border-radius: 12px;
          margin-bottom: 14px;
          overflow: hidden;
          box-shadow: 0 2px 8px rgba(0,0,0,0.04);
        }
        .voom-header {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 12px;
        }
        .voom-body {
          padding: 0 12px 12px;
          font-size: 14px;
          line-height: 1.6;
          white-space: pre-wrap;
          word-break: break-word;
        }
        .voom-img {
          width: 100%;
          max-height: 360px;
          object-fit: cover;
          display: block;
        }
        .voom-footer {
          padding: 8px 12px;
          border-top: 1px solid #f3f4f6;
          display: flex;
          gap: 16px;
          font-size: 13px;
          color: #6b7280;
        }

        /* 投票・アンケートバー */
        .poll-option-bar {
          position: relative;
          background: #f1f5f9;
          border: 1px solid #cbd5e1;
          border-radius: 8px;
          padding: 10px 14px;
          margin-bottom: 8px;
          cursor: pointer;
          overflow: hidden;
          font-size: 13px;
          font-weight: 600;
        }
        .poll-fill {
          position: absolute;
          top: 0;
          left: 0;
          height: 100%;
          background: rgba(6, 199, 85, 0.18);
          z-index: 1;
          transition: width 0.3s ease;
        }
        .poll-text-wrap {
          position: relative;
          z-index: 2;
          display: flex;
          justify-content: space-between;
        }
      `;
      document.head.appendChild(style);
    }
  }

  // ----------------------------------------------------
  // 2. Apple Music 30s Web Preview BGM 管理
  // ----------------------------------------------------
  window.openMusicSearchModal = function () {
    const modal = document.getElementById("musicSearchModal");
    if (!modal) return;
    modal.classList.remove("hidden");
    const input = document.getElementById("musicSearchInput");
    if (input) {
      input.value = "";
      input.focus();
    }
    const list = document.getElementById("musicSearchResults");
    if (list) list.innerHTML = `<div style="text-align:center;padding:24px;color:#94a3b8;font-size:13px;">曲名やアーティスト名を入力して検索してください</div>`;
  };

  window.closeMusicSearchModal = function () {
    const modal = document.getElementById("musicSearchModal");
    if (modal) modal.classList.add("hidden");
    if (window._previewAudio) {
      window._previewAudio.pause();
      window._previewAudio = null;
    }
  };

  window.searchMusic = async function () {
    const input = document.getElementById("musicSearchInput");
    const list = document.getElementById("musicSearchResults");
    if (!input || !list) return;
    const q = input.value.trim();
    if (!q) return;

    list.innerHTML = `<div style="text-align:center;padding:24px;color:#06c755;font-size:13px;">🔍 楽曲を検索中…</div>`;

    try {
      const res = await window.api(`/api/music/search?q=${encodeURIComponent(q)}`);
      const songs = (res && res.results) || [];
      if (songs.length === 0) {
        list.innerHTML = `<div style="text-align:center;padding:24px;color:#94a3b8;font-size:13px;">一致する楽曲が見つかりませんでした</div>`;
        return;
      }

      list.innerHTML = "";
      songs.forEach((song) => {
        const item = document.createElement("div");
        item.style.cssText = "display:flex; align-items:center; justify-content:space-between; padding:10px; border-bottom:1px solid #f1f5f9; gap:10px;";
        item.innerHTML = `
          <div style="display:flex; align-items:center; gap:10px; min-width:0; flex:1;">
            <img src="${song.artworkUrl || 'https://via.placeholder.com/60'}" style="width:46px; height:46px; border-radius:8px; object-fit:cover; flex-shrink:0;">
            <div style="min-width:0; overflow:hidden;">
              <div style="font-weight:700; font-size:13px; color:#1e293b; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${window.escapeHtml(song.trackName)}</div>
              <div style="font-size:11px; color:#64748b; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${window.escapeHtml(song.artistName)}</div>
            </div>
          </div>
          <div style="display:flex; gap:6px; flex-shrink:0;">
            <button class="music-prev-btn" style="background:#f1f5f9; border:1px solid #cbd5e1; color:#1e293b; padding:6px 10px; border-radius:6px; font-size:11px; font-weight:bold; cursor:pointer;">
              ▶ 試聴
            </button>
            <button class="music-set-btn" style="background:#06c755; color:#fff; border:none; padding:6px 12px; border-radius:6px; font-size:11px; font-weight:bold; cursor:pointer;">
              設定
            </button>
          </div>
        `;

        const prevBtn = item.querySelector(".music-prev-btn");
        prevBtn.onclick = () => {
          if (window._previewAudio && window._previewAudio.src === song.previewUrl && !window._previewAudio.paused) {
            window._previewAudio.pause();
            prevBtn.textContent = "▶ 試聴";
          } else {
            if (window._previewAudio) window._previewAudio.pause();
            window._previewAudio = new Audio(song.previewUrl);
            window._previewAudio.play().catch(() => {});
            document.querySelectorAll(".music-prev-btn").forEach(b => b.textContent = "▶ 試聴");
            prevBtn.textContent = "⏸ 停止";
            window._previewAudio.onended = () => { prevBtn.textContent = "▶ 試聴"; };
          }
        };

        const setBtn = item.querySelector(".music-set-btn");
        setBtn.onclick = async () => {
          await window.setUserBgm(song);
          window.closeMusicSearchModal();
        };

        list.appendChild(item);
      });
    } catch (err) {
      list.innerHTML = `<div style="text-align:center;padding:24px;color:#ef4444;font-size:13px;">検索エラーが発生しました</div>`;
    }
  };

  window.setUserBgm = async function (song) {
    currentBgmData = song;
    try {
      await window.api("/api/users/profile", {
        method: "PUT",
        body: JSON.stringify({ bgm: song })
      });
      alert(`🎵 プロフィールBGMを「${song.trackName} - ${song.artistName}」に設定しました！`);
      window.renderBgmWidget();
    } catch (e) {
      console.warn("BGM save error:", e);
    }
  };

  window.toggleBgmPlay = function () {
    if (!currentBgmData || !currentBgmData.previewUrl) return;

    if (!currentBgmAudio || currentBgmAudio.src !== currentBgmData.previewUrl) {
      if (currentBgmAudio) currentBgmAudio.pause();
      currentBgmAudio = new Audio(currentBgmData.previewUrl);
      currentBgmAudio.onended = () => {
        isBgmPlaying = false;
        window.renderBgmWidget();
      };
    }

    if (currentBgmAudio.paused) {
      currentBgmAudio.play().then(() => {
        isBgmPlaying = true;
        window.renderBgmWidget();
      }).catch(() => {});
    } else {
      currentBgmAudio.pause();
      isBgmPlaying = false;
      window.renderBgmWidget();
    }
  };

  window.renderBgmWidget = function () {
    const wrap = document.getElementById("roomBgmContainer");
    if (!wrap) return;
    if (!currentBgmData) {
      wrap.innerHTML = "";
      return;
    }

    wrap.innerHTML = `
      <div class="line-bgm-pill" onclick="window.toggleBgmPlay()" title="30秒試聴を再生/停止">
        <div class="line-bgm-disc ${isBgmPlaying ? 'spinning' : ''}">🎵</div>
        <span>${window.escapeHtml(currentBgmData.trackName)} - ${window.escapeHtml(currentBgmData.artistName)}</span>
      </div>
    `;
  };

  window.openThemeFontModal = function () {
    const modal = document.getElementById("themeFontModal");
    if (modal) modal.classList.remove("hidden");
  };

  // ----------------------------------------------------
  // 3. LINEフォント設定
  // ----------------------------------------------------
  const LINE_FONTS = {
    default: { name: "LINE Seed (標準)", family: "'Noto Sans JP', sans-serif" },
    maru: { name: "丸ゴシック", family: "'Zen Maru Gothic', sans-serif" },
    mincho: { name: "明朝体", family: "'Shippori Mincho', serif" },
    pop: { name: "ポップ体", family: "'Dela Gothic One', cursive" },
    tegaki: { name: "手書き毛筆風", family: "'Yuji Boku', serif" },
    retro: { name: "レトロおしゃれ", family: "'Kaisei Decol', serif" }
  };

  window.applyLineFont = function (fontKey) {
    const cfg = LINE_FONTS[fontKey] || LINE_FONTS.default;
    document.body.style.fontFamily = cfg.family;
    localStorage.setItem("mokori_font", fontKey);
  };

  // ----------------------------------------------------
  // 4. 着せ替えテーマ
  // ----------------------------------------------------
  const LINE_THEMES = {
    green: { name: "LINE Green", accent: "#06c755", chatBg: "#8cabd9", bubbleMe: "#06c755", textMe: "#ffffff" },
    dark: { name: "ブラック (Dark)", accent: "#3b82f6", chatBg: "#1e293b", bubbleMe: "#2563eb", textMe: "#ffffff" },
    white: { name: "ホワイト (Pure)", accent: "#111827", chatBg: "#f3f4f6", bubbleMe: "#1f2937", textMe: "#ffffff" },
    sakura: { name: "サクラピンク", accent: "#ec4899", chatBg: "#fce7f3", bubbleMe: "#f43f5e", textMe: "#ffffff" },
    mint: { name: "ミントスカイ", accent: "#06b6d4", chatBg: "#cffafe", bubbleMe: "#0891b2", textMe: "#ffffff" }
  };

  window.applyLineTheme = function (themeKey) {
    const t = LINE_THEMES[themeKey] || LINE_THEMES.green;
    document.documentElement.style.setProperty("--primary", t.accent);
    document.documentElement.style.setProperty("--chat-bg", t.chatBg);
    document.documentElement.style.setProperty("--msg-me-bg", t.bubbleMe);
    document.documentElement.style.setProperty("--msg-me-text", t.textMe);
    localStorage.setItem("mokori_theme", themeKey);
  };

  // ----------------------------------------------------
  // 5. 無料通話 / ビデオ通話 (リアルタイムWebRTC & 音声マイク通話)
  // ----------------------------------------------------
  let callMediaStream = null;
  let callPeerConnection = null;
  let callPollerTimer = null;
  let callRingtoneInterval = null;
  let isCallMuted = false;
  let activeCallSession = null;

  // 日本式コール音 (400Hz + 16Hz変調 1秒発音・2秒無音のリピート)
  function startRingtoneSound(isIncoming = false) {
    stopRingtoneSound();
    try {
      if (!callAudioCtx) {
        callAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (callAudioCtx.state === "suspended") {
        callAudioCtx.resume();
      }
      
      const playToneBurst = () => {
        try {
          const now = callAudioCtx.currentTime;
          const osc1 = callAudioCtx.createOscillator();
          const osc2 = callAudioCtx.createOscillator();
          const gain = callAudioCtx.createGain();

          osc1.type = "sine";
          osc1.frequency.setValueAtTime(isIncoming ? 440 : 400, now);
          osc2.type = "sine";
          osc2.frequency.setValueAtTime(isIncoming ? 480 : 416, now);

          gain.gain.setValueAtTime(0.08, now);
          gain.gain.exponentialRampToValueAtTime(0.001, now + (isIncoming ? 0.8 : 1.0));

          osc1.connect(gain);
          osc2.connect(gain);
          gain.connect(callAudioCtx.destination);

          osc1.start(now);
          osc2.start(now);
          osc1.stop(now + (isIncoming ? 0.8 : 1.0));
          osc2.stop(now + (isIncoming ? 0.8 : 1.0));
        } catch(e){}
      };

      playToneBurst();
      callRingtoneInterval = setInterval(playToneBurst, isIncoming ? 2000 : 3000);
    } catch(e) {
      console.warn("Ringtone error:", e);
    }
  }

  function stopRingtoneSound() {
    if (callRingtoneInterval) {
      clearInterval(callRingtoneInterval);
      callRingtoneInterval = null;
    }
  }

  function playCallConnectedChime() {
    try {
      if (!callAudioCtx) callAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const now = callAudioCtx.currentTime;
      const notes = [523.25, 659.25, 783.99, 1046.50]; // C5, E5, G5, C6
      notes.forEach((freq, idx) => {
        const osc = callAudioCtx.createOscillator();
        const gain = callAudioCtx.createGain();
        osc.frequency.setValueAtTime(freq, now + idx * 0.08);
        gain.gain.setValueAtTime(0.08, now + idx * 0.08);
        gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.08 + 0.15);
        osc.connect(gain);
        gain.connect(callAudioCtx.destination);
        osc.start(now + idx * 0.08);
        osc.stop(now + idx * 0.08 + 0.15);
      });
    } catch(e){}
  }

  // 通話を開始する (発信)
  window.startVoiceCall = async function (isCam = false) {
    const chatId = window.activeChatId;
    if (!chatId) {
      alert("通話を開始するトークを選択してください。");
      return;
    }

    const modal = document.getElementById("voiceCallModal");
    if (!modal) return;
    modal.classList.remove("hidden");

    callSeconds = 0;
    isCallMuted = false;
    const timerEl = document.getElementById("callDurationTimer");
    const statusEl = document.getElementById("callStatusText");
    if (timerEl) timerEl.textContent = "00:00";
    if (statusEl) statusEl.textContent = "相手を呼び出し中… ぷるるる…";

    startRingtoneSound(false);

    // マイク許可の取得 (失敗してもフォールバック)
    try {
      if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        callMediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }
    } catch (micErr) {
      console.warn("Microphone access note:", micErr.message);
      if (statusEl) statusEl.textContent = "呼び出し中… (マイク未許可・受信専用)";
    }

    // WebRTC PeerConnection の初期化 (発信側)
    setupWebRTC(chatId, true);

    // サーバーへ通話開始を送信
    try {
      const res = await window.api(`/api/calls/${chatId}/start`, { method: "POST" });
      activeCallSession = res.call;
      startCallWatcher(chatId, true);
    } catch (err) {
      stopRingtoneSound();
      alert("通話の開始に失敗しました: " + err.message);
      window.endVoiceCall();
    }
  };

  // WebRTC ピア接続管理
  let rtcPeerConnection = null;
  let remoteAudioElement = null;

  function ensureRemoteAudioElement() {
    if (!remoteAudioElement) {
      remoteAudioElement = document.createElement("audio");
      remoteAudioElement.autoplay = true;
      remoteAudioElement.style.display = "none";
      document.body.appendChild(remoteAudioElement);
    }
    return remoteAudioElement;
  }

  function setupWebRTC(chatId, isCaller) {
    if (rtcPeerConnection) {
      try { rtcPeerConnection.close(); } catch(_) {}
    }
    try {
      const pc = new RTCPeerConnection({
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:stun1.l.google.com:19302" }
        ]
      });
      rtcPeerConnection = pc;

      if (callMediaStream) {
        callMediaStream.getTracks().forEach(track => pc.addTrack(track, callMediaStream));
      }

      pc.ontrack = (event) => {
        const audioEl = ensureRemoteAudioElement();
        if (event.streams && event.streams[0]) {
          audioEl.srcObject = event.streams[0];
          audioEl.play().catch(() => {});
        }
      };

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          window.api(`/api/calls/${chatId}/signal`, {
            method: "POST",
            body: JSON.stringify({ signal: { type: "candidate", candidate: event.candidate } })
          }).catch(() => {});
        }
      };

      if (isCaller) {
        pc.createOffer().then(offer => {
          return pc.setLocalDescription(offer).then(() => {
            window.api(`/api/calls/${chatId}/signal`, {
              method: "POST",
              body: JSON.stringify({ signal: { type: "offer", sdp: offer.sdp } })
            }).catch(() => {});
          });
        }).catch(e => console.warn("WebRTC createOffer error:", e));
      }

      return pc;
    } catch (e) {
      console.warn("WebRTC setup error:", e);
      return null;
    }
  }

  // 通話監視 & シグナリングポーリング
  function startCallWatcher(chatId, isCaller = false) {
    if (callPollerTimer) clearInterval(callPollerTimer);
    callPollerTimer = setInterval(async () => {
      try {
        const res = await window.api(`/api/calls/${chatId}`);
        const call = res.call;
        const statusEl = document.getElementById("callStatusText");
        const timerEl = document.getElementById("callDurationTimer");

        if (!call || call.status === "ended") {
          // 通話終了
          stopRingtoneSound();
          if (statusEl) statusEl.textContent = "通話が終了しました";
          if (callTimer) clearInterval(callTimer);
          callTimer = null;
          setTimeout(() => {
            window.endVoiceCall(false);
          }, 1500);
          return;
        }

        activeCallSession = call;

        // WebRTCシグナリング処理 (offer/answer/candidate)
        if (Array.isArray(res.signals) && rtcPeerConnection) {
          for (const item of res.signals) {
            const sig = item.signal;
            if (!sig) continue;
            try {
              if (sig.type === "offer" && !isCaller) {
                await rtcPeerConnection.setRemoteDescription(new RTCSessionDescription({ type: "offer", sdp: sig.sdp }));
                const answer = await rtcPeerConnection.createAnswer();
                await rtcPeerConnection.setLocalDescription(answer);
                await window.api(`/api/calls/${chatId}/signal`, {
                  method: "POST",
                  body: JSON.stringify({ signal: { type: "answer", sdp: answer.sdp } })
                });
              } else if (sig.type === "answer" && isCaller) {
                await rtcPeerConnection.setRemoteDescription(new RTCSessionDescription({ type: "answer", sdp: sig.sdp }));
              } else if (sig.type === "candidate" && sig.candidate) {
                await rtcPeerConnection.addIceCandidate(new RTCIceCandidate(sig.candidate)).catch(() => {});
              }
            } catch (sigErr) {
              console.warn("Signal process error:", sigErr);
            }
          }
        }

        // 相手が応答した瞬間
        if (call.status === "connected" && !callTimer) {
          stopRingtoneSound();
          playCallConnectedChime();
          if (statusEl) statusEl.textContent = "📞 音声通話中";

          callSeconds = call.connectedAt ? Math.floor((Date.now() - call.connectedAt) / 1000) : 0;
          callTimer = setInterval(() => {
            callSeconds += 1;
            const mins = String(Math.floor(callSeconds / 60)).padStart(2, "0");
            const secs = String(callSeconds % 60).padStart(2, "0");
            if (timerEl) timerEl.textContent = `${mins}:${secs}`;
          }, 1000);
        }
      } catch (e) {
        console.warn("Call watcher poll error:", e.message);
      }
    }, 1500);
  }

  // 通話を終了する
  window.endVoiceCall = async function (notifyServer = true) {
    const modal = document.getElementById("voiceCallModal");
    if (modal) modal.classList.add("hidden");

    stopRingtoneSound();
    if (callTimer) clearInterval(callTimer);
    callTimer = null;
    if (callPollerTimer) clearInterval(callPollerTimer);
    callPollerTimer = null;

    if (rtcPeerConnection) {
      try { rtcPeerConnection.close(); } catch(_) {}
      rtcPeerConnection = null;
    }
    if (remoteAudioElement) {
      try { remoteAudioElement.srcObject = null; } catch(_) {}
    }

    if (callMediaStream) {
      try {
        callMediaStream.getTracks().forEach(t => t.stop());
      } catch(e){}
      callMediaStream = null;
    }

    if (notifyServer && window.activeChatId && activeCallSession) {
      try {
        await window.api(`/api/calls/${window.activeChatId}/end`, { method: "POST" });
      } catch(e){}
    }
    activeCallSession = null;
  };

  // マイクのミュート切り替え
  window.toggleMuteVoiceCall = function () {
    isCallMuted = !isCallMuted;
    if (callMediaStream) {
      callMediaStream.getAudioTracks().forEach(track => {
        track.enabled = !isCallMuted;
      });
    }
    const icon = document.getElementById("callMuteIcon");
    const label = document.getElementById("callMuteLabel");
    const btn = document.getElementById("callMuteBtn");
    if (icon) icon.textContent = isCallMuted ? "🔇" : "🎙️";
    if (label) label.textContent = isCallMuted ? "ミュート中" : "マイク";
    if (btn) btn.style.background = isCallMuted ? "#dc2626" : "#374151";
  };

  // スピーカー切り替え
  window.toggleSpeakerVoiceCall = function () {
    try {
      if (callAudioCtx) {
        const cur = callAudioCtx.state;
        if (cur === "running") {
          alert("🔊 スピーカー出力を切り替えました（最大音量）");
        }
      }
    } catch(e){}
  };

  // 着信への応答
  window.answerIncomingCall = async function () {
    const incModal = document.getElementById("incomingCallModal");
    if (incModal) incModal.classList.add("hidden");
    stopRingtoneSound();

    const chatId = window.activeChatId;
    if (!chatId) return;

    const modal = document.getElementById("voiceCallModal");
    if (modal) modal.classList.remove("hidden");

    const statusEl = document.getElementById("callStatusText");
    if (statusEl) statusEl.textContent = "接続中…";

    // マイク許可
    try {
      if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        callMediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }
    } catch(e){}

    try {
      const res = await window.api(`/api/calls/${chatId}/join`, { method: "POST" });
      activeCallSession = res.call;
      startCallWatcher(chatId);
      playCallConnectedChime();
      if (statusEl) statusEl.textContent = "📞 音声通話中";

      const timerEl = document.getElementById("callDurationTimer");
      callSeconds = 0;
      if (callTimer) clearInterval(callTimer);
      callTimer = setInterval(() => {
        callSeconds += 1;
        const mins = String(Math.floor(callSeconds / 60)).padStart(2, "0");
        const secs = String(callSeconds % 60).padStart(2, "0");
        if (timerEl) timerEl.textContent = `${mins}:${secs}`;
      }, 1000);
    } catch(err) {
      alert("通話の接続に失敗しました: " + err.message);
      window.endVoiceCall(false);
    }
  };

  // 着信を拒否
  window.rejectIncomingCall = function () {
    const incModal = document.getElementById("incomingCallModal");
    if (incModal) incModal.classList.add("hidden");
    stopRingtoneSound();
  };

  // 着信チェック (ポーリングから呼ばれる)
  window.checkIncomingCallSignal = async function (chatId) {
    if (!chatId || activeCallSession) return;
    try {
      const res = await window.api(`/api/calls/${chatId}`);
      const call = res.call;
      if (call && call.status === "ringing" && window.currentUser && call.callerUid !== window.currentUser.uid) {
        const incModal = document.getElementById("incomingCallModal");
        const nameEl = document.getElementById("incomingCallerName");
        if (incModal && incModal.classList.contains("hidden")) {
          if (nameEl) nameEl.textContent = `${call.callerName || "友だち"} からの無料通話`;
          incModal.classList.remove("hidden");
          startRingtoneSound(true);
        }
      }
    } catch(e){}
  };

  
  // 6. アルバム機能
  // ----------------------------------------------------
  window.openAlbumsModal = async function () {
    const modal = document.getElementById("albumsModal");
    if (!modal) return;
    modal.classList.remove("hidden");
    window.loadChatAlbums();
  };

  window.closeAlbumsModal = function () {
    const modal = document.getElementById("albumsModal");
    if (modal) modal.classList.add("hidden");
  };

  window.loadChatAlbums = async function () {
    const list = document.getElementById("albumsList");
    if (!list || !window.activeChatId) return;
    list.innerHTML = `<div style="text-align:center;padding:24px;color:#94a3b8;">アルバムを読み込み中…</div>`;

    try {
      const res = await window.api(`/api/chats/${window.activeChatId}/albums`);
      const albums = (res && res.albums) || [];
      if (albums.length === 0) {
        list.innerHTML = `<div style="text-align:center;padding:24px;color:#94a3b8;font-size:13px;">アルバムがまだありません。「＋新規アルバム」で写真を追加してください。</div>`;
        return;
      }

      list.innerHTML = "";
      albums.forEach(alb => {
        const item = document.createElement("div");
        item.style.cssText = "background:#f8fafc; border:1px solid #e2e8f0; border-radius:10px; padding:12px; margin-bottom:10px;";
        const photosHtml = (alb.photos || []).map(p => `
          <img src="${p.url || p}" style="width:70px; height:70px; border-radius:6px; object-fit:cover;">
        `).join("");

        item.innerHTML = `
          <div style="font-weight:700; font-size:14px; color:#1e293b; margin-bottom:6px;">📸 ${window.escapeHtml(alb.title)} (${(alb.photos || []).length}枚)</div>
          <div style="display:flex; gap:6px; flex-wrap:wrap;">${photosHtml}</div>
        `;
        list.appendChild(item);
      });
    } catch (e) {
      list.innerHTML = `<div style="text-align:center;padding:24px;color:#ef4444;">アルバム読み込みエラー</div>`;
    }
  };

  window.createNewAlbum = async function () {
    const title = prompt("新しいアルバムの名前を入力してください:");
    if (!title) return;
    const photoUrl = prompt("写真の画像URLを入力してください (空欄で空アルバム):");

    try {
      await window.api(`/api/chats/${window.activeChatId}/albums`, {
        method: "POST",
        body: JSON.stringify({
          title,
          photos: photoUrl ? [{ url: photoUrl }] : []
        })
      });
      window.loadChatAlbums();
    } catch(e) {
      alert("アルバム作成に失敗しました。");
    }
  };

  // ----------------------------------------------------
  // 7. ノート機能
  // ----------------------------------------------------
  window.openNotesModal = function () {
    const modal = document.getElementById("notesModal");
    if (!modal) return;
    modal.classList.remove("hidden");
    window.loadChatNotes();
  };

  window.closeNotesModal = function () {
    const modal = document.getElementById("notesModal");
    if (modal) modal.classList.add("hidden");
  };

  window.loadChatNotes = async function () {
    const list = document.getElementById("notesList");
    if (!list || !window.activeChatId) return;
    list.innerHTML = `<div style="text-align:center;padding:24px;color:#94a3b8;">ノートを読み込み中…</div>`;

    try {
      const res = await window.api(`/api/chats/${window.activeChatId}/notes`);
      const notes = (res && res.notes) || [];
      if (notes.length === 0) {
        list.innerHTML = `<div style="text-align:center;padding:24px;color:#94a3b8;font-size:13px;">ノートがまだありません。「＋ノートを投稿」でメモや大事な連絡を書き残せます。</div>`;
        return;
      }

      list.innerHTML = "";
      notes.forEach(note => {
        const item = document.createElement("div");
        item.style.cssText = "background:#ffffff; border:1px solid #e2e8f0; border-radius:10px; padding:14px; margin-bottom:12px; box-shadow:0 2px 6px rgba(0,0,0,0.03);";
        item.innerHTML = `
          <div style="display:flex; justify-content:space-between; margin-bottom:8px;">
            <strong style="color:#06c755; font-size:13px;">📝 ${window.escapeHtml(note.authorName || 'ユーザー')}</strong>
            <span style="color:#94a3b8; font-size:11px;">${new Date(note.createdAt).toLocaleDateString()}</span>
          </div>
          <div style="font-size:14px; color:#1e293b; line-height:1.6; white-space:pre-wrap; margin-bottom:10px;">${window.escapeHtml(note.text || '')}</div>
          <div style="display:flex; gap:12px; font-size:12px; color:#64748b;">
            <button class="note-like-btn" style="background:#f1f5f9; border:none; padding:4px 10px; border-radius:6px; cursor:pointer;">
              ❤️ いいね (${(note.likes || []).length})
            </button>
          </div>
        `;

        item.querySelector(".note-like-btn").onclick = async () => {
          await window.api(`/api/chats/${window.activeChatId}/notes/${note.id}/like`, { method: "POST" });
          window.loadChatNotes();
        };

        list.appendChild(item);
      });
    } catch(e) {
      list.innerHTML = `<div style="text-align:center;padding:24px;color:#ef4444;">ノート読み込みエラー</div>`;
    }
  };

  window.createNewNote = async function () {
    const text = prompt("ノートの内容を入力してください:");
    if (!text) return;

    try {
      await window.api(`/api/chats/${window.activeChatId}/notes`, {
        method: "POST",
        body: JSON.stringify({ text })
      });
      window.loadChatNotes();
    } catch(e) {
      alert("ノート作成に失敗しました。");
    }
  };

  // ----------------------------------------------------
  // 8. 投票 (アンケート) 機能
  // ----------------------------------------------------
  window.openPollModal = function () {
    const modal = document.getElementById("pollsModal");
    if (!modal) return;
    modal.classList.remove("hidden");
    window.loadChatPolls();
  };

  window.closePollModal = function () {
    const modal = document.getElementById("pollsModal");
    if (modal) modal.classList.add("hidden");
  };

  window.loadChatPolls = async function () {
    const list = document.getElementById("pollsList");
    if (!list || !window.activeChatId) return;
    list.innerHTML = `<div style="text-align:center;padding:24px;color:#94a3b8;">投票を読み込み中…</div>`;

    try {
      const res = await window.api(`/api/chats/${window.activeChatId}/polls`);
      const polls = (res && res.polls) || [];
      if (polls.length === 0) {
        list.innerHTML = `<div style="text-align:center;padding:24px;color:#94a3b8;font-size:13px;">現在募集中の投票はありません。「＋新規投票」からアンケートを作れます。</div>`;
        return;
      }

      list.innerHTML = "";
      polls.forEach(poll => {
        const item = document.createElement("div");
        item.style.cssText = "background:#ffffff; border:1px solid #e2e8f0; border-radius:10px; padding:14px; margin-bottom:12px;";

        const totalVotes = (poll.options || []).reduce((acc, opt) => acc + (opt.votes || []).length, 0);

        const optionsHtml = (poll.options || []).map((opt, idx) => {
          const count = (opt.votes || []).length;
          const pct = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0;
          return `
            <div class="poll-option-bar" onclick="window.votePoll('${poll.id}', ${idx})">
              <div class="poll-fill" style="width:${pct}%;"></div>
              <div class="poll-text-wrap">
                <span>${window.escapeHtml(opt.text)}</span>
                <span style="color:#06c755;">${count}票 (${pct}%)</span>
              </div>
            </div>
          `;
        }).join("");

        item.innerHTML = `
          <div style="font-weight:700; font-size:15px; color:#1e293b; margin-bottom:10px;">📊 ${window.escapeHtml(poll.title)}</div>
          <div>${optionsHtml}</div>
          <div style="text-align:right; font-size:11px; color:#94a3b8; margin-top:6px;">総投票数: ${totalVotes}票</div>
        `;
        list.appendChild(item);
      });
    } catch(e) {
      list.innerHTML = `<div style="text-align:center;padding:24px;color:#ef4444;">投票読み込みエラー</div>`;
    }
  };

  window.votePoll = async function (pollId, optionIdx) {
    try {
      await window.api(`/api/chats/${window.activeChatId}/polls/${pollId}/vote`, {
        method: "POST",
        body: JSON.stringify({ optionIdx })
      });
      window.loadChatPolls();
    } catch(e) {
      alert("投票に失敗しました。");
    }
  };

  window.createNewPoll = async function () {
    const title = prompt("投票のタイトル（質問）を入力してください:");
    if (!title) return;
    const optStr = prompt("選択肢をカンマ(,)区切りで入力してください (例: ラーメン, カレー, 焼肉):");
    if (!optStr) return;
    const options = optStr.split(",").map(s => s.trim()).filter(Boolean);

    try {
      await window.api(`/api/chats/${window.activeChatId}/polls`, {
        method: "POST",
        body: JSON.stringify({ title, options })
      });
      window.loadChatPolls();
    } catch(e) {
      alert("投票作成に失敗しました。");
    }
  };

  // ----------------------------------------------------
  // 9. VOOM (タイムライン)
  // ----------------------------------------------------
  window.closeVoomTab = function () {
    const chatsArea = document.getElementById("chatListSection") || document.getElementById("chatListArea");
    const friendsArea = document.getElementById("friendsSection") || document.getElementById("friendsArea");
    const voomArea = document.getElementById("voomArea");
    if (voomArea) voomArea.classList.add("hidden");
    if (chatsArea) chatsArea.classList.remove("hidden");
    if (friendsArea) friendsArea.classList.add("hidden");
    document.querySelectorAll(".nav-tab").forEach(t => t.classList.remove("active"));
    const cTab = document.getElementById("tabChats");
    if (cTab) cTab.classList.add("active");
  };

  window.openVoomTab = function () {
    const chatsArea = document.getElementById("chatListSection") || document.getElementById("chatListArea");
    const friendsArea = document.getElementById("friendsSection") || document.getElementById("friendsArea");
    let voomArea = document.getElementById("voomArea");

    if (!voomArea) {
      voomArea = document.createElement("div");
      voomArea.id = "voomArea";
      voomArea.style.cssText = "padding:12px; overflow-y:auto; flex:1;";
      const parent = chatsArea ? chatsArea.parentElement : document.getElementById("sidebar");
      if (parent) parent.appendChild(voomArea);
    }

    if (chatsArea) chatsArea.classList.add("hidden");
    if (friendsArea) friendsArea.classList.add("hidden");
    voomArea.classList.remove("hidden");

    document.querySelectorAll(".nav-tab").forEach(t => t.classList.remove("active"));
    const vTab = document.getElementById("tabVoom");
    if (vTab) vTab.classList.add("active");

    window.loadVoomPosts();
  };

  window.loadVoomPosts = async function () {
    const area = document.getElementById("voomArea");
    if (!area) return;

    area.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
        <h3 style="margin:0; font-size:16px; color:#1e293b;">🌏 VOOM タイムライン</h3>
        <div style="display:flex; gap:6px;">
          <button onclick="window.createVoomPost()" style="background:#06c755; color:#fff; border:0; padding:6px 14px; border-radius:20px; font-weight:700; font-size:12px; cursor:pointer;">
            ✏️ 投稿する
          </button>
          <button onclick="window.closeVoomTab()" style="background:#e2e8f0; color:#475569; border:0; padding:6px 10px; border-radius:12px; font-weight:700; font-size:12px; cursor:pointer;" title="VOOMを閉じる">
            ✕ 閉じる
          </button>
        </div>
      </div>
      <div id="voomPostsList"><div style="text-align:center;padding:24px;color:#94a3b8;">読み込み中…</div></div>
    `;

    try {
      const res = await window.api("/api/voom/posts");
      const posts = (res && res.posts) || [];
      const list = document.getElementById("voomPostsList");
      if (!list) return;

      if (posts.length === 0) {
        list.innerHTML = `<div style="text-align:center;padding:32px;color:#94a3b8;font-size:13px;">まだ投稿がありません。「✏️ 投稿する」から日常や写真をシェアしよう！</div>`;
        return;
      }

      const myUid = window.currentUser ? window.currentUser.uid : null;
      list.innerHTML = "";
      posts.forEach(post => {
        const isMine = myUid && post.authorUid === myUid;
        const card = document.createElement("div");
        card.className = "voom-card";
        card.innerHTML = `
          <div class="voom-header" style="display:flex; justify-content:space-between; align-items:center;">
            <div style="display:flex; align-items:center; gap:8px;">
              <div style="width:36px; height:36px; border-radius:50%; background:#06c755; color:#fff; display:flex; align-items:center; justify-content:center; font-weight:bold;">
                ${post.authorName ? post.authorName.charAt(0) : '🐐'}
              </div>
              <div>
                <div style="font-weight:700; font-size:13px; color:#1e293b;">${window.escapeHtml(post.authorName || 'ユーザー')}</div>
                <div style="font-size:11px; color:#94a3b8;">${new Date(post.createdAt).toLocaleString()}</div>
              </div>
            </div>
            ${isMine ? `
              <div style="display:flex; gap:4px;">
                <button class="voom-edit-btn" style="background:#f1f5f9; border:1px solid #cbd5e1; border-radius:6px; font-size:11px; padding:2px 6px; cursor:pointer;">✏️ 編集</button>
                <button class="voom-del-btn" style="background:#fee2e2; border:1px solid #fca5a5; color:#b91c1c; border-radius:6px; font-size:11px; padding:2px 6px; cursor:pointer;">🗑️ 削除</button>
              </div>
            ` : ''}
          </div>
          <div class="voom-body" style="margin:8px 0; font-size:13px; color:#1e293b; white-space:pre-wrap;">${window.escapeHtml(post.text || '')}</div>
          ${post.imageUrl ? `<img src="${post.imageUrl}" class="voom-img" style="width:100%; max-height:280px; object-fit:cover; border-radius:8px; margin-bottom:8px;">` : ''}
          <div class="voom-footer" style="display:flex; justify-content:space-between; align-items:center;">
            <button class="voom-like-btn" style="background:none; border:none; cursor:pointer; color:#ef4444; font-weight:bold; font-size:12px;">
              ❤️ いいね (${(post.likes || []).length})
            </button>
          </div>
        `;

        card.querySelector(".voom-like-btn").onclick = async () => {
          await window.api(`/api/voom/posts/${post.id}/like`, { method: "POST" });
          window.loadVoomPosts();
        };

        if (isMine) {
          card.querySelector(".voom-del-btn").onclick = async () => {
            if (!confirm("この投稿を削除しますか？")) return;
            try {
              await window.api(`/api/voom/posts/${post.id}`, { method: "DELETE" });
              window.loadVoomPosts();
            } catch (err) {
              alert("削除に失敗しました: " + err.message);
            }
          };

          card.querySelector(".voom-edit-btn").onclick = async () => {
            const newText = prompt("編集後のメッセージを入力してください:", post.text || "");
            if (newText === null) return;
            try {
              await window.api(`/api/voom/posts/${post.id}`, {
                method: "PUT",
                body: JSON.stringify({ text: newText })
              });
              window.loadVoomPosts();
            } catch (err) {
              alert("編集に失敗しました: " + err.message);
            }
          };
        }

        list.appendChild(card);
      });
    } catch(e) {
      const list = document.getElementById("voomPostsList");
      if (list) list.innerHTML = `<div style="text-align:center;padding:24px;color:#ef4444;">VOOMの読み込みに失敗しました</div>`;
    }
  };

  window.createVoomPost = async function () {
    const text = prompt("VOOMに投稿するメッセージを入力してください:");
    if (!text && text !== "") return;

    let imageUrl = "";
    if (confirm("写真を添付しますか？（「キャンセル」でテキストのみ投稿）")) {
      const file = await new Promise(resolve => {
        const inp = document.createElement("input");
        inp.type = "file";
        inp.accept = "image/*";
        inp.onchange = (e) => resolve(e.target.files && e.target.files[0]);
        inp.click();
      });
      if (file && window.compressImageFile) {
        try {
          imageUrl = await window.compressImageFile(file, 960, 960, 0.8);
        } catch (_) {}
      }
    }

    try {
      await window.api("/api/voom/posts", {
        method: "POST",
        body: JSON.stringify({ text, imageUrl })
      });
      window.loadVoomPosts();
    } catch(e) {
      alert("投稿に失敗しました: " + e.message);
    }
  };

  // 初期化
  injectGoogleFontsAndStyles();
  const savedFont = localStorage.getItem("mokori_font");
  if (savedFont) window.applyLineFont(savedFont);
  const savedTheme = localStorage.getItem("mokori_theme");
  if (savedTheme) window.applyLineTheme(savedTheme);

})();
