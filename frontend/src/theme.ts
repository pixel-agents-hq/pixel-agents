import { createTheme } from '@mui/material/styles';

const border = {
  structural: '#1e1e2a',
  control: '#2a2a38',
};

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

export const statusColors = {
  running: { color: '#22c55e', glow: '0 0 5px rgba(34,197,94,0.5)' },
  waiting: { color: '#f59e0b', glow: '0 0 4px rgba(245,158,11,0.4)' },
  idle: { color: '#374151', glow: 'none' },
} as const;

export const monoFontFamily = "'JetBrains Mono', ui-monospace, monospace";

export const theme = createTheme({
  palette: {
    mode: 'dark',
    background: { default: surface.page, paper: surface.panel },
    primary: { main: '#5b30d6', light: '#a78bfa', contrastText: '#ffffff' },
    success: { main: '#22c55e', contrastText: '#0a0a0f' },
    warning: { main: '#f59e0b', contrastText: '#0a0a0f' },
    error: { main: '#ef4444' },
    info: { main: '#60a5fa', contrastText: '#0a0a0f' },
    divider: border.structural,
    text: { primary: '#f1f5f9', secondary: '#9ca3af', disabled: '#4b5563' },
  },
  shape: { borderRadius: 4 },
  typography: {
    fontFamily: "'Inter', system-ui, sans-serif",
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
        root: { borderRadius: 3, padding: '5px 14px' },
        outlined: { borderColor: border.control },
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
