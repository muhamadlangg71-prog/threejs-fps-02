// FERROLINE effects: gunfire tracers, blood, impact sparks, smoke and
// explosions. Nothing is created while the game runs: every mesh and sprite
// is pooled up front and handed back when its life runs out, so the busiest
// second of a 5v5 firefight costs no allocation and no collection hitch.
import * as THREE from 'three';

// Pool sizes: enough for the busiest second of a 5v5 firefight.
const TRACER_COUNT = 32;
const SPARK_COUNT = 256;
const PUFF_COUNT = 48;
const FLASH_COUNT = 4;

// How long each kind of effect lives, in seconds.
const TRACER_SPAN = 0.07;
const BLOOD_SPAN = 0.45;
const SPARK_SPAN = 0.22;
const PUFF_SPAN = 2.6;
const FLASH_SPAN = 0.35;

// Looks: a warm tracer, dark blood, pale sparks, grey smoke, orange fire.
const TRACER_COLOR = 0xffd27a;
const BLOOD_COLOR = 0x8a1414;
const SPARK_COLOR = 0xffe9a8;
const PUFF_COLOR = 0x9aa0a8;
const FLASH_COLOR = 0xff9a3c;
const SPARK_FALL = 9;
const BLOOD_SPEED = 2.2;
const SPARK_SPEED = 5;
const BLAST_SPEED = 7;

// A soft round disc, painted once, shared by every smoke puff.
function softDisc() {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const g = canvas.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 2, 32, 32, 30);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.6, 'rgba(255,255,255,0.45)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(canvas);
}

export function createEffects(scene, camera) {
  const disc = softDisc();
  const tmpA = new THREE.Vector3();
  const tmpB = new THREE.Vector3();

  // ---- Tracers: thin glowing bars stretched muzzle to hit. ----
  const tracerGeo = new THREE.BoxGeometry(1, 1, 1);
  const tracers = [];
  for (let i = 0; i < TRACER_COUNT; i += 1) {
    const mat = new THREE.MeshBasicMaterial({
      color: TRACER_COLOR, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const mesh = new THREE.Mesh(tracerGeo, mat);
    mesh.visible = false;
    scene.add(mesh);
    tracers.push({ mesh, age: 0 });
  }
  let tracerNext = 0;

  // ---- Sparks: one shared pool for blood, impacts and blast debris. ----
  // Blood and sparks share geometry; colour is the only difference, and a
  // spark shrinks away instead of fading, so two materials cover the pool.
  const sparkGeo = new THREE.BoxGeometry(0.06, 0.06, 0.06);
  const bloodMat = new THREE.MeshBasicMaterial({ color: BLOOD_COLOR });
  const sparkMat = new THREE.MeshBasicMaterial({ color: SPARK_COLOR });
  const sparks = [];
  for (let i = 0; i < SPARK_COUNT; i += 1) {
    const mesh = new THREE.Mesh(sparkGeo, sparkMat);
    mesh.visible = false;
    scene.add(mesh);
    sparks.push({ mesh, vel: new THREE.Vector3(), age: 0, span: SPARK_SPAN });
  }
  let sparkNext = 0;

  function burst(point, normal, count, speed, span, bloody) {
    for (let n = 0; n < count; n += 1) {
      const s = sparks[sparkNext];
      sparkNext = (sparkNext + 1) % SPARK_COUNT;
      s.mesh.position.copy(point);
      s.mesh.material = bloody ? bloodMat : sparkMat;
      s.vel.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5)
        .multiplyScalar(speed)
        .addScaledVector(normal, speed * 0.8);
      s.age = 0;
      s.span = span;
      s.mesh.scale.setScalar(1);
      s.mesh.visible = true;
    }
  }

  // ---- Smoke: billboards that swell and thin out. ----
  const puffs = [];
  for (let i = 0; i < PUFF_COUNT; i += 1) {
    const mat = new THREE.SpriteMaterial({
      map: disc, color: PUFF_COLOR, transparent: true, opacity: 0, depthWrite: false,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.visible = false;
    scene.add(sprite);
    puffs.push({ sprite, age: 0, size: 1, base: 0.5, drift: new THREE.Vector3() });
  }
  let puffNext = 0;

  // ---- Blast flashes: a fireball that swells and dies in a blink. ----
  const flashGeo = new THREE.SphereGeometry(1, 16, 12);
  const flashes = [];
  for (let i = 0; i < FLASH_COUNT; i += 1) {
    const mat = new THREE.MeshBasicMaterial({
      color: FLASH_COLOR, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const mesh = new THREE.Mesh(flashGeo, mat);
    mesh.visible = false;
    scene.add(mesh);
    flashes.push({ mesh, age: 0 });
  }
  let flashNext = 0;

  function showTracer(from, to) {
    const len = from.distanceTo(to);
    if (len < 0.1) return;
    const t = tracers[tracerNext];
    tracerNext = (tracerNext + 1) % TRACER_COUNT;
    tmpA.copy(from).add(to).multiplyScalar(0.5);
    t.mesh.position.copy(tmpA);
    t.mesh.lookAt(to);
    t.mesh.scale.set(0.02, 0.02, len);
    t.mesh.material.opacity = 0.9;
    t.mesh.visible = true;
    t.age = 0;
  }

  function showSmoke(at, radius, count) {
    for (let n = 0; n < count; n += 1) {
      const p = puffs[puffNext];
      puffNext = (puffNext + 1) % PUFF_COUNT;
      tmpA.set(Math.random() - 0.5, Math.random() * 0.4, Math.random() - 0.5)
        .multiplyScalar(radius);
      p.sprite.position.copy(at).add(tmpA);
      p.drift.set(Math.random() - 0.5, 0.3 + Math.random() * 0.4, Math.random() - 0.5);
      p.size = radius * (0.8 + Math.random() * 0.8);
      p.base = 0.5;
      p.age = 0;
      p.sprite.scale.setScalar(p.size * 0.4);
      p.sprite.material.opacity = p.base;
      p.sprite.visible = true;
    }
  }

  function showExplosion(at) {
    const f = flashes[flashNext];
    flashNext = (flashNext + 1) % FLASH_COUNT;
    f.mesh.position.copy(at);
    f.mesh.scale.setScalar(0.5);
    f.mesh.material.opacity = 0.9;
    f.mesh.visible = true;
    f.age = 0;
    tmpB.set(0, 1, 0);
    burst(at, tmpB, 12, BLAST_SPEED, SPARK_SPAN * 2, false);
    showSmoke(at, 3, 5);
  }

  function advance(dt) {
    for (const t of tracers) {
      if (!t.mesh.visible) continue;
      t.age += dt;
      if (t.age >= TRACER_SPAN) {
        t.mesh.visible = false;
        continue;
      }
      t.mesh.material.opacity = 0.9 * (1 - t.age / TRACER_SPAN);
    }
    for (const s of sparks) {
      if (!s.mesh.visible) continue;
      s.age += dt;
      if (s.age >= s.span) {
        s.mesh.visible = false;
        continue;
      }
      s.vel.y -= SPARK_FALL * dt;
      s.mesh.position.addScaledVector(s.vel, dt);
      s.mesh.scale.setScalar(Math.max(0.01, 1 - s.age / s.span));
    }
    for (const p of puffs) {
      if (!p.sprite.visible) continue;
      p.age += dt;
      if (p.age >= PUFF_SPAN) {
        p.sprite.visible = false;
        continue;
      }
      const k = p.age / PUFF_SPAN;
      p.sprite.position.addScaledVector(p.drift, dt);
      p.sprite.scale.setScalar(p.size * (0.4 + 0.6 * k));
      p.sprite.material.opacity = p.base * (1 - k);
    }
    for (const f of flashes) {
      if (!f.mesh.visible) continue;
      f.age += dt;
      if (f.age >= FLASH_SPAN) {
        f.mesh.visible = false;
        continue;
      }
      const k = f.age / FLASH_SPAN;
      f.mesh.scale.setScalar(0.5 + k * 7);
      f.mesh.material.opacity = 0.9 * (1 - k);
    }
  }

  return {
    tracer: showTracer,
    blood(point, normal) {
      burst(point, normal, 10, BLOOD_SPEED, BLOOD_SPAN, true);
    },
    impact(point, normal) {
      burst(point, normal, 7, SPARK_SPEED, SPARK_SPAN, false);
    },
    smoke: showSmoke,
    explosion: showExplosion,
    step: advance,
  };
}
