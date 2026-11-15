/** English strings: launch. The source of truth — vi/launch.ts must carry every key. */
export const launch = {
  // Launch drawer
  addDirectoryRow: '+ Directory',
  hostBadge: 'host',
  editNamed: 'Edit {name}',
  editDirectoryTitle: 'Edit directory',
  // A Directory's default characters in its drawer row
  launchAs: 'Launch as {name}',
  launchAsIn: 'Launch as {name} in {directory}',
  showAll: 'Show all',
  showAllCharacters: 'Show all {count} characters of {directory}',
  // Directory modal
  addDirectory: 'Add Directory',
  editDirectory: 'Edit Directory',
  name: 'Name',
  namePlaceholder: 'Project name',
  path: 'Path',
  pathPlaceholder: '~/code/my-project',
  recentDirectories: 'Recent working directories',
  areas: 'Areas',
  // Default characters field
  characters: 'Characters',
  orderPriority: 'Priority',
  orderRandom: 'Random',
  removeCharacter: 'Remove {name}',
  addCharacter: 'Add {name}',
  addDefaultCharacter: 'Add a default character',
  noDefaults: 'None: agents launched here wear a random character no one is wearing.',
  orderHintPriority:
    'Agents launched here wear the first one not in the office; once all are, someone no one is wearing.',
  orderHintRandom:
    'Agents launched here wear a random one not in the office; once all are, someone no one is wearing.',
} as const;
