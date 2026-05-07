/**
 * Charging-station telemetry: fetch, parse, cache, and reshape the published Google Sheet.
 *
 * Wire-shape (CSV columns from the sheet):
 *   timestamp, datetime, Output_AC_Voltage, AC_Input_Voltage, Inverter_BUS_Voltage,
 *   Battery_Voltage, Battery_Discharge_Power, Battery_Percentage,
 *   Input_Battery_Charge_Power_KWh_hour, Input_Battery_Charge_Power_watt,
 *   Load_Power, Load_Current, Load_Power_Percentage,
 *   PV1_Voltage, PV1_Power, PV2_Voltage, PV2_Power,
 *   Inverter_BUS_Current, Inverter_Heatsink_temp, MPPT_Heatsink_temp,
 *   Inverter_internal_DC_to_DC_Heatsink_temp
 */

export interface Sample {
  ts: number;          // epoch seconds (UTC)
  batteryV: number;
  batteryPct: number;
  batteryDischargeW: number;
  batteryChargeW: number;
  totalKwh: number;    // monotonic lifetime energy harvested
  pv1V: number;
  pv1W: number;
  pv2W: number;
  loadW: number;
  loadA: number;
  acOutV: number;
  invTemp: number;
  mpptTemp: number;
  dcdcTemp: number;
}

export type Range = '24h' | '7d' | '30d' | 'all';

const RANGE_SECONDS: Record<Range, number> = {
  '24h': 24 * 3600,
  '7d': 7 * 24 * 3600,
  '30d': 30 * 24 * 3600,
  'all': Infinity,
};

const CACHE_KEY = 'udst-sheet-v1';
const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  fetchedAt: number;
  url: string;
  data: Sample[];
}

// Same robust parser used in the earlier draft — handles quoted fields w/ commas + escaped quotes.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = '';
        if (row.some(v => v !== '')) rows.push(row);
        row = [];
      } else field += c;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    if (row.some(v => v !== '')) rows.push(row);
  }
  return rows;
}

const num = (s: string | undefined) => {
  if (s == null || s === '') return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
};

export function rowsToSamples(grid: string[][]): Sample[] {
  if (grid.length < 2) return [];
  const head = grid[0].map(s => s.trim());
  const idx = (name: string) => head.indexOf(name);
  const I = {
    ts: idx('timestamp'),
    bv: idx('Battery_Voltage'),
    bp: idx('Battery_Percentage'),
    bd: idx('Battery_Discharge_Power'),
    bcK: idx('Input_Battery_Charge_Power_KWh_hour'),
    bcW: idx('Input_Battery_Charge_Power_watt'),
    pv1V: idx('PV1_Voltage'),
    pv1W: idx('PV1_Power'),
    pv2W: idx('PV2_Power'),
    lw: idx('Load_Power'),
    la: idx('Load_Current'),
    ac: idx('Output_AC_Voltage'),
    iT: idx('Inverter_Heatsink_temp'),
    mT: idx('MPPT_Heatsink_temp'),
    dT: idx('Inverter_internal_DC_to_DC_Heatsink_temp'),
  };

  const out: Sample[] = [];
  for (let i = 1; i < grid.length; i++) {
    const r = grid[i];
    out.push({
      ts: num(r[I.ts]),
      batteryV: num(r[I.bv]),
      batteryPct: num(r[I.bp]),
      batteryDischargeW: num(r[I.bd]),
      batteryChargeW: num(r[I.bcW]),
      totalKwh: num(r[I.bcK]),
      pv1V: num(r[I.pv1V]),
      pv1W: num(r[I.pv1W]),
      pv2W: num(r[I.pv2W]),
      loadW: num(r[I.lw]),
      loadA: num(r[I.la]),
      acOutV: num(r[I.ac]),
      invTemp: num(r[I.iT]),
      mpptTemp: num(r[I.mT]),
      dcdcTemp: num(r[I.dT]),
    });
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

export function filterRange(samples: Sample[], range: Range): Sample[] {
  if (samples.length === 0) return samples;
  if (range === 'all') return samples;
  const last = samples[samples.length - 1].ts;
  const cutoff = last - RANGE_SECONDS[range];
  // binary search for first ts >= cutoff
  let lo = 0, hi = samples.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].ts < cutoff) lo = mid + 1; else hi = mid;
  }
  return samples.slice(lo);
}

/** Bucket-average downsampling — keeps min/max + avg per bucket so spikes survive. */
export function downsample(samples: Sample[], target: number): Sample[] {
  if (samples.length <= target) return samples;
  const bucketSize = samples.length / target;
  const out: Sample[] = [];
  for (let i = 0; i < target; i++) {
    const start = Math.floor(i * bucketSize);
    const end = Math.floor((i + 1) * bucketSize);
    const slice = samples.slice(start, end);
    if (!slice.length) continue;
    const mid = slice[Math.floor(slice.length / 2)];
    const acc = slice.reduce((a, s) => {
      a.batteryV += s.batteryV; a.batteryPct += s.batteryPct;
      a.batteryDischargeW += s.batteryDischargeW; a.batteryChargeW += s.batteryChargeW;
      a.pv1W += s.pv1W; a.pv1V += s.pv1V; a.pv2W += s.pv2W;
      a.loadW += s.loadW; a.loadA += s.loadA;
      a.invTemp += s.invTemp; a.mpptTemp += s.mpptTemp; a.dcdcTemp += s.dcdcTemp;
      a.acOutV += s.acOutV;
      return a;
    }, {
      batteryV: 0, batteryPct: 0, batteryDischargeW: 0, batteryChargeW: 0,
      pv1W: 0, pv1V: 0, pv2W: 0, loadW: 0, loadA: 0,
      invTemp: 0, mpptTemp: 0, dcdcTemp: 0, acOutV: 0,
    });
    const n = slice.length;
    out.push({
      ts: mid.ts,
      totalKwh: mid.totalKwh,  // monotonic; pick midpoint
      batteryV: acc.batteryV / n,
      batteryPct: acc.batteryPct / n,
      batteryDischargeW: acc.batteryDischargeW / n,
      batteryChargeW: acc.batteryChargeW / n,
      pv1V: acc.pv1V / n,
      pv1W: acc.pv1W / n,
      pv2W: acc.pv2W / n,
      loadW: acc.loadW / n,
      loadA: acc.loadA / n,
      acOutV: acc.acOutV / n,
      invTemp: acc.invTemp / n,
      mpptTemp: acc.mpptTemp / n,
      dcdcTemp: acc.dcdcTemp / n,
    });
  }
  return out;
}

export interface DerivedStats {
  totalEnergyKwh: number;     // last - first totalKwh in window
  peakPvW: number;
  peakBattW: number;
  avgBattPct: number;
  daysCovered: number;
  loadEnergyKwh: number;      // ∫ Load_Power dt
}

export function deriveStats(samples: Sample[]): DerivedStats {
  if (samples.length < 2) {
    return { totalEnergyKwh: 0, peakPvW: 0, peakBattW: 0, avgBattPct: 0, daysCovered: 0, loadEnergyKwh: 0 };
  }
  let peakPvW = 0, peakBattW = 0, sumBattPct = 0, loadJ = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    if (s.pv1W > peakPvW) peakPvW = s.pv1W;
    if (s.batteryDischargeW > peakBattW) peakBattW = s.batteryDischargeW;
    sumBattPct += s.batteryPct;
    if (i > 0) {
      const dt = samples[i].ts - samples[i - 1].ts;  // seconds
      loadJ += s.loadW * dt;  // joules
    }
  }
  const first = samples[0];
  const last = samples[samples.length - 1];
  return {
    totalEnergyKwh: Math.max(0, last.totalKwh - first.totalKwh),
    peakPvW,
    peakBattW,
    avgBattPct: sumBattPct / samples.length,
    daysCovered: (last.ts - first.ts) / 86400,
    loadEnergyKwh: loadJ / 3.6e6,
  };
}

/** SWR-style cached load. Returns cached data immediately (sync via callback) and revalidates in background. */
export async function loadSheet(
  url: string,
  onUpdate: (samples: Sample[], info: { fromCache: boolean; fetchedAt: number }) => void,
): Promise<void> {
  // 1. Try cache
  let cached: CacheEntry | null = null;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) {
      const c = JSON.parse(raw) as CacheEntry;
      if (c.url === url && Array.isArray(c.data)) cached = c;
    }
  } catch { /* ignore */ }

  if (cached) onUpdate(cached.data, { fromCache: true, fetchedAt: cached.fetchedAt });

  const isFresh = cached && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS;
  if (isFresh) return;

  // 2. Fetch fresh
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const samples = rowsToSamples(parseCsv(text));
    if (samples.length === 0) throw new Error('Empty sheet');
    const fetchedAt = Date.now();
    onUpdate(samples, { fromCache: false, fetchedAt });
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ url, fetchedAt, data: samples } satisfies CacheEntry));
    } catch { /* localStorage full or disabled */ }
  } catch (err) {
    if (!cached) throw err;
    // else: silently keep cached data on failure
  }
}
