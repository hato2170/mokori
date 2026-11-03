// ====================================================
// 🏆 Fortnite 3D (フォートナイト 3D バトルロイヤル) - 改修完全版
// Three.js完全自前内蔵・外部通信不要・完全独立3Dゲームエンジン
// 建築 (壁・階段・床) + 射撃 (ツルハシ・AR・ショットガン) + ストーム + ボット + ビクロイ
// ====================================================

(function () {
  "use strict";

  let scene, camera, renderer, animId = null;
  let audioCtx = null;
  let gameRunning = false;

  // ゲーム状態
  let player = null;
  let bots = [];
  let bullets = [];
  let structures = []; // 建築物 (壁, 階段, 床)
  let trees = [];
  let rocks = [];
  let chests = [];
  let particles = [];
  let damageNumbers = [];
  let stormCylinder = null;

  let aliveCount = 10;
  let killCount = 0;
  let woodCount = 150;
  let currentSlot = 2; // デフォルトでAR (アサルトライフル) 装備！
  let buildType = "wall"; // "wall", "ramp", "floor"
  let spawnProtectionTimer = 5; // スポーン直後5秒無敵保護

  // ストーム (嵐)
  let stormRadius = 110;
  let stormTargetRadius = 45;
  let stormCenter = { x: 0, z: 0 };
  let stormTimer = 60;
  let stormInterval = null;
  let stormShrinking = false;

  // 操作
  let keys = {};
  let mouse = { x: 0, y: 0, down: false };
  let cameraAngle = { yaw: 0, pitch: 0.22 };
  let joystick = { active: false, startX: 0, startY: 0, dx: 0, dy: 0 };
  let lookTouch = { active: false, id: null, lastX: 0, lastY: 0 };

  // 効果音合成 (Web Audio API)
  function playSound(type) {
    try {
      if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (audioCtx.state === "suspended") audioCtx.resume();
      const now = audioCtx.currentTime;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);

      if (type === "ar") {
        osc.type = "sawtooth";
        osc.frequency.setValueAtTime(460, now);
        osc.frequency.exponentialRampToValueAtTime(110, now + 0.1);
        gain.gain.setValueAtTime(0.3, now);
        gain.gain.linearRampToValueAtTime(0.01, now + 0.1);
        osc.start(now);
        osc.stop(now + 0.1);
      } else if (type === "shotgun") {
        osc.type = "square";
        osc.frequency.setValueAtTime(240, now);
        osc.frequency.exponentialRampToValueAtTime(45, now + 0.22);
        gain.gain.setValueAtTime(0.4, now);
        gain.gain.linearRampToValueAtTime(0.01, now + 0.22);
        osc.start(now);
        osc.stop(now + 0.22);
      } else if (type === "pickaxe") {
        osc.type = "triangle";
        osc.frequency.setValueAtTime(340, now);
        osc.frequency.exponentialRampToValueAtTime(140, now + 0.1);
        gain.gain.setValueAtTime(0.25, now);
        gain.gain.linearRampToValueAtTime(0.01, now + 0.1);
        osc.start(now);
        osc.stop(now + 0.1);
      } else if (type === "build") {
        osc.type = "sine";
        osc.frequency.setValueAtTime(280, now);
        osc.frequency.setValueAtTime(560, now + 0.08);
        gain.gain.setValueAtTime(0.3, now);
        gain.gain.linearRampToValueAtTime(0.01, now + 0.12);
        osc.start(now);
        osc.stop(now + 0.12);
      } else if (type === "shield") {
        osc.type = "sine";
        osc.frequency.setValueAtTime(587.33, now);
        osc.frequency.setValueAtTime(880, now + 0.15);
        gain.gain.setValueAtTime(0.3, now);
        gain.gain.linearRampToValueAtTime(0.01, now + 0.3);
        osc.start(now);
        osc.stop(now + 0.3);
      } else if (type === "hit") {
        osc.type = "sine";
        osc.frequency.setValueAtTime(880, now);
        gain.gain.setValueAtTime(0.2, now);
        gain.gain.linearRampToValueAtTime(0.01, now + 0.05);
        osc.start(now);
        osc.stop(now + 0.05);
      } else if (type === "chest") {
        [523.25, 659.25, 783.99, 1046.5].forEach((freq, i) => {
          const o = audioCtx.createOscillator();
          const g = audioCtx.createGain();
          o.connect(g);
          g.connect(audioCtx.destination);
          o.type = "triangle";
          o.frequency.setValueAtTime(freq, now + i * 0.08);
          g.gain.setValueAtTime(0.2, now + i * 0.08);
          g.gain.linearRampToValueAtTime(0.01, now + i * 0.08 + 0.2);
          o.start(now + i * 0.08);
          o.stop(now + i * 0.08 + 0.2);
        });
      } else if (type === "victory") {
        const fanfare = [523.25, 659.25, 783.99, 1046.5, 1318.5];
        fanfare.forEach((freq, idx) => {
          const o = audioCtx.createOscillator();
          const g = audioCtx.createGain();
          o.connect(g);
          g.connect(audioCtx.destination);
          o.type = "triangle";
          o.frequency.setValueAtTime(freq, now + idx * 0.12);
          g.gain.setValueAtTime(0.35, now + idx * 0.12);
          g.gain.linearRampToValueAtTime(0.01, now + idx * 0.12 + 0.35);
          o.start(now + idx * 0.12);
          o.stop(now + idx * 0.12 + 0.35);
        });
      }
    } catch (e) {}
  }

  // 島・マップ環境の生成
  function initFortniteMap() {
    // 地形 (緑の芝生アイランド)
    const islandGeo = new THREE.CylinderGeometry(110, 120, 4, 32);
    const islandMat = new THREE.MeshLambertMaterial({ color: 0x4ade80 });
    const island = new THREE.Mesh(islandGeo, islandMat);
    island.position.y = -2;
    island.receiveShadow = true;
    scene.add(island);

    // 周囲の海
    const oceanGeo = new THREE.PlaneGeometry(600, 600);
    const oceanMat = new THREE.MeshLambertMaterial({ color: 0x0284c7 });
    const ocean = new THREE.Mesh(oceanGeo, oceanMat);
    ocean.rotation.x = -Math.PI / 2;
    ocean.position.y = -3.8;
    scene.add(ocean);

    // 木 (採取して木材ゲット)
    trees = [];
    const treeTrunkMat = new THREE.MeshLambertMaterial({ color: 0x78350f });
    const treeLeavesMat = new THREE.MeshLambertMaterial({ color: 0x15803d });

    for (let i = 0; i < 35; i++) {
      const angle = Math.random() * Math.PI * 2;
      const dist = Math.random() * 85 + 10;
      const x = Math.cos(angle) * dist;
      const z = Math.sin(angle) * dist;

      const group = new THREE.Group();
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.7, 4, 8), treeTrunkMat);
      trunk.position.y = 2;
      trunk.castShadow = true;
      group.add(trunk);

      const leaves = new THREE.Mesh(new THREE.ConeGeometry(2.6, 5, 8), treeLeavesMat);
      leaves.position.y = 5.2;
      leaves.castShadow = true;
      group.add(leaves);

      group.position.set(x, 0, z);
      scene.add(group);
      trees.push({ group, x, z, hp: 100, alive: true });
    }

    // 岩 (ストーン)
    rocks = [];
    const rockMat = new THREE.MeshLambertMaterial({ color: 0x64748b });
    for (let i = 0; i < 18; i++) {
      const angle = Math.random() * Math.PI * 2;
      const dist = Math.random() * 80 + 12;
      const x = Math.cos(angle) * dist;
      const z = Math.sin(angle) * dist;

      const rockMesh = new THREE.Mesh(new THREE.DodecahedronGeometry(1.4, 0), rockMat);
      rockMesh.position.set(x, 1.0, z);
      rockMesh.castShadow = true;
      scene.add(rockMesh);
      rocks.push({ mesh: rockMesh, x, z, hp: 120, alive: true });
    }

    // 宝箱 (ゴールドチェスト)
    chests = [];
    const chestMat = new THREE.MeshLambertMaterial({ color: 0xf59e0b, emissive: 0x78350f });
    const chestPositions = [
      { x: 0, z: 0 },
      { x: -15, z: -12 },
      { x: 18, z: -15 },
      { x: -14, z: 18 },
      { x: 20, z: 15 },
      { x: 0, z: -30 },
      { x: 0, z: 30 },
      { x: -35, z: 0 },
      { x: 35, z: 0 }
    ];

    chestPositions.forEach(pos => {
      const group = new THREE.Group();
      const base = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.0, 1.1), chestMat);
      base.position.y = 0.5;
      base.castShadow = true;
      group.add(base);

      const pLight = new THREE.PointLight(0xfacc15, 1.5, 6);
      pLight.position.set(0, 1.2, 0);
      group.add(pLight);

      group.position.set(pos.x, 0, pos.z);
      scene.add(group);
      chests.push({ group, x: pos.x, z: pos.z, opened: false });
    });

    // ストームシリンダー (半透明の紫の嵐)
    const stormGeo = new THREE.CylinderGeometry(stormRadius, stormRadius, 80, 32, 1, true);
    const stormMat = new THREE.MeshBasicMaterial({
      color: 0x9333ea,
      transparent: true,
      opacity: 0.35,
      side: THREE.BackSide
    });
    stormCylinder = new THREE.Mesh(stormGeo, stormMat);
    stormCylinder.position.set(stormCenter.x, 40, stormCenter.z);
    scene.add(stormCylinder);
  }

  // プレイヤーキャラクター生成 (ジョーンズィー風TPS)
  function createPlayer() {
    const group = new THREE.Group();

    // 影
    const shadowGeo = new THREE.CircleGeometry(0.8, 12);
    const shadowMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35 });
    const shadow = new THREE.Mesh(shadowGeo, shadowMat);
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.05;
    group.add(shadow);

    // 胴体 (タンクトップ/アーミー)
    const bodyGeo = new THREE.BoxGeometry(0.9, 1.2, 0.6);
    const bodyMat = new THREE.MeshLambertMaterial({ color: 0x15803d });
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    body.position.y = 1.3;
    body.castShadow = true;
    group.add(body);

    // 頭部
    const headGeo = new THREE.BoxGeometry(0.65, 0.65, 0.65);
    const headMat = new THREE.MeshLambertMaterial({ color: 0xfcd34d });
    const head = new THREE.Mesh(headGeo, headMat);
    head.position.y = 2.2;
    head.castShadow = true;
    group.add(head);

    // 金髪
    const hairGeo = new THREE.BoxGeometry(0.7, 0.3, 0.7);
    const hairMat = new THREE.MeshLambertMaterial({ color: 0xfacc15 });
    const hair = new THREE.Mesh(hairGeo, hairMat);
    hair.position.y = 2.55;
    group.add(hair);

    // 腕 & 武器保持ノード
    const armGeo = new THREE.BoxGeometry(0.3, 0.9, 0.3);
    const armMat = new THREE.MeshLambertMaterial({ color: 0xfcd34d });
    const rightArm = new THREE.Mesh(armGeo, armMat);
    rightArm.position.set(0.65, 1.3, 0.2);
    rightArm.rotation.x = -Math.PI / 4;
    group.add(rightArm);

    // 銃身
    const gunGeo = new THREE.BoxGeometry(0.2, 0.2, 1.2);
    const gunMat = new THREE.MeshLambertMaterial({ color: 0x1e293b });
    const gun = new THREE.Mesh(gunGeo, gunMat);
    gun.position.set(0.65, 1.1, 0.6);
    group.add(gun);

    // スポーン保護バブル (青い球体)
    const shieldBubbleGeo = new THREE.SphereGeometry(1.6, 16, 16);
    const shieldBubbleMat = new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.35, wireframe: true });
    const shieldBubble = new THREE.Mesh(shieldBubbleGeo, shieldBubbleMat);
    shieldBubble.position.y = 1.5;
    group.add(shieldBubble);

    group.position.set(0, 0, 10);
    scene.add(group);

    return {
      group,
      shieldBubble,
      gun,
      x: 0,
      y: 0,
      z: 10,
      vx: 0,
      vy: 0,
      vz: 0,
      rotation: 0,
      hp: 100,
      maxHp: 100,
      shield: 50,
      maxShield: 100,
      speed: 0.32,
      isGrounded: true,
      lastShotTime: 0
    };
  }

  // ボット対戦相手の生成 (遠隔配置 & バトルロイヤルAI)
  function createBot(id, startPos, name) {
    const group = new THREE.Group();

    // 影
    const shadowGeo = new THREE.CircleGeometry(0.7, 10);
    const shadowMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.3 });
    const shadow = new THREE.Mesh(shadowGeo, shadowMat);
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.05;
    group.add(shadow);

    const colors = [0xd97706, 0x2563eb, 0xdc2626, 0x7c3aed, 0x0891b2, 0x059669];
    const skinColor = colors[id % colors.length];

    const body = new THREE.Mesh(new THREE.BoxGeometry(0.85, 1.2, 0.55), new THREE.MeshLambertMaterial({ color: skinColor }));
    body.position.y = 1.3;
    body.castShadow = true;
    group.add(body);

    const head = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.6, 0.6), new THREE.MeshLambertMaterial({ color: 0xfcd34d }));
    head.position.y = 2.2;
    group.add(head);

    // ネームタグ (ビルボード)
    const nameCanvas = document.createElement("canvas");
    nameCanvas.width = 128;
    nameCanvas.height = 32;
    const nctx = nameCanvas.getContext("2d");
    nctx.fillStyle = "rgba(0,0,0,0.6)";
    nctx.fillRect(0, 0, 128, 32);
    nctx.fillStyle = "#ffffff";
    nctx.font = "bold 15px sans-serif";
    nctx.textAlign = "center";
    nctx.fillText(name, 64, 22);
    const nameTex = new THREE.CanvasTexture(nameCanvas);
    const tagMesh = new THREE.Mesh(new THREE.PlaneGeometry(2.0, 0.5), new THREE.MeshBasicMaterial({ map: nameTex, transparent: true }));
    tagMesh.position.y = 3.0;
    group.add(tagMesh);

    group.position.set(startPos.x, 0, startPos.z);
    scene.add(group);

    return {
      id,
      name,
      group,
      x: startPos.x,
      y: 0,
      z: startPos.z,
      hp: 80,
      shield: 25,
      alive: true,
      speed: 0.18,
      lastShotTime: 0,
      aiCooldown: Math.random() * 1500 + 1200,
      targetBot: null
    };
  }

  // 建築システム (壁・階段・床)
  function placeStructure(type) {
    if (woodCount < 10) {
      showOnScreenNotice("⚠️ 木材が足りません！（必要: 10）");
      return;
    }
    woodCount -= 10;
    playSound("build");

    const snapGrid = 4;
    const forwardX = Math.sin(player.rotation) * 4;
    const forwardZ = Math.cos(player.rotation) * 4;
    const rawX = player.x + forwardX;
    const rawZ = player.z + forwardZ;

    const snapX = Math.round(rawX / snapGrid) * snapGrid;
    const snapZ = Math.round(rawZ / snapGrid) * snapGrid;
    const snapY = Math.max(0, Math.round(player.y / 3.5) * 3.5);

    const woodMat = new THREE.MeshLambertMaterial({
      color: 0xb45309,
      transparent: true,
      opacity: 0.95
    });

    let mesh = null;

    if (type === "wall") {
      const geo = new THREE.BoxGeometry(4.0, 3.5, 0.3);
      mesh = new THREE.Mesh(geo, woodMat);
      mesh.position.set(snapX, snapY + 1.75, snapZ);
      mesh.rotation.y = Math.round(player.rotation / (Math.PI / 2)) * (Math.PI / 2);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      scene.add(mesh);
    } else if (type === "ramp") {
      const geo = new THREE.BoxGeometry(4.0, 0.25, 4.8);
      mesh = new THREE.Mesh(geo, woodMat);
      mesh.position.set(snapX, snapY + 1.75, snapZ);
      mesh.rotation.x = Math.PI / 4;
      mesh.rotation.y = Math.round(player.rotation / (Math.PI / 2)) * (Math.PI / 2);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      scene.add(mesh);
    } else if (type === "floor") {
      const geo = new THREE.BoxGeometry(4.0, 0.25, 4.0);
      mesh = new THREE.Mesh(geo, woodMat);
      mesh.position.set(snapX, snapY + 3.5, snapZ);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      scene.add(mesh);
    }

    structures.push({
      mesh,
      type,
      x: snapX,
      y: snapY,
      z: snapZ,
      hp: 150,
      maxHp: 150,
      alive: true
    });
  }

  // 射撃 & 攻撃 (ツルハシ / AR / ショットガン)
  function attackCurrentWeapon() {
    const now = Date.now();
    if (!player || player.hp <= 0) return;

    // 1: ツルハシ
    if (currentSlot === 1) {
      if (now - player.lastShotTime < 350) return;
      player.lastShotTime = now;
      playSound("pickaxe");

      // スイング視覚効果 (前方にスラッシュパーティクル)
      const slashX = player.x + Math.sin(player.rotation) * 2.0;
      const slashZ = player.z + Math.cos(player.rotation) * 2.0;
      createHitParticles(slashX, player.y + 1.5, slashZ, 0xfacc15);

      const hitDist = 4.2;
      let hitSomething = false;

      trees.forEach(t => {
        if (!t.alive) return;
        if (Math.hypot(t.x - player.x, t.z - player.z) < hitDist) {
          t.hp -= 35;
          woodCount += 25;
          hitSomething = true;
          createHitParticles(t.x, 2.0, t.z, 0x78350f);
          showOnScreenNotice("🪵 木材 +25！");
          if (t.hp <= 0) {
            t.alive = false;
            scene.remove(t.group);
            woodCount += 35;
            showOnScreenNotice("🌲 木を伐採！木材 +35！");
          }
        }
      });

      rocks.forEach(r => {
        if (!r.alive) return;
        if (Math.hypot(r.x - player.x, r.z - player.z) < hitDist) {
          r.hp -= 40;
          woodCount += 20;
          hitSomething = true;
          createHitParticles(r.x, 1.2, r.z, 0x64748b);
          showOnScreenNotice("🧱 石材 +20！");
          if (r.hp <= 0) {
            r.alive = false;
            scene.remove(r.mesh);
            woodCount += 30;
          }
        }
      });

      chests.forEach(c => {
        if (c.opened) return;
        if (Math.hypot(c.x - player.x, c.z - player.z) < hitDist) {
          c.opened = true;
          hitSomething = true;
          playSound("chest");
          scene.remove(c.group);
          woodCount += 80;
          player.shield = Math.min(player.maxShield, player.shield + 50);
          showOnScreenNotice("✨ 宝箱オープン！木材+80 & シールド+50！");
        }
      });
      return;
    }

    // 2: アサルトライフル (AR)
    if (currentSlot === 2) {
      if (now - player.lastShotTime < 160) return;
      player.lastShotTime = now;
      playSound("ar");

      spawnBullet(player, 34, 1.4, 0xfacc15, (Math.random() - 0.5) * 0.04);
      return;
    }

    // 3: ポンプショットガン
    if (currentSlot === 3) {
      if (now - player.lastShotTime < 750) return;
      player.lastShotTime = now;
      playSound("shotgun");

      for (let i = -2; i <= 2; i++) {
        spawnBullet(player, 22, 1.2, 0xef4444, i * 0.07);
      }
      return;
    }

    // 4: シールドポーション
    if (currentSlot === 4) {
      if (player.shield >= player.maxShield) {
        showOnScreenNotice("🛡️ シールドは満タンです！");
        return;
      }
      playSound("shield");
      player.shield = Math.min(player.maxShield, player.shield + 25);
      showOnScreenNotice("🧪 ミニポーション使用！シールド+25！");
      window.fnSelectSlot(2); // 自動でARに戻す
      return;
    }
  }

  // 弾丸の生成
  function spawnBullet(shooter, damage, speed, color, spreadAngle = 0) {
    const angle = shooter.rotation + spreadAngle;
    const vx = Math.sin(angle) * speed;
    const vz = Math.cos(angle) * speed;

    const geo = new THREE.SphereGeometry(0.2, 6, 6);
    const mat = new THREE.MeshBasicMaterial({ color });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(shooter.x, (shooter.y || 0) + 1.4, shooter.z);
    scene.add(mesh);

    bullets.push({
      mesh,
      owner: shooter,
      x: shooter.x,
      y: (shooter.y || 0) + 1.4,
      z: shooter.z,
      vx,
      vz,
      damage,
      dist: 0,
      maxDist: 70
    });
  }

  // ヒットパーティクル
  function createHitParticles(x, y, z, color) {
    for (let i = 0; i < 5; i++) {
      const geo = new THREE.BoxGeometry(0.25, 0.25, 0.25);
      const mat = new THREE.MeshBasicMaterial({ color });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(x, y, z);
      scene.add(mesh);
      particles.push({
        mesh,
        vx: (Math.random() - 0.5) * 0.25,
        vy: Math.random() * 0.25 + 0.1,
        vz: (Math.random() - 0.5) * 0.25,
        life: 25
      });
    }
  }

  // 画面中央通知メッセージ
  function showOnScreenNotice(msg) {
    const el = document.getElementById("fnNotice");
    if (el) {
      el.textContent = msg;
      el.style.display = "block";
      clearTimeout(el._timer);
      el._timer = setTimeout(() => {
        el.style.display = "none";
      }, 2000);
    }
  }

  // メインループ更新
  function updateGame() {
    const now = Date.now();

    // 1. プレイヤー移動 (WASD / ジョイスティック)
    if (player && player.hp > 0) {
      let moveX = 0, moveZ = 0;
      if (keys["KeyW"] || keys["ArrowUp"]) moveZ += 1;
      if (keys["KeyS"] || keys["ArrowDown"]) moveZ -= 1;
      if (keys["KeyA"] || keys["ArrowLeft"]) moveX -= 1;
      if (keys["KeyD"] || keys["ArrowRight"]) moveX += 1;

      if (joystick.active) {
        moveX = joystick.dx;
        moveZ = -joystick.dy;
      }

      const len = Math.hypot(moveX, moveZ);
      if (len > 0.05) {
        const forwardAngle = cameraAngle.yaw;
        const inputAngle = Math.atan2(moveX, moveZ);
        const finalAngle = forwardAngle + inputAngle;

        player.vx = Math.sin(finalAngle) * player.speed;
        player.vz = Math.cos(finalAngle) * player.speed;
        player.rotation = finalAngle;
      } else {
        player.vx = 0;
        player.vz = 0;
      }

      // ジャンプ
      if (keys["Space"] && player.isGrounded) {
        player.vy = 0.42;
        player.isGrounded = false;
      }

      player.vy -= 0.02; // 重力
      player.x += player.vx;
      player.y += player.vy;
      player.z += player.vz;

      // 地面衝突
      if (player.y <= 0) {
        player.y = 0;
        player.vy = 0;
        player.isGrounded = true;
      }

      player.group.position.set(player.x, player.y, player.z);
      player.group.rotation.y = player.rotation;

      // カメラのTPS追従 (プレイヤーの肩越し)
      const camDist = 7.0;
      const camHeight = 3.0;
      const targetCamX = player.x - Math.sin(cameraAngle.yaw) * camDist;
      const targetCamZ = player.z - Math.cos(cameraAngle.yaw) * camDist;
      const targetCamY = player.y + camHeight + Math.sin(cameraAngle.pitch) * 2.5;

      camera.position.x = THREE.MathUtils.lerp(camera.position.x, targetCamX, 0.18);
      camera.position.y = THREE.MathUtils.lerp(camera.position.y, targetCamY, 0.18);
      camera.position.z = THREE.MathUtils.lerp(camera.position.z, targetCamZ, 0.18);
      camera.lookAt(player.x, player.y + 1.8, player.z);
    }

    // 2. ボットAI (移動 & バトルロイヤル交戦)
    bots.forEach(bot => {
      if (!bot.alive) return;

      const distToPlayer = Math.hypot(player.x - bot.x, player.z - bot.z);

      // スポーン保護中または遠距離ではプレイヤーを襲わない
      if (spawnProtectionTimer <= 0 && distToPlayer < 30 && player.hp > 0) {
        bot.rotation = Math.atan2(player.x - bot.x, player.z - bot.z);
        bot.group.rotation.y = bot.rotation;

        if (now - bot.lastShotTime > bot.aiCooldown) {
          bot.lastShotTime = now;
          // 命中率を少し散らして理不尽な瞬殺を防止
          const spread = (Math.random() - 0.5) * 0.25;
          spawnBullet(bot, 14, 0.85, 0xef4444, spread);
          bot.aiCooldown = Math.random() * 1200 + 1000;
        }

        if (distToPlayer > 14) {
          bot.x += Math.sin(bot.rotation) * bot.speed;
          bot.z += Math.cos(bot.rotation) * bot.speed;
        }
      } else {
        // ボット同士で戦うか、ストームの中心へ歩く
        const toCenterX = stormCenter.x - bot.x;
        const toCenterZ = stormCenter.z - bot.z;
        const d = Math.hypot(toCenterX, toCenterZ);
        if (d > 6) {
          bot.rotation = Math.atan2(toCenterX, toCenterZ);
          bot.group.rotation.y = bot.rotation;
          bot.x += (toCenterX / d) * (bot.speed * 0.7);
          bot.z += (toCenterZ / d) * (bot.speed * 0.7);
        }

        // たまにボット同士で発砲して撃破しあう
        if (Math.random() < 0.001) {
          bot.hp -= 20;
          if (bot.hp <= 0) eliminateBot(bot);
        }
      }

      bot.group.position.set(bot.x, 0, bot.z);
    });

    // 3. 弾丸の更新 & 命中判定
    for (let i = bullets.length - 1; i >= 0; i--) {
      const b = bullets[i];
      b.x += b.vx;
      b.z += b.vz;
      b.dist += Math.hypot(b.vx, b.vz);
      b.mesh.position.set(b.x, b.y, b.z);

      let removed = false;

      // 建築物への着弾
      for (const s of structures) {
        if (!s.alive) continue;
        if (Math.hypot(s.x - b.x, s.z - b.z) < 2.5) {
          s.hp -= b.damage;
          createHitParticles(b.x, b.y, b.z, 0xb45309);
          if (s.hp <= 0) {
            s.alive = false;
            scene.remove(s.mesh);
          }
          removed = true;
          break;
        }
      }

      // ボットへの着弾 (プレイヤーが撃った弾)
      if (!removed && b.owner === player) {
        for (const bot of bots) {
          if (!bot.alive) continue;
          if (Math.hypot(bot.x - b.x, bot.z - b.z) < 1.4 && Math.abs(b.y - 1.2) < 1.6) {
            damageEntity(bot, b.damage);
            playSound("hit");
            createHitParticles(b.x, b.y, b.z, 0xef4444);
            removed = true;
            if (bot.hp <= 0) {
              eliminateBot(bot);
            }
            break;
          }
        }
      }

      // プレイヤーへの着弾 (ボットが撃った弾)
      if (!removed && b.owner !== player && player && player.hp > 0) {
        if (spawnProtectionTimer > 0) {
          // スポーン保護中は弾を弾く
          createHitParticles(b.x, b.y, b.z, 0x38bdf8);
          removed = true;
        } else if (Math.hypot(player.x - b.x, player.z - b.z) < 1.3 && Math.abs(b.y - 1.2) < 1.6) {
          damageEntity(player, b.damage);
          createHitParticles(b.x, b.y, b.z, 0x38bdf8);
          removed = true;
          if (player.hp <= 0) {
            eliminatePlayer();
          }
        }
      }

      if (removed || b.dist >= b.maxDist) {
        scene.remove(b.mesh);
        bullets.splice(i, 1);
      }
    }

    // 4. ストームの縮小 & ダメージ判定
    if (stormShrinking && stormRadius > stormTargetRadius) {
      stormRadius -= 0.04;
      if (stormCylinder) {
        stormCylinder.scale.set(stormRadius / 110, 1, stormRadius / 110);
      }
    }

    // ストーム圏外ダメージ (毎秒)
    if (player && player.hp > 0 && spawnProtectionTimer <= 0) {
      const distFromCenter = Math.hypot(player.x - stormCenter.x, player.z - stormCenter.z);
      if (distFromCenter > stormRadius) {
        if (Math.random() < 0.02) {
          player.hp -= 2;
          showOnScreenNotice("⚡ ストームのダメージ！安全地帯へ！");
          if (player.hp <= 0) eliminatePlayer();
        }
      }
    }

    // 5. パーティクルの更新
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.mesh.position.x += p.vx;
      p.mesh.position.y += p.vy;
      p.mesh.position.z += p.vz;
      p.vy -= 0.01;
      p.life -= 1;
      if (p.life <= 0) {
        scene.remove(p.mesh);
        particles.splice(i, 1);
      }
    }

    updateFortniteHUD();
  }

  // ダメージ計算 (シールド優先)
  function damageEntity(entity, dmg) {
    if (entity.shield > 0) {
      if (entity.shield >= dmg) {
        entity.shield -= dmg;
      } else {
        const rem = dmg - entity.shield;
        entity.shield = 0;
        entity.hp -= rem;
      }
    } else {
      entity.hp -= dmg;
    }
  }

  // ボット撃破
  function eliminateBot(bot) {
    bot.alive = false;
    scene.remove(bot.group);
    aliveCount = Math.max(1, aliveCount - 1);
    killCount += 1;
    woodCount += 50;
    showOnScreenNotice(`🎯 ${bot.name} を撃破！ (+50 木材)`);

    if (aliveCount === 1 && player.hp > 0) {
      triggerVictoryRoyale();
    }
  }

  // プレイヤー脱落
  function eliminatePlayer() {
    player.hp = 0;
    gameRunning = false;
    if (animId) cancelAnimationFrame(animId);

    const overlay = document.getElementById("fnOverlay");
    const title = document.getElementById("fnOverlayTitle");
    const msg = document.getElementById("fnOverlayMsg");
    if (overlay && title && msg) {
      title.textContent = "💀 敗北 (ELIMINATED)";
      title.style.color = "#ef4444";
      msg.textContent = `撃破数: ${killCount}人 | 順位: #${aliveCount}位`;
      overlay.style.display = "flex";
    }
  }

  // 🏆 #1 VICTORY ROYALE 達成
  function triggerVictoryRoyale() {
    gameRunning = false;
    if (animId) cancelAnimationFrame(animId);
    playSound("victory");

    const overlay = document.getElementById("fnOverlay");
    const title = document.getElementById("fnOverlayTitle");
    const msg = document.getElementById("fnOverlayMsg");
    if (overlay && title && msg) {
      title.textContent = "🏆 #1 VICTORY ROYALE";
      title.style.color = "#facc15";
      msg.textContent = `おめでとうございます！全敵を制覇してビクロイを達成しました！\n総撃破数: ${killCount}人`;
      overlay.style.display = "flex";
    }
  }

  // HUD 更新
  function updateFortniteHUD() {
    if (!player) return;
    const hpEl = document.getElementById("fnHp");
    const shieldEl = document.getElementById("fnShield");
    const woodEl = document.getElementById("fnWood");
    const aliveEl = document.getElementById("fnAlive");
    const killsEl = document.getElementById("fnKills");
    const timerEl = document.getElementById("fnStormTimer");

    if (hpEl) hpEl.textContent = Math.max(0, Math.ceil(player.hp));
    if (shieldEl) shieldEl.textContent = Math.max(0, Math.ceil(player.shield));
    if (woodEl) woodEl.textContent = woodCount;
    if (aliveEl) aliveEl.textContent = aliveCount;
    if (killsEl) killsEl.textContent = killCount;
    if (timerEl) {
      if (spawnProtectionTimer > 0) {
        timerEl.textContent = `🛡️ 無敵保護中: ${spawnProtectionTimer}秒`;
        timerEl.style.color = "#38bdf8";
      } else {
        timerEl.textContent = `${stormTimer}秒`;
        timerEl.style.color = "#c084fc";
      }
    }
  }

  // ゲームの開始
  window.startFortnite3DGame = function (containerEl) {
    if (!containerEl) return;
    window.stopFortnite3DGame();

    containerEl.innerHTML = `
      <div style="position:relative; width:100%; height:100%; min-height:520px; background:#0284c7; border-radius:12px; overflow:hidden; user-select:none; -webkit-user-select:none; font-family:-apple-system,BlinkMacSystemFont,sans-serif;">
        <!-- 上部ヘッダー (生存数 & 撃破数 & ストーム) -->
        <div style="position:absolute; top:8px; left:8px; right:8px; z-index:20; display:flex; justify-content:space-between; align-items:center; background:rgba(15,23,42,0.85); backdrop-filter:blur(8px); border:1px solid #334155; padding:8px 14px; border-radius:10px;">
          <div style="display:flex; gap:14px; font-size:13px; font-weight:bold;">
            <span style="color:#f8fafc;">👥 生存: <strong id="fnAlive" style="color:#38bdf8;">10</strong></span>
            <span style="color:#f8fafc;">🎯 撃破: <strong id="fnKills" style="color:#f59e0b;">0</strong></span>
          </div>
          <div style="font-size:12px; font-weight:bold;">
            <span id="fnStormTimer" style="color:#38bdf8;">🛡️ 無敵保護中: 5秒</span>
          </div>
        </div>

        <!-- 画面中央クロスヘア -->
        <div style="position:absolute; top:50%; left:50%; transform:translate(-50%,-50%); z-index:15; pointer-events:none; font-size:22px; color:rgba(255,255,255,0.9); font-weight:bold; text-shadow:0 0 4px #000;">
          +
        </div>

        <!-- 画面中央通知バナー -->
        <div id="fnNotice" style="display:none; position:absolute; top:70px; left:50%; transform:translateX(-50%); z-index:25; background:rgba(15,23,42,0.92); color:#facc15; font-size:13px; font-weight:bold; padding:6px 18px; border-radius:20px; border:1px solid #facc15; pointer-events:none; animation:fadeIn 0.2s;"></div>

        <!-- 3D WebGL Canvas ラッパー -->
        <div id="fnCanvasWrap" style="width:100%; height:100%; min-height:520px; cursor:crosshair;"></div>

        <!-- 左下操作ジョイスティック (スマホ・iPad対応) -->
        <div style="position:absolute; bottom:14px; left:14px; z-index:25; display:flex; align-items:flex-end; gap:12px; pointer-events:none;">
          <!-- バーチャルジョイスティック -->
          <div id="fnJoystickArea" style="width:100px; height:100px; border-radius:50%; background:rgba(15,23,42,0.7); border:2px dashed #38bdf8; display:flex; align-items:center; justify-content:center; pointer-events:auto; touch-action:none; box-shadow:0 4px 16px rgba(0,0,0,0.4);">
            <div id="fnJoystickThumb" style="width:44px; height:44px; border-radius:50%; background:linear-gradient(135deg, #38bdf8, #0284c7); box-shadow:0 0 10px #38bdf8;"></div>
          </div>

          <!-- ジャンプボタン -->
          <button id="fnJumpBtn" style="pointer-events:auto; background:rgba(15,23,42,0.85); color:#fff; font-weight:bold; border:2px solid #38bdf8; width:52px; height:52px; border-radius:50%; font-size:14px; cursor:pointer; box-shadow:0 4px 12px rgba(0,0,0,0.3); touch-action:none;">
            ⏫
          </button>
        </div>

        <!-- 左下ステータス (HP / シールド / 木材) -->
        <div style="position:absolute; bottom:126px; left:14px; z-index:20; background:rgba(15,23,42,0.88); border:1px solid #334155; padding:6px 12px; border-radius:10px; min-width:140px;">
          <div style="display:flex; justify-content:space-between; font-size:12px; font-weight:bold; margin-bottom:3px;">
            <span style="color:#4ade80;">❤️ HP: <span id="fnHp">100</span></span>
            <span style="color:#38bdf8;">🛡️ シールド: <span id="fnShield">50</span></span>
          </div>
          <div style="font-size:12px; font-weight:bold; color:#f59e0b;">
            🪵 木材: <span id="fnWood">150</span>
          </div>
        </div>

        <!-- 右側 建築パレット (壁・階段・床) -->
        <div style="position:absolute; bottom:84px; right:12px; z-index:20; display:flex; flex-direction:column; gap:6px;">
          <button id="fnBuildWallBtn" onclick="window.fnSetBuild('wall')" style="background:#b45309; color:#fff; font-weight:bold; border:1px solid #f59e0b; padding:8px 12px; border-radius:8px; font-size:12px; cursor:pointer;">
            🧱 壁 (10)
          </button>
          <button id="fnBuildRampBtn" onclick="window.fnSetBuild('ramp')" style="background:#1e293b; color:#cbd5e1; font-weight:bold; border:1px solid #475569; padding:8px 12px; border-radius:8px; font-size:12px; cursor:pointer;">
            🪜 階段 (10)
          </button>
          <button id="fnBuildFloorBtn" onclick="window.fnSetBuild('floor')" style="background:#1e293b; color:#cbd5e1; font-weight:bold; border:1px solid #475569; padding:8px 12px; border-radius:8px; font-size:12px; cursor:pointer;">
            🪵 床 (10)
          </button>
        </div>

        <!-- 下部 ホットバー武器スロット (1〜4) & 攻撃ボタン -->
        <div style="position:absolute; bottom:12px; right:12px; z-index:20; display:flex; gap:10px; align-items:center;">
          <!-- 武器スロット -->
          <div style="display:flex; gap:5px; background:rgba(15,23,42,0.85); padding:5px; border-radius:10px; border:1px solid #334155;">
            <button id="fnSlot1" onclick="window.fnSelectSlot(1)" style="background:#1e293b; color:#94a3b8; font-weight:bold; border:0; padding:6px 10px; border-radius:6px; font-size:12px; cursor:pointer;">⛏️ 1</button>
            <button id="fnSlot2" onclick="window.fnSelectSlot(2)" style="background:#0284c7; color:#fff; font-weight:bold; border:0; padding:6px 10px; border-radius:6px; font-size:12px; cursor:pointer;">🔫 AR</button>
            <button id="fnSlot3" onclick="window.fnSelectSlot(3)" style="background:#1e293b; color:#94a3b8; font-weight:bold; border:0; padding:6px 10px; border-radius:6px; font-size:12px; cursor:pointer;">💥 ポンプ</button>
            <button id="fnSlot4" onclick="window.fnSelectSlot(4)" style="background:#1e293b; color:#94a3b8; font-weight:bold; border:0; padding:6px 10px; border-radius:6px; font-size:12px; cursor:pointer;">🧪 薬</button>
          </div>

          <!-- アクションボタン (攻撃 / 建築決定) -->
          <div style="display:flex; gap:8px;">
            <button id="fnAttackBtn" style="background:linear-gradient(135deg, #ef4444, #dc2626); color:#fff; font-weight:bold; border:0; padding:12px 22px; border-radius:12px; font-size:14px; cursor:pointer; box-shadow:0 4px 14px rgba(239,68,68,0.4); touch-action:none;">
              🔥 発射
            </button>
            <button id="fnPlaceBuildBtn" style="background:linear-gradient(135deg, #f59e0b, #d97706); color:#fff; font-weight:bold; border:0; padding:12px 18px; border-radius:12px; font-size:14px; cursor:pointer; box-shadow:0 4px 14px rgba(245,158,11,0.4); touch-action:none;">
              🔨 建築
            </button>
          </div>
        </div>

        <!-- 勝利/敗北 オーバーレイ -->
        <div id="fnOverlay" style="display:none; position:absolute; top:0; left:0; width:100%; height:100%; z-index:40; background:rgba(15,23,42,0.92); flex-direction:column; align-items:center; justify-content:center; text-align:center; padding:20px; box-sizing:border-box;">
          <h1 id="fnOverlayTitle" style="color:#facc15; font-size:32px; margin:0 0 12px; font-weight:900; text-shadow:0 0 20px rgba(250,204,21,0.8);">🏆 #1 VICTORY ROYALE</h1>
          <p id="fnOverlayMsg" style="color:#e2e8f0; font-size:15px; margin:0 0 24px; white-space:pre-wrap;"></p>
          <button onclick="window.startFortnite3DGame(document.getElementById('fnCanvasWrap').parentElement.parentElement)" style="background:#0284c7; color:#fff; font-weight:bold; border:0; padding:12px 32px; border-radius:10px; font-size:15px; cursor:pointer; box-shadow:0 4px 16px rgba(2,132,199,0.5);">
            🔄 もう一度バトルバスに乗る
          </button>
        </div>
      </div>
    `;

    const wrap = document.getElementById("fnCanvasWrap");
    if (!wrap) return;

    const width = wrap.clientWidth || 400;
    const height = wrap.clientHeight || 520;

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x38bdf8);
    scene.fog = new THREE.FogExp2(0x38bdf8, 0.007);

    camera = new THREE.PerspectiveCamera(60, width / height, 0.1, 1000);
    camera.position.set(0, 10, 25);

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.shadowMap.enabled = true;
    wrap.appendChild(renderer.domElement);

    const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 0.7);
    scene.add(hemiLight);

    const sun = new THREE.DirectionalLight(0xfffbeb, 0.9);
    sun.position.set(40, 60, 30);
    sun.castShadow = true;
    scene.add(sun);

    // マップ初期化
    stormRadius = 110;
    stormTimer = 60;
    stormShrinking = false;
    aliveCount = 10;
    killCount = 0;
    woodCount = 150;
    currentSlot = 2; // ARが最初から選択されている
    buildType = "wall";
    spawnProtectionTimer = 5;
    structures = [];
    bullets = [];
    particles = [];

    initFortniteMap();

    // プレイヤー作成
    player = createPlayer();

    // 9人のボット作成 (プレイヤーから遠く離れた外周に配置して即死防止！)
    bots = [];
    const botNames = ["Jonesy_Bot", "Raven_99", "Peely_Fan", "DarkKnight", "Default_Pro", "Raptor", "Fishstick", "Drift_01", "Midas_Gold"];
    for (let i = 0; i < 9; i++) {
      const angle = (i / 9) * Math.PI * 2;
      const dist = Math.random() * 30 + 55; // 距離55〜85にスポーン！
      const bPos = { x: Math.cos(angle) * dist, z: Math.sin(angle) * dist };
      bots.push(createBot(i, bPos, botNames[i]));
    }

    // スポーン保護カウントダウン & ストームタイマー
    if (stormInterval) clearInterval(stormInterval);
    stormInterval = setInterval(() => {
      if (spawnProtectionTimer > 0) {
        spawnProtectionTimer -= 1;
        if (spawnProtectionTimer === 0 && player && player.shieldBubble) {
          player.group.remove(player.shieldBubble);
        }
      }

      stormTimer -= 1;
      if (stormTimer <= 0) {
        stormShrinking = true;
        stormTimer = 45;
        showOnScreenNotice("⚠️ ストームが縮小しています！安全地帯へ！");
      }
    }, 1000);

    // 操作セットアップ
    setupFortniteControls(wrap);

    // ループ開始
    gameRunning = true;
    function loop() {
      if (!gameRunning) return;
      animId = requestAnimationFrame(loop);
      updateGame();
      renderer.render(scene, camera);
    }
    loop();
  };

  // スロット切り替え
  window.fnSelectSlot = function (slot) {
    currentSlot = slot;
    for (let i = 1; i <= 4; i++) {
      const btn = document.getElementById("fnSlot" + i);
      if (!btn) continue;
      if (i === slot) {
        btn.style.background = "#0284c7";
        btn.style.color = "#fff";
      } else {
        btn.style.background = "#1e293b";
        btn.style.color = "#94a3b8";
      }
    }
  };

  // 建築タイプ設定
  window.fnSetBuild = function (type) {
    buildType = type;
    ["wall", "ramp", "floor"].forEach(t => {
      const btn = document.getElementById("fnBuild" + t.charAt(0).toUpperCase() + t.slice(1) + "Btn");
      if (!btn) return;
      if (t === type) {
        btn.style.background = "#b45309";
        btn.style.borderColor = "#f59e0b";
      } else {
        btn.style.background = "#1e293b";
        btn.style.borderColor = "#475569";
      }
    });
    placeStructure(buildType);
  };

  // 操作イベントバインド (ジョイスティック + タッチ視点 + キーボード)
  function setupFortniteControls(wrap) {
    window.onkeydown = (e) => {
      keys[e.code] = true;
      if (e.code === "Digit1") window.fnSelectSlot(1);
      if (e.code === "Digit2") window.fnSelectSlot(2);
      if (e.code === "Digit3") window.fnSelectSlot(3);
      if (e.code === "Digit4") window.fnSelectSlot(4);
      if (e.code === "KeyZ") window.fnSetBuild("wall");
      if (e.code === "KeyX") window.fnSetBuild("ramp");
      if (e.code === "KeyC") window.fnSetBuild("floor");
      if (e.code === "KeyF" || e.code === "KeyE") attackCurrentWeapon();
    };

    window.onkeyup = (e) => {
      keys[e.code] = false;
    };

    // タッチ ジョイスティック操作
    const joyArea = document.getElementById("fnJoystickArea");
    const joyThumb = document.getElementById("fnJoystickThumb");
    if (joyArea && joyThumb) {
      joyArea.onpointerdown = (e) => {
        e.preventDefault();
        joystick.active = true;
        joystick.startX = e.clientX;
        joystick.startY = e.clientY;
        joystick.dx = 0;
        joystick.dy = 0;
        joyArea.setPointerCapture(e.pointerId);
      };

      joyArea.onpointermove = (e) => {
        if (!joystick.active) return;
        const diffX = e.clientX - joystick.startX;
        const diffY = e.clientY - joystick.startY;
        const dist = Math.hypot(diffX, diffY);
        const maxR = 30;

        if (dist > maxR) {
          joystick.dx = diffX / dist;
          joystick.dy = diffY / dist;
          joyThumb.style.transform = `translate(${joystick.dx * maxR}px, ${joystick.dy * maxR}px)`;
        } else {
          joystick.dx = diffX / maxR;
          joystick.dy = diffY / maxR;
          joyThumb.style.transform = `translate(${diffX}px, ${diffY}px)`;
        }
      };

      const resetJoy = () => {
        joystick.active = false;
        joystick.dx = 0;
        joystick.dy = 0;
        joyThumb.style.transform = "translate(0px, 0px)";
      };
      joyArea.onpointerup = resetJoy;
      joyArea.onpointercancel = resetJoy;
    }

    // ジャンプボタン
    const jmpBtn = document.getElementById("fnJumpBtn");
    if (jmpBtn) {
      jmpBtn.onpointerdown = (e) => {
        e.preventDefault();
        if (player && player.isGrounded) {
          player.vy = 0.42;
          player.isGrounded = false;
        }
      };
    }

    // マウスドラッグで視点回転
    let isMouseDown = false;
    let prevMouseX = 0, prevMouseY = 0;

    wrap.onmousedown = (e) => {
      isMouseDown = true;
      prevMouseX = e.clientX;
      prevMouseY = e.clientY;
    };

    window.onmousemove = (e) => {
      if (!isMouseDown) return;
      const dx = e.clientX - prevMouseX;
      const dy = e.clientY - prevMouseY;
      prevMouseX = e.clientX;
      prevMouseY = e.clientY;

      cameraAngle.yaw -= dx * 0.006;
      cameraAngle.pitch = Math.max(-0.25, Math.min(0.75, cameraAngle.pitch - dy * 0.005));
    };

    window.onmouseup = () => { isMouseDown = false; };

    // タッチによる視点回転 (画面右半分ドラッグ)
    wrap.addEventListener("touchstart", (e) => {
      for (let i = 0; i < e.changedTouches.length; i++) {
        const t = e.changedTouches[i];
        if (t.clientX > window.innerWidth / 3) {
          lookTouch.active = true;
          lookTouch.id = t.identifier;
          lookTouch.lastX = t.clientX;
          lookTouch.lastY = t.clientY;
        }
      }
    }, { passive: true });

    wrap.addEventListener("touchmove", (e) => {
      if (!lookTouch.active) return;
      for (let i = 0; i < e.changedTouches.length; i++) {
        const t = e.changedTouches[i];
        if (t.identifier === lookTouch.id) {
          const dx = t.clientX - lookTouch.lastX;
          const dy = t.clientY - lookTouch.lastY;
          lookTouch.lastX = t.clientX;
          lookTouch.lastY = t.clientY;

          cameraAngle.yaw -= dx * 0.008;
          cameraAngle.pitch = Math.max(-0.25, Math.min(0.75, cameraAngle.pitch - dy * 0.006));
        }
      }
    }, { passive: true });

    const endLook = (e) => {
      for (let i = 0; i < e.changedTouches.length; i++) {
        if (e.changedTouches[i].identifier === lookTouch.id) {
          lookTouch.active = false;
        }
      }
    };
    wrap.addEventListener("touchend", endLook, { passive: true });
    wrap.addEventListener("touchcancel", endLook, { passive: true });

    // 攻撃ボタン
    const atkBtn = document.getElementById("fnAttackBtn");
    if (atkBtn) {
      atkBtn.onpointerdown = (e) => {
        e.preventDefault();
        attackCurrentWeapon();
      };
    }

    // 建築配置ボタン
    const buildBtn = document.getElementById("fnPlaceBuildBtn");
    if (buildBtn) {
      buildBtn.onpointerdown = (e) => {
        e.preventDefault();
        placeStructure(buildType);
      };
    }
  }

  // クリーンアップ
  window.stopFortnite3DGame = function () {
    gameRunning = false;
    if (animId) cancelAnimationFrame(animId);
    if (stormInterval) clearInterval(stormInterval);
    stormInterval = null;
    window.onkeydown = null;
    window.onkeyup = null;

    if (renderer && renderer.domElement && renderer.domElement.parentElement) {
      renderer.domElement.parentElement.removeChild(renderer.domElement);
    }
  };

})();
