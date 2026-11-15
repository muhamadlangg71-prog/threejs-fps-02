// The look plan, in one place: a dusk rail yard — warm rust against cool steel.
// The same names are the CSS custom properties in index.html.
export const PALETTE = {
  canvas: '#181d26', // dusk sky / page background
  surface: '#232a33', // steel panels
  hairline: '#39434e', // steel edges
  ink: '#e8e2d4', // warm off-white
  muted: '#8a93a0', // cool grey-blue
  accent: '#f0a830', // hazard amber
  rust: '#a85b2a', // rusted metal
  ground: '#4a4640', // warm concrete
  container: '#3a4a52', // teal-grey container
  containerB: '#5c4632', // brown container
  vanguard: '#c96a2e', // attacker team (rust orange)
  sentinel: '#2e7f8a', // defender team (teal)
  skyTop: '#2a3444',
  skyBottom: '#c97e46',
};

export function shade(name) {
  return PALETTE[name];
}
