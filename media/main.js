(function () {
  const vscode = acquireVsCodeApi();

  /** @type {HTMLCanvasElement} */
  const canvas = document.getElementById('kanvasCanvas');
  const ctx = canvas.getContext('2d');
  const rc = rough.canvas(canvas);
  const textInput = document.getElementById('textInput');
  const wrap = document.getElementById('canvas-wrap');

  // Custom Eraser Cursor SVG and Data URL (a clean, round brush circle)
  const ERASER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none">
    <circle cx="12" cy="12" r="6.5" stroke="#ffffff" stroke-width="3" />
    <circle cx="12" cy="12" r="6.5" stroke="#fa5252" stroke-width="1.5" fill="rgba(250, 82, 82, 0.2)" />
  </svg>`;
  const eraserCursor = `url("data:image/svg+xml;base64,${btoa(ERASER_SVG)}") 12 12, auto`;

  // ---------- State ----------
  let elements = [];   // committed elements
  let selectedIds = new Set();
  let tool = 'selection';
  let style = {
    strokeColor: '#ffffff',
    fillColor: 'transparent',
    strokeWidth: 2,
    strokeStyle: 'solid',      // 'solid' | 'dashed' | 'dotted'
    fillStyle: 'hachure',      // 'hachure' | 'cross-hatch' | 'solid'
    roughness: 1.5,
    fontFamily: 'handwritten', // 'handwritten' | 'sans-serif' | 'monospace'
    brushType: 'pencil',       // 'pencil' | 'highlighter'
    arrowhead: 'arrow'         // 'arrow' | 'bar' | 'dot' | 'triangle'
  };
  const camera = { x: 0, y: 0, zoom: 1 };
  let gridEnabled = true;
  let activeGuides = [];
  const imageCache = new Map();
  let imagePlacementPoint = null;

  let draft = null;        // element currently being drawn
  let dragMode = null;     // 'move' | 'resize' | 'marquee' | 'pan' | null
  let dragStart = null;    // {x,y} in world coords
  let dragHandle = null;   // which resize handle
  let marquee = null;      // {x0,y0,x1,y1} in world coords
  let elementsSnapshotForDrag = null;
  let spaceDown = false;

  function uid() {
    return 'el_' + Math.random().toString(36).slice(2, 10);
  }
  function seedFor() {
    return Math.floor(Math.random() * 2 ** 31);
  }

  // ---------- Coordinate transforms ----------
  function screenToWorld(sx, sy) {
    return { x: (sx - camera.x) / camera.zoom, y: (sy - camera.y) / camera.zoom };
  }
  function getCanvasPoint(evt) {
    const rect = canvas.getBoundingClientRect();
    return screenToWorld(evt.clientX - rect.left, evt.clientY - rect.top);
  }

  // ---------- Sizing ----------
  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = wrap.clientWidth * dpr;
    canvas.height = wrap.clientHeight * dpr;
    canvas.style.width = wrap.clientWidth + 'px';
    canvas.style.height = wrap.clientHeight + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    redraw();
  }
  window.addEventListener('resize', resizeCanvas);

  // ---------- Geometry helpers ----------
  function normRect(el) {
    const x = el.width < 0 ? el.x + el.width : el.x;
    const y = el.height < 0 ? el.y + el.height : el.y;
    return { x, y, w: Math.abs(el.width), h: Math.abs(el.height) };
  }

  function boundingBoxOf(el) {
    if (el.type === 'draw') {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of el.points) {
        const px = el.x + p.x, py = el.y + p.y;
        minX = Math.min(minX, px); minY = Math.min(minY, py);
        maxX = Math.max(maxX, px); maxY = Math.max(maxY, py);
      }
      return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }
    if (el.type === 'line' || el.type === 'arrow') {
      const x2 = el.x + el.width, y2 = el.y + el.height;
      return {
        x: Math.min(el.x, x2), y: Math.min(el.y, y2),
        w: Math.abs(el.width), h: Math.abs(el.height)
      };
    }
    if (el.type === 'text') {
      return { x: el.x, y: el.y, w: el.width, h: el.height };
    }
    return normRect(el);
  }

  function pointInBox(px, py, box, pad = 0) {
    return px >= box.x - pad && px <= box.x + box.w + pad && py >= box.y - pad && py <= box.y + box.h + pad;
  }

  function rectsIntersect(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  function hitTest(px, py) {
    for (let i = elements.length - 1; i >= 0; i--) {
      const el = elements[i];
      const box = boundingBoxOf(el);
      if (el.type === 'draw' || el.type === 'line' || el.type === 'arrow') {
        const pts = el.type === 'draw'
          ? el.points.map(p => ({ x: el.x + p.x, y: el.y + p.y }))
          : [{ x: el.x, y: el.y }, { x: el.x + el.width, y: el.y + el.height }];
        if (distanceToPolyline(px, py, pts) < 8 / camera.zoom) return el;
      } else if (pointInBox(px, py, box, 2)) {
        if (el.fillColor && el.fillColor !== 'transparent' && el.fillColor !== '#00000000') {
          return el;
        }
        const nearBorder =
          px < box.x + 6 / camera.zoom || px > box.x + box.w - 6 / camera.zoom ||
          py < box.y + 6 / camera.zoom || py > box.y + box.h - 6 / camera.zoom;
        if (el.type === 'text' || nearBorder || (box.w < 12 && box.h < 12)) return el;
      }
    }
    return null;
  }

  function distanceToPolyline(px, py, pts) {
    let min = Infinity;
    for (let i = 0; i < pts.length - 1; i++) {
      min = Math.min(min, distToSeg(px, py, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y));
    }
    if (pts.length === 1) min = Math.hypot(px - pts[0].x, py - pts[0].y);
    return min;
  }
  function distToSeg(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    let t = len2 === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const cx = x1 + t * dx, cy = y1 + t * dy;
    return Math.hypot(px - cx, py - cy);
  }

  function selectionBoundingBox() {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const el of elements) {
      if (!selectedIds.has(el.id)) continue;
      const b = boundingBoxOf(el);
      minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h);
    }
    if (minX === Infinity) return null;
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  // ---------- Rendering ----------
  function hexToRgbA(hex, alpha = 1) {
    let c;
    if (/^#([A-Fa-f0-9]{3}){1,2}$/.test(hex)) {
      c = hex.substring(1).split('');
      if (c.length === 3) {
        c = [c[0], c[0], c[1], c[1], c[2], c[2]];
      }
      c = '0x' + c.join('');
      return 'rgba(' + [(c >> 16) & 255, (c >> 8) & 255, c & 255].join(',') + ',' + alpha + ')';
    }
    return hex;
  }

  function roughOptions(el) {
    let strokeColor = el.strokeColor;
    let strokeWidth = el.strokeWidth;
    let roughness = typeof el.roughness === 'number' ? el.roughness : 1.5;

    if (el.type === 'draw' && el.brushType === 'highlighter') {
      strokeColor = hexToRgbA(el.strokeColor, 0.45);
      strokeWidth = 14;
      roughness = 0.5;
    }

    const opts = {
      stroke: strokeColor,
      strokeWidth: strokeWidth,
      fillStyle: el.fillStyle || 'hachure',
      roughness: roughness,
      seed: el.seed,
      bowing: 1.2
    };

    if (el.fillColor && el.fillColor !== 'transparent' && el.fillColor !== '#00000000') {
      opts.fill = el.fillColor;
    }

    if (el.strokeStyle === 'dashed') {
      opts.strokeDasharray = [8, 8];
    } else if (el.strokeStyle === 'dotted') {
      opts.strokeDasharray = [2, 6];
    }

    return opts;
  }

  function drawElement(el) {
    if (el.editing) return;
    const opts = roughOptions(el);
    switch (el.type) {
      case 'rectangle': {
        const b = normRect(el);
        rc.rectangle(b.x, b.y, b.w, b.h, opts);
        break;
      }
      case 'ellipse': {
        const b = normRect(el);
        rc.ellipse(b.x + b.w / 2, b.y + b.h / 2, b.w, b.h, opts);
        break;
      }
      case 'diamond': {
        const b = normRect(el);
        const pts = [
          [b.x + b.w / 2, b.y],
          [b.x + b.w, b.y + b.h / 2],
          [b.x + b.w / 2, b.y + b.h],
          [b.x, b.y + b.h / 2]
        ];
        rc.polygon(pts, opts);
        break;
      }
      case 'line': {
        rc.line(el.x, el.y, el.x + el.width, el.y + el.height, opts);
        break;
      }
      case 'arrow': {
        const x1 = el.x, y1 = el.y, x2 = el.x + el.width, y2 = el.y + el.height;
        rc.line(x1, y1, x2, y2, opts);
        const angle = Math.atan2(y2 - y1, x2 - x1);
        const headLen = 14 + el.strokeWidth * 2;
        const a1 = angle + Math.PI - 0.4;
        const a2 = angle + Math.PI + 0.4;
        rc.line(x2, y2, x2 + headLen * Math.cos(a1), y2 + headLen * Math.sin(a1), opts);
        rc.line(x2, y2, x2 + headLen * Math.cos(a2), y2 + headLen * Math.sin(a2), opts);
        break;
      }
      case 'draw': {
        const pts = el.points.map(p => [el.x + p.x, el.y + p.y]);
        if (pts.length > 1) {
          rc.curve(pts, { ...opts, fill: undefined });
        }
        break;
      }
      case 'image': {
        let img = imageCache.get(el.id);
        if (!img) {
          img = new Image();
          img.onload = () => {
            imageCache.set(el.id, img);
            redraw();
          };
          img.src = el.src;
        } else {
          ctx.drawImage(img, el.x, el.y, el.width, el.height);
        }
        rc.rectangle(el.x, el.y, el.width, el.height, {
          stroke: '#666666',
          strokeWidth: 1,
          roughness: 0.8,
          fillStyle: 'none'
        });
        break;
      }
      case 'text': {
        ctx.save();
        ctx.fillStyle = el.strokeColor;
        let fontStr = 'sans-serif';
        if (el.fontFamily === 'handwritten' || !el.fontFamily) {
          fontStr = '"Segoe Print", "Comic Sans MS", cursive, sans-serif';
        } else if (el.fontFamily === 'monospace') {
          fontStr = '"Courier New", Courier, monospace';
        }
        ctx.font = `${el.fontSize}px ${fontStr}`;
        ctx.textBaseline = 'top';
        const lines = el.text.split('\n');
        lines.forEach((line, i) => ctx.fillText(line, el.x, el.y + i * el.fontSize * 1.25));
        ctx.restore();
        break;
      }
    }
  }

  function drawSelectionUI() {
    const box = selectionBoundingBox();
    if (!box) return;
    ctx.save();
    ctx.strokeStyle = '#40c057';
    ctx.lineWidth = 1.5 / camera.zoom;
    ctx.setLineDash([4 / camera.zoom, 3 / camera.zoom]);
    const pad = (12 / camera.zoom) + (box.w + box.h) * 0.015;
    ctx.strokeRect(box.x - pad, box.y - pad, box.w + pad * 2, box.h + pad * 2);
    ctx.setLineDash([]);

    if (selectedIds.size === 1) {
      const handleSize = 8 / camera.zoom;
      ctx.fillStyle = '#40c057';
      const handles = handlePositions(box, pad);
      for (const h of Object.values(handles)) {
        ctx.beginPath();
        ctx.arc(h.x, h.y, handleSize / 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1 / camera.zoom;
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  function handlePositions(box, pad) {
    return {
      nw: { x: box.x - pad, y: box.y - pad },
      ne: { x: box.x + box.w + pad, y: box.y - pad },
      sw: { x: box.x - pad, y: box.y + box.h + pad },
      se: { x: box.x + box.w + pad, y: box.y + box.h + pad },
      n: { x: box.x + box.w / 2, y: box.y - pad },
      s: { x: box.x + box.w / 2, y: box.y + box.h + pad },
      e: { x: box.x + box.w + pad, y: box.y + box.h / 2 },
      w: { x: box.x - pad, y: box.y + box.h / 2 }
    };
  }

  function drawGrid() {
    const w = canvas.width / (window.devicePixelRatio || 1);
    const h = canvas.height / (window.devicePixelRatio || 1);

    const gridSize = 30;

    const minX = -camera.x / camera.zoom;
    const minY = -camera.y / camera.zoom;
    const maxX = (w - camera.x) / camera.zoom;
    const maxY = (h - camera.y) / camera.zoom;

    const startX = Math.floor(minX / gridSize) * gridSize;
    const startY = Math.floor(minY / gridSize) * gridSize;
    const endX = Math.ceil(maxX / gridSize) * gridSize;
    const endY = Math.ceil(maxY / gridSize) * gridSize;

    ctx.save();
    const bodyStyles = getComputedStyle(document.body);
    const textCol = bodyStyles.getPropertyValue('--text-muted') || '#55555e';
    ctx.fillStyle = textCol;
    ctx.globalAlpha = 0.25;

    const radius = 1;
    for (let x = startX; x <= endX; x += gridSize) {
      for (let y = startY; y <= endY; y += gridSize) {
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  function redraw() {
    const w = wrap.clientWidth, h = wrap.clientHeight;
    ctx.save();
    ctx.setTransform((window.devicePixelRatio || 1), 0, 0, (window.devicePixelRatio || 1), 0, 0);
    ctx.clearRect(0, 0, w, h);

    ctx.translate(camera.x, camera.y);
    ctx.scale(camera.zoom, camera.zoom);

    if (gridEnabled) {
      drawGrid();
    }

    for (const el of elements) {
      if (el === draft) continue;
      drawElement(el);
    }
    if (draft) drawElement(draft);

    if (marquee) {
      ctx.save();
      ctx.strokeStyle = '#40c057';
      ctx.fillStyle = 'rgba(64,192,87,0.1)';
      ctx.lineWidth = 1 / camera.zoom;
      const x = Math.min(marquee.x0, marquee.x1), y = Math.min(marquee.y0, marquee.y1);
      const w2 = Math.abs(marquee.x1 - marquee.x0), h2 = Math.abs(marquee.y1 - marquee.y0);
      ctx.fillRect(x, y, w2, h2);
      ctx.strokeRect(x, y, w2, h2);
      ctx.restore();
    }

    if (activeGuides && activeGuides.length > 0) {
      ctx.save();
      ctx.strokeStyle = '#ff4b4b';
      ctx.lineWidth = 1 / camera.zoom;
      ctx.setLineDash([4 / camera.zoom, 4 / camera.zoom]);
      const w = wrap.clientWidth, h = wrap.clientHeight;
      const minWorld = screenToWorld(0, 0);
      const maxWorld = screenToWorld(w, h);
      for (const g of activeGuides) {
        ctx.beginPath();
        if (g.type === 'v') {
          ctx.moveTo(g.x, minWorld.y);
          ctx.lineTo(g.x, maxWorld.y);
        } else {
          ctx.moveTo(minWorld.x, g.y);
          ctx.lineTo(maxWorld.x, g.y);
        }
        ctx.stroke();
      }
      ctx.restore();
    }

    drawSelectionUI();
    ctx.restore();
  }

  // ---------- History sync with extension ----------
  function commit(label) {
    pushSceneEdit(label);
    redraw();
  }
  function pushSceneEdit(label) {
    vscode.postMessage({
      type: 'edit',
      label,
      body: { elements: clone(elements), appState: { camera } }
    });
  }
  function clone(v) {
    return JSON.parse(JSON.stringify(v));
  }

  // ---------- Toolbar ----------
  const toolButtons = document.querySelectorAll('.tool-btn');
  toolButtons.forEach(btn => {
    btn.addEventListener('click', () => setTool(btn.dataset.tool));
  });

  function setTool(t) {
    tool = t;
    selectedIds.clear();
    toolButtons.forEach(b => b.classList.toggle('active', b.dataset.tool === t));
    canvas.style.cursor = t === 'selection' ? 'default' : (t === 'eraser' ? eraserCursor : 'crosshair');

    const brushSec = document.querySelector('.brush-section');
    if (brushSec) brushSec.style.display = (t === 'draw') ? 'block' : 'none';

    updateStylePanelFromSelection();
    redraw();
  }

  const undoBtn = document.getElementById('undoBtn');
  if (undoBtn) undoBtn.addEventListener('click', () => vscode.postMessage({ type: 'requestUndo' }));
  const redoBtn = document.getElementById('redoBtn');
  if (redoBtn) redoBtn.addEventListener('click', () => vscode.postMessage({ type: 'requestRedo' }));
  const deleteBtn = document.getElementById('deleteBtn');
  if (deleteBtn) deleteBtn.addEventListener('click', deleteSelected);

  // Toggle/Close Styles panel
  const toggleStylePanelBtn = document.getElementById('toggleStylePanelBtn');
  if (toggleStylePanelBtn) toggleStylePanelBtn.addEventListener('click', toggleStylePanel);
  const closeStylePanelBtn = document.getElementById('closeStylePanelBtn');
  if (closeStylePanelBtn) {
    closeStylePanelBtn.addEventListener('click', () => {
      const panel = document.getElementById('style-panel');
      if (panel) panel.classList.remove('visible');
      if (toggleStylePanelBtn) toggleStylePanelBtn.classList.remove('active');
    });
  }

  function toggleStylePanel() {
    const panel = document.getElementById('style-panel');
    if (panel) {
      panel.classList.toggle('visible');
      const isVisible = panel.classList.contains('visible');
      if (toggleStylePanelBtn) {
        toggleStylePanelBtn.classList.toggle('active', isVisible);
      }
    }
  }

  // ---------- Style Panel Events ----------

  // Stroke Color Swatches
  const strokeSwatches = document.querySelectorAll('#stroke-palette .color-swatch');
  strokeSwatches.forEach(swatch => {
    swatch.addEventListener('click', () => {
      style.strokeColor = swatch.dataset.color;
      document.getElementById('strokeColor').value = swatch.dataset.color.startsWith('#') ? swatch.dataset.color : '#ffffff';
      strokeSwatches.forEach(s => s.classList.toggle('active', s === swatch));
      applyStyleToSelection();
    });
  });

  // Stroke Color Picker
  document.getElementById('strokeColor').addEventListener('input', (e) => {
    style.strokeColor = e.target.value;
    strokeSwatches.forEach(s => s.classList.remove('active'));
    applyStyleToSelection();
  });

  // Fill Color Swatches
  const fillSwatches = document.querySelectorAll('#fill-palette .color-swatch');
  fillSwatches.forEach(swatch => {
    swatch.addEventListener('click', () => {
      style.fillColor = swatch.dataset.color;
      document.getElementById('fillColor').value = swatch.dataset.color.startsWith('#') ? swatch.dataset.color : '#000000';
      fillSwatches.forEach(s => s.classList.toggle('active', s === swatch));
      applyStyleToSelection();
    });
  });

  // Fill Color Picker
  document.getElementById('fillColor').addEventListener('input', (e) => {
    style.fillColor = e.target.value;
    fillSwatches.forEach(s => s.classList.remove('active'));
    applyStyleToSelection();
  });

  // Stroke Width
  const widthButtons = document.querySelectorAll('#stroke-width-group .toggle-btn');
  widthButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      style.strokeWidth = Number(btn.dataset.val);
      widthButtons.forEach(b => b.classList.toggle('active', b === btn));
      applyStyleToSelection();
    });
  });

  // Stroke Style
  const styleButtons = document.querySelectorAll('#stroke-style-group .toggle-btn');
  styleButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      style.strokeStyle = btn.dataset.val;
      styleButtons.forEach(b => b.classList.toggle('active', b === btn));
      applyStyleToSelection();
    });
  });

  // Fill Style
  const fillStyleButtons = document.querySelectorAll('#fill-style-group .toggle-btn');
  fillStyleButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      style.fillStyle = btn.dataset.val;
      fillStyleButtons.forEach(b => b.classList.toggle('active', b === btn));
      applyStyleToSelection();
    });
  });

  // Sloppiness
  const sloppinessButtons = document.querySelectorAll('#sloppiness-group .toggle-btn');
  sloppinessButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      style.roughness = Number(btn.dataset.val);
      sloppinessButtons.forEach(b => b.classList.toggle('active', b === btn));
      applyStyleToSelection();
    });
  });

  // Font Family
  const fontButtons = document.querySelectorAll('#font-family-group .toggle-btn');
  fontButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      style.fontFamily = btn.dataset.val;
      fontButtons.forEach(b => b.classList.toggle('active', b === btn));
      applyStyleToSelection();
    });
  });

  // Brush Type
  const brushButtons = document.querySelectorAll('#brush-type-group .toggle-btn');
  brushButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      style.brushType = btn.dataset.val;
      brushButtons.forEach(b => b.classList.toggle('active', b === btn));
      applyStyleToSelection();
    });
  });

  // Arrow Head
  const arrowheadButtons = document.querySelectorAll('#arrowhead-group .toggle-btn');
  arrowheadButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      style.arrowhead = btn.dataset.val;
      arrowheadButtons.forEach(b => b.classList.toggle('active', b === btn));
      applyStyleToSelection();
    });
  });

  // Image Loader
  const imageLoader = document.getElementById('imageLoader');
  if (imageLoader) {
    imageLoader.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (event) => {
        const src = event.target.result;
        const img = new Image();
        img.onload = () => {
          let w = img.naturalWidth || 300;
          let h = img.naturalHeight || 300;
          const maxSide = 300;
          if (w > maxSide || h > maxSide) {
            if (w > h) {
              h = (h / w) * maxSide;
              w = maxSide;
            } else {
              w = (w / h) * maxSide;
              h = maxSide;
            }
          }
          const pt = imagePlacementPoint || screenToWorld(canvas.width / 2 / (window.devicePixelRatio || 1), canvas.height / 2 / (window.devicePixelRatio || 1));
          const el = {
            id: uid(),
            type: 'image',
            x: pt.x - w / 2,
            y: pt.y - h / 2,
            width: w,
            height: h,
            src: src,
            seed: seedFor()
          };
          imageCache.set(el.id, img);
          elements.push(el);
          selectedIds = new Set([el.id]);
          setTool('selection');
          updateStylePanelFromSelection();
          redraw();
          commit('Add image');
          imageLoader.value = '';
        };
        img.src = src;
      };
      reader.readAsDataURL(file);
    });
  }

  // Layer Operations
  function sendSelectedToBack() {
    if (selectedIds.size === 0) return;
    const selected = [];
    const unselected = [];
    for (const el of elements) {
      if (selectedIds.has(el.id)) {
        selected.push(el);
      } else {
        unselected.push(el);
      }
    }
    elements = [...selected, ...unselected];
    redraw();
    commit('Send to back');
  }

  function bringSelectedToFront() {
    if (selectedIds.size === 0) return;
    const selected = [];
    const unselected = [];
    for (const el of elements) {
      if (selectedIds.has(el.id)) {
        selected.push(el);
      } else {
        unselected.push(el);
      }
    }
    elements = [...unselected, ...selected];
    redraw();
    commit('Bring to front');
  }

  const sendBackBtn = document.getElementById('sendBackBtn');
  if (sendBackBtn) sendBackBtn.addEventListener('click', sendSelectedToBack);
  const bringFrontBtn = document.getElementById('bringFrontBtn');
  if (bringFrontBtn) bringFrontBtn.addEventListener('click', bringSelectedToFront);

  function applyStyleToSelection() {
    if (selectedIds.size === 0) return;
    for (const el of elements) {
      if (selectedIds.has(el.id)) {
        el.strokeColor = style.strokeColor;
        el.fillColor = style.fillColor;
        el.strokeWidth = style.strokeWidth;
        el.strokeStyle = style.strokeStyle;
        el.fillStyle = style.fillStyle;
        el.roughness = style.roughness;
        if (el.type === 'text') {
          el.fontFamily = style.fontFamily;
        }
        if (el.type === 'draw') {
          el.brushType = style.brushType;
        }
        if (el.type === 'arrow') {
          el.arrowhead = style.arrowhead;
        }
      }
    }
    redraw();
    commit('Style change');
  }

  function updateStylePanelFromSelection() {
    if (selectedIds.size === 1) {
      const id = [...selectedIds][0];
      const el = elements.find(e => e.id === id);
      if (el) {
        style.strokeColor = el.strokeColor;
        document.getElementById('strokeColor').value = el.strokeColor.startsWith('#') ? el.strokeColor : '#ffffff';
        updateColorPaletteActive('stroke-palette', el.strokeColor);

        style.fillColor = el.fillColor || 'transparent';
        document.getElementById('fillColor').value = el.fillColor.startsWith('#') ? el.fillColor : '#000000';
        updateColorPaletteActive('fill-palette', el.fillColor || 'transparent');

        style.strokeWidth = el.strokeWidth || 2;
        updateToggleGroupActive('stroke-width-group', String(style.strokeWidth));

        style.strokeStyle = el.strokeStyle || 'solid';
        updateToggleGroupActive('stroke-style-group', style.strokeStyle);

        style.fillStyle = el.fillStyle || 'hachure';
        updateToggleGroupActive('fill-style-group', style.fillStyle);

        style.roughness = typeof el.roughness === 'number' ? el.roughness : 1.5;
        updateToggleGroupActive('sloppiness-group', String(style.roughness));

        if (el.type === 'text') {
          style.fontFamily = el.fontFamily || 'handwritten';
          updateToggleGroupActive('font-family-group', style.fontFamily);
          document.querySelector('.font-section').style.display = 'block';
        } else {
          document.querySelector('.font-section').style.display = 'none';
        }

        if (el.type === 'arrow') {
          style.arrowhead = el.arrowhead || 'arrow';
          updateToggleGroupActive('arrowhead-group', style.arrowhead);
          const arrowheadSec = document.querySelector('.arrowhead-section');
          if (arrowheadSec) arrowheadSec.style.display = 'block';
        } else {
          const arrowheadSec = document.querySelector('.arrowhead-section');
          if (arrowheadSec) arrowheadSec.style.display = 'none';
        }

        const brushSec = document.querySelector('.brush-section');
        if (brushSec) {
          if (el.type === 'draw') {
            style.brushType = el.brushType || 'pencil';
            updateToggleGroupActive('brush-type-group', style.brushType);
            brushSec.style.display = 'block';
          } else {
            brushSec.style.display = 'none';
          }
        }
      }
    } else if (selectedIds.size > 1) {
      const hasText = [...selectedIds].some(id => {
        const el = elements.find(e => e.id === id);
        return el && el.type === 'text';
      });
      document.querySelector('.font-section').style.display = hasText ? 'block' : 'none';

      const hasArrow = [...selectedIds].some(id => {
        const el = elements.find(e => e.id === id);
        return el && el.type === 'arrow';
      });
      const arrowheadSec = document.querySelector('.arrowhead-section');
      if (arrowheadSec) arrowheadSec.style.display = hasArrow ? 'block' : 'none';

      const hasDraw = [...selectedIds].some(id => {
        const el = elements.find(e => e.id === id);
        return el && el.type === 'draw';
      });
      const brushSec = document.querySelector('.brush-section');
      if (brushSec) brushSec.style.display = hasDraw ? 'block' : 'none';
    } else {
      document.querySelector('.font-section').style.display = tool === 'text' ? 'block' : 'none';
      const arrowheadSec = document.querySelector('.arrowhead-section');
      if (arrowheadSec) arrowheadSec.style.display = tool === 'arrow' ? 'block' : 'none';
      const brushSec = document.querySelector('.brush-section');
      if (brushSec) brushSec.style.display = tool === 'draw' ? 'block' : 'none';
    }
  }

  function updateColorPaletteActive(paletteId, value) {
    const palette = document.getElementById(paletteId);
    if (!palette) return;
    const swatches = palette.querySelectorAll('.color-swatch');
    swatches.forEach(swatch => {
      const match = swatch.dataset.color === value;
      swatch.classList.toggle('active', match);
      if (match) {
        swatch.style.borderColor = 'var(--text-primary)';
      } else {
        swatch.style.borderColor = 'transparent';
      }
    });
  }

  function updateToggleGroupActive(groupId, value) {
    const group = document.getElementById(groupId);
    if (!group) return;
    const buttons = group.querySelectorAll('.toggle-btn');
    buttons.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.val === value);
    });
  }

  function deleteSelected() {
    if (selectedIds.size === 0) return;
    elements = elements.filter(el => !selectedIds.has(el.id));
    selectedIds.clear();
    updateStylePanelFromSelection();
    commit('Delete');
  }

  // ---------- Keyboard shortcuts ----------
  const KEY_TOOL = { v: 'selection', r: 'rectangle', o: 'ellipse', d: 'diamond', a: 'arrow', l: 'line', p: 'draw', t: 'text', e: 'eraser', i: 'image' };
  window.addEventListener('keydown', (e) => {
    if (document.activeElement === textInput) return;
    if (e.key === ' ') { spaceDown = true; canvas.style.cursor = 'grab'; return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { deleteSelected(); return; }
    if (e.key === 'Escape') { selectedIds.clear(); setTool('selection'); updateStylePanelFromSelection(); return; }

    // Ctrl/Meta shortcuts
    if (e.ctrlKey || e.metaKey) {
      if (e.key === '=' || e.key === '+') { e.preventDefault(); zoomIn(); return; }
      if (e.key === '-') { e.preventDefault(); zoomOut(); return; }
      if (e.key === '0') { e.preventDefault(); resetZoom(); return; }
      if (e.key === 'a' || e.key === 'A') {
        e.preventDefault();
        selectedIds = new Set(elements.map(el => el.id));
        updateStylePanelFromSelection();
        redraw();
        return;
      }
      if (e.key === '[') { e.preventDefault(); sendSelectedToBack(); return; }
      if (e.key === ']') { e.preventDefault(); bringSelectedToFront(); return; }
    }

    if (e.key.toLowerCase() === 'g' && !e.ctrlKey && !e.metaKey) {
      gridEnabled = !gridEnabled;
      const gridBtn = document.getElementById('gridToggleBtn');
      if (gridBtn) gridBtn.classList.toggle('active', gridEnabled);
      redraw();
      return;
    }

    if (e.key.toLowerCase() === 's' && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      toggleStylePanel();
      return;
    }

    const t = KEY_TOOL[e.key.toLowerCase()];
    if (t) setTool(t);
  });
  window.addEventListener('keyup', (e) => {
    if (e.key === ' ') {
      spaceDown = false;
      canvas.style.cursor = tool === 'selection' ? 'default' : (tool === 'eraser' ? eraserCursor : 'crosshair');
    }
  });

  // ---------- Pointer interaction ----------
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('dblclick', onDoubleClick);

  function onWheel(e) {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const before = screenToWorld(mx, my);
      const factor = Math.exp(-e.deltaY * 0.001);
      camera.zoom = Math.min(6, Math.max(0.15, camera.zoom * factor));
      const after = screenToWorld(mx, my);
      camera.x += (after.x - before.x) * camera.zoom;
      camera.y += (after.y - before.y) * camera.zoom;
      updateZoomDisplay();
      redraw();
    } else {
      camera.x -= e.deltaX;
      camera.y -= e.deltaY;
      redraw();
    }
  }

  function resizeHandleAt(px, py) {
    if (selectedIds.size !== 1) return null;
    const box = selectionBoundingBox();
    if (!box) return null;
    const pad = (12 / camera.zoom) + (box.w + box.h) * 0.015;
    const handles = handlePositions(box, pad);
    const tolerance = 8 / camera.zoom;
    for (const [name, pos] of Object.entries(handles)) {
      if (Math.hypot(px - pos.x, py - pos.y) <= tolerance) return name;
    }
    return null;
  }

  function commitTextEditIfAny() {
    if (textInput.style.display !== 'none') {
      finishTextEditing();
    }
  }

  function onPointerDown(e) {
    // Prevent default browser behavior (e.g. text selection, focus loss)
    e.preventDefault();

    canvas.setPointerCapture(e.pointerId);
    const p = getCanvasPoint(e);
    commitTextEditIfAny();

    if (spaceDown || e.button === 1) {
      dragMode = 'pan';
      dragStart = { x: e.clientX, y: e.clientY, camX: camera.x, camY: camera.y };
      canvas.style.cursor = 'grabbing';
      return;
    }

    if (tool === 'selection') {
      const handle = resizeHandleAt(p.x, p.y);
      if (handle) {
        dragMode = 'resize';
        dragHandle = handle;
        dragStart = p;
        elementsSnapshotForDrag = clone(elements);
        return;
      }
      const hit = hitTest(p.x, p.y);
      if (hit) {
        if (!selectedIds.has(hit.id)) {
          if (!e.shiftKey) selectedIds.clear();
          selectedIds.add(hit.id);
        } else if (e.shiftKey) {
          selectedIds.delete(hit.id);
        }
        dragMode = 'move';
        dragStart = p;
        elementsSnapshotForDrag = clone(elements);
      } else {
        if (!e.shiftKey) selectedIds.clear();
        dragMode = 'marquee';
        marquee = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
      }
      updateStylePanelFromSelection();
      redraw();
      return;
    }

    if (tool === 'eraser') {
      dragMode = 'erase';
      eraseAt(p.x, p.y);
      return;
    }

    if (tool === 'text') {
      startTextInput(p);
      return;
    }

    if (tool === 'image') {
      imagePlacementPoint = p;
      const loader = document.getElementById('imageLoader');
      if (loader) loader.click();
      return;
    }

    const base = {
      id: uid(),
      type: tool,
      x: p.x, y: p.y, width: 0, height: 0,
      strokeColor: style.strokeColor,
      fillColor: style.fillColor,
      strokeWidth: style.strokeWidth,
      strokeStyle: style.strokeStyle,
      fillStyle: style.fillStyle,
      roughness: style.roughness,
      seed: seedFor()
    };
    if (tool === 'draw') {
      base.points = [{ x: 0, y: 0 }];
      base.brushType = style.brushType || 'pencil';
    }
    if (tool === 'arrow') {
      base.arrowhead = style.arrowhead || 'arrow';
    }
    draft = base;
    dragMode = 'draft';
    dragStart = p;
  }

  function onPointerMove(e) {
    const p = getCanvasPoint(e);

    if (dragMode === 'pan') {
      camera.x = dragStart.camX + (e.clientX - dragStart.x);
      camera.y = dragStart.camY + (e.clientY - dragStart.y);
      redraw();
      return;
    }

    if (dragMode === 'draft' && draft) {
      if (draft.type === 'draw') {
        draft.points.push({ x: p.x - draft.x, y: p.y - draft.y });
      } else {
        draft.width = p.x - draft.x;
        draft.height = p.y - draft.y;
      }
      redraw();
      return;
    }

    if (dragMode === 'marquee' && marquee) {
      marquee.x1 = p.x; marquee.y1 = p.y;
      const mBox = { x: Math.min(marquee.x0, marquee.x1), y: Math.min(marquee.y0, marquee.y1), w: Math.abs(marquee.x1 - marquee.x0), h: Math.abs(marquee.y1 - marquee.y0) };
      selectedIds = new Set(elements.filter(el => rectsIntersect(mBox, boundingBoxOf(el))).map(el => el.id));
      updateStylePanelFromSelection();
      redraw();
      return;
    }

    if (dragMode === 'move') {
      const dx = p.x - dragStart.x, dy = p.y - dragStart.y;
      activeGuides = [];
      if (selectedIds.size === 1) {
        const id = [...selectedIds][0];
        const el = elements.find(e => e.id === id);
        const orig = elementsSnapshotForDrag.find(o => o.id === id);
        if (el && orig) {
          let targetX = orig.x + dx;
          let targetY = orig.y + dy;
          const targetW = el.width;
          const targetH = el.height;
          const snapThreshold = 8 / camera.zoom;

          for (const other of elements) {
            if (selectedIds.has(other.id) || other.type === 'draw') continue;
            const otherBox = boundingBoxOf(other);
            const selfBox = { x: targetX, y: targetY, w: Math.abs(targetW), h: Math.abs(targetH) };

            // Snap X (Vertical guides)
            if (Math.abs(selfBox.x - otherBox.x) < snapThreshold) {
              targetX = otherBox.x;
              activeGuides.push({ type: 'v', x: otherBox.x });
            } else if (Math.abs((selfBox.x + selfBox.w / 2) - (otherBox.x + otherBox.w / 2)) < snapThreshold) {
              targetX = otherBox.x + otherBox.w / 2 - selfBox.w / 2;
              activeGuides.push({ type: 'v', x: otherBox.x + otherBox.w / 2 });
            } else if (Math.abs((selfBox.x + selfBox.w) - (otherBox.x + otherBox.w)) < snapThreshold) {
              targetX = otherBox.x + otherBox.w - selfBox.w;
              activeGuides.push({ type: 'v', x: otherBox.x + otherBox.w });
            }

            // Snap Y (Horizontal guides)
            if (Math.abs(selfBox.y - otherBox.y) < snapThreshold) {
              targetY = otherBox.y;
              activeGuides.push({ type: 'h', y: otherBox.y });
            } else if (Math.abs((selfBox.y + selfBox.h / 2) - (otherBox.y + otherBox.h / 2)) < snapThreshold) {
              targetY = otherBox.y + otherBox.h / 2 - selfBox.h / 2;
              activeGuides.push({ type: 'h', y: otherBox.y + otherBox.h / 2 });
            } else if (Math.abs((selfBox.y + selfBox.h) - (otherBox.y + otherBox.h)) < snapThreshold) {
              targetY = otherBox.y + otherBox.h - selfBox.h;
              activeGuides.push({ type: 'h', y: otherBox.y + otherBox.h });
            }
          }
          el.x = targetX;
          el.y = targetY;
        }
      } else {
        for (const el of elements) {
          if (!selectedIds.has(el.id)) continue;
          const orig = elementsSnapshotForDrag.find(o => o.id === el.id);
          el.x = orig.x + dx;
          el.y = orig.y + dy;
        }
      }
      redraw();
      return;
    }

    if (dragMode === 'resize') {
      resizeSelected(p);
      redraw();
      return;
    }

    if (dragMode === 'erase') {
      eraseAt(p.x, p.y);
      return;
    }

    if (tool === 'selection') {
      const handle = resizeHandleAt(p.x, p.y);
      canvas.style.cursor = handle ? cursorForHandle(handle) : (hitTest(p.x, p.y) ? 'move' : 'default');
    }
  }

  function cursorForHandle(h) {
    const map = { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize' };
    return map[h] || 'default';
  }

  function resizeSelected(p) {
    const id = [...selectedIds][0];
    const el = elements.find(e => e.id === id);
    const orig = elementsSnapshotForDrag.find(o => o.id === id);
    if (!el || !orig) return;
    const b = { x: orig.x, y: orig.y, w: orig.width, h: orig.height };
    let x = b.x, y = b.y, w = b.w, h = b.h;
    const dx = p.x - dragStart.x, dy = p.y - dragStart.y;

    if (dragHandle.includes('e')) w = b.w + dx;
    if (dragHandle.includes('s')) h = b.h + dy;
    if (dragHandle.includes('w')) { x = b.x + dx; w = b.w - dx; }
    if (dragHandle.includes('n')) { y = b.y + dy; h = b.h - dy; }

    el.x = x; el.y = y; el.width = w; el.height = h;
    if (el.type === 'text') {
      el.fontSize = Math.max(8, orig.fontSize * (Math.abs(w) / Math.max(1, Math.abs(b.w))));
    }
  }

  function eraseAt(x, y) {
    const hit = hitTest(x, y);
    if (hit) {
      elements = elements.filter(el => el.id !== hit.id);
      redraw();
    }
  }

  function onPointerUp(e) {
    if (dragMode === 'draft' && draft) {
      const tiny = draft.type === 'draw' ? draft.points.length < 2 : (Math.abs(draft.width) < 2 && Math.abs(draft.height) < 2);
      if (!tiny) {
        elements.push(draft);
        selectedIds = new Set([draft.id]);
        updateStylePanelFromSelection();
        commit('Draw ' + draft.type);
      }
      draft = null;
      setTool('selection');
    } else if (dragMode === 'move') {
      commit('Move');
    } else if (dragMode === 'resize') {
      commit('Resize');
    } else if (dragMode === 'erase') {
      commit('Erase');
    } else if (dragMode === 'marquee') {
      redraw();
    }

    dragMode = null;
    dragStart = null;
    dragHandle = null;
    marquee = null;
    elementsSnapshotForDrag = null;
    activeGuides = [];
    canvas.style.cursor = spaceDown ? 'grab' : (tool === 'selection' ? 'default' : (tool === 'eraser' ? eraserCursor : 'crosshair'));
  }

  // ---------- Text tool ----------
  function startTextInput(p) {
    const screenX = p.x * camera.zoom + camera.x;
    const screenY = p.y * camera.zoom + camera.y;
    textInput.style.left = screenX + 'px';
    textInput.style.top = screenY + 'px';
    textInput.style.display = 'block';
    textInput.style.fontSize = (20 * camera.zoom) + 'px';
    textInput.style.color = style.strokeColor;

    let fontStr = 'sans-serif';
    if (style.fontFamily === 'handwritten') {
      fontStr = '"Segoe Print", "Comic Sans MS", cursive, sans-serif';
    } else if (style.fontFamily === 'monospace') {
      fontStr = '"Courier New", Courier, monospace';
    }
    textInput.style.fontFamily = fontStr;

    textInput.value = '';
    textInput.dataset.worldX = p.x;
    textInput.dataset.worldY = p.y;
    textInput.dataset.editElId = '';

    autoResizeTextInput();

    // Defer focus slightly to ensure smooth activation
    textInput.focus();
    setTimeout(() => textInput.focus(), 0);
  }

  function startTextEditing(el) {
    textInput.dataset.editElId = el.id;
    textInput.value = el.text;

    const screenX = el.x * camera.zoom + camera.x;
    const screenY = el.y * camera.zoom + camera.y;
    textInput.style.left = screenX + 'px';
    textInput.style.top = screenY + 'px';
    textInput.style.display = 'block';
    textInput.style.fontSize = (20 * camera.zoom) + 'px';
    textInput.style.color = el.strokeColor;

    let fontStr = 'sans-serif';
    if (el.fontFamily === 'handwritten') {
      fontStr = '"Segoe Print", "Comic Sans MS", cursive, sans-serif';
    } else if (el.fontFamily === 'monospace') {
      fontStr = '"Courier New", Courier, monospace';
    }
    textInput.style.fontFamily = fontStr;

    autoResizeTextInput();

    el.editing = true;
    redraw();

    textInput.focus();
    setTimeout(() => textInput.focus(), 0);
  }

  function onDoubleClick(e) {
    const p = getCanvasPoint(e);
    const hit = hitTest(p.x, p.y);
    if (hit && hit.type === 'text') {
      startTextEditing(hit);
    }
  }

  textInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      const editId = textInput.dataset.editElId;
      if (editId) {
        const el = elements.find(e => e.id === editId);
        if (el) el.editing = false;
      }
      textInput.value = '';
      finishTextEditing();
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); finishTextEditing(); }
  });
  textInput.addEventListener('blur', finishTextEditing);
  textInput.addEventListener('input', autoResizeTextInput);

  function autoResizeTextInput() {
    textInput.style.width = 'auto';
    textInput.style.height = 'auto';
    textInput.style.width = (textInput.scrollWidth + 10) + 'px';
    textInput.style.height = textInput.scrollHeight + 'px';
  }

  function finishTextEditing() {
    if (textInput.style.display === 'none') return;
    const text = textInput.value;
    const editId = textInput.dataset.editElId;
    textInput.style.display = 'none';
    textInput.value = '';

    if (editId) {
      const el = elements.find(e => e.id === editId);
      if (el) {
        el.editing = false;
        if (text.trim().length > 0) {
          el.text = text;
          let fontStr = 'sans-serif';
          if (el.fontFamily === 'handwritten') {
            fontStr = '"Segoe Print", "Comic Sans MS", cursive, sans-serif';
          } else if (el.fontFamily === 'monospace') {
            fontStr = '"Courier New", Courier, monospace';
          }
          ctx.font = `20px ${fontStr}`;
          const lines = text.split('\n');
          el.width = Math.max(...lines.map(l => ctx.measureText(l).width), 20);
          el.height = lines.length * 20 * 1.25;
          commit('Edit text');
        } else {
          elements = elements.filter(e => e.id !== editId);
          selectedIds.delete(editId);
          commit('Delete text');
        }
      }
      textInput.dataset.editElId = '';
    } else {
      const worldX = Number(textInput.dataset.worldX);
      const worldY = Number(textInput.dataset.worldY);
      if (text.trim().length > 0) {
        let fontStr = 'sans-serif';
        if (style.fontFamily === 'handwritten') {
          fontStr = '"Segoe Print", "Comic Sans MS", cursive, sans-serif';
        } else if (style.fontFamily === 'monospace') {
          fontStr = '"Courier New", Courier, monospace';
        }
        ctx.font = `20px ${fontStr}`;
        const lines = text.split('\n');
        const width = Math.max(...lines.map(l => ctx.measureText(l).width), 20);
        const height = lines.length * 20 * 1.25;
        const el = {
          id: uid(), type: 'text', x: worldX, y: worldY,
          width, height, text, fontSize: 20,
          fontFamily: style.fontFamily,
          strokeColor: style.strokeColor, fillColor: 'transparent', strokeWidth: style.strokeWidth, seed: seedFor()
        };
        elements.push(el);
        selectedIds = new Set([el.id]);
        updateStylePanelFromSelection();
        commit('Add text');
      }
    }
    setTool('selection');
  }

  // ---------- Zoom Controls ----------
  function zoomIn() {
    const center = { x: canvas.width / 2 / (window.devicePixelRatio || 1), y: canvas.height / 2 / (window.devicePixelRatio || 1) };
    const before = screenToWorld(center.x, center.y);
    camera.zoom = Math.min(6, camera.zoom + 0.1);
    const after = screenToWorld(center.x, center.y);
    camera.x += (after.x - before.x) * camera.zoom;
    camera.y += (after.y - before.y) * camera.zoom;
    updateZoomDisplay();
    redraw();
  }

  function zoomOut() {
    const center = { x: canvas.width / 2 / (window.devicePixelRatio || 1), y: canvas.height / 2 / (window.devicePixelRatio || 1) };
    const before = screenToWorld(center.x, center.y);
    camera.zoom = Math.max(0.15, camera.zoom - 0.1);
    const after = screenToWorld(center.x, center.y);
    camera.x += (after.x - before.x) * camera.zoom;
    camera.y += (after.y - before.y) * camera.zoom;
    updateZoomDisplay();
    redraw();
  }

  function resetZoom() {
    camera.zoom = 1;
    camera.x = 0;
    camera.y = 0;
    updateZoomDisplay();
    redraw();
  }

  function updateZoomDisplay() {
    const val = Math.round(camera.zoom * 100) + '%';
    document.getElementById('zoomVal').innerText = val;
  }

  document.getElementById('zoomInBtn').addEventListener('click', zoomIn);
  document.getElementById('zoomOutBtn').addEventListener('click', zoomOut);
  document.getElementById('zoomVal').addEventListener('click', resetZoom);

  document.getElementById('gridToggleBtn').addEventListener('click', () => {
    gridEnabled = !gridEnabled;
    document.getElementById('gridToggleBtn').classList.toggle('active', gridEnabled);
    redraw();
  });

  document.getElementById('clearAllBtn').addEventListener('click', () => {
    vscode.postMessage({ type: 'requestClearAll' });
  });

  // ---------- Export ----------
  function computeContentBox() {
    const w = canvas.width / (window.devicePixelRatio || 1);
    const h = canvas.height / (window.devicePixelRatio || 1);
    const visibleTopLeft = screenToWorld(0, 0);
    const visibleBottomRight = screenToWorld(w, h);

    let minX = visibleTopLeft.x;
    let minY = visibleTopLeft.y;
    let maxX = visibleBottomRight.x;
    let maxY = visibleBottomRight.y;

    for (const el of elements) {
      const b = boundingBoxOf(el);
      minX = Math.min(minX, b.x);
      minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.w);
      maxY = Math.max(maxY, b.y + b.h);
    }
    const pad = 24;
    return { x: minX - pad, y: minY - pad, w: (maxX - minX) + pad * 2, h: (maxY - minY) + pad * 2 };
  }

  function exportPng(purpose, targetUri) {
    const box = computeContentBox();
    const off = document.createElement('canvas');
    const scale = 2;
    off.width = Math.max(1, Math.ceil(box.w * scale));
    off.height = Math.max(1, Math.ceil(box.h * scale));
    const offCtx = off.getContext('2d');
    offCtx.fillStyle = getComputedStyle(document.body).backgroundColor || '#121214';
    offCtx.fillRect(0, 0, off.width, off.height);
    offCtx.scale(scale, scale);
    offCtx.translate(-box.x, -box.y);
    const offRc = rough.canvas(off);
    for (const el of elements) drawElementWith(offCtx, offRc, el);
    const data = off.toDataURL('image/png');
    vscode.postMessage({ type: 'exportResult', body: { format: 'png', data, purpose, targetUri } });
  }

  function drawElementWith(dCtx, dRc, el) {
    const opts = roughOptions(el);
    switch (el.type) {
      case 'rectangle': { const b = normRect(el); dRc.rectangle(b.x, b.y, b.w, b.h, opts); break; }
      case 'ellipse': { const b = normRect(el); dRc.ellipse(b.x + b.w / 2, b.y + b.h / 2, b.w, b.h, opts); break; }
      case 'diamond': {
        const b = normRect(el);
        const pts = [[b.x + b.w / 2, b.y], [b.x + b.w, b.y + b.h / 2], [b.x + b.w / 2, b.y + b.h], [b.x, b.y + b.h / 2]];
        dRc.polygon(pts, opts);
        break;
      }
      case 'line': { dRc.line(el.x, el.y, el.x + el.width, el.y + el.height, opts); break; }
      case 'arrow': {
        const x1 = el.x, y1 = el.y, x2 = el.x + el.width, y2 = el.y + el.height;
        dRc.line(x1, y1, x2, y2, opts);
        const angle = Math.atan2(y2 - y1, x2 - x1);
        const headLen = 12 + el.strokeWidth * 2;
        const headStyle = el.arrowhead || 'arrow';

        if (headStyle === 'arrow') {
          const a1 = angle + Math.PI - 0.4, a2 = angle + Math.PI + 0.4;
          dRc.line(x2, y2, x2 + headLen * Math.cos(a1), y2 + headLen * Math.sin(a1), opts);
          dRc.line(x2, y2, x2 + headLen * Math.cos(a2), y2 + headLen * Math.sin(a2), opts);
        } else if (headStyle === 'bar') {
          const perpAngle = angle + Math.PI / 2;
          const halfBar = headLen * 0.7;
          const bx1 = x2 + halfBar * Math.cos(perpAngle);
          const by1 = y2 + halfBar * Math.sin(perpAngle);
          const bx2 = x2 - halfBar * Math.cos(perpAngle);
          const by2 = y2 - halfBar * Math.sin(perpAngle);
          dRc.line(bx1, by1, bx2, by2, opts);
        } else if (headStyle === 'dot') {
          const r = 5 + el.strokeWidth;
          const cx = x2 - r * Math.cos(angle);
          const cy = y2 - r * Math.sin(angle);
          dRc.ellipse(cx, cy, r * 2, r * 2, { ...opts, fill: el.strokeColor, fillStyle: 'solid' });
        } else if (headStyle === 'triangle') {
          const a1 = angle + Math.PI - 0.4, a2 = angle + Math.PI + 0.4;
          const tx1 = x2 + headLen * Math.cos(a1);
          const ty1 = y2 + headLen * Math.sin(a1);
          const tx2 = x2 + headLen * Math.cos(a2);
          const ty2 = y2 + headLen * Math.sin(a2);
          dRc.polygon([[x2, y2], [tx1, ty1], [tx2, ty2]], { ...opts, fill: el.strokeColor, fillStyle: 'solid' });
        }
        break;
      }
      case 'draw': {
        const pts = el.points.map(p => [el.x + p.x, el.y + p.y]);
        if (pts.length > 1) dRc.curve(pts, { ...opts, fill: undefined });
        break;
      }
      case 'text': {
        dCtx.save();
        dCtx.fillStyle = el.strokeColor;
        let fontStr = 'sans-serif';
        if (el.fontFamily === 'handwritten' || !el.fontFamily) {
          fontStr = '"Segoe Print", "Comic Sans MS", cursive, sans-serif';
        } else if (el.fontFamily === 'monospace') {
          fontStr = '"Courier New", Courier, monospace';
        }
        dCtx.font = `${el.fontSize}px ${fontStr}`;
        dCtx.textBaseline = 'top';
        el.text.split('\n').forEach((line, i) => dCtx.fillText(line, el.x, el.y + i * el.fontSize * 1.25));
        dCtx.restore();
        break;
      }
    }
  }

  function exportSvg(purpose, targetUri) {
    const box = computeContentBox();
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('xmlns', svgNS);
    svg.setAttribute('width', String(Math.ceil(box.w)));
    svg.setAttribute('height', String(Math.ceil(box.h)));
    svg.setAttribute('viewBox', `${box.x} ${box.y} ${box.w} ${box.h}`);
    const bg = document.createElementNS(svgNS, 'rect');
    bg.setAttribute('x', String(box.x)); bg.setAttribute('y', String(box.y));
    bg.setAttribute('width', String(box.w)); bg.setAttribute('height', String(box.h));
    bg.setAttribute('fill', getComputedStyle(document.body).backgroundColor || '#121214');
    svg.appendChild(bg);

    const rsvg = rough.svg(svg);
    for (const el of elements) {
      const opts = roughOptions(el);
      let node = null;
      switch (el.type) {
        case 'rectangle': { const b = normRect(el); node = rsvg.rectangle(b.x, b.y, b.w, b.h, opts); break; }
        case 'ellipse': { const b = normRect(el); node = rsvg.ellipse(b.x + b.w / 2, b.y + b.h / 2, b.w, b.h, opts); break; }
        case 'diamond': {
          const b = normRect(el);
          const pts = [[b.x + b.w / 2, b.y], [b.x + b.w, b.y + b.h / 2], [b.x + b.w / 2, b.y + b.h], [b.x, b.y + b.h / 2]];
          node = rsvg.polygon(pts, opts);
          break;
        }
        case 'line': { node = rsvg.line(el.x, el.y, el.x + el.width, el.y + el.height, opts); break; }
        case 'arrow': {
          const g = document.createElementNS(svgNS, 'g');
          const x1 = el.x, y1 = el.y, x2 = el.x + el.width, y2 = el.y + el.height;
          g.appendChild(rsvg.line(x1, y1, x2, y2, opts));
          const angle = Math.atan2(y2 - y1, x2 - x1);
          const headLen = 12 + el.strokeWidth * 2;
          const headStyle = el.arrowhead || 'arrow';

          if (headStyle === 'arrow') {
            const a1 = angle + Math.PI - 0.4, a2 = angle + Math.PI + 0.4;
            g.appendChild(rsvg.line(x2, y2, x2 + headLen * Math.cos(a1), y2 + headLen * Math.sin(a1), opts));
            g.appendChild(rsvg.line(x2, y2, x2 + headLen * Math.cos(a2), y2 + headLen * Math.sin(a2), opts));
          } else if (headStyle === 'bar') {
            const perpAngle = angle + Math.PI / 2;
            const halfBar = headLen * 0.7;
            const bx1 = x2 + halfBar * Math.cos(perpAngle);
            const by1 = y2 + halfBar * Math.sin(perpAngle);
            const bx2 = x2 - halfBar * Math.cos(perpAngle);
            const by2 = y2 - halfBar * Math.sin(perpAngle);
            g.appendChild(rsvg.line(bx1, by1, bx2, by2, opts));
          } else if (headStyle === 'dot') {
            const r = 5 + el.strokeWidth;
            const cx = x2 - r * Math.cos(angle);
            const cy = y2 - r * Math.sin(angle);
            g.appendChild(rsvg.ellipse(cx, cy, r * 2, r * 2, { ...opts, fill: el.strokeColor, fillStyle: 'solid' }));
          } else if (headStyle === 'triangle') {
            const a1 = angle + Math.PI - 0.4, a2 = angle + Math.PI + 0.4;
            const tx1 = x2 + headLen * Math.cos(a1);
            const ty1 = y2 + headLen * Math.sin(a1);
            const tx2 = x2 + headLen * Math.cos(a2);
            const ty2 = y2 + headLen * Math.sin(a2);
            g.appendChild(rsvg.polygon([[x2, y2], [tx1, ty1], [tx2, ty2]], { ...opts, fill: el.strokeColor, fillStyle: 'solid' }));
          }
          node = g;
          break;
        }
        case 'draw': {
          const pts = el.points.map(p => [el.x + p.x, el.y + p.y]);
          if (pts.length > 1) node = rsvg.curve(pts, { ...opts, fill: undefined });
          break;
        }
        case 'text': {
          node = document.createElementNS(svgNS, 'text');
          node.setAttribute('x', String(el.x));
          node.setAttribute('y', String(el.y + el.fontSize));
          node.setAttribute('fill', el.strokeColor);
          node.setAttribute('font-size', String(el.fontSize));
          let fontStr = "sans-serif";
          if (el.fontFamily === 'handwritten' || !el.fontFamily) {
            fontStr = "'Segoe Print','Comic Sans MS',cursive,sans-serif";
          } else if (el.fontFamily === 'monospace') {
            fontStr = "'Courier New',Courier,monospace";
          }
          node.setAttribute('font-family', fontStr);
          node.textContent = el.text;
          break;
        }
        case 'image': {
          node = document.createElementNS(svgNS, 'image');
          node.setAttribute('x', String(el.x));
          node.setAttribute('y', String(el.y));
          node.setAttribute('width', String(el.width));
          node.setAttribute('height', String(el.height));
          node.setAttribute('href', el.src);
          break;
        }
      }
      if (node) svg.appendChild(node);
    }

    const serializer = new XMLSerializer();
    const data = serializer.serializeToString(svg);
    vscode.postMessage({ type: 'exportResult', body: { format: 'svg', data, purpose, targetUri } });
  }

  // ---------- Message handling from extension ----------
  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'init': {
        elements = msg.body.elements || [];
        if (msg.body.appState && msg.body.appState.camera) {
          Object.assign(camera, msg.body.appState.camera);
          updateZoomDisplay();
        }
        updateStylePanelFromSelection();
        redraw();
        break;
      }
      case 'sceneUpdate': {
        elements = msg.body.elements || [];
        selectedIds.clear();
        updateStylePanelFromSelection();
        redraw();
        break;
      }
      case 'requestExport': {
        if (msg.body.format === 'png') exportPng(msg.body.purpose, msg.body.targetUri);
        else exportSvg(msg.body.purpose, msg.body.targetUri);
        break;
      }
      case 'clearAll': {
        elements = [];
        selectedIds.clear();
        updateStylePanelFromSelection();
        commit('Clear all');
        break;
      }
    }
  });

  // ---------- Init ----------
  resizeCanvas();
  vscode.postMessage({ type: 'ready' });
})();
