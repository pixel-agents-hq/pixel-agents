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
