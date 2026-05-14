import {
  CHANGELOG_REPO_URL,
  changelogEntries,
  toMajorMinor,
} from "../changelogData.ts";
import { Modal } from "./ui/Modal.js";

interface ChangelogModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentVersion: string;
}

export function ChangelogModal({
  isOpen,
  onClose,
  currentVersion,
}: ChangelogModalProps) {
  const majorMinor = toMajorMinor(currentVersion);
  const entry =
    changelogEntries.find((e) => e.version === majorMinor) ??
    changelogEntries[0];

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
            <div className="text-lg text-accent-bright mb-4">
              {section.title}
            </div>
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
                  {" — "}
                  {c.description}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="py-6 px-10 border-t border-border mt-4 flex justify-center">
        <a
          href={`${CHANGELOG_REPO_URL}/blob/main/CHANGELOG.md`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-lg no-underline cursor-pointer transition-colors duration-200 hover:text-accent-bright"
        >
          View on GitHub
        </a>
      </div>
    </Modal>
  );
}
