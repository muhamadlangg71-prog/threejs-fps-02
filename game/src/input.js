// FERROLINE input: keyboard, mouse and pointer lock, kept as one small
// state object the loop reads every frame. Keys held down live in
// state.keys; keys tapped since the last frame live in the pressed set
// takePressed hands over (so one tap is one buy, one switch, one throw);
// mouse movement accumulates in takeLook until the loop spends it.
export function createInput(canvas, onLockChange) {
  const state = { keys: new Set(), firing: false };
  const lookDelta = { x: 0, y: 0 };
  let pressed = new Set();

  function onKeyDown(e) {
    if (e.repeat) return;
    if (e.code === 'Space') e.preventDefault();
    state.keys.add(e.code);
    pressed.add(e.code);
  }

  function onKeyUp(e) {
    state.keys.delete(e.code);
  }

  function onMouseMove(e) {
    if (document.pointerLockElement !== canvas) return;
    lookDelta.x += e.movementX || 0;
    lookDelta.y += e.movementY || 0;
  }

  function onMouseDown(e) {
    if (e.button === 0) state.firing = true;
  }

  function onMouseUp(e) {
    if (e.button === 0) state.firing = false;
  }

  function onWheel(e) {
    pressed.add(e.deltaY < 0 ? 'WheelUp' : 'WheelDown');
  }

  function onLock() {
    onLockChange(document.pointerLockElement === canvas);
  }

  function onBlur() {
    state.keys.clear();
    state.firing = false;
  }

  function onContext(e) {
    e.preventDefault();
  }

  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);
  canvas.addEventListener('mousedown', onMouseDown);
  canvas.addEventListener('wheel', onWheel);
  canvas.addEventListener('contextmenu', onContext);
  document.addEventListener('pointerlockchange', onLock);
  window.addEventListener('blur', onBlur);

  return {
    state,
    requestLock() {
      try {
        const pending = canvas.requestPointerLock();
        if (pending && typeof pending.catch === 'function') pending.catch(() => {});
      } catch {
        // Pointer lock is a nicety: the game plays on without it.
      }
    },
    takeLook() {
      const spent = { x: lookDelta.x, y: lookDelta.y };
      lookDelta.x = 0;
      lookDelta.y = 0;
      return spent;
    },
    takePressed() {
      const spent = pressed;
      pressed = new Set();
      return spent;
    },
  };
}
