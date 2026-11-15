/** English strings: intro. The source of truth — vi/intro.ts must carry every key. */
export const intro = {
  // The Intro tour (IntroBubble). The consent step's copy comes from the server.
  welcomeTitle: 'Welcome to Pixel Agents!',
  claudeCodeTitle: 'Powered by Claude Code',
  usageTitle: 'Track your usage',
  closingTitle: "You're all set!",
  closingFailedTitle: "Hooks couldn't be installed",
  stepOf: 'Step {current} of {total}',
  welcomeBody:
    "In this office, your AI agents become tiny pixel characters: they type at their desks while they work, wander off when they're done, and speak up when they need you.",
  claudeCodeBody:
    'The office watches your Claude Code sessions and brings them to life in here. New to Claude Code? Download it first:',
  moreInfo: 'For more info, visit',
  usageShown: 'Your usage now shows in the top-left corner.',
  installFailedBody:
    'Something went wrong writing to your Claude Code settings, so the office will watch your sessions the slower way instead. No worries, everything still works and you can retry activating them any time from Settings.',
  enjoyBody:
    'Enjoy your new office! Questions, ideas, or pixel art to show off? Come hang out in our Discord.',
  joinDiscord: 'Join our Discord!',
  skip: 'Skip',
  connecting: 'Connecting...',
  showUsage: 'Show Usage',
  dontAskAgain: "Don't Ask Again",
  notNow: 'Not Now',
  installing: 'Installing...',
  installHooks: 'Install Hooks',
  letsGo: "Let's Go",
  continue: 'Continue',
  // Migration notice
  migrationTitle: 'We owe you an apology!',
  migrationBody:
    "We've just migrated to fully open-source assets, all built from scratch with love. Unfortunately, this means your previous layout had to be reset.",
  migrationSorry: "We're really sorry about that.",
  migrationGoodNews:
    'The good news? This was a one-time thing, and it paves the way for some genuinely exciting updates ahead.',
  migrationThanks: 'Stay tuned, and thanks for using Pixel Agents!',
  gotIt: 'Got it',
  // What's new (changelog modal chrome + version label)
  whatsNewIn: "What's New in v{version}",
  contributors: 'Contributors',
  viewOnGitHub: 'View on GitHub',
  updatedTo: 'Updated to v{version}!',
  seeWhatsNew: "See what's new",
  seeWhatsNewTooltip: "See what's new!",
  // Loading screen
  loadingOffice: 'Loading the office',
} as const;
