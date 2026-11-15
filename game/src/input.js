// Keyboard and mouse, plus the pointer lock that turns mouse movement into
// looking. Plain browser APIs only: the game asks the canvas for pointer
// lock and reads movementX/Y while it holds it. `edge` is the set of keys
// that went down since the last takePressed() call, so the game can act on a
// single press (buy, swap weapon, throw) without repeats.
export function createInput(canvas, onLockChange) {
  const held = new Set();
  const edge = new Set();
  const pad = { keys: held, pressed: edge, locked: false, firing: false, lookX: 0, lookY: 0 };

  function onKey(event, isDown) {
    if (isDown) {
      if (!held.has(event.code)) edge.add(event.code);
      held.add(event.code);
    } else {
      held.delete(event.code);
    }
    if (event.code === 'Space') event.preventDefault();
  }

  function onMouseMove(event) {
    if (!pad.locked) return;
    pad.lookX += event.movementX;
    pad.lookY += event.movementY;
  }

  function onMouseDown(event) {
    if (pad.locked && event.button === 0) pad.firing = true;
  }

  function onMouseUp(event) {
    if (event.button === 0) pad.firing = false;
  }

  function onWheel(event) {
    if (!pad.locked) return;
    edge.add(event.deltaY > 0 ? 'WheelDown' : 'WheelUp');
  }

  function onBlur() {
    held.clear();
    edge.clear();
  }

  function onLock() {
    pad.locked = document.pointerLockElement === canvas;
    if (!pad.locked) {
      held.clear();
      pad.firing = false;
    }
    onLockChange(pad.locked);
  }

  const bindings = [
    [window, 'keydown', (event) => onKey(event, true)],
    [window, 'keyup', (event) => onKey(event, false)],
    [window, 'blur', onBlur],
    [window, 'mousemove', onMouseMove],
    [window, 'mousedown', onMouseDown],
    [window, 'mouseup', onMouseUp],
    [window, 'wheel', onWheel, { passive: true }],
    [document, 'pointerlockchange', onLock],
  ];
  for (const [target, type, handler, opts] of bindings) target.addEventListener(type, handler, opts);

  return {
    state: pad,
    requestLock() {
      canvas.requestPointerLock();
    },
    takeLook() {
      const snapshot = { x: pad.lookX, y: pad.lookY };
      pad.lookX = 0;
      pad.lookY = 0;
      return snapshot;
    },
    takePressed() {
      const snapshot = new Set(edge);
      edge.clear();
      return snapshot;
    },
  };
}
