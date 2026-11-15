// Player movement: acceleration, friction, gravity, crouch and jump, resolved as a
// box against the world's colliders one axis at a time, so a wall never swallows
// the player. The feet and the crown are trimmed out of the horizontal tests, so
// standing on the floor is never read as walking into a wall.
import * as THREE from 'three';

// Everything that tunes how the body feels, in one place.
const TUNE = {
  radius: 0.34,
  standHeight: 1.72,
  crouchHeight: 1.12,
  standEye: 1.6,
  crouchEye: 1.02,
  walk: 5.2,
  crouchWalk: 2.4,
  groundAccel: 42,
  airAccel: 9,
  friction: 9,
  gravity: 20,
  jump: 6.2,
  look: 0.0022,
  pitchLimit: 1.45,
  eyeLerp: 12,
  maxFall: -30,
};

export function createPlayer(colliders) {
  const body = {
    position: new THREE.Vector3(0, 0, 9.5),
    velocity: new THREE.Vector3(),
    yaw: 0,
    pitch: 0,
    eye: TUNE.standEye,
    onGround: true,
    crouching: false,
    height: TUNE.standHeight,
    health: 100,
    armor: 0,
    alive: true,
  };
  const probe = new THREE.Box3();
  const wish = new THREE.Vector3();

  // First solid the body box would touch at (x, y, z), or null when the spot is free.
  // `lift` trims the bottom and top of the box, so the floor and the ceiling above
  // the head do not count as side walls.
  function probeSolid(x, y, z, height, lift) {
    probe.min.set(x - TUNE.radius, y + lift, z - TUNE.radius);
    probe.max.set(x + TUNE.radius, y + height - lift, z + TUNE.radius);
    for (const collider of colliders) if (probe.intersectsBox(collider)) return collider;
    return null;
  }

  function updateStance(dt, keys) {
    const wantCrouch = keys.has('ControlLeft') || keys.has('ControlRight') || keys.has('KeyC');
    if (wantCrouch && !body.crouching) {
      body.crouching = true;
      body.height = TUNE.crouchHeight;
    } else if (!wantCrouch && body.crouching
      && !probeSolid(body.position.x, body.position.y, body.position.z, TUNE.standHeight, 0.02)) {
      body.crouching = false;
      body.height = TUNE.standHeight;
    }
    const eyeTarget = body.crouching ? TUNE.crouchEye : TUNE.standEye;
    body.eye += (eyeTarget - body.eye) * Math.min(1, dt * TUNE.eyeLerp);
  }

  function updateWish(keys) {
    const forward = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
    const strafe = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
    wish.set(0, 0, 0);
    if (forward || strafe) {
      const sin = Math.sin(body.yaw);
      const cos = Math.cos(body.yaw);
      wish.set(-sin * forward + cos * strafe, 0, -cos * forward - sin * strafe).normalize();
    }
    return { forward, strafe };
  }

  function accelerate(dt, moving) {
    const speed = body.crouching ? TUNE.crouchWalk : TUNE.walk;
    const blend = Math.min(1, (body.onGround ? TUNE.groundAccel : TUNE.airAccel) * dt / speed);
    body.velocity.x += (wish.x * speed - body.velocity.x) * blend;
    body.velocity.z += (wish.z * speed - body.velocity.z) * blend;
    if (body.onGround && !moving) {
      const damp = Math.max(0, 1 - TUNE.friction * dt);
      body.velocity.x *= damp;
      body.velocity.z *= damp;
    }
  }

  function moveAxis(dt, axis) {
    if (axis === 'x') {
      const nextX = body.position.x + body.velocity.x * dt;
      if (!probeSolid(nextX, body.position.y, body.position.z, body.height, 0.04)) body.position.x = nextX;
      else body.velocity.x = 0;
    } else {
      const nextZ = body.position.z + body.velocity.z * dt;
      if (!probeSolid(body.position.x, body.position.y, nextZ, body.height, 0.04)) body.position.z = nextZ;
      else body.velocity.z = 0;
    }
  }

  function resolveVertical(dt) {
    body.position.y += body.velocity.y * dt;
    body.onGround = false;
    const hit = probeSolid(body.position.x, body.position.y, body.position.z, body.height, 0);
    if (hit && body.velocity.y <= 0) {
      body.position.y = hit.max.y;
      body.velocity.y = 0;
      body.onGround = true;
    } else if (hit) {
      body.position.y = hit.min.y - body.height;
      body.velocity.y = 0;
    }
    if (body.position.y < 0) {
      body.position.y = 0;
      body.velocity.y = 0;
      body.onGround = true;
    }
    body.velocity.y = Math.max(TUNE.maxFall, body.velocity.y);
  }

  function step(dt, keys) {
    updateStance(dt, keys);
    const { forward, strafe } = updateWish(keys);
    accelerate(dt, forward || strafe);
    if (keys.has('Space') && body.onGround) {
      body.velocity.y = TUNE.jump;
      body.onGround = false;
    }
    body.velocity.y -= TUNE.gravity * dt;
    moveAxis(dt, 'x');
    moveAxis(dt, 'z');
    resolveVertical(dt);
  }

  return {
    state: body,
    step,
    look(dx, dy, sensitivity = TUNE.look) {
      body.yaw -= dx * sensitivity;
      body.pitch = Math.max(-TUNE.pitchLimit, Math.min(TUNE.pitchLimit, body.pitch - dy * sensitivity));
    },
    recoil(pitchKick, yawKick) {
      body.pitch = Math.min(TUNE.pitchLimit, body.pitch + pitchKick);
      body.yaw += yawKick;
    },
    teleport(x, y, z, yaw) {
      body.position.set(x, y, z);
      body.velocity.set(0, 0, 0);
      body.yaw = yaw;
      body.pitch = 0;
    },
    groundSpeed() {
      return Math.hypot(body.velocity.x, body.velocity.z);
    },
  };
}
