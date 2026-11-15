// FERROLINE player: a first-person body with acceleration, crouch, jump
// and collision against the map's boxes. The body is a box of its own —
// half a metre wide, a head taller than a crate — and it moves one axis at
// a time, so sliding along a wall never snags on a corner. The ground is
// the yard at y=0; anything the feet can stand on is a floor, anything
// taller than the feet is a wall, and the two never mix.
import * as THREE from 'three';

// Feel: walk and crouch speeds, how fast the body answers the keys,
// gravity, and a jump that just clears the Crane Deck's edge.
const WALK_SPEED = 4.6;
const CROUCH_SPEED = 2.5;
const ANSWER = 22;
const GRAVITY = 16;
const JUMP_SPEED = 5.6;
const EYE_STAND = 1.55;
const EYE_CROUCH = 1.05;
const EYE_RATE = 10;
const HALF = 0.34;
const HEIGHT = 1.72;
const LOOK_SENS = 0.0022;
const PITCH_LIMIT = 1.55;

export function createPlayer(colliders) {
  const state = {
    position: new THREE.Vector3(0, 0, 17),
    velocity: new THREE.Vector3(),
    yaw: 0,
    pitch: 0,
    eye: EYE_STAND,
    health: 100,
    armor: 0,
    alive: true,
  };
  const probe = new THREE.Box3();
  let grounded = true;

  // The body's box at (x, z): tall enough to catch walls, high enough off
  // the floor that the ground slab itself never counts as one.
  function bodyAt(x, z) {
    probe.min.set(x - HALF, state.position.y + 0.02, z - HALF);
    probe.max.set(x + HALF, state.position.y + HEIGHT, z + HALF);
    return probe;
  }

  // One axis of movement at a time: take it when no solid stands in the
  // way, so pushing into a wall still slides along it instead of sticking.
  function slideX(dx) {
    const nx = state.position.x + dx;
    const box = bodyAt(nx, state.position.z);
    for (const c of colliders) {
      if (box.intersectsBox(c)) return;
    }
    state.position.x = nx;
  }

  function slideZ(dz) {
    const nz = state.position.z + dz;
    const box = bodyAt(state.position.x, nz);
    for (const c of colliders) {
      if (box.intersectsBox(c)) return;
    }
    state.position.z = nz;
  }

  // The highest floor under the body's footprint: the yard, or the top of
  // a deck or crate the feet are already above.
  function floorUnder() {
    let top = 0;
    const px = state.position.x;
    const pz = state.position.z;
    for (const c of colliders) {
      if (px - HALF >= c.max.x || px + HALF <= c.min.x) continue;
      if (pz - HALF >= c.max.z || pz + HALF <= c.min.z) continue;
      if (c.max.y <= state.position.y + 0.05 && c.max.y > top) top = c.max.y;
    }
    return top;
  }

  // Rising headroom: the lowest ceiling over the body's footprint.
  function ceilingOver() {
    let low = Infinity;
    const px = state.position.x;
    const pz = state.position.z;
    for (const c of colliders) {
      if (px - HALF >= c.max.x || px + HALF <= c.min.x) continue;
      if (pz - HALF >= c.max.z || pz + HALF <= c.min.z) continue;
      if (c.min.y >= state.position.y + HEIGHT && c.min.y < low) low = c.min.y;
    }
    return low;
  }

  function step(dt, keys) {
    const crouched = keys.has('ControlLeft') || keys.has('ControlRight');
    const speed = crouched ? CROUCH_SPEED : WALK_SPEED;
    // Wish direction in yaw space: forward is -z turned by the yaw, right
    // is +x turned the same way.
    const sin = Math.sin(state.yaw);
    const cos = Math.cos(state.yaw);
    let fx = 0;
    let fz = 0;
    if (keys.has('KeyW')) { fx -= sin; fz -= cos; }
    if (keys.has('KeyS')) { fx += sin; fz += cos; }
    if (keys.has('KeyD')) { fx += cos; fz -= sin; }
    if (keys.has('KeyA')) { fx -= cos; fz += sin; }
    const len = Math.hypot(fx, fz);
    if (len > 0) {
      fx /= len;
      fz /= len;
    }
    // Ease the velocity toward the wish: quick to answer, never a snap.
    const k = 1 - Math.exp(-ANSWER * dt);
    state.velocity.x += (fx * speed - state.velocity.x) * k;
    state.velocity.z += (fz * speed - state.velocity.z) * k;

    if (keys.has('Space') && grounded) {
      state.velocity.y = JUMP_SPEED;
      grounded = false;
    }
    state.velocity.y -= GRAVITY * dt;

    slideX(state.velocity.x * dt);
    slideZ(state.velocity.z * dt);

    const nextY = state.position.y + state.velocity.y * dt;
    if (state.velocity.y <= 0) {
      const floor = floorUnder();
      if (nextY <= floor) {
        state.position.y = floor;
        state.velocity.y = 0;
        grounded = true;
      } else {
        state.position.y = nextY;
        grounded = false;
      }
    } else {
      const ceiling = ceilingOver();
      if (nextY + HEIGHT > ceiling) {
        state.position.y = ceiling - HEIGHT;
        state.velocity.y = 0;
      } else {
        state.position.y = nextY;
      }
      grounded = false;
    }

    // The eye drops when crouched, and rises again on standing.
    const eyeTarget = crouched ? EYE_CROUCH : EYE_STAND;
    state.eye += (eyeTarget - state.eye) * (1 - Math.exp(-EYE_RATE * dt));
  }

  function look(dx, dy) {
    state.yaw -= dx * LOOK_SENS;
    state.pitch -= dy * LOOK_SENS;
    if (state.pitch > PITCH_LIMIT) state.pitch = PITCH_LIMIT;
    if (state.pitch < -PITCH_LIMIT) state.pitch = -PITCH_LIMIT;
  }

  function recoil(pitchKick, yawKick) {
    state.pitch += pitchKick;
    if (state.pitch > PITCH_LIMIT) state.pitch = PITCH_LIMIT;
    if (state.pitch < -PITCH_LIMIT) state.pitch = -PITCH_LIMIT;
    state.yaw += yawKick;
  }

  function groundSpeed() {
    return Math.hypot(state.velocity.x, state.velocity.z);
  }

  function teleport(x, y, z, yaw) {
    state.position.set(x, y, z);
    state.velocity.set(0, 0, 0);
    state.yaw = yaw;
    grounded = true;
  }

  return {
    state,
    step,
    look,
    recoil,
    groundSpeed,
    teleport,
    get onGround() {
      return grounded;
    },
  };
}
