import './perf-render';
import ReactDOM from 'react-dom/client';
import App from './App.tsx';
import { ThemeProvider } from '@fileverse/ui';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <ThemeProvider>
    <App />
  </ThemeProvider>
);
