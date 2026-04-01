import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './popup.css';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Could not find #root element');

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
