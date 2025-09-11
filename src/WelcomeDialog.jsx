import React, { useState } from 'react';

export default function WelcomeDialog({ onShowTutorial, onClose }) {
  const [dontShow, setDontShow] = useState(false);

  return (
    <div className="welcome-overlay">
      <div className="welcome-dialog glass-effect">
        <img src="/images/favi2.png" alt="Vectra logo" className="welcome-logo" />
        <h2>Welcome to Vectra</h2>
        <p>Plan and visualize your drone missions.</p>
        <label className="welcome-checkbox">
          <input
            type="checkbox"
            checked={dontShow}
            onChange={e => setDontShow(e.target.checked)}
          />
          Don't show this again
        </label>
        <div className="welcome-buttons">
          <button onClick={() => onShowTutorial(dontShow)}>Show Tutorial</button>
          <button onClick={() => onClose(dontShow)}>Close</button>
        </div>
      </div>
    </div>
  );
}
