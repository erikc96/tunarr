import { type PaletteOptions, createTheme } from '@mui/material';

// Bauhaus: ink and paper grounds, red / yellow / blue primaries, Futura, square
// corners, flat surfaces. The colours match the Bauhaus Paper / Ink terminal
// themes; every primary keeps 4.5:1 or better against its contrastText.
const INK = '#141414';
const PAPER = '#f2ede1';
const GEO = 'Futura, "Jost", "Century Gothic", "Avenir Next", sans-serif';

const LightTheme: PaletteOptions = {
  mode: 'light',
  primary: { main: '#1f4e9e', contrastText: '#ffffff' },
  secondary: { main: '#c0271f', contrastText: '#ffffff' },
  error: { main: '#c0271f', contrastText: '#ffffff' },
  warning: { main: '#8a6400', contrastText: '#ffffff' },
  info: { main: '#3a68be', contrastText: '#ffffff' },
  success: { main: '#3f6b2a', contrastText: '#ffffff' },
  background: { default: PAPER, paper: '#faf7f0' },
  text: { primary: INK },
  divider: 'rgba(20, 20, 20, 0.16)',
};

const DarkTheme: PaletteOptions = {
  mode: 'dark',
  primary: { main: '#5d8ce6', contrastText: INK },
  secondary: { main: '#f45a48', contrastText: INK },
  error: { main: '#ff5a4a', contrastText: INK },
  warning: { main: '#f2b705', contrastText: INK },
  info: { main: '#7fa2ea', contrastText: INK },
  success: { main: '#9cc288', contrastText: INK },
  background: { default: INK, paper: '#1c1c1c' },
  text: { primary: PAPER },
  divider: 'rgba(242, 237, 225, 0.14)',
};

const heading = { fontWeight: 500, letterSpacing: '0.04em' };

export const Theme = createTheme({
  colorSchemes: {
    dark: {
      palette: DarkTheme,
    },
    light: {
      palette: LightTheme,
    },
  },
  defaultColorScheme: 'light',
  shape: { borderRadius: 0 },
  typography: {
    fontFamily: GEO,
    h1: heading,
    h2: heading,
    h3: heading,
    h4: heading,
    h5: { ...heading, textTransform: 'uppercase' },
    h6: { ...heading, textTransform: 'uppercase' },
    overline: { letterSpacing: '0.14em', fontWeight: 600 },
    button: { fontWeight: 600, letterSpacing: '0.06em' },
  },
  components: {
    MuiButton: { defaultProps: { disableElevation: true } },
    MuiFab: {
      styleOverrides: { root: { borderRadius: 0, boxShadow: 'none' } },
    },
    MuiChip: { styleOverrides: { root: { borderRadius: 0 } } },
    MuiAppBar: {
      defaultProps: { elevation: 0 },
      styleOverrides: {
        // The Bauhaus bar: an ink bar in both modes (a blue one would swallow the
        // stripe's blue third) with hard red / yellow / blue stops under it.
        root: ({ theme }) => ({
          backgroundColor: INK,
          color: PAPER,
          borderBottom: '4px solid',
          borderImage: `linear-gradient(90deg, ${theme.palette.error.main} 0 33.3%, #f2b705 33.3% 66.6%, ${theme.palette.primary.main} 66.6%) 1`,
        }),
      },
    },
    MuiTab: { styleOverrides: { root: { letterSpacing: '0.06em' } } },
    MuiTabs: { styleOverrides: { indicator: { height: 4 } } },
  },
});
