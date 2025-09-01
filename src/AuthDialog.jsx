import React, { useState } from 'react';

export default function AuthDialog({ onAuthenticated, onClose }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  function handleSubmit(e) {
    e.preventDefault();
    if (onAuthenticated) {
      onAuthenticated(email);
    }
    if (onClose) {
      onClose();
    }
  }

  return (
    <div className="auth-overlay">
      <form className="auth-form glass-effect" onSubmit={handleSubmit}>
        <h2>Sign In</h2>
        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={e => setEmail(e.target.value)}
          required
        />
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={e => setPassword(e.target.value)}
        />
        <div className="auth-actions">
          <button type="submit" disabled={!email.trim()}>Log In</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </div>
  );
}

