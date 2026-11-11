import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';

import {
  KB_REJECTION_TEXT,
  KB_TEXT,
  KB_TREE_MIN_HEIGHT_PX,
  KB_TREE_WIDTH_PX,
} from '../../constants';
import type { KbView } from '../../features/kb/kbSlice';
import type { KbRejectionReason } from '../../protocol';
import { KB_ROOT_DIR, listDirectory, parentDirectory } from './kbTree';
import type { KbDirectoryEntry } from './kbTree';

interface KbBrowserProps {
  view: KbView;
  /** 不能瀏覽的原因（例如未連線、沒有根目錄）；有值時只顯示這段說明 */
  blockedNote?: string | null;
  onSelect: (relPath: string) => void;
  onChangeDirectory: (dir: string) => void;
}

const noteSx = { p: 3, fontSize: 12, color: 'text.disabled' };

function Note({ children }: { children: string }) {
  return <Typography sx={noteSx}>{children}</Typography>;
}

const rowSx = {
  font: 'inherit',
  fontSize: 12,
  display: 'block',
  width: '100%',
  textAlign: 'left',
  cursor: 'pointer',
  border: 0,
  py: 0.25,
  color: 'text.primary',
} as const;

function DirectoryRows({
  entries,
  dir,
  selectedPath,
  onSelect,
  onChangeDirectory,
}: {
  entries: KbDirectoryEntry[];
  dir: string;
  selectedPath: string | null;
  onSelect: (relPath: string) => void;
  onChangeDirectory: (dir: string) => void;
}) {
  return (
    <>
      {dir !== KB_ROOT_DIR && (
        <Box
          component="button"
          type="button"
          onClick={() => onChangeDirectory(parentDirectory(dir))}
          sx={{ ...rowSx, bgcolor: 'transparent', fontWeight: 600 }}
        >
          {KB_TEXT.parentEntry}
        </Box>
      )}
      {entries.map((entry) =>
        entry.kind === 'folder' ? (
          <Box
            key={`dir:${entry.path}`}
            component="button"
            type="button"
            onClick={() => onChangeDirectory(entry.path)}
            sx={{ ...rowSx, bgcolor: 'transparent', fontWeight: 600 }}
          >
            {entry.name}/
          </Box>
        ) : (
          <Box
            key={`file:${entry.path}`}
            component="button"
            type="button"
            aria-current={entry.path === selectedPath ? 'true' : undefined}
            onClick={() => onSelect(entry.path)}
            sx={{
              ...rowSx,
              bgcolor: entry.path === selectedPath ? 'action.selected' : 'transparent',
            }}
          >
            {entry.name}
          </Box>
        ),
      )}
    </>
  );
}

function reasonText(reason: KbRejectionReason) {
  return KB_REJECTION_TEXT[reason];
}

function Content({ view }: { view: KbView }) {
  if (view.selectedPath === null) return <Note>{KB_TEXT.pickFile}</Note>;
  if (view.readError) return <Note>{reasonText(view.readError)}</Note>;
  if (view.reading || view.content === null) return <Note>{KB_TEXT.reading}</Note>;
  // 內容與檔名一律當純文字輸出：只經過 React 的文字節點，不解析 HTML / Markdown。
  return (
    <Box
      component="pre"
      sx={{
        m: 0,
        p: 2,
        fontFamily: 'inherit',
        fontSize: 12,
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere',
      }}
    >
      {view.content === '' ? KB_TEXT.emptyFile : view.content}
    </Box>
  );
}

/** 左側只列目前目錄的資料夾與檔案（點資料夾進入、`..` 回上一層），右側是選中檔案的純文字內容。 */
export function KbBrowser({ view, blockedNote, onSelect, onChangeDirectory }: KbBrowserProps) {
  if (blockedNote) return <Note>{blockedNote}</Note>;
  if (view.listError) return <Note>{reasonText(view.listError)}</Note>;
  if (!view.listed) return <Note>{KB_TEXT.loading}</Note>;
  if (view.files.length === 0) return <Note>{KB_TEXT.empty}</Note>;

  return (
    <Box sx={{ display: 'flex', flex: 1, minHeight: KB_TREE_MIN_HEIGHT_PX }}>
      <Box
        sx={{
          width: KB_TREE_WIDTH_PX,
          flexShrink: 0,
          overflowY: 'auto',
          p: 1.5,
          borderRight: 1,
          borderColor: 'divider',
        }}
      >
        <Typography sx={{ mb: 1, fontSize: 11, color: 'text.disabled', overflowWrap: 'anywhere' }}>
          {KB_TEXT.location}：/{view.dir}
        </Typography>
        <DirectoryRows
          entries={listDirectory(
            view.files.map((file) => file.path),
            view.dir,
          )}
          dir={view.dir}
          selectedPath={view.selectedPath}
          onSelect={onSelect}
          onChangeDirectory={onChangeDirectory}
        />
        {view.truncated && (
          <Typography sx={{ mt: 1, fontSize: 11, color: 'text.disabled' }}>
            {KB_TEXT.truncated}
          </Typography>
        )}
      </Box>
      <Box sx={{ flex: 1, minWidth: 0, overflow: 'auto' }}>
        <Content view={view} />
      </Box>
    </Box>
  );
}
