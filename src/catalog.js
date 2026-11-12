// catalog.js — the Family -> Type -> Shape menu, as pure data.
//
// The catalogue is the shape <select> markup itself: each <optgroup> is a type
// and carries its family in data-family. The page reads that markup into plain
// groups and hands them here, so there is no second list to fall out of step
// with the first. DOM-free, so tools/catalog.test.js can drive it.

// groups: [{ label, family, options: [{ value, label }] }] in menu order.
// Returns { families: [{ name, types: [{ label, shapes: [{ value, label }] }] }] }
// with families and types in first-appearance order.
export function buildCatalog(groups) {
  const families = [];
  const byName = new Map();
  for (const g of groups) {
    const name = g.family || 'Other';
    let fam = byName.get(name);
    if (!fam) {
      fam = { name, types: [] };
      byName.set(name, fam);
      families.push(fam);
    }
    fam.types.push({ label: g.label, shapes: g.options.map((o) => ({ ...o })) });
  }
  return { families };
}

// Where a shape lives: { family, type } indices, or null if it is not listed.
export function locate(catalog, value) {
  for (let f = 0; f < catalog.families.length; f++) {
    const types = catalog.families[f].types;
    for (let t = 0; t < types.length; t++) {
      if (types[t].shapes.some((s) => s.value === value)) return { family: f, type: t };
    }
  }
  return null;
}

// What to show after the user picks a family or a type. Choosing a family
// opens its first type; choosing a type keeps the current shape if it is in
// that type, otherwise selects the type's first shape. `changed` says whether
// the shape itself changed, i.e. whether the renderer must be told.
export function pick(catalog, current, family, type = 0) {
  const fam = catalog.families[family];
  if (!fam) return null;
  const ty = fam.types[Math.min(Math.max(type, 0), fam.types.length - 1)];
  const keep = ty.shapes.some((s) => s.value === current);
  const value = keep ? current : ty.shapes[0].value;
  return { family, type: fam.types.indexOf(ty), value, shapes: ty.shapes, changed: value !== current };
}
