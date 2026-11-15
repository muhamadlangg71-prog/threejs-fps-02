// Hit feedback: tracers, impact sparks, blood puffs, explosions. Every effect is a
// pooled object reused across frames — the hot loop never allocates a mesh.
import * as THREE from 'three';
import { PALETTE } from './palette.js';

const POOL_SIZES = { tracer: 24, spark: 40, smoke: 16 };
const TRACER_LIFE = 0.12;
const TRACER_OPACITY = 0.85;
const SPARK_OPACITY = 0.95;

function makePool(count, build) {
  const items = [];
  for (let i = 0; i < count; i += 1) items.push(build());
  let cursor = 0;
  return {
    items,
    next() {
      const item = items[cursor];
      cursor = (cursor + 1) % count;
      return item;
    },
  };
}

function smokeTexture() {
  const canvas = document.createElement('canvas');
  Object.assign(canvas, { width: 64, height: 64 });
  const g = canvas.getContext('2d');
  const radial = g.createRadialGradient(32, 32, 2, 32, 32, 32);
  radial.addColorStop(0, 'rgba(200, 190, 175, 0.7)');
  radial.addColorStop(1, 'rgba(200, 190, 175, 0)');
  g.fillStyle = radial;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(canvas);
}

export function createEffects(scene, camera) {
  const tracerMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(PALETTE.accent), transparent: true, opacity: TRACER_OPACITY, depthWrite: false,
  });
  const tracers = makePool(POOL_SIZES.tracer, () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.035, 1), tracerMat.clone());
    mesh.visible = false;
    scene.add(mesh);
    return { mesh, life: 0 };
  });

  const sparkGeo = new THREE.TetrahedronGeometry(0.06);
  const sparks = makePool(POOL_SIZES.spark, () => {
    const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(PALETTE.accent), transparent: true, opacity: 0.9 });
    const mesh = new THREE.Mesh(sparkGeo, mat);
    mesh.visible = false;
    scene.add(mesh);
    return { mesh, vel: new THREE.Vector3(), life: 0, gravity: 9 };
  });

  const smokeTex = smokeTexture();
  const smokes = makePool(POOL_SIZES.smoke, () => {
    const mat = new THREE.SpriteMaterial({ map: smokeTex, transparent: true, opacity: 0, depthWrite: false });
    const sprite = new THREE.Sprite(mat);
    sprite.visible = false;
    scene.add(sprite);
    return { sprite, life: 0, maxLife: 1, grow: 1 };
  });

  // Explosion flash: a point light plus a bright sphere that pops and fades.
  const boomLight = new THREE.PointLight(new THREE.Color('#ffb066'), 0, 22, 1.6);
  scene.add(boomLight);
  const boomMesh = new THREE.Mesh(
    new THREE.SphereGeometry(1, 16, 12),
    new THREE.MeshBasicMaterial({ color: new THREE.Color('#ffcf8a'), transparent: true, opacity: 0, depthWrite: false }),
  );
  boomMesh.visible = false;
  scene.add(boomMesh);
  let boomLife = 0;

  const tmpA = new THREE.Vector3();
  const tmpB = new THREE.Vector3();

  function spawnSpark(point, normal, color, speed, count, gravity) {
    for (let n = 0; n < count; n += 1) {
      const s = sparks.next();
      s.mesh.visible = true;
      s.mesh.position.copy(point);
      s.mesh.material.color.set(color);
      s.mesh.material.opacity = SPARK_OPACITY;
      tmpA.copy(normal).multiplyScalar(speed * (0.5 + Math.random() * 0.8));
      tmpB.set((Math.random() - 0.5) * speed, Math.random() * speed * 0.7, (Math.random() - 0.5) * speed);
      s.vel.copy(tmpA).add(tmpB);
      s.life = 0.35 + Math.random() * 0.25;
      s.gravity = gravity;
    }
  }

  function placeSmoke(point, scale, life) {
    const s = smokes.next();
    s.sprite.visible = true;
    s.sprite.position.copy(point);
    s.sprite.scale.setScalar(0.4);
    s.sprite.material.opacity = 0.55;
    s.life = life;
    s.maxLife = life;
    s.grow = scale;
  }

  function updateTracers(dt) {
    for (const t of tracers.items) {
      if (!t.mesh.visible) continue;
      t.life -= dt;
      if (t.life <= 0) t.mesh.visible = false;
      else t.mesh.material.opacity = TRACER_OPACITY * (t.life / TRACER_LIFE);
    }
  }

  function updateSparks(dt) {
    for (const s of sparks.items) {
      if (!s.mesh.visible) continue;
      s.life -= dt;
      if (s.life <= 0) {
        s.mesh.visible = false;
        continue;
      }
      s.vel.y -= s.gravity * dt;
      s.mesh.position.addScaledVector(s.vel, dt);
      s.mesh.material.opacity = Math.min(SPARK_OPACITY, s.life * 3);
      s.mesh.rotation.x += dt * 9;
      s.mesh.rotation.y += dt * 7;
    }
  }

  function updateSmokes(dt) {
    for (const s of smokes.items) {
      if (!s.sprite.visible) continue;
      s.life -= dt;
      if (s.life <= 0) {
        s.sprite.visible = false;
        continue;
      }
      const k = 1 - s.life / s.maxLife;
      s.sprite.scale.setScalar(0.4 + k * s.grow);
      s.sprite.material.opacity = 0.55 * (s.life / s.maxLife);
    }
  }

  function updateBoom(dt) {
    if (boomLife <= 0) return;
    boomLife -= dt;
    const k = Math.max(0, boomLife / 0.45);
    boomLight.intensity = 90 * k;
    boomMesh.scale.setScalar(0.6 + (1 - k) * 4.5);
    boomMesh.material.opacity = 0.95 * k;
    if (boomLife <= 0) {
      boomMesh.visible = false;
      boomLight.intensity = 0;
    }
  }

  function fireTracer(from, to) {
    const t = tracers.next();
    tmpA.copy(to).sub(from);
    const len = tmpA.length();
    if (len < 0.1) return;
    t.mesh.visible = true;
    t.mesh.position.copy(from).addScaledVector(tmpA, 0.5);
    t.mesh.scale.set(1, 1, len);
    t.mesh.lookAt(to);
    t.mesh.material.opacity = TRACER_OPACITY;
    t.life = TRACER_LIFE;
  }

  return {
    tracer(from, to) {
      fireTracer(from, to);
    },
    impact(point, normal) {
      spawnSpark(point, normal, PALETTE.accent, 3.2, 6, 9);
    },
    blood(point, normal) {
      spawnSpark(point, normal, '#a02020', 2.2, 8, 7);
    },
    smoke(point, scale = 1.6, life = 1.1) {
      placeSmoke(point, scale, life);
    },
    explosion(point) {
      boomLight.position.copy(point);
      boomLight.intensity = 90;
      boomMesh.position.copy(point);
      boomMesh.visible = true;
      boomMesh.scale.setScalar(0.6);
      boomMesh.material.opacity = 0.95;
      boomLife = 0.45;
      spawnSpark(point, tmpA.set(0, 1, 0), '#ffcf8a', 7, 14, 10);
      placeSmoke(point, 4.5, 1.6);
      placeSmoke(tmpB.copy(point).add(new THREE.Vector3(0, 1.2, 0)), 3, 1.3);
    },
    muzzleFlash() {
      // The weapon's own flash quad handles the look; the light is driven by weapon.step.
    },
    step(dt) {
      updateTracers(dt);
      updateSparks(dt);
      updateSmokes(dt);
      updateBoom(dt);
      void camera;
    },
  };
}
