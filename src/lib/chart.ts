/**
 * Minimal editorial SVG line chart.
 *
 * - Multiple series with different colors
 * - Auto y-axis with "nice" rounded ticks
 * - Sparse x ticks aware of time spans (hours / days)
 * - Crosshair + tooltip on hover (single mousemove listener per chart)
 * - Pure DOM, no deps. Bundled into the inline LiveData script.
 */

export interface Series {
  label: string;
  color: string;
  /** [epochSeconds, value] tuples, sorted by x ascending. */
  data: [number, number][];
  /** Render an area fill below the line. */
  fill?: boolean;
  /** Stroke style: solid (default), dashed. */
  dashed?: boolean;
}

export interface ChartOpts {
  width?: number;
  height?: number;
  yMin?: number;
  yMax?: number;
  yMinForceZero?: boolean;
  yFormat?: (v: number) => string;
  xFormat?: (v: number) => string;
  yLabel?: string;
  padding?: { top: number; right: number; bottom: number; left: number };
}

const DEFAULT_PADDING = { top: 14, right: 18, bottom: 24, left: 44 };

function niceNum(range: number): number {
  if (range <= 0) return 1;
  const exp = Math.floor(Math.log10(range));
  const frac = range / Math.pow(10, exp);
  let nf: number;
  if (frac < 1.5) nf = 1;
  else if (frac < 3) nf = 2;
  else if (frac < 7) nf = 5;
  else nf = 10;
  return nf * Math.pow(10, exp);
}

function niceScale(min: number, max: number, count = 5) {
  if (max === min) { max = min + 1; }
  const step = niceNum((max - min) / count);
  const niceMin = Math.floor(min / step) * step;
  const niceMax = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = niceMin; v <= niceMax + step * 0.5; v += step) {
    ticks.push(Math.round(v / step) * step);
  }
  return { min: niceMin, max: niceMax, ticks };
}

function buildPath(pts: [number, number][], scaleX: (x: number) => number, scaleY: (y: number) => number): string {
  if (!pts.length) return '';
  let d = `M${scaleX(pts[0][0]).toFixed(1)} ${scaleY(pts[0][1]).toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) {
    d += `L${scaleX(pts[i][0]).toFixed(1)} ${scaleY(pts[i][1]).toFixed(1)}`;
  }
  return d;
}

function buildAreaPath(pts: [number, number][], scaleX: (x: number) => number, scaleY: (y: number) => number, baseline: number): string {
  if (!pts.length) return '';
  let d = `M${scaleX(pts[0][0]).toFixed(1)} ${baseline.toFixed(1)}`;
  d += `L${scaleX(pts[0][0]).toFixed(1)} ${scaleY(pts[0][1]).toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) {
    d += `L${scaleX(pts[i][0]).toFixed(1)} ${scaleY(pts[i][1]).toFixed(1)}`;
  }
  d += `L${scaleX(pts[pts.length - 1][0]).toFixed(1)} ${baseline.toFixed(1)} Z`;
  return d;
}

function fmtSI(n: number, digits = 0): string {
  if (Math.abs(n) >= 1000) return (n / 1000).toFixed(1) + 'k';
  return n.toFixed(digits);
}

/** Pick ~5 sparse, well-spaced x ticks. Time-aware: snaps to hour/day boundaries when possible. */
function pickXTicks(xMin: number, xMax: number, target = 5): number[] {
  const span = xMax - xMin;
  const HOUR = 3600, DAY = 86400;
  let step: number;
  if (span <= 6 * HOUR) step = HOUR;
  else if (span <= 36 * HOUR) step = 4 * HOUR;
  else if (span <= 8 * DAY) step = DAY;
  else if (span <= 30 * DAY) step = 7 * DAY;
  else step = 30 * DAY;

  // adjust step so we land near `target` ticks
  while ((span / step) > target * 1.6) step *= 2;
  while ((span / step) < target * 0.6) step /= 2;

  const ticks: number[] = [];
  const start = Math.ceil(xMin / step) * step;
  for (let v = start; v <= xMax; v += step) ticks.push(v);
  return ticks;
}

export class Chart {
  private el: HTMLElement;
  private opts: Required<Pick<ChartOpts, 'width' | 'height'>> & ChartOpts;
  private series: Series[] = [];
  private padding = DEFAULT_PADDING;

  // computed scales
  private xMin = 0; private xMax = 0;
  private yMin = 0; private yMax = 0;
  private plotW = 0; private plotH = 0;

  constructor(el: HTMLElement, opts: ChartOpts = {}) {
    this.el = el;
    this.opts = {
      width: opts.width ?? 600,
      height: opts.height ?? 200,
      ...opts,
    };
    this.padding = { ...DEFAULT_PADDING, ...(opts.padding ?? {}) };

    // Re-render on size change so axis labels & dots stay crisp
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => {
        if (this.series.length) {
          // schedule via rAF so we coalesce rapid resizes
          requestAnimationFrame(() => {
            this.compute();
            this.render();
            this.attachHover();
          });
        }
      });
      ro.observe(el);
    }
  }

  setData(series: Series[]) {
    this.series = series;
    this.compute();
    this.render();
    this.attachHover();
  }

  private compute() {
    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    for (const s of this.series) {
      for (const [x, y] of s.data) {
        if (x < xMin) xMin = x;
        if (x > xMax) xMax = x;
        if (y < yMin) yMin = y;
        if (y > yMax) yMax = y;
      }
    }
    if (!Number.isFinite(xMin)) { xMin = 0; xMax = 1; yMin = 0; yMax = 1; }

    if (this.opts.yMin !== undefined) yMin = this.opts.yMin;
    if (this.opts.yMax !== undefined) yMax = this.opts.yMax;
    if (this.opts.yMinForceZero && yMin > 0) yMin = 0;

    this.xMin = xMin; this.xMax = xMax;
    this.yMin = yMin; this.yMax = yMax;

    // Use the container's actual width so SVG renders at native resolution.
    const cw = this.el.clientWidth || this.el.getBoundingClientRect().width;
    if (cw > 0) this.opts.width = Math.round(cw);

    this.plotW = this.opts.width - this.padding.left - this.padding.right;
    this.plotH = this.opts.height - this.padding.top - this.padding.bottom;
  }

  private scaleX = (x: number) =>
    this.padding.left + ((x - this.xMin) / (this.xMax - this.xMin || 1)) * this.plotW;

  private scaleY = (y: number) =>
    this.padding.top + (1 - (y - this.yMin) / (this.yMax - this.yMin || 1)) * this.plotH;

  private render() {
    const { width, height } = this.opts;
    const yScale = niceScale(this.yMin, this.yMax, 4);
    // Keep configured min/max but use yScale ticks if they fit
    const ticks = yScale.ticks.filter(t => t >= this.yMin - 1e-6 && t <= this.yMax + 1e-6);

    const xTicks = pickXTicks(this.xMin, this.xMax);
    const xFmt = this.opts.xFormat ?? ((x: number) => {
      const d = new Date(x * 1000);
      const span = this.xMax - this.xMin;
      if (span <= 36 * 3600) return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      return `${d.getMonth() + 1}/${d.getDate()}`;
    });
    const yFmt = this.opts.yFormat ?? ((v: number) => fmtSI(v));

    const baseline = this.scaleY(Math.max(0, this.yMin));

    // grid + axis
    let grid = '';
    for (const t of ticks) {
      const y = this.scaleY(t);
      grid += `<line x1="${this.padding.left}" y1="${y.toFixed(1)}" x2="${(width - this.padding.right).toFixed(1)}" y2="${y.toFixed(1)}"/>`;
    }
    let yAxis = '';
    for (const t of ticks) {
      const y = this.scaleY(t);
      yAxis += `<text x="${this.padding.left - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end">${yFmt(t)}</text>`;
    }
    let xAxis = '';
    for (const t of xTicks) {
      const x = this.scaleX(t);
      xAxis += `<text x="${x.toFixed(1)}" y="${(height - this.padding.bottom + 14).toFixed(1)}" text-anchor="middle">${xFmt(t)}</text>`;
    }

    // series paths
    let paths = '';
    for (const s of this.series) {
      if (s.fill) {
        const d = buildAreaPath(s.data, this.scaleX, this.scaleY, baseline);
        paths += `<path d="${d}" class="chart-area" fill="${s.color}"/>`;
      }
      const d = buildPath(s.data, this.scaleX, this.scaleY);
      paths += `<path d="${d}" class="chart-line" stroke="${s.color}"${s.dashed ? ' stroke-dasharray="3 3"' : ''}/>`;
    }

    // legend
    let legend = '';
    if (this.series.length > 1) {
      const items = this.series.map((s, i) => {
        const x = this.padding.left + i * 110;
        return `<g transform="translate(${x.toFixed(1)},${(this.padding.top - 8).toFixed(1)})">
          <line x1="0" y1="0" x2="14" y2="0" stroke="${s.color}" stroke-width="2"/>
          <text x="20" y="3" fill="var(--color-ink-soft)" font-size="10.5">${s.label}</text>
        </g>`;
      }).join('');
      legend = items;
    }

    // hover overlay (transparent) + crosshair (hidden until hover)
    const overlay = `
      <rect class="chart-overlay" x="${this.padding.left}" y="${this.padding.top}"
        width="${this.plotW.toFixed(1)}" height="${this.plotH.toFixed(1)}"
        fill="transparent" pointer-events="all"/>
      <g class="chart-cursor" style="display:none">
        <line class="chart-cursor-line" x1="0" y1="${this.padding.top}" x2="0" y2="${(height - this.padding.bottom).toFixed(1)}"/>
        ${this.series.map((s, i) => `<circle class="chart-cursor-pt-${i}" cx="0" cy="0" r="3.5" stroke="${s.color}"/>`).join('')}
      </g>`;

    this.el.innerHTML = `
      <svg class="chart-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${this.opts.yLabel ?? 'chart'}">
        <g class="chart-grid">${grid}</g>
        <g class="chart-axis">${yAxis}${xAxis}</g>
        ${legend}
        <g class="chart-series">${paths}</g>
        ${overlay}
      </svg>
      <div class="chart-tooltip" style="display:none"></div>`;

    // tooltip styling — inline so it ships with the markup
    const tip = this.el.querySelector<HTMLDivElement>('.chart-tooltip')!;
    Object.assign(tip.style, {
      position: 'absolute', pointerEvents: 'none',
      background: 'white', border: '1px solid var(--color-rule)',
      borderRadius: '6px', padding: '6px 9px',
      fontSize: '11px', lineHeight: '1.45',
      boxShadow: '0 6px 18px -8px rgba(0,0,0,0.18)',
      whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums',
      zIndex: '10', transform: 'translate(-50%, -100%)',
    });
    if (getComputedStyle(this.el).position === 'static') this.el.style.position = 'relative';
  }

  private attachHover() {
    const overlay = this.el.querySelector<SVGRectElement>('.chart-overlay');
    const cursor = this.el.querySelector<SVGGElement>('.chart-cursor');
    const tip = this.el.querySelector<HTMLDivElement>('.chart-tooltip');
    const svg = this.el.querySelector<SVGSVGElement>('svg');
    if (!overlay || !cursor || !tip || !svg) return;

    const yFmt = this.opts.yFormat ?? ((v: number) => fmtSI(v, 1));
    const xFmt = this.opts.xFormat ?? ((x: number) => {
      const d = new Date(x * 1000);
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} ${d.getMonth() + 1}/${d.getDate()}`;
    });

    const onMove = (ev: MouseEvent) => {
      const pt = svg.createSVGPoint();
      pt.x = ev.clientX; pt.y = ev.clientY;
      const ctm = svg.getScreenCTM();
      if (!ctm) return;
      const local = pt.matrixTransform(ctm.inverse());
      // Convert local x to data x
      const xData = this.xMin + ((local.x - this.padding.left) / (this.plotW || 1)) * (this.xMax - this.xMin);

      // Find nearest sample (use first series, all share x roughly)
      const ref = this.series[0]?.data;
      if (!ref || !ref.length) return;
      let lo = 0, hi = ref.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (ref[mid][0] < xData) lo = mid + 1; else hi = mid;
      }
      const idx = lo;

      const cx = this.scaleX(ref[idx][0]);
      cursor.setAttribute('style', 'display:block');
      const lineEl = cursor.querySelector('line');
      lineEl?.setAttribute('x1', cx.toFixed(1));
      lineEl?.setAttribute('x2', cx.toFixed(1));

      // place dots
      const tipLines: string[] = [`<div style="font-weight:600;color:var(--color-ink);margin-bottom:4px">${xFmt(ref[idx][0])}</div>`];
      this.series.forEach((s, i) => {
        const sample = s.data[Math.min(idx, s.data.length - 1)];
        if (!sample) return;
        const cy = this.scaleY(sample[1]);
        const c = cursor.querySelector(`.chart-cursor-pt-${i}`);
        c?.setAttribute('cx', cx.toFixed(1));
        c?.setAttribute('cy', cy.toFixed(1));
        tipLines.push(
          `<div><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${s.color};margin-right:6px;vertical-align:middle"></span>${s.label}: <strong>${yFmt(sample[1])}</strong></div>`,
        );
      });

      tip.innerHTML = tipLines.join('');
      tip.style.display = 'block';
      // position: relative to chart container, in viewBox coords scaled to actual size
      const elRect = this.el.getBoundingClientRect();
      const svgRect = svg.getBoundingClientRect();
      const scaleX = svgRect.width / this.opts.width;
      const scaleY = svgRect.height / this.opts.height;
      tip.style.left = `${(svgRect.left - elRect.left) + cx * scaleX}px`;
      const topYPx = (svgRect.top - elRect.top) + this.padding.top * scaleY - 8;
      tip.style.top = `${topYPx}px`;
    };

    const onLeave = () => {
      cursor.setAttribute('style', 'display:none');
      tip.style.display = 'none';
    };

    overlay.addEventListener('mousemove', onMove);
    overlay.addEventListener('mouseleave', onLeave);
  }
}
