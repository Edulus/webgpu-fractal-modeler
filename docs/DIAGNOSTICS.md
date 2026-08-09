# Renderer Diagnostics

Renderer Diagnostics is an optional developer tool for measuring the Fractal WebGPU Modeler on real hardware. It exists to answer empirical questions about the adaptive renderer before the quality ladder is retuned.

The demo exposes a collapsed **Diagnostics** section in the control panel. It is off by default. Opening it enables live quality telemetry; closing it disables the per-frame diagnostic sample tap again. Add `?diagnostics=1` to the demo URL to open it at startup for a benchmark session.

## What it reports

The diagnostics snapshot combines the renderer's public `handle.info` state with observational quality telemetry from `src/quality.js` and the canvas's actual backing-store dimensions.

It reports:

- model name, id, and geometry family;
- selected mode, current rung, texture-limit rung cap, and interactive/showcase source;
- governor budget, miss rate, climb/drop thresholds, ceiling, last failed rung, retry interval, and EMA;
- CSS canvas size, browser DPR, effective backing-store scale after any proportional fit, actual swapchain size, reconstructed internal material size, requested/effective scale, and `maxTextureDimension2D`;
- live raymarch step ceiling, iteration depth, and shading tier;
- accumulation sample count, the live 96-sample cap, accumulation/convergence state, and whether a converged frame is skipping the material/raymarch pass;
- rolling FPS; and
- a bounded history of recent quality transitions.

The internal target size is reconstructed from the actual swapchain size, live quality scale, exact texture limit observed by `maxRungForLimit()`, and the same proportional fitting rule used by `resize()`. The renderer does not expose its private texture objects directly.

## Copy Renderer Report

**Copy Renderer Report** copies a plain-text snapshot suitable for an issue, benchmark note, ChatGPT conversation, or coding session. It includes the renderer state above plus the browser user agent, platform string, and language when available. Diagnostics deliberately avoids higher-entropy or permission-gated device fingerprinting.

Example shape of the report:

```text
Fractal WebGPU Modeler Renderer Report
Model: barth (raymarched surface)
Mode: max
Rung: 7 / cap 9 (interactive governor)
Governor ceiling: 8 · last fail: 9
Budget: 22.545 ms · miss rate: 0.041
Steps: 220 · iterations: 15 · shading: full
Canvas CSS: 1920 × 1080
Swapchain: 3840 × 2160
Internal render: 5760 × 3240 (q1.5)
Texture limit: 8192
Accumulation: 37 / 96 · accumulating
Recent transitions:
  ...
```

## Programmatic use

The diagnostics module can be installed around an existing renderer handle:

```js
import { installRendererDiagnostics } from './src/diagnostics.js';

const diagnostics = installRendererDiagnostics(handle, canvas);
diagnostics.setEnabled(true);

const snapshot = diagnostics.snapshot();
const report = diagnostics.report();

// The installer also adds these convenience methods while installed:
handle.getDiagnostics();
handle.getRendererReport();

// Stop live sampling when it is not being inspected.
diagnostics.setEnabled(false);

// Restore wrapped handle methods and remove the convenience methods.
diagnostics.destroy();
```

`installRendererDiagnostics()` wraps only the public `setQuality()` and `setAccumulate()` methods so explicit mode/accumulation changes can be represented accurately. `destroy()` restores the original function objects.

## Transition history

History is bounded to 32 events by default. It records meaningful changes rather than every frame, including:

- initialization;
- governor rung changes;
- Max showcase escalation;
- explicit quality-mode changes; and
- texture-limit caps when observed while diagnostics is enabled.

Each event records elapsed diagnostic time, previous and next rung, reason, model, and governor miss/ceiling information when available. Consumers receive copies of history rather than the mutable internal array.

## Observational boundary

Diagnostics must never become an input to rendering policy.

The governor continues to make exactly the same decisions from the frame samples it already receives. The quality module has no DOM, WebGPU, or clock dependency. Diagnostic subscribers receive frozen event snapshots after meaningful decisions have been made; their return values are ignored and their exceptions are contained.

While no diagnostics subscriber is active, ordinary `govSample()` calls retain only the already-created governor object reference and a few scalar fields. They create no diagnostic event objects, frozen copies, or callbacks. Retaining the last interactive state lets Diagnostics open on an already-converged view without reporting an ancient governor snapshot, while keeping the hot-path measurement overhead extremely small.

The following rules should be preserved:

1. diagnostics never call `govSample()` or `adaptQuality()` themselves;
2. converged frames remain excluded from governor evidence;
3. diagnostic UI refresh remains decoupled from the render loop;
4. diagnostic data never changes a rung, budget, ceiling, accumulation state, or texture size; and
5. real allocated/fitted dimensions are reported rather than presenting a requested supersampling scale as if it were guaranteed.

## First real-hardware measurement pass

Before changing rungs 7–9, collect reports on at least:

- one phone;
- one laptop; and
- one desktop/workstation.

For each device compare Auto and Max while moving, then freeze the view long enough to observe showcase/accumulation behaviour. Use at least:

- one relatively inexpensive raymarched model;
- Mandelbulb or Mandelbox;
- Barth sextic;
- Tetrabrot; and
- one strange attractor.

The next decision should be perceptual: whether the upper ladder spends too much budget on supersampled pixels compared with deeper iteration, tighter surface precision, or additional stationary accumulation. The diagnostics system is intended to supply evidence for that decision, not to make the decision automatically.
