// ====================================================
// ⭐ mokori & myyajuu: 自前完全内蔵 3Dブロスタ (Brawl Stars 3v3)
// 外部CDN/埋め込み一切なし、Three.jsローカル駆動型3D WebGLゲーム
// ====================================================

(function () {
  "use strict";

  let scene, camera, renderer, animId = null;
  let audioCtx = null;
  let gameRunning = false;

  // ゲーム状態
  let player = null;
  let brawlers = [];
  let bullets = [];
  let gems = [];
  let obstacles = [];
  let bushes = [];
  let debris = [];
  let gemMine = null;

  let blueGems = 0;
  let redGems = 0;
  let countdownTimer = null;
  let countdownSeconds = 15;
  let countdownTeam = null;

  let keys = {};
  let mouse = { x: 0, y: 0, down: false };
  let joystick = { active: false, startX: 0, startY: 0, dx: 0, dy: 0 };
  let aimAngle = 0;

  // キャラクター定義
  const BRAWLER_TYPES = {
    shelly: {
      name: "シェリー",
      role: "ショットガン",
      maxHp: 3800,
      speed: 0.18,
      ammoMax: 3,
      reloadTime: 1200,
      pellets: 5,
      spread: 0.45,
      range: 14,
      damage: 320,
      color: 0x9333ea, // 紫の髪
      superReq: 7
    },
    colt: {
      name: "コルト",
      role: "長距離連射",
      maxHp: 2800,
      speed: 0.20,
      ammoMax: 3,
      reloadTime: 1100,
      pellets: 6,
      spread: 0.08,
      range: 22,
      damage: 280,
      color: 0xef4444, // 赤髪
      superReq: 10
    },
    bull: {
      name: "ブル",
      role: "重量級タンク",
      maxHp: 5000,
      speed: 0.17,
      ammoMax: 3,
      reloadTime: 1300,
      pellets: 5,
      spread: 0.55,
      range: 10,
      damage: 480,
      color: 0x1e293b, // 黒髪
      superReq: 6
    }
  };

  let selectedBrawlerType = "shelly";

  // 効果音合成 (Web Audio API)
  function playSound(type) {
    try {
      if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (audioCtx.state === "suspended") {
        audioCtx.resume();
      }
      const now = audioCtx.currentTime;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);

      if (type === "shot") {
        osc.type = "triangle";
        osc.frequency.setValueAtTime(380, now);
        osc.frequency.exponentialRampToValueAtTime(110, now + 0.12);
        gain.gain.setValueAtTime(0.25, now);
        gain.gain.linearRampToValueAtTime(0.01, now + 0.12);
        osc.start(now);
        osc.stop(now + 0.12);
      } else if (type === "super") {
        osc.type = "sawtooth";
        osc.frequency.setValueAtTime(280, now);
        osc.frequency.exponentialRampToValueAtTime(60, now + 0.35);
        gain.gain.setValueAtTime(0.4, now);
        gain.gain.linearRampToValueAtTime(0.01, now + 0.35);
        osc.start(now);
        osc.stop(now + 0.35);
      } else if (type === "gem") {
        osc.type = "sine";
        osc.frequency.setValueAtTime(659.25, now);
        osc.frequency.setValueAtTime(880, now + 0.08);
        osc.frequency.setValueAtTime(1318.5, now + 0.16);
        gain.gain.setValueAtTime(0.3, now);
        gain.gain.linearRampToValueAtTime(0.01, now + 0.25);
        osc.start(now);
        osc.stop(now + 0.25);
      } else if (type === "alarm") {
        osc.type = "square";
        osc.frequency.setValueAtTime(523.25, now);
        osc.frequency.setValueAtTime(659.25, now + 0.1);
        gain.gain.setValueAtTime(0.2, now);
        gain.gain.linearRampToValueAtTime(0.01, now + 0.2);
        osc.start(now);
        osc.stop(now + 0.2);
      } else if (type === "win") {
        const notes = [523.25, 659.25, 783.99, 1046.5];
        notes.forEach((freq, idx) => {
          const o = audioCtx.createOscillator();
          const g = audioCtx.createGain();
          o.connect(g);
          g.connect(audioCtx.destination);
          o.type = "triangle";
          o.frequency.setValueAtTime(freq, now + idx * 0.1);
          g.gain.setValueAtTime(0.3, now + idx * 0.1);
          g.gain.linearRampToValueAtTime(0.01, now + idx * 0.1 + 0.2);
          o.start(now + idx * 0.1);
          o.stop(now + idx * 0.1 + 0.2);
        });
      }
    } catch (e) {}
  }

  // 3Dアリーナの構築
  function init3DArena() {
    // 地面
    const groundGeo = new THREE.PlaneGeometry(42, 60);
    const groundMat = new THREE.MeshLambertMaterial({ color: 0x242b35 });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    // 外枠フェンス
    const borderMat = new THREE.MeshLambertMaterial({ color: 0x3b82f6 });
    const wallNorth = new THREE.Mesh(new THREE.BoxGeometry(43, 2, 1), borderMat);
    wallNorth.position.set(0, 1, -30);
    scene.add(wallNorth);
    const wallSouth = new THREE.Mesh(new THREE.BoxGeometry(43, 2, 1), borderMat);
    wallSouth.position.set(0, 1, 30);
    scene.add(wallSouth);
    const wallWest = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 61), borderMat);
    wallWest.position.set(-21, 1, 0);
    scene.add(wallWest);
    const wallEast = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 61), borderMat);
    wallEast.position.set(21, 1, 0);
    scene.add(wallEast);

    // 中央ジェム鉱山
    const mineGeo = new THREE.CylinderGeometry(2.2, 2.6, 0.8, 12);
    const mineMat = new THREE.MeshLambertMaterial({ color: 0x475569 });
    gemMine = new THREE.Mesh(mineGeo, mineMat);
    gemMine.position.set(0, 0.4, 0);
    scene.add(gemMine);

    // 鉱山の光るコア
    const coreGeo = new THREE.CylinderGeometry(1.2, 1.2, 0.9, 12);
    const coreMat = new THREE.MeshBasicMaterial({ color: 0xc084fc });
    const core = new THREE.Mesh(coreGeo, coreMat);
    core.position.set(0, 0.45, 0);
    scene.add(core);

    const mineLight = new THREE.PointLight(0xc084fc, 2, 12);
    mineLight.position.set(0, 2, 0);
    scene.add(mineLight);

    // 障害物 (レンガブロック・破壊可能)
    obstacles = [];
    const obstacleDefs = [
      { x: -9, z: -10, w: 5, d: 2 },
      { x: 9, z: -10, w: 5, d: 2 },
      { x: -9, z: 10, w: 5, d: 2 },
      { x: 9, z: 10, w: 5, d: 2 },
      { x: 0, z: -16, w: 10, d: 2.2 },
      { x: 0, z: 16, w: 10, d: 2.2 },
      { x: -12, z: 0, w: 2.5, d: 8 },
      { x: 12, z: 0, w: 2.5, d: 8 }
    ];

    const blockMat = new THREE.MeshLambertMaterial({ color: 0xd97706 });
    obstacleDefs.forEach(def => {
      const geo = new THREE.BoxGeometry(def.w, 2.2, def.d);
      const mesh = new THREE.Mesh(geo, blockMat);
      mesh.position.set(def.x, 1.1, def.z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      scene.add(mesh);
      obstacles.push({
        mesh: mesh,
        x: def.x,
        z: def.z,
        w: def.w,
        d: def.d,
        alive: true
      });
    });

    // 草むら (ブッシュ)
    bushes = [];
    const bushDefs = [
      { x: -7, z: -4, w: 5, d: 5 },
      { x: 7, z: -4, w: 5, d: 5 },
      { x: -7, z: 4, w: 5, d: 5 },
      { x: 7, z: 4, w: 5, d: 5 },
      { x: -14, z: -16, w: 6, d: 6 },
      { x: 14, z: -16, w: 6, d: 6 },
      { x: -14, z: 16, w: 6, d: 6 },
      { x: 14, z: 16, w: 6, d: 6 }
    ];

    const bushMat = new THREE.MeshLambertMaterial({ color: 0x15803d, transparent: true, opacity: 0.85 });
    bushDefs.forEach(def => {
      const group = new THREE.Group();
      for (let bx = -def.w / 2 + 1; bx <= def.w / 2 - 1; bx += 1.8) {
        for (let bz = -def.d / 2 + 1; bz <= def.d / 2 - 1; bz += 1.8) {
          const sphere = new THREE.Mesh(new THREE.SphereGeometry(1.2, 7, 7), bushMat);
          sphere.position.set(bx, 0.9, bz);
          group.add(sphere);
        }
      }
      group.position.set(def.x, 0, def.z);
      scene.add(group);
      bushes.push({
        group: group,
        x: def.x,
        z: def.z,
        w: def.w,
        d: def.d
      });
    });
  }

  // 3Dブロスタキャラクターの生成
  function create3DBrawler(typeKey, team, isPlayer, startPos, name) {
    const config = BRAWLER_TYPES[typeKey] || BRAWLER_TYPES.shelly;
    const group = new THREE.Group();

    // 影
    const shadowGeo = new THREE.CircleGeometry(0.8, 12);
    const shadowMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35 });
    const shadow = new THREE.Mesh(shadowGeo, shadowMat);
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.05;
    group.add(shadow);

    // 胴体
    const bodyColor = team === "blue" ? 0x2563eb : 0xdc2626;
    const bodyGeo = new THREE.CylinderGeometry(0.55, 0.65, 1.2, 10);
    const bodyMat = new THREE.MeshLambertMaterial({ color: bodyColor });
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    body.position.y = 0.9;
    body.castShadow = true;
    group.add(body);

    // 頭部
    const headGeo = new THREE.SphereGeometry(0.5, 12, 12);
    const headMat = new THREE.MeshLambertMaterial({ color: 0xfcd34d });
    const head = new THREE.Mesh(headGeo, headMat);
    head.position.y = 1.8;
    head.castShadow = true;
    group.add(head);

    // 髪 / 帽子
    const hairGeo = new THREE.SphereGeometry(0.52, 10, 10);
    const hairMat = new THREE.MeshLambertMaterial({ color: config.color });
    const hair = new THREE.Mesh(hairGeo, hairMat);
    hair.position.set(0, 1.95, -0.08);
    group.add(hair);

    // 武器 (銃身)
    const gunGeo = new THREE.CylinderGeometry(0.12, 0.14, 0.9, 8);
    const gunMat = new THREE.MeshLambertMaterial({ color: 0x1e293b });
    const gun = new THREE.Mesh(gunGeo, gunMat);
    gun.rotation.x = Math.PI / 2;
    gun.position.set(0.45, 1.0, 0.5);
    group.add(gun);

    // 照準インジケーター (プレイヤーのみ)
    let reticle = null;
    if (isPlayer) {
      const reticleGeo = new THREE.ConeGeometry(0.3, 0.8, 8);
      const reticleMat = new THREE.MeshBasicMaterial({ color: 0x38bdf8 });
      reticle = new THREE.Mesh(reticleGeo, reticleMat);
      reticle.rotation.x = Math.PI / 2;
      reticle.position.set(0, 0.2, 2.0);
      group.add(reticle);
    }

    group.position.set(startPos.x, 0, startPos.z);
    scene.add(group);

    return {
      typeKey: typeKey,
      config: config,
      team: team,
      isPlayer: isPlayer,
      name: name,
      group: group,
      body: body,
      gun: gun,
      reticle: reticle,
      x: startPos.x,
      z: startPos.z,
      vx: 0,
      vz: 0,
      rotation: team === "blue" ? -Math.PI / 2 : Math.PI / 2,
      hp: config.maxHp,
      maxHp: config.maxHp,
      ammo: config.ammoMax,
      maxAmmo: config.ammoMax,
      superCharge: 0,
      superReq: config.superReq,
      gems: 0,
      alive: true,
      respawnTimer: 0,
      lastAttackTime: 0,
      lastDamagedTime: 0,
      spawnX: startPos.x,
      spawnZ: startPos.z,
      inBush: false,
      aiTarget: null,
      aiShootCooldown: Math.random() * 800 + 400
    };
  }

  // 3Dジェムのドロップ
  function spawn3DGem(x, z, vy = 0.25) {
    if (gems.length >= 29) return;
    const geo = new THREE.OctahedronGeometry(0.42, 0);
    const mat = new THREE.MeshLambertMaterial({ color: 0xc084fc, emissive: 0x7e22ce });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, 0.5, z);
    scene.add(mesh);

    gems.push({
      mesh: mesh,
      x: x,
      y: 0.5,
      z: z,
      vy: vy,
      rotSpeed: 0.05
    });
  }

  // 弾丸発射 (ショット / 必殺技)
  function fireBullet(brawler, isSuper) {
    if (!brawler.alive) return;
    if (!isSuper) {
      if (brawler.ammo < 1) return;
      brawler.ammo -= 1;
      brawler.lastAttackTime = Date.now();
      playSound("shot");
    } else {
      brawler.superCharge = 0;
      brawler.lastAttackTime = Date.now();
      playSound("super");
    }

    const cfg = brawler.config;
    const pelletCount = isSuper ? (brawler.typeKey === "colt" ? 12 : 9) : cfg.pellets;
    const baseAngle = brawler.rotation;
    const spreadTotal = isSuper ? cfg.spread * 1.5 : cfg.spread;
    const speed = isSuper ? 0.6 : 0.5;
    const damage = isSuper ? cfg.damage * 1.35 : cfg.damage;
    const isWallBreaker = isSuper;

    for (let i = 0; i < pelletCount; i++) {
      const offset = (pelletCount > 1) ? ((i / (pelletCount - 1)) - 0.5) * spreadTotal : 0;
      const angle = baseAngle + offset;
      const vx = Math.sin(angle) * speed;
      const vz = Math.cos(angle) * speed;

      const bulletGeo = new THREE.SphereGeometry(isSuper ? 0.35 : 0.22, 8, 8);
      const bulletColor = brawler.team === "blue" ? (isSuper ? 0xfacc15 : 0x38bdf8) : (isSuper ? 0xf97316 : 0xef4444);
      const bulletMat = new THREE.MeshBasicMaterial({ color: bulletColor });
      const bulletMesh = new THREE.Mesh(bulletGeo, bulletMat);
      bulletMesh.position.set(brawler.x, 1.2, brawler.z);
      scene.add(bulletMesh);

      bullets.push({
        mesh: bulletMesh,
        owner: brawler,
        x: brawler.x,
        z: brawler.z,
        vx: vx,
        vz: vz,
        dist: 0,
        maxDist: isSuper ? cfg.range * 1.3 : cfg.range,
        damage: damage,
        isSuper: isSuper,
        breaksWalls: isWallBreaker
      });
    }
  }

  // 壁破壊エフェクト
  function breakObstacle(obs) {
    if (!obs.alive) return;
    obs.alive = false;
    scene.remove(obs.mesh);

    // 飛び散る破片パーティクル
    for (let i = 0; i < 6; i++) {
      const geo = new THREE.BoxGeometry(0.5, 0.5, 0.5);
      const mat = new THREE.MeshLambertMaterial({ color: 0xd97706 });
      const piece = new THREE.Mesh(geo, mat);
      piece.position.set(obs.x + (Math.random() - 0.5) * obs.w, 1.0, obs.z + (Math.random() - 0.5) * obs.d);
      scene.add(piece);
      debris.push({
        mesh: piece,
        vx: (Math.random() - 0.5) * 0.3,
        vy: Math.random() * 0.25 + 0.1,
        vz: (Math.random() - 0.5) * 0.3,
        rotX: Math.random() * 0.2,
        rotY: Math.random() * 0.2,
        life: 40
      });
    }
  }

  // メインループ更新
  function updateGame() {
    const now = Date.now();

    // 1. ジェム鉱山からの定期ジェム湧き (4.5秒毎)
    if (Math.random() < 0.004 && gems.length < 29) {
      spawn3DGem(0, 0, 0.25);
    }

    // 2. プレイヤー操作
    if (player && player.alive) {
      let moveX = 0, moveZ = 0;
      if (keys["KeyW"] || keys["ArrowUp"]) moveZ -= 1;
      if (keys["KeyS"] || keys["ArrowDown"]) moveZ += 1;
      if (keys["KeyA"] || keys["ArrowLeft"]) moveX -= 1;
      if (keys["KeyD"] || keys["ArrowRight"]) moveX += 1;

      if (joystick.active) {
        moveX = joystick.dx;
        moveZ = joystick.dy;
      }

      const len = Math.hypot(moveX, moveZ);
      if (len > 0.05) {
        const spd = player.config.speed;
        const normX = (moveX / (len > 1 ? len : 1)) * spd;
        const normZ = (moveZ / (len > 1 ? len : 1)) * spd;
        tryMoveBrawler(player, normX, normZ);
        player.rotation = Math.atan2(normX, normZ);
      }
    }

    // 3. AIボット思考 & 行動
    brawlers.forEach(b => {
      if (b.isPlayer || !b.alive) return;

      // ターゲット決定: ジェム拾い 優先、敵がいれば攻撃
      let targetX = 0, targetZ = 0;
      let closestGem = null;
      let minGemDist = Infinity;

      // チーム全体のジェムカウント >= 10 かつ リード時は自陣へ退却
      const teamGems = b.team === "blue" ? blueGems : redGems;
      const oppGems = b.team === "blue" ? redGems : blueGems;
      if (teamGems >= 10 && teamGems > oppGems) {
        targetX = b.spawnX;
        targetZ = b.spawnZ;
      } else {
        // 一番近いジェムを探す
        gems.forEach(g => {
          const d = Math.hypot(g.x - b.x, g.z - b.z);
          if (d < minGemDist) {
            minGemDist = d;
            closestGem = g;
          }
        });

        if (closestGem && minGemDist < 25) {
          targetX = closestGem.x;
          targetZ = closestGem.z;
        } else {
          // 敵の方向へ向かう
          const enemies = brawlers.filter(e => e.team !== b.team && e.alive);
          if (enemies.length > 0) {
            targetX = enemies[0].x;
            targetZ = enemies[0].z;
          }
        }
      }

      // 障害物を迂回しつつ移動
      const dx = targetX - b.x;
      const dz = targetZ - b.z;
      const dist = Math.hypot(dx, dz);
      if (dist > 0.5) {
        const spd = b.config.speed * 0.92;
        let vx = (dx / dist) * spd;
        let vz = (dz / dist) * spd;

        // 壁にぶつかったら滑り移動
        if (!tryMoveBrawler(b, vx, vz)) {
          if (!tryMoveBrawler(b, vx, 0)) {
            tryMoveBrawler(b, 0, vz);
          }
        }
        b.rotation = Math.atan2(vx, vz);
      }

      // 敵への攻撃判定
      const visibleEnemies = brawlers.filter(e => e.team !== b.team && e.alive && (!e.inBush || Math.hypot(e.x - b.x, e.z - b.z) < 6));
      if (visibleEnemies.length > 0) {
        const closestEnemy = visibleEnemies[0];
        const edist = Math.hypot(closestEnemy.x - b.x, closestEnemy.z - b.z);
        if (edist <= b.config.range * 0.85) {
          b.rotation = Math.atan2(closestEnemy.x - b.x, closestEnemy.z - b.z);
          if (now - b.lastAttackTime > b.aiShootCooldown) {
            if (b.superCharge >= b.superReq) {
              fireBullet(b, true);
            } else if (b.ammo >= 1) {
              fireBullet(b, false);
            }
            b.aiShootCooldown = Math.random() * 600 + 500;
          }
        }
      }
    });

    // 4. リロード & 自動回復
    brawlers.forEach(b => {
      if (!b.alive) {
        b.respawnTimer -= 1;
        if (b.respawnTimer <= 0) {
          respawnBrawler(b);
        }
        return;
      }

      // 残弾リロード
      if (b.ammo < b.maxAmmo && now - b.lastAttackTime > b.config.reloadTime) {
        b.ammo = Math.min(b.maxAmmo, b.ammo + 0.02);
      }

      // 非戦闘時オートヒール (3秒間無傷で毎秒15%回復)
      if (now - b.lastAttackTime > 3000 && now - b.lastDamagedTime > 3000 && b.hp < b.maxHp) {
        b.hp = Math.min(b.maxHp, b.hp + b.maxHp * 0.003);
      }

      // 草むら潜伏判定
      let inside = false;
      bushes.forEach(bush => {
        if (Math.abs(b.x - bush.x) < bush.w / 2 && Math.abs(b.z - bush.z) < bush.d / 2) {
          inside = true;
        }
      });
      b.inBush = inside;

      // 姿勢反映
      b.group.position.set(b.x, 0, b.z);
      b.group.rotation.y = b.rotation;

      // 草むら透明化 (敵視点)
      if (b.inBush) {
        b.body.material.transparent = true;
        b.body.material.opacity = b.team === "blue" ? 0.45 : (player && player.inBush ? 0.3 : 0.0);
      } else {
        b.body.material.transparent = false;
        b.body.material.opacity = 1.0;
      }
    });

    // 5. 弾丸の更新 & 衝突判定
    for (let i = bullets.length - 1; i >= 0; i--) {
      const b = bullets[i];
      b.x += b.vx;
      b.z += b.vz;
      b.dist += Math.hypot(b.vx, b.vz);
      b.mesh.position.set(b.x, 1.2, b.z);

      let removed = false;

      // 壁衝突
      for (const obs of obstacles) {
        if (!obs.alive) continue;
        if (Math.abs(b.x - obs.x) < obs.w / 2 + 0.3 && Math.abs(b.z - obs.z) < obs.d / 2 + 0.3) {
          if (b.breaksWalls) {
            breakObstacle(obs);
          }
          removed = true;
          break;
        }
      }

      // 敵キャラ衝突
      if (!removed) {
        for (const target of brawlers) {
          if (!target.alive || target.team === b.owner.team) continue;
          if (Math.hypot(target.x - b.x, target.z - b.z) < 1.0) {
            target.hp -= b.damage;
            target.lastDamagedTime = now;
            b.owner.superCharge = Math.min(b.owner.superReq, b.owner.superCharge + 1);

            if (target.hp <= 0) {
              killBrawler(target);
            }
            removed = true;
            break;
          }
        }
      }

      if (removed || b.dist >= b.maxDist) {
        scene.remove(b.mesh);
        bullets.splice(i, 1);
      }
    }

    // 6. ジェムの物理 & 取得判定
    for (let i = gems.length - 1; i >= 0; i--) {
      const gem = gems[i];
      gem.mesh.rotation.y += gem.rotSpeed;
      if (gem.y > 0.5) {
        gem.y += gem.vy;
        gem.vy -= 0.02;
        if (gem.y < 0.5) gem.y = 0.5;
        gem.mesh.position.y = gem.y;
      }

      // キャラクターが拾う
      let collected = false;
      for (const b of brawlers) {
        if (!b.alive) continue;
        if (Math.hypot(b.x - gem.x, b.z - gem.z) < 1.4) {
          b.gems += 1;
          playSound("gem");
          collected = true;
          break;
        }
      }

      if (collected) {
        scene.remove(gem.mesh);
        gems.splice(i, 1);
        recalcTeamGems();
      }
    }

    // 7. 破壊破片の更新
    for (let i = debris.length - 1; i >= 0; i--) {
      const d = debris[i];
      d.mesh.position.x += d.vx;
      d.mesh.position.y += d.vy;
      d.mesh.position.z += d.vz;
      d.vy -= 0.015;
      if (d.mesh.position.y < 0.25) d.mesh.position.y = 0.25;
      d.mesh.rotation.x += d.rotX;
      d.mesh.rotation.y += d.rotY;
      d.life -= 1;
      if (d.life <= 0) {
        scene.remove(d.mesh);
        debris.splice(i, 1);
      }
    }

    // 8. カメラの追従
    if (player && player.alive) {
      camera.position.x = THREE.MathUtils.lerp(camera.position.x, player.x, 0.08);
      camera.position.z = THREE.MathUtils.lerp(camera.position.z, player.z + 18, 0.08);
      camera.lookAt(player.x, 0, player.z - 2);
    }

    updateUI();
  }

  // 移動衝突判定
  function tryMoveBrawler(b, dx, dz) {
    const nextX = b.x + dx;
    const nextZ = b.z + dz;

    // 外枠制限
    if (nextX < -19.5 || nextX > 19.5 || nextZ < -28.5 || nextZ > 28.5) return false;

    // 壁障害物衝突
    for (const obs of obstacles) {
      if (!obs.alive) continue;
      if (Math.abs(nextX - obs.x) < obs.w / 2 + 0.8 && Math.abs(nextZ - obs.z) < obs.d / 2 + 0.8) {
        return false;
      }
    }

    b.x = nextX;
    b.z = nextZ;
    return true;
  }

  // 撃破処理 (所持ジェム全ドロップ)
  function killBrawler(b) {
    b.alive = false;
    b.group.visible = false;
    b.respawnTimer = 210; // 約3.5秒

    // 持っていたジェムを散らばして落とす
    for (let i = 0; i < b.gems; i++) {
      const offsetX = (Math.random() - 0.5) * 2.5;
      const offsetZ = (Math.random() - 0.5) * 2.5;
      spawn3DGem(b.x + offsetX, b.z + offsetZ, 0.2 + Math.random() * 0.15);
    }
    b.gems = 0;
    recalcTeamGems();
  }

  // リスポーン処理
  function respawnBrawler(b) {
    b.alive = true;
    b.x = b.spawnX;
    b.z = b.spawnZ;
    b.hp = b.maxHp;
    b.ammo = b.maxAmmo;
    b.superCharge = 0;
    b.group.position.set(b.spawnX, 0, b.spawnZ);
    b.group.visible = true;
  }

  // チームジェム合計の再計算 & 15秒カウントダウン制御
  function recalcTeamGems() {
    blueGems = brawlers.filter(b => b.team === "blue").reduce((acc, b) => acc + b.gems, 0);
    redGems = brawlers.filter(b => b.team === "red").reduce((acc, b) => acc + b.gems, 0);

    const prevTeam = countdownTeam;
    if (blueGems >= 10 && blueGems > redGems) {
      if (countdownTeam !== "blue") {
        countdownTeam = "blue";
        countdownSeconds = 15;
        startCountdown();
      }
    } else if (redGems >= 10 && redGems > blueGems) {
      if (countdownTeam !== "red") {
        countdownTeam = "red";
        countdownSeconds = 15;
        startCountdown();
      }
    } else {
      // カウントダウン解除
      if (countdownTimer) {
        clearInterval(countdownTimer);
        countdownTimer = null;
        countdownTeam = null;
      }
    }
  }

  function startCountdown() {
    if (countdownTimer) clearInterval(countdownTimer);
    playSound("alarm");

    countdownTimer = setInterval(() => {
      countdownSeconds -= 1;
      playSound("alarm");

      if (countdownSeconds <= 0) {
        clearInterval(countdownTimer);
        countdownTimer = null;
        endMatch(countdownTeam);
      }
    }, 1000);
  }

  function endMatch(winnerTeam) {
    gameRunning = false;
    if (animId) cancelAnimationFrame(animId);

    const isWin = winnerTeam === "blue";
    if (isWin) playSound("win");

    const overlay = document.getElementById("brawl3DOverlay");
    const title = document.getElementById("brawl3DOverlayTitle");
    const msg = document.getElementById("brawl3DOverlayMsg");
    if (overlay && title && msg) {
      title.textContent = isWin ? "🏆 勝利！ (VICTORY)" : "💀 敗北… (DEFEAT)";
      title.style.color = isWin ? "#38bdf8" : "#ef4444";
      msg.textContent = isWin ? "ジェムを10個集めてカウントダウンを守り切った！スタープレイヤー獲得！" : "敵チームにカウントダウンを守り切られた…次は奪い返そう！";
      overlay.style.display = "flex";
    }
  }

  // HTML UIの更新
  function updateUI() {
    const blueEl = document.getElementById("brawl3DBlueGems");
    const redEl = document.getElementById("brawl3DRedGems");
    const cdEl = document.getElementById("brawl3DCountdown");
    if (blueEl) blueEl.textContent = blueGems;
    if (redEl) redEl.textContent = redGems;

    if (cdEl) {
      if (countdownTeam) {
        cdEl.style.display = "block";
        cdEl.style.color = countdownTeam === "blue" ? "#38bdf8" : "#ef4444";
        cdEl.textContent = `⏱️ ${countdownTeam === "blue" ? "青チーム" : "赤チーム"}勝利まで: ${countdownSeconds}秒！`;
      } else {
        cdEl.style.display = "none";
      }
    }

    if (player) {
      const hpEl = document.getElementById("brawl3DPlayerHp");
      const ammoEl = document.getElementById("brawl3DPlayerAmmo");
      const superBtn = document.getElementById("brawl3DSuperBtn");

      if (hpEl) hpEl.textContent = `${Math.ceil(player.hp)} / ${player.maxHp}`;
      if (ammoEl) ammoEl.style.width = `${(player.ammo / player.maxAmmo) * 100}%`;

      if (superBtn) {
        const charged = player.superCharge >= player.superReq;
        superBtn.disabled = !charged;
        superBtn.style.background = charged ? "linear-gradient(135deg, #eab308, #ca8a04)" : "#334155";
        superBtn.style.color = charged ? "#ffffff" : "#94a3b8";
        superBtn.style.boxShadow = charged ? "0 0 16px rgba(234, 179, 8, 0.7)" : "none";
        superBtn.textContent = charged ? "⚡ 必殺技 (発動可能！)" : `⚡ 必殺技 (${Math.floor((player.superCharge / player.superReq) * 100)}%)`;
      }
    }
  }

  // ゲームの初期化 & 開始
  window.start3DBrawlGame = function (containerEl, chosenType = "shelly") {
    selectedBrawlerType = chosenType;
    if (!containerEl) return;

    // 既存キャンバス等のクリーンアップ
    window.stop3DBrawlGame();

    containerEl.innerHTML = `
      <div style="position:relative; width:100%; height:100%; min-height:500px; background:#0f172a; border-radius:12px; overflow:hidden; user-select:none; -webkit-user-select:none; font-family:-apple-system,BlinkMacSystemFont,sans-serif;">
        <!-- ヘッダー スコアボード -->
        <div style="position:absolute; top:8px; left:8px; right:8px; z-index:20; display:flex; justify-content:space-between; align-items:center; background:rgba(15,23,42,0.85); backdrop-filter:blur(8px); border:1px solid #334155; padding:8px 14px; border-radius:10px;">
          <div style="font-size:13px; font-weight:bold; color:#38bdf8;">
            💎 青チーム: <span id="brawl3DBlueGems">0</span>個
          </div>
          <div id="brawl3DCountdown" style="font-size:13px; font-weight:bold; color:#facc15; display:none; animation:pulse 1s infinite;">
            ⏱️ 勝利まで: 15秒！
          </div>
          <div style="font-size:13px; font-weight:bold; color:#ef4444;">
            💎 赤チーム: <span id="brawl3DRedGems">0</span>個
          </div>
        </div>

        <!-- 3D WebGL Canvas コンテナ -->
        <div id="brawl3DCanvasWrap" style="width:100%; height:100%; min-height:500px;"></div>

        <!-- 自機ステータス (HP / 弾薬リロード) -->
        <div style="position:absolute; bottom:84px; left:12px; z-index:20; background:rgba(15,23,42,0.85); padding:6px 12px; border-radius:8px; border:1px solid #334155; min-width:140px;">
          <div style="font-size:11px; color:#cbd5e1; display:flex; justify-content:space-between;">
            <span>HP</span>
            <span id="brawl3DPlayerHp" style="font-weight:bold; color:#4ade80;">3800 / 3800</span>
          </div>
          <div style="width:100%; height:6px; background:#334155; border-radius:3px; margin-top:4px; overflow:hidden;">
            <div id="brawl3DPlayerAmmo" style="width:100%; height:100%; background:#f59e0b; transition:width 0.1s;"></div>
          </div>
        </div>

        <!-- コントローラー (スマホ/タッチ用) -->
        <div style="position:absolute; bottom:12px; left:12px; right:12px; z-index:20; display:flex; justify-content:space-between; align-items:center; pointer-events:none;">
          <!-- バーチャルジョイスティック エリア -->
          <div id="brawl3DJoystickArea" style="width:90px; height:90px; border-radius:50%; background:rgba(255,255,255,0.12); border:2px dashed rgba(255,255,255,0.25); display:flex; align-items:center; justify-content:center; pointer-events:auto; touch-action:none;">
            <div id="brawl3DJoystickThumb" style="width:40px; height:40px; border-radius:50%; background:#38bdf8; box-shadow:0 0 10px #38bdf8;"></div>
          </div>

          <!-- 攻撃 & 必殺技ボタン -->
          <div style="display:flex; flex-direction:column; gap:8px; pointer-events:auto;">
            <button id="brawl3DAttackBtn" style="background:#0284c7; color:#fff; font-weight:bold; border:0; padding:12px 20px; border-radius:12px; font-size:13px; cursor:pointer; box-shadow:0 4px 12px rgba(2,132,199,0.4); touch-action:none;">
              💥 攻撃 (散弾)
            </button>
            <button id="brawl3DSuperBtn" style="background:#334155; color:#94a3b8; font-weight:bold; border:0; padding:10px 18px; border-radius:12px; font-size:12px; cursor:pointer; touch-action:none;">
              ⚡ 必殺技 (0%)
            </button>
          </div>
        </div>

        <!-- 勝利/敗北 オーバーレイ -->
        <div id="brawl3DOverlay" style="display:none; position:absolute; top:0; left:0; width:100%; height:100%; z-index:30; background:rgba(15,23,42,0.92); flex-direction:column; align-items:center; justify-content:center; text-align:center; padding:20px; box-sizing:border-box;">
          <h2 id="brawl3DOverlayTitle" style="color:#38bdf8; font-size:26px; margin:0 0 10px;">🏆 勝利！</h2>
          <p id="brawl3DOverlayMsg" style="color:#cbd5e1; font-size:14px; margin:0 0 20px; max-width:320px;">ジェムを10個集めてカウントダウンを守り切った！</p>
          <div style="display:flex; gap:10px;">
            <button onclick="window.start3DBrawlGame(document.getElementById('brawl3DCanvasWrap').parentElement.parentElement, 'shelly')" style="background:#0284c7; color:#fff; font-weight:bold; border:0; padding:10px 20px; border-radius:8px; cursor:pointer;">
              🔄 シェリーで再戦
            </button>
            <button onclick="window.start3DBrawlGame(document.getElementById('brawl3DCanvasWrap').parentElement.parentElement, 'colt')" style="background:#ef4444; color:#fff; font-weight:bold; border:0; padding:10px 20px; border-radius:8px; cursor:pointer;">
              🔫 コルトで再戦
            </button>
            <button onclick="window.start3DBrawlGame(document.getElementById('brawl3DCanvasWrap').parentElement.parentElement, 'bull')" style="background:#1e293b; color:#fff; font-weight:bold; border:0; padding:10px 20px; border-radius:8px; cursor:pointer;">
              🐂 ブルで再戦
            </button>
          </div>
        </div>
      </div>
    `;

    const wrap = document.getElementById("brawl3DCanvasWrap");
    if (!wrap) return;

    // Three.js シーン初期化
    const width = wrap.clientWidth || 380;
    const height = wrap.clientHeight || 500;

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0f1d);

    camera = new THREE.PerspectiveCamera(48, width / height, 0.1, 1000);
    camera.position.set(0, 24, 20);
    camera.lookAt(0, 0, -2);

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.shadowMap.enabled = true;
    wrap.appendChild(renderer.domElement);

    // ライティング
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.65);
    scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight.position.set(10, 28, 15);
    dirLight.castShadow = true;
    scene.add(dirLight);

    // アリーナ作成
    init3DArena();

    // 3v3 キャラクター作成
    brawlers = [];
    bullets = [];
    gems = [];
    debris = [];
    blueGems = 0;
    redGems = 0;
    countdownTeam = null;

    // 青チーム (プレイヤー + 仲間2人)
    player = create3DBrawler(selectedBrawlerType, "blue", true, { x: 0, z: 22 }, "あなた");
    brawlers.push(player);
    brawlers.push(create3DBrawler("colt", "blue", false, { x: -8, z: 24 }, "仲間コルト"));
    brawlers.push(create3DBrawler("bull", "blue", false, { x: 8, z: 24 }, "仲間ブル"));

    // 赤チーム (敵3人)
    brawlers.push(create3DBrawler("shelly", "red", false, { x: 0, z: -22 }, "敵シェリー"));
    brawlers.push(create3DBrawler("colt", "red", false, { x: -8, z: -24 }, "敵コルト"));
    brawlers.push(create3DBrawler("bull", "red", false, { x: 8, z: -24 }, "敵ブル"));

    // 初期ジェム配置 (中央に4個)
    spawn3DGem(-1.5, -1.5, 0);
    spawn3DGem(1.5, -1.5, 0);
    spawn3DGem(-1.5, 1.5, 0);
    spawn3DGem(1.5, 1.5, 0);

    // イベントバインド (キーボード & タッチ)
    setupControls();

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

  // コントローラー・イベントのセットアップ
  function setupControls() {
    window.onkeydown = (e) => {
      keys[e.code] = true;
      if (e.code === "Space") {
        if (player) fireBullet(player, false);
      } else if (e.code === "KeyX" || e.code === "KeyE") {
        if (player && player.superCharge >= player.superReq) fireBullet(player, true);
      }
    };

    window.onkeyup = (e) => {
      keys[e.code] = false;
    };

    // タッチ ジョイスティック
    const stickArea = document.getElementById("brawl3DJoystickArea");
    const thumb = document.getElementById("brawl3DJoystickThumb");

    if (stickArea && thumb) {
      stickArea.onpointerdown = (e) => {
        e.preventDefault();
        joystick.active = true;
        joystick.startX = e.clientX;
        joystick.startY = e.clientY;
        joystick.dx = 0;
        joystick.dy = 0;
        stickArea.setPointerCapture(e.pointerId);
      };

      stickArea.onpointermove = (e) => {
        if (!joystick.active) return;
        const diffX = e.clientX - joystick.startX;
        const diffY = e.clientY - joystick.startY;
        const dist = Math.hypot(diffX, diffY);
        const maxR = 30;

        if (dist > maxR) {
          joystick.dx = diffX / dist;
          joystick.dy = diffY / dist;
          thumb.style.transform = `translate(${joystick.dx * maxR}px, ${joystick.dy * maxR}px)`;
        } else {
          joystick.dx = diffX / maxR;
          joystick.dy = diffY / maxR;
          thumb.style.transform = `translate(${diffX}px, ${diffY}px)`;
        }
      };

      const resetJoy = () => {
        joystick.active = false;
        joystick.dx = 0;
        joystick.dy = 0;
        thumb.style.transform = "translate(0px, 0px)";
      };
      stickArea.onpointerup = resetJoy;
      stickArea.onpointercancel = resetJoy;
    }

    // 攻撃ボタン
    const atkBtn = document.getElementById("brawl3DAttackBtn");
    if (atkBtn) {
      atkBtn.onpointerdown = (e) => {
        e.preventDefault();
        if (player) fireBullet(player, false);
      };
    }

    // 必殺技ボタン
    const supBtn = document.getElementById("brawl3DSuperBtn");
    if (supBtn) {
      supBtn.onpointerdown = (e) => {
        e.preventDefault();
        if (player && player.superCharge >= player.superReq) fireBullet(player, true);
      };
    }
  }

  // クリーンアップ
  window.stop3DBrawlGame = function () {
    gameRunning = false;
    if (animId) cancelAnimationFrame(animId);
    if (countdownTimer) clearInterval(countdownTimer);
    countdownTimer = null;
    window.onkeydown = null;
    window.onkeyup = null;

    if (renderer && renderer.domElement && renderer.domElement.parentElement) {
      renderer.domElement.parentElement.removeChild(renderer.domElement);
    }
  };

})();
