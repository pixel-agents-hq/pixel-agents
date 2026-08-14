import {
  CHANGELOG_REPO_URL,
  changelogEntries,
  DISCORD_INVITE_URL,
  toMajorMinor,
} from '../changelogData.ts';
import { Modal } from './ui/Modal.js';

function GitHubIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="size-20 shrink-0 translate-y-2"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

export function DiscordIcon() {
  return (
    <svg
      viewBox="0 0 127.14 96.36"
      className="w-21 h-16 shrink-0 translate-y-2"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M107.7 8.07A105.15 105.15 0 0 0 81.47 0a72.06 72.06 0 0 0-3.36 6.83 97.68 97.68 0 0 0-29.11 0A72.37 72.37 0 0 0 45.64 0a105.89 105.89 0 0 0-26.25 8.09C2.79 32.65-1.71 56.6.54 80.21a105.73 105.73 0 0 0 32.17 16.15 77.7 77.7 0 0 0 6.89-11.11 68.42 68.42 0 0 1-10.85-5.18c.91-.66 1.8-1.34 2.66-2a75.57 75.57 0 0 0 64.32 0c.87.71 1.76 1.39 2.66 2a68.68 68.68 0 0 1-10.87 5.19 77 77 0 0 0 6.89 11.1 105.25 105.25 0 0 0 32.19-16.14c2.64-27.38-4.51-51.11-18.9-72.15ZM42.45 65.69C36.18 65.69 31 60 31 53s5-12.74 11.43-12.74S54 46 53.89 53s-5.05 12.69-11.44 12.69Zm42.24 0C78.41 65.69 73.25 60 73.25 53s5-12.74 11.44-12.74S96.23 46 96.12 53s-5.04 12.69-11.43 12.69Z" />
    </svg>
  );
}

interface ChangelogModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentVersion: string;
}

export function ChangelogModal({ isOpen, onClose, currentVersion }: ChangelogModalProps) {
  const majorMinor = toMajorMinor(currentVersion);
  const entry = changelogEntries.find((e) => e.version === majorMinor) ?? changelogEntries[0];

  if (!entry) return null;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={<span className="text-4xl">What's New in v{entry.version}</span>}
      zIndex={51}
      className="min-w-sm!"
    >
      {/* Body */}
      <div className="py-4 px-10 max-h-[60vh] overflow-y-auto">
        {entry.sections.map((section) => (
          <div key={section.title} className="mb-12">
            <div className="text-lg text-accent-bright mb-4">{section.title}</div>
            <ul className="m-0 pl-18 list-disc">
              {section.items.map((item, i) => (
                <li key={i} className="text-sm mb-2">
                  {item}
                </li>
              ))}
            </ul>
          </div>
        ))}

        {/* Contributors */}
        {entry.contributors.length > 0 && (
          <div className="mb-8">
            <div className="text-lg text-accent-bright mb-4">Contributors</div>
            <ul className="m-0 pl-18 list-disc">
              {entry.contributors.map((c) => (
                <li key={c.name} className="text-sm mb-2">
                  <a
                    href={c.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-accent-bright hover:text-accent no-underline"
                  >
                    {c.name}
                  </a>
                  {' — '}
                  {c.description}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="border-t border-border mt-4 flex">
        <a
          href={`${CHANGELOG_REPO_URL}/blob/main/CHANGELOG.md`}
          target="_blank"
          rel="noopener noreferrer"
          className="flex-1 py-6 px-10 border-r border-border flex items-center justify-center gap-12 text-lg no-underline cursor-pointer transition-colors duration-200 hover:text-accent-bright"
        >
          <GitHubIcon />
          View on GitHub
        </a>
        <a
          href={DISCORD_INVITE_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="flex-1 py-6 px-10 flex items-center justify-center gap-12 text-lg no-underline cursor-pointer transition-colors duration-200 hover:text-accent-bright"
        >
          <DiscordIcon />
          Join our Discord!
        </a>
      </div>
    </Modal>
  );
}
