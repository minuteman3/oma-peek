// View state of the viewer page: which plate is shown, which object is isolated, which
// object is highlighted under the pointer. Parts are referred to by index into model.parts.
//
//   selectPlate(p)   p = -1 (all plates) or a plate index; clears isolation and hover
//   toggleIsolate(i) isolate part i, or un-isolate if it already is; i must be on the plate
//   hover(i, on)     highlight part i while the pointer is over it; ignored while isolated
//
// Invariants: an isolated part is on the current plate; a hovered part is visible and
// nothing is hovered while a part is isolated. Invalid actions return the state unchanged.

export function initialState(model) {
    return { plate: model.plates.length > 1 ? 0 : -1, isolated: null, hovered: null };
}

export function onPlate(model, state, i) {
    const p = model.parts[i];
    return !!p && (state.plate < 0 || p.plate === state.plate);
}

export function isVisible(model, state, i) {
    return state.isolated !== null ? i === state.isolated : onPlate(model, state, i);
}

export function reduce(model, state, action) {
    switch (action.type) {
        case 'selectPlate': {
            const p = action.plate;
            if (p !== -1 && !(Number.isInteger(p) && p >= 0 && p < model.plates.length)) return state;
            return { plate: p, isolated: null, hovered: null };
        }
        case 'toggleIsolate': {
            const i = action.part;
            if (!onPlate(model, state, i)) return state;
            return { ...state, isolated: state.isolated === i ? null : i, hovered: null };
        }
        case 'hover': {
            const i = action.part;
            if (state.isolated !== null) return state;
            if (action.on) return isVisible(model, state, i) ? { ...state, hovered: i } : state;
            return state.hovered === i ? { ...state, hovered: null } : state;
        }
        default:
            return state;
    }
}
