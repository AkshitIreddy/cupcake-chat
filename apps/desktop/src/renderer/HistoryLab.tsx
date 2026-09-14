import { useEffect, useMemo, useState } from 'react';
import { HISTORY_ERAS, type HistoryEra } from './history-eras';
import { distanceKm, forage, granary, journey, type Coordinate } from './history-math';
import { useWorkspace } from './workspace';

type Place = { name: string; point: Coordinate };
const PLACES: Record<HistoryEra, Place[]> = {
  egyptian: [
    { name: 'Memphis', point: [31.25, 29.85] },
    { name: 'Thebes', point: [32.65, 25.72] },
    { name: 'Aswan', point: [32.9, 24.09] },
  ],
  greek: [
    { name: 'Athens', point: [23.73, 37.98] },
    { name: 'Corinth', point: [22.88, 37.91] },
    { name: 'Sparta', point: [22.43, 37.07] },
  ],
  roman: [
    { name: 'Rome', point: [12.49, 41.9] },
    { name: 'Capua', point: [14.25, 41.08] },
    { name: 'Ravenna', point: [12.2, 44.42] },
  ],
  viking: [
    { name: 'Roskilde', point: [12.08, 55.64] },
    { name: 'York', point: [-1.08, 53.96] },
    { name: 'Bergen', point: [5.32, 60.39] },
  ],
  mongol: [
    { name: 'Karakorum', point: [102.84, 47.2] },
    { name: 'Samarkand', point: [66.98, 39.65] },
    { name: 'Dadu', point: [116.4, 39.9] },
  ],
  medieval: [
    { name: 'Paris', point: [2.35, 48.86] },
    { name: 'Rouen', point: [1.1, 49.44] },
    { name: 'Reims', point: [4.03, 49.26] },
  ],
};
const CONTEXT: Record<HistoryEra, string> = {
  egyptian:
    'A river can connect settlements while making direction, landing places and seasonal conditions matter more than a line on a map.',
  greek:
    'Mountains, sea crossings and separate city-states made nearby places quite different journeys. A short distance is not always an easy trip.',
  roman:
    'Roads, rivers and ports worked together. Bulk freight could favor water, but changing transport and reaching the final destination still took time.',
  viking:
    'A ship needs people, weather and somewhere to land. Cargo vessels and warships served different purposes; a single pace cannot describe every voyage.',
  mongol:
    'Fresh mounts help mobility, but more horses also need more forage and water. Postal relays and campaigning armies are different systems.',
  medieval:
    'A road links places, but bridges, gradients, animals and delays shape the journey. Towns, markets and castles also served political and economic roles.',
};
const SOURCES = [
  ['Stanford ORBIS: transport modeling', 'https://orbis.stanford.edu/'],
  [
    'Viking Ship Museum: different ships and crews',
    'https://www.vikingeskibsmuseet.dk/en/visit-the-museum/exhibitions/previous-exhibitions/heart-and-soul-50-years-with-the-ships-of-the-vikings-2012-13/exhibition-text/conclusions',
  ],
  [
    'British Museum: the Nile',
    'https://www.britishmuseum.org/learn/schools/ages-7-11/ancient-egypt',
  ],
  [
    'Metropolitan Museum: Mongolian horses',
    'https://www.metmuseum.org/exhibitions/listings/2000/mongolian-horse',
  ],
] as const;
const num = (value: number, digits = 1) =>
  value.toLocaleString(undefined, { maximumFractionDigits: digits });

function Slider({
  label,
  value,
  set,
  min,
  max,
  step = 1,
  unit = '',
}: {
  label: string;
  value: number;
  set: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  unit?: string;
}) {
  return (
    <label className="history-slider">
      <span>
        {label}
        <output>
          {num(value, 2)}
          {unit}
        </output>
      </span>
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => set(Number(event.target.value))}
      />
    </label>
  );
}

export function HistoryLab() {
  const workspace = useWorkspace();
  const [open, setOpen] = useState(true);
  const [era, setEra] = useState<HistoryEra>('roman');
  const [tab, setTab] = useState<'map' | 'stores' | 'horses'>('map');
  const [destination, setDestination] = useState(1);
  const [pace, setPace] = useState(25);
  const [detour, setDetour] = useState(1.4);
  const [delay, setDelay] = useState(2);
  const [progress, setProgress] = useState(0);
  const [stock, setStock] = useState(18000);
  const [spoilage, setSpoilage] = useState(10);
  const [people, setPeople] = useState(600);
  const [ration, setRation] = useState(0.75);
  const [arrivals, setArrivals] = useState(120);
  const [arrivalDay, setArrivalDay] = useState(10);
  const [riders, setRiders] = useState(100);
  const [mounts, setMounts] = useState(3);
  const [horseFood, setHorseFood] = useState(10);
  const [grazing, setGrazing] = useState(80);
  const [days, setDays] = useState(5);
  const [land, setLand] = useState<Coordinate[][][]>([]);
  const [mapError, setMapError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const chosen = HISTORY_ERAS.find((item) => item.id === era)!;
  const places = PLACES[era];
  const start = places[0]!;
  const end = places[destination]!;
  const straight = distanceKm(start.point, end.point);
  const travel = journey(straight, detour, pace, delay);
  const food = granary(stock, spoilage, people, ration, arrivals, arrivalDay);
  const horses = forage(riders, mounts, horseFood, grazing, days);
  useEffect(() => {
    if (!open || land.length) return;
    const controller = new AbortController();
    fetch('/maps/land-110m.json', { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error('Map unavailable');
        return r.json();
      })
      .then((data: Coordinate[][][]) => {
        setLand(data);
        setMapError(false);
      })
      .catch((error: Error) => {
        if (error.name !== 'AbortError') setMapError(true);
      });
    return () => controller.abort();
  }, [open, land.length]);
  const projection = useMemo(() => {
    const xs = places.map((p) => p.point[0]);
    const ys = places.map((p) => p.point[1]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const cos = Math.cos((cy * Math.PI) / 180);
    const scale = Math.min(
      620 / Math.max(3, (Math.max(...xs) - Math.min(...xs)) * cos),
      270 / Math.max(2, Math.max(...ys) - Math.min(...ys)),
    );
    return ([lon, lat]: Coordinate) =>
      [380 + (lon - cx) * cos * scale, 195 - (lat - cy) * scale] as const;
  }, [places]);
  const paths = useMemo(
    () =>
      land.map((polygon) =>
        polygon
          .map(
            (ring) =>
              ring
                .map((point, index) => {
                  const [x, y] = projection(point);
                  return `${index ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
                })
                .join(' ') + 'Z',
          )
          .join(' '),
      ),
    [land, projection],
  );
  const a = projection(start.point),
    b = projection(end.point);
  const remainingAt = (day: number) =>
    Math.max(
      0,
      food.usable -
        people * ration * Math.min(day, arrivalDay) -
        (people + arrivals) * ration * Math.max(0, day - arrivalDay),
    );
  const chart = Array.from(
    { length: 41 },
    (_, i) =>
      `${30 + i * 17.5},${200 - (remainingAt((i * Math.max(1, food.initialDays)) / 40) / Math.max(1, food.usable)) * 160}`,
  ).join(' ');
  const save = async () => {
    setSaving(true);
    setNotice('');
    const content =
      `# ${chosen.label}: ${tab === 'map' ? 'journey' : tab === 'stores' ? 'siege supplies' : 'horse forage'}\n\n${chosen.dates}\n\nThese are editable teaching assumptions, not measured historical campaign figures.\n\n` +
      (tab === 'map'
        ? `From ${start.name} to ${end.name}. Great-circle distance: ${num(straight)} km. Detour multiplier: ${detour}. Assumed traveled distance: ${num(travel.distance)} km. Pace: ${pace} km/day. Delays: ${delay} days. Total: ${num(travel.totalDays)} days.\n\nFormula: distance × detour / pace + delay. The map's dashed line is a distance guide, not a verified road or sailing route. Coastlines are modern and simplified; no historical borders are implied.`
        : tab === 'stores'
          ? `Stock: ${stock} kg; spoilage: ${spoilage}%; usable: ${food.usable} kg. Population: ${people}; grain per person: ${ration} kg/day. ${arrivals} people arrive after ${arrivalDay} full days.\n\nInitial duration: ${num(food.initialDays)} days. Total with arrivals: ${num(food.totalDays)} days. Formula: stock after spoilage minus consumption before arrival, divided by the new daily consumption, plus elapsed days. If stores run out before arrival, arrival cannot extend them. Food mass alone does not describe a complete diet.`
          : `Riders: ${riders}; mounts per rider: ${mounts}; horses: ${horses.horses}. Dry-forage equivalent: ${horseFood} kg/horse/day; grazing contribution: ${grazing}%; duration: ${days} days. Daily forage: ${num(horses.dailyNeed)} kg. Carried requirement: ${num(horses.carried)} kg.\n\nFormula: riders × mounts × forage × (1 − grazing share) × days. This excludes water, grazing time, transport animals and changes in pasture quality; it does not establish carrying capacity.`) +
      `\n\n## Historical context\n\n${CONTEXT[era]}\n\n## Further reading\n\n` +
      SOURCES.map(([label, url]) => `- [${label}](${url})`).join('\n');
    try {
      await workspace.createArtifact({
        name: `${chosen.label} — ${tab === 'map' ? 'journey notes' : tab === 'stores' ? 'siege supplies' : 'horse forage'}`,
        kind: 'document',
        mimeType: 'text/markdown',
        content,
      });
      setNotice('Saved in this project’s Artifacts.');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not save this result.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <section className="history-lab" aria-label="History workshop">
      <button className="history-lab__launch" aria-expanded={open} onClick={() => setOpen(!open)}>
        <img src="/art/history/roman-0.webp" alt="" />
        <span>
          <strong>History workshop</strong>
          <small>Follow the routes. Count the grain. Meet the people behind the armies.</small>
        </span>
        <b>{open ? 'Close' : 'Explore'} →</b>
      </button>
      {open && (
        <div className="history-lab__body">
          <div className="history-era-tabs" aria-label="Historical era">
            {HISTORY_ERAS.map((item) => (
              <button
                key={item.id}
                aria-pressed={era === item.id}
                onClick={() => {
                  setEra(item.id);
                  setProgress(0);
                }}
              >
                {item.label}
              </button>
            ))}
          </div>
          <header className="history-heading">
            <div>
              <p className="eyebrow">{chosen.dates}</p>
              <h3>What kept an army going?</h3>
              <p>{CONTEXT[era]}</p>
            </div>
            <img
              src={`/art/history/${era}-2.webp`}
              alt={`${chosen.names[2]}, ${chosen.label} companion`}
            />
          </header>
          <div className="history-tool-tabs" role="tablist" aria-label="History tools">
            {(
              [
                ['map', 'Routes & travel'],
                ['stores', 'Siege supplies'],
                ['horses', 'Horses & forage'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                role="tab"
                aria-selected={tab === id}
                onClick={() => {
                  setTab(id);
                  setNotice('');
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="history-assumptions">
            Change the example assumptions and see what follows. These values are teaching
            scenarios, not historical measurements.
          </p>
          <div className="history-workbench">
            <div className="history-visual">
              {tab === 'map' ? (
                <>
                  <svg
                    className="history-map"
                    viewBox="0 0 760 400"
                    role="img"
                    aria-label={`Distance map from ${start.name} to ${end.name}`}
                  >
                    <defs>
                      <pattern
                        id="history-grid"
                        width="40"
                        height="40"
                        patternUnits="userSpaceOnUse"
                      >
                        <path
                          d="M 40 0 L 0 0 0 40"
                          fill="none"
                          stroke="currentColor"
                          opacity=".1"
                        />
                      </pattern>
                    </defs>
                    <rect width="760" height="400" className="history-map__water" />
                    <rect width="760" height="400" fill="url(#history-grid)" />
                    <g className="history-map__land">
                      {paths.map((d, index) => (
                        <path d={d} key={index} fillRule="evenodd" />
                      ))}
                    </g>
                    <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} className="history-map__route" />
                    {places.map((place, index) => {
                      const [x, y] = projection(place.point);
                      return (
                        <g key={place.name}>
                          <circle cx={x} cy={y} r={index === destination ? 8 : 5} />
                          <text x={x + 11} y={y - 12}>
                            {place.name}
                          </text>
                        </g>
                      );
                    })}
                    <circle
                      cx={a[0] + ((b[0] - a[0]) * progress) / 100}
                      cy={a[1] + ((b[1] - a[1]) * progress) / 100}
                      r="10"
                      className="history-map__traveler"
                    />
                    <text x="22" y="375" className="history-map__caption">
                      N ↑ · Modern land outlines · Approximate settlement locations
                    </text>
                  </svg>
                  {mapError && (
                    <p role="status">
                      The land outline could not load; the distance calculation still works.
                    </p>
                  )}
                  <Slider
                    label="Explore the distance"
                    value={progress}
                    set={setProgress}
                    min={0}
                    max={100}
                    unit="%"
                  />
                  <p className="history-note">
                    Dashed line = geographic distance guide, not a surveyed road or sailing route.
                    Detours and pace below are your assumptions.
                  </p>
                  <div className="history-result">
                    <strong>
                      {num(travel.totalDays)} <small>days</small>
                    </strong>
                    <span>
                      {num(travel.distance)} km assumed travel · {num(travel.movingDays)} moving
                      days + {delay} delayed
                    </span>
                  </div>
                </>
              ) : tab === 'stores' ? (
                <>
                  <h4>Every extra day comes out of the same store</h4>
                  <svg
                    viewBox="0 0 760 240"
                    className="history-stock-chart"
                    role="img"
                    aria-label="Grain remaining over time"
                  >
                    <path d={`M30,200 L${chart.replaceAll(' ', ' L')} L730,200 Z`} />
                    <polyline points={chart} />
                    <text x="30" y="225">
                      Day 0
                    </text>
                    <text x="645" y="225">
                      Day {num(food.initialDays)}
                    </text>
                    <text x="30" y="25">
                      {num(food.usable)} kg usable
                    </text>
                  </svg>
                  <div className="history-result">
                    <strong>
                      {num(food.totalDays)} <small>days</small>
                    </strong>
                    <span>
                      with arrivals, compared with {num(food.initialDays)} days at the original
                      population
                    </span>
                  </div>
                  <p>
                    {arrivals} extra people after {arrivalDay} days leave {num(food.remaining)} kg
                    at that point.{' '}
                    {food.remaining === 0
                      ? 'The stores have already run out.'
                      : arrivals > 0
                        ? 'The same grain now feeds more mouths.'
                        : 'The daily consumption stays the same.'}
                  </p>
                  <p className="history-note">
                    Grain mass is one part of a diet. Water, nutrition, other foods and changing
                    rations are outside this calculation.
                  </p>
                </>
              ) : (
                <>
                  <h4>Fresh mounts still need something to eat</h4>
                  <div className="history-herd" aria-label={`${horses.horses} horses`}>
                    <img
                      src="/art/history/mongol-1.webp"
                      alt="Tula, the horse and pasture companion"
                    />
                    <div>
                      <strong>{num(horses.horses, 0)}</strong>
                      <span>horses for {num(riders, 0)} riders</span>
                    </div>
                  </div>
                  <div
                    className="history-forage-bar"
                    aria-label={`${grazing}% grazed, ${100 - grazing}% carried`}
                  >
                    <span style={{ width: `${grazing}%` }} />
                  </div>
                  <p>
                    {grazing}% from grazing · {100 - grazing}% carried
                  </p>
                  <div className="history-result">
                    <strong>
                      {num(horses.carried)} <small>kg</small>
                    </strong>
                    <span>
                      carried forage over {days} days · {num(horses.dailyNeed)} kg total daily need
                    </span>
                  </div>
                  <p className="history-note">
                    Dry-forage equivalent is an editable assumption. This excludes water, grazing
                    time, pack animals and pasture quality; it does not prove that the force could
                    carry this load.
                  </p>
                </>
              )}
            </div>
            <aside className="history-inputs" aria-label="Scenario assumptions">
              {tab === 'map' ? (
                <>
                  <label className="history-select">
                    From {start.name} to
                    <select
                      aria-label="Map destination"
                      value={destination}
                      onChange={(e) => {
                        setDestination(Number(e.target.value));
                        setProgress(0);
                      }}
                    >
                      {places.slice(1).map((place, i) => (
                        <option key={place.name} value={i + 1}>
                          {place.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p>
                    Geographic distance: <strong>{num(straight)} km</strong>
                  </p>
                  <Slider
                    label="Detour multiplier"
                    value={detour}
                    set={setDetour}
                    min={1}
                    max={3}
                    step={0.1}
                    unit="×"
                  />
                  <Slider
                    label="Travel pace"
                    value={pace}
                    set={setPace}
                    min={5}
                    max={150}
                    step={5}
                    unit=" km/day"
                  />
                  <Slider
                    label="Weather, rest or transfer delays"
                    value={delay}
                    set={setDelay}
                    min={0}
                    max={20}
                    unit=" days"
                  />
                  <p className="history-formula">distance × detour ÷ pace + delays</p>
                </>
              ) : tab === 'stores' ? (
                <>
                  <Slider
                    label="Grain in store"
                    value={stock}
                    set={setStock}
                    min={0}
                    max={40000}
                    step={500}
                    unit=" kg"
                  />
                  <Slider
                    label="Spoilage"
                    value={spoilage}
                    set={setSpoilage}
                    min={0}
                    max={100}
                    unit="%"
                  />
                  <Slider
                    label="People at the start"
                    value={people}
                    set={setPeople}
                    min={100}
                    max={2000}
                    step={20}
                  />
                  <Slider
                    label="Grain per person"
                    value={ration}
                    set={setRation}
                    min={0.25}
                    max={2}
                    step={0.05}
                    unit=" kg/day"
                  />
                  <Slider
                    label="People arriving"
                    value={arrivals}
                    set={setArrivals}
                    min={0}
                    max={1000}
                    step={20}
                  />
                  <Slider
                    label="Arrival after full days"
                    value={arrivalDay}
                    set={setArrivalDay}
                    min={0}
                    max={60}
                    unit=" days"
                  />
                </>
              ) : (
                <>
                  <Slider
                    label="Riders"
                    value={riders}
                    set={setRiders}
                    min={10}
                    max={1000}
                    step={10}
                  />
                  <Slider label="Mounts per rider" value={mounts} set={setMounts} min={1} max={6} />
                  <Slider
                    label="Forage per horse"
                    value={horseFood}
                    set={setHorseFood}
                    min={5}
                    max={20}
                    unit=" kg/day"
                  />
                  <Slider
                    label="Available from grazing"
                    value={grazing}
                    set={setGrazing}
                    min={0}
                    max={100}
                    step={5}
                    unit="%"
                  />
                  <Slider
                    label="Journey length"
                    value={days}
                    set={setDays}
                    min={1}
                    max={30}
                    unit=" days"
                  />
                </>
              )}
              <button
                className="button button--primary"
                onClick={() => void save()}
                disabled={saving}
              >
                {saving ? 'Saving…' : 'Save result to project'}
              </button>
              {notice && <p role="status">{notice}</p>}
            </aside>
          </div>
          <details className="history-sources">
            <summary>Sources, map data and assumptions</summary>
            <p>
              The land outline is Natural Earth 1:110m data, bundled offline via World Atlas 2.0.2.
              It shows modern coastlines, not ancient political borders. Settlement coordinates are
              rounded orientation points. The workshop is an arithmetic explainer, not a
              reconstruction of a particular campaign.
            </p>
            <ul>
              {SOURCES.map(([label, url]) => (
                <li key={url}>
                  <a href={url} target="_blank" rel="noreferrer">
                    {label}
                  </a>
                </li>
              ))}
            </ul>
          </details>
        </div>
      )}
    </section>
  );
}
