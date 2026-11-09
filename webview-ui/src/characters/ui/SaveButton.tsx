import { useStudio } from './studio.js';
import { ViewButton } from './ViewButton.js';

/**
 * Save: what the view changed becomes the roster agents wear. Floats at the bottom right
 * (over the wardrobe's corner on desktop, above the dock on phones); lit while there is
 * something to save.
 */
export function SaveButton() {
  const { cast, save } = useStudio();
  return (
    <ViewButton
      primary={cast.dirty}
      disabled={!cast.dirty}
      icon="save"
      className="chv-save"
      title={cast.dirty ? 'Save your changes to the roster (⌘S)' : 'No unsaved changes'}
      onClick={save}
    >
      {cast.dirty ? 'Save' : 'Saved'}
    </ViewButton>
  );
}
