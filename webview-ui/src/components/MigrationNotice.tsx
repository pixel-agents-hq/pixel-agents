import { useT } from '../i18n/index.js';
import { Button } from './ui/Button.js';

interface MigrationNoticeProps {
  onDismiss: () => void;
}

export function MigrationNotice({ onDismiss }: MigrationNoticeProps) {
  const t = useT();
  return (
    <div
      className="absolute inset-0 bg-black/70 flex items-center justify-center z-100"
      onClick={onDismiss}
    >
      <div
        className="pixel-panel py-24 px-32 max-w-xl text-center leading-[1.3]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-5xl mb-12 text-accent">{t('intro.migrationTitle')}</div>
        <p className="text-xl m-0 mb-12">{t('intro.migrationBody')}</p>
        <p className="text-xl m-0 mb-12">{t('intro.migrationSorry')}</p>
        <p className="text-xl m-0 mb-12">{t('intro.migrationGoodNews')}</p>
        <p className="text-xl m-0 mb-20">{t('intro.migrationThanks')}</p>
        <Button variant="accent" size="xl" onClick={onDismiss}>
          {t('intro.gotIt')}
        </Button>
      </div>
    </div>
  );
}
