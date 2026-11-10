import { createTheme } from '@mui/material/styles';

import { APP_FONT_FAMILY } from './constants';

const border = {
  structural: '#2c2c3c',
  /** 輸入框、按鈕、切換鈕這類可操作元件的邊框，要比分隔線明顯 */
  control: '#4a4a62',
};

/** 紫色底色（按鈕、選取背景）與紫色文字分開：#6d3fe8 配白字 6.0:1，但直接當文字在深色底只有約 3:1 */
const purple = { fill: '#6d3fe8', text: '#a78bfa' };

const surface = {
  page: '#0c0c10',
  panel: '#111117',
  field: '#0e0e14',
};

interface BadgeColors {
  color: string;
  background: string;
  border: string;
}

export const roleColors: Record<'R' | 'E' | 'D' | 'W', BadgeColors> = {
  R: { color: '#60a5fa', background: 'rgba(59,130,246,0.1)', border: 'rgba(59,130,246,0.2)' },
  E: { color: '#ca8a04', background: 'rgba(234,179,8,0.12)', border: 'rgba(234,179,8,0.25)' },
  D: { color: '#ef4444', background: 'rgba(239,68,68,0.1)', border: 'rgba(239,68,68,0.2)' },
  W: { color: '#22c55e', background: 'rgba(34,197,94,0.1)', border: 'rgba(34,197,94,0.2)' },
};

export const controlBorderColor = border.control;

export const statusColors = {
  running: { color: '#22c55e', glow: '0 0 5px rgba(34,197,94,0.5)' },
  waiting: { color: '#f59e0b', glow: '0 0 4px rgba(245,158,11,0.4)' },
  idle: { color: '#8b93a1', glow: 'none' },
  stopped: { color: '#8b93a1', glow: 'none' },
} as const;

export const theme = createTheme({
  palette: {
    mode: 'dark',
    background: { default: surface.page, paper: surface.panel },
    primary: { main: purple.fill, light: purple.text, contrastText: '#ffffff' },
    success: { main: '#22c55e', contrastText: '#0a0a0f' },
    warning: { main: '#f59e0b', contrastText: '#0a0a0f' },
    error: { main: '#ef4444' },
    info: { main: '#60a5fa', contrastText: '#0a0a0f' },
    divider: border.structural,
    text: { primary: '#f1f5f9', secondary: '#b4bac6', disabled: '#8b93a1' },
  },
  shape: { borderRadius: 4 },
  typography: {
    fontFamily: APP_FONT_FAMILY,
    fontSize: 13,
    h6: { fontSize: 15, fontWeight: 600 },
    subtitle1: { fontSize: 14, fontWeight: 500 },
    body1: { fontSize: 13 },
    body2: { fontSize: 12 },
    caption: { fontSize: 11 },
    button: { fontSize: 12, textTransform: 'none' },
  },
  components: {
    MuiPaper: {
      styleOverrides: { root: { backgroundImage: 'none' } },
    },
    MuiAppBar: {
      styleOverrides: {
        root: {
          backgroundColor: surface.panel,
          backgroundImage: 'none',
          borderBottom: `1px solid ${border.structural}`,
        },
      },
    },
    MuiDivider: {
      styleOverrides: { root: { borderColor: border.structural } },
    },
    MuiCard: {
      styleOverrides: { root: { borderRadius: 6, borderColor: border.structural } },
    },
    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: {
        root: ({ ownerState }) => ({
          borderRadius: 3,
          padding: '5px 14px',
          ...(ownerState.color === 'primary' &&
            ownerState.variant !== 'contained' && { color: purple.text }),
        }),
        outlined: ({ ownerState }) => ({
          borderColor: ownerState.color === 'primary' ? 'rgba(167,139,250,0.5)' : border.control,
        }),
      },
    },
    MuiTabs: {
      styleOverrides: { indicator: { backgroundColor: purple.text } },
    },
    MuiTab: {
      styleOverrides: { root: { '&.Mui-selected': { color: '#f1f5f9' } } },
    },
    MuiSwitch: {
      styleOverrides: {
        switchBase: { '&.Mui-checked': { color: purple.text } },
        track: { backgroundColor: '#6b7280', opacity: 0.6 },
      },
    },
    MuiOutlinedInput: {
      styleOverrides: {
        root: {
          backgroundColor: surface.field,
          fontSize: 12,
          '& .MuiOutlinedInput-notchedOutline': { borderColor: border.control },
        },
      },
    },
    MuiChip: {
      styleOverrides: { root: { borderRadius: 2, fontSize: 11 } },
    },
    MuiBadge: {
      styleOverrides: { badge: { borderRadius: 2 } },
    },
  },
});
