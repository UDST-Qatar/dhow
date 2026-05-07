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
  acInV: number;       // shore-power AC input voltage (low/0 when disconnected)
  invTemp: number;
  mpptTemp: number;
  dcdcTemp: number;
}

/** AC unit (cabin) sample. Pulled from the second sheet tab. */
export interface AcSample {
  ts: number;
  cabinTemp: number;   // °C
  setPoint: number;    // °C cooling target
}

export type Range = '24h' | '7d' | '30d' | 'all';

const RANGE_SECONDS: Record<Range, number> = {
  '24h': 24 * 3600,
  '7d': 7 * 24 * 3600,
  '30d': 30 * 24 * 3600,
  'all': Infinity,
};

const CACHE_KEY_INVERTER = 'udst-sheet-inv-v2';
const CACHE_KEY_AC = 'udst-sheet-ac-v2';
const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry<T> {
  fetchedAt: number;
  url: string;
  data: T[];
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
    acO: idx('Output_AC_Voltage'),
    acI: idx('AC_Input_Voltage'),
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
      acOutV: num(r[I.acO]),
      acInV: num(r[I.acI]),
      invTemp: num(r[I.iT]),
      mpptTemp: num(r[I.mT]),
      dcdcTemp: num(r[I.dT]),
    });
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

export function filterRange<T extends { ts: number }>(samples: T[], range: Range): T[] {
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

export function rowsToAcSamples(grid: string[][]): AcSample[] {
  if (grid.length < 2) return [];
  const head = grid[0].map(s => s.trim());
  const idx = (name: string) => head.indexOf(name);
  const I = {
    ts: idx('timestamp'),
    cabin: idx('Internal_Cabin_Temp'),
    set: idx('Cool_Set_Point'),
  };
  const out: AcSample[] = [];
  for (let i = 1; i < grid.length; i++) {
    const r = grid[i];
    out.push({
      ts: num(r[I.ts]),
      cabinTemp: num(r[I.cabin]),
      setPoint: num(r[I.set]),
    });
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

export function downsampleAc(samples: AcSample[], target: number): AcSample[] {
  if (samples.length <= target) return samples;
  const bucket = samples.length / target;
  const out: AcSample[] = [];
  for (let i = 0; i < target; i++) {
    const start = Math.floor(i * bucket);
    const end = Math.floor((i + 1) * bucket);
    const slice = samples.slice(start, end);
    if (!slice.length) continue;
    const mid = slice[Math.floor(slice.length / 2)];
    let cT = 0, sT = 0;
    for (const s of slice) { cT += s.cabinTemp; sT += s.setPoint; }
    out.push({ ts: mid.ts, cabinTemp: cT / slice.length, setPoint: sT / slice.length });
  }
  return out;
}

export interface AcStats {
  current: number;
  setPoint: number;
  avg: number;
  min: number;
  max: number;
  comfortPct: number;          // % of samples within ±1°C of setpoint
  degreeHoursAbove: number;    // ∫ max(0, cabinTemp - setPoint) dt  → °C·hours
  setPointChanges: number;
}

export function deriveAcStats(samples: AcSample[]): AcStats {
  if (samples.length === 0) {
    return { current: 0, setPoint: 0, avg: 0, min: 0, max: 0, comfortPct: 0, degreeHoursAbove: 0, setPointChanges: 0 };
  }
  let sum = 0, mn = Infinity, mx = -Infinity, comfort = 0, dhAbove = 0, changes = 0;
  let prevSet = samples[0].setPoint;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    sum += s.cabinTemp;
    if (s.cabinTemp < mn) mn = s.cabinTemp;
    if (s.cabinTemp > mx) mx = s.cabinTemp;
    if (Math.abs(s.cabinTemp - s.setPoint) <= 1) comfort++;
    if (s.setPoint !== prevSet) { changes++; prevSet = s.setPoint; }
    if (i > 0) {
      const dtHours = (s.ts - samples[i - 1].ts) / 3600;
      dhAbove += Math.max(0, s.cabinTemp - s.setPoint) * dtHours;
    }
  }
  const last = samples[samples.length - 1];
  return {
    current: last.cabinTemp,
    setPoint: last.setPoint,
    avg: sum / samples.length,
    min: mn,
    max: mx,
    comfortPct: (comfort / samples.length) * 100,
    degreeHoursAbove: dhAbove,
    setPointChanges: changes,
  };
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
      a.acOutV += s.acOutV; a.acInV += s.acInV;
      return a;
    }, {
      batteryV: 0, batteryPct: 0, batteryDischargeW: 0, batteryChargeW: 0,
      pv1W: 0, pv1V: 0, pv2W: 0, loadW: 0, loadA: 0,
      invTemp: 0, mpptTemp: 0, dcdcTemp: 0, acOutV: 0, acInV: 0,
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
      acInV: acc.acInV / n,
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

/** SWR-style cached load — generic over the sample type. */
async function loadSource<T extends { ts: number }>(
  url: string,
  cacheKey: string,
  parse: (grid: string[][]) => T[],
  onUpdate: (data: T[], info: { fromCache: boolean; fetchedAt: number }) => void,
): Promise<void> {
  let cached: CacheEntry<T> | null = null;
  try {
    const raw = localStorage.getItem(cacheKey);
    if (raw) {
      const c = JSON.parse(raw) as CacheEntry<T>;
      if (c.url === url && Array.isArray(c.data)) cached = c;
    }
  } catch { /* ignore */ }

  if (cached) onUpdate(cached.data, { fromCache: true, fetchedAt: cached.fetchedAt });

  const isFresh = cached && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS;
  if (isFresh) return;

  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const data = parse(parseCsv(text));
    if (data.length === 0) throw new Error('Empty sheet');
    const fetchedAt = Date.now();
    onUpdate(data, { fromCache: false, fetchedAt });
    try {
      localStorage.setItem(cacheKey, JSON.stringify({ url, fetchedAt, data } satisfies CacheEntry<T>));
    } catch { /* localStorage full or disabled */ }
  } catch (err) {
    if (!cached) throw err;
  }
}

export const loadInverterSheet = (
  url: string,
  cb: (data: Sample[], info: { fromCache: boolean; fetchedAt: number }) => void,
) => loadSource(url, CACHE_KEY_INVERTER, rowsToSamples, cb);

export const loadAcSheet = (
  url: string,
  cb: (data: AcSample[], info: { fromCache: boolean; fetchedAt: number }) => void,
) => loadSource(url, CACHE_KEY_AC, rowsToAcSamples, cb);
