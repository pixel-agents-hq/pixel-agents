/** Tune names: a retro sci-fi city whose office has drifted into orbit. */

import type { MoodKey } from './moods.js';
import type { Rng } from './rng.js';

const STARS = [
  'Nova',
  'Vega',
  'Lyra',
  'Kepler',
  'Orion',
  'Tycho',
  'Halley',
  'Juno',
  'Cygnus',
  'Aster',
  'Nimbus',
  'Polaris',
  'Echo',
  'Helix',
  'Zephyr',
];
const TOWN_ADJ = [
  'Neon',
  'Pastel',
  'Chrome',
  'Sunny',
  'Pixel',
  'Velvet',
  'Lucky',
  'Mint',
  'Cosmo',
  'Lumen',
  'Solar',
  'Retro',
  'Candy',
  'Halcyon',
  'Cobalt',
  'Amber',
];
const TOWN_PLACES = [
  'Plaza',
  'Atrium',
  'Lobby',
  'Arcade',
  'Commons',
  'Café',
  'Concourse',
  'Promenade',
  'Terrace',
  'Breakroom',
  'Market',
  'Hub',
  'Courtyard',
  'Lounge',
  'Greenhouse',
];
const ROUTE_WAYS = [
  'Monorail',
  'Skyway',
  'Data Highway',
  'Hyperlane',
  'Elevator',
  'Tram Line',
  'Shuttle Run',
  'Fiber Tunnel',
  'Conveyor',
  'Maglev',
  'Overpass',
  'Service Duct',
  'Air Lock',
  'Starlane',
];
const ROUTE_TO = [
  'Orbit',
  'the Mainframe',
  'the Top Floor',
  'Sector 9',
  'the Stars',
  'the Next Level',
  'Moonbase',
  'the Core',
  'the Archive',
  'Lobby Zero',
  'the Edge',
  'Headquarters',
];
const LAB_PLACES = [
  'Mainframe',
  'Reactor',
  'Holo Lab',
  'Cryo Vault',
  'Server Spire',
  'Signal Room',
  'Data Core',
  'Clone Bay',
  'Circuit Garden',
  'Prototype Bay',
  'Copy Chamber',
  'Logic Gate',
  'Memory Bank',
  'Plasma Lab',
  'Robot Workshop',
  'Synth Lab',
];
const LAB_TAGS = [
  'Protocol',
  'Build',
  'Unit',
  'Module',
  'Firmware',
  'Experiment',
  'Program',
  'Patch',
];
const NIGHT_PLACES = [
  'Moonbase Lobby',
  'Starlit Server Room',
  'Empty Concourse',
  'Orbital Breakroom',
  'Silent Mainframe',
  'Dim Arcade',
  'Sleeping Spire',
  'Last Shuttle',
  'Night Tram',
  'Observation Deck',
  'Quiet Terminal',
  'Rooftop Antenna',
  'Vending Machine Glow',
  'Blue Monitor',
];
const NIGHT_MODES = [
  'Standby',
  'Sleep Mode',
  'Low Power',
  'Screensaver',
  'Night Cycle',
  'Idle Loop',
  'Dim Mode',
  'Starlight Mode',
];
const NIGHT_OF = [
  'Stars',
  'Satellites',
  'Fireflies',
  'Monitors',
  'Neon',
  'Static',
  'Comets',
  'Moonlight',
];

const ORBIT_PLACES = [
  'Space Station',
  'Satellite',
  'Docking Bay',
  'Solar Array',
  'Zero-G Lounge',
  'Ring Station',
  'Star Elevator',
  'Comet Trail',
  'Lunar Office',
  'Orbital Atrium',
  'Gravity Well',
  'Launch Window',
];
const RAIN_ON = [
  'Skylight',
  'Monorail',
  'Dome',
  'Neon Sign',
  'Window',
  'Rooftop Antenna',
  'Concourse',
  'Glass Tower',
  'Solar Panels',
  'Arcade Awning',
];
const RAIN_WEATHER = ['Drizzle', 'Rain', 'Mist', 'Showers', 'Fog', 'Downpour'];
const RAIN_PLACES = [
  'Wet Neon',
  'Umbrella Lobby',
  'Puddle Plaza',
  'Foggy Terminal',
  'Rainy Breakroom',
  'Misty Concourse',
  'Dripping Mainframe',
  'Storm Window',
];
const DAWN_WORDS = [
  'Boot Sequence',
  'Morning Shift',
  'Coffee Protocol',
  'First Shuttle',
  'Wake-Up Call',
  'Power On',
  'Daybreak Terminal',
  'Early Tram',
  'Sunrise Lobby',
  'Morning Briefing',
];
const ARCADE_WORDS = [
  'Insert Coin',
  'High Score',
  'Bonus Round',
  'Power-Up',
  'Extra Life',
  'Warp Zone',
  'Boss Rush',
  'Combo Breaker',
  'Player Two',
  'Press Start',
];

const letter = (r: Rng) => String.fromCharCode(65 + r.int(0, 25));

/** Each mood's name patterns, weighted. */
const NAME_PATTERNS: Record<MoodKey, Array<[(r: Rng) => string, number]>> = {
  town: [
    [(r) => `${r.pick(TOWN_ADJ)} ${r.pick(TOWN_PLACES)}`, 3],
    [(r) => `${r.pick(STARS)} ${r.pick(TOWN_PLACES)}`, 2],
    [(r) => `${r.pick(STARS)} City`, 1],
    [(r) => `Floor ${r.int(2, 99)} ${r.pick(TOWN_PLACES)}`, 1],
  ],
  route: [
    [(r) => `Route ${r.int(1, 99)}`, 1],
    [(r) => `${r.pick(ROUTE_WAYS)} to ${r.pick(ROUTE_TO)}`, 3],
    [(r) => `${r.pick(ROUTE_WAYS)} ${r.int(1, 99)}`, 1],
    [(r) => `Sector ${r.int(1, 12)}-${letter(r)}`, 1],
    [(r) => `${r.pick(STARS)} ${r.pick(ROUTE_WAYS)}`, 2],
  ],
  lab: [
    [(r) => `${r.pick(LAB_PLACES)} ${letter(r)}`, 2],
    [(r) => `${r.pick(LAB_TAGS)} ${r.int(1, 99)}`, 1],
    [(r) => `${r.pick(LAB_PLACES)} ${r.int(2, 9)}.${r.int(0, 9)}`, 1],
    [(r) => `The ${r.pick(LAB_PLACES)}`, 2],
  ],
  night: [
    [(r) => r.pick(NIGHT_PLACES), 3],
    [(r) => r.pick(NIGHT_MODES), 1],
    [(r) => `${r.pick(NIGHT_PLACES)}, ${r.int(1, 4)} AM`, 2],
    [(r) => `City of ${r.pick(NIGHT_OF)}`, 2],
    [(r) => `${r.pick(NIGHT_MODES)}: ${r.pick(STARS)}`, 1],
    [(r) => `${r.pick(STARS)} After Dark`, 1],
  ],
  orbit: [
    [(r) => r.pick(ORBIT_PLACES), 2],
    [(r) => `${r.pick(STARS)} Station`, 1],
    [(r) => `Drifting Past ${r.pick(STARS)}`, 2],
    [(r) => `Low Orbit ${letter(r)}`, 1],
    [(r) => `${r.pick(ORBIT_PLACES)} ${r.pick(STARS)}`, 2],
  ],
  rain: [
    [(r) => `Rain on the ${r.pick(RAIN_ON)}`, 3],
    [(r) => `${r.pick(RAIN_WEATHER)} Over ${r.pick(STARS)}`, 2],
    [(r) => `${r.pick(STARS)} in the Rain`, 1],
    [(r) => r.pick(RAIN_PLACES), 2],
    [(r) => `${r.pick(RAIN_WEATHER)} on Floor ${r.int(2, 99)}`, 1],
  ],
  dawn: [
    [(r) => r.pick(DAWN_WORDS), 2],
    [(r) => `First Light on ${r.pick(STARS)}`, 2],
    [(r) => `${r.pick(STARS)} Sunrise`, 1],
    [(r) => `Good Morning, ${r.pick(STARS)}`, 1],
    [(r) => `Sunrise Over Sector ${r.int(1, 12)}`, 1],
  ],
  arcade: [
    [(r) => r.pick(ARCADE_WORDS), 2],
    [(r) => `Stage ${r.int(1, 9)}-${r.int(1, 4)}`, 2],
    [(r) => `${r.pick(STARS)} Zone`, 2],
    [(r) => `${r.pick(TOWN_ADJ)} Galaxy`, 1],
    [(r) => `Level ${r.int(1, 99)}`, 1],
  ],
};

/** The tune's name, drawn from `r` (the composer draws it last). */
export function tuneName(r: Rng, mood: MoodKey): string {
  return r.weighted(NAME_PATTERNS[mood])(r);
}
