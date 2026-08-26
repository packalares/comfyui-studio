import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { AppProvider } from './context/AppContext';
import { ThemeProvider } from './context/ThemeContext';
import { TooltipProvider } from './components/ui/tooltip';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <BrowserRouter>
        <TooltipProvider delayDuration={150}>
          <AppProvider>
            <App />
          </AppProvider>
        </TooltipProvider>
      </BrowserRouter>
    </ThemeProvider>
  </React.StrictMode>
);
